import React, { useEffect, useState } from 'react';
import {
  Check, ChevronDown, Edit3, Languages, Loader2, Play, Plus, Trash2, X,
} from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

type GroupStatus = 'active' | 'inactive' | 'archived';
type MatchType = 'exact' | 'whole_word';

interface PronunciationRule {
  id: string;
  groupId: string;
  writtenText: string;
  spokenReplacement: string;
  matchType: MatchType;
  caseSensitive: boolean;
  priority: number;
  enabled: boolean;
}

interface PronunciationGroup {
  id: string;
  name: string;
  language: string;
  status: GroupStatus;
  description: string | null;
  ruleCount: number;
  assignedAgentCount: number;
}

interface PronunciationGroupDetail extends PronunciationGroup {
  rules: PronunciationRule[];
}

interface GroupListResponse {
  items: PronunciationGroup[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface AgentGroupAssignment {
  groupId: string;
}

interface PronunciationPreview {
  mimeType: string;
  audioBase64: string;
  originalText: string;
  spokenText: string;
  replacementCount: number;
  provider: string;
  model: string;
  voiceId: string;
  durationMs: number;
}

interface PronunciationGroupManagerProps {
  agentId: string | null;
  selectedGroupIds: string[];
  onSelectionChange: (groupIds: string[]) => void;
  defaultLanguage?: string;
  readOnly?: boolean;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

const emptyGroupForm = (language = 'und') => ({
  name: '', language: language || 'und', status: 'active' as GroupStatus, description: '',
});
const emptyRuleForm = () => ({
  writtenText: '', spokenReplacement: '', matchType: 'whole_word' as MatchType,
  caseSensitive: false, priority: 100, enabled: true,
});

export function PronunciationGroupManager({
  agentId,
  selectedGroupIds,
  onSelectionChange,
  defaultLanguage = 'und',
  readOnly = false,
  onError,
  onSuccess,
}: PronunciationGroupManagerProps) {
  const [groups, setGroups] = useState<PronunciationGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [localError, setLocalError] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [selectedManagerGroupId, setSelectedManagerGroupId] = useState('');
  const [groupDetail, setGroupDetail] = useState<PronunciationGroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [groupFormOpen, setGroupFormOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState(() => emptyGroupForm(defaultLanguage));
  const [groupSaving, setGroupSaving] = useState(false);
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState(emptyRuleForm);
  const [ruleSaving, setRuleSaving] = useState(false);
  const [previewText, setPreviewText] = useState('Shanmuga Hospital ECG');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<PronunciationPreview | null>(null);

  const reportError = (error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : fallback;
    setLocalError(message);
    onError?.(message);
  };

  const loadGroups = async (signal?: AbortSignal) => {
    const response = await apiRequest<GroupListResponse>('/pronunciation-groups?page=1&pageSize=100', {
      signal,
      zeaCache: 'bypass',
    });
    setGroups(response.items);
    return response.items;
  };

  const loadDetail = async (groupId: string) => {
    if (!groupId) { setGroupDetail(null); return; }
    setDetailLoading(true);
    try {
      setGroupDetail(await apiRequest<PronunciationGroupDetail>(`/pronunciation-groups/${groupId}`, {
        zeaCache: 'bypass',
      }));
    } catch (error) {
      reportError(error, 'Pronunciation group could not be loaded');
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setLocalError('');
      try {
        const [availableGroups, assignments] = await Promise.all([
          loadGroups(controller.signal),
          agentId
            ? apiRequest<AgentGroupAssignment[]>(`/agents/${agentId}/pronunciation-groups`, {
              signal: controller.signal, zeaCache: 'bypass',
            })
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        if (assignments) onSelectionChange(assignments.map((assignment) => assignment.groupId));
        setSelectedManagerGroupId((current) => current && availableGroups.some((group) => group.id === current)
          ? current : (availableGroups[0]?.id ?? ''));
      } catch (error) {
        if (!isAbortError(error)) reportError(error, 'Pronunciation groups could not be loaded');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [agentId]);

  useEffect(() => {
    if (!managerOpen || !selectedManagerGroupId || groupFormOpen) return;
    void loadDetail(selectedManagerGroupId);
  }, [managerOpen, selectedManagerGroupId, groupFormOpen]);

  const toggleSelection = (group: PronunciationGroup) => {
    if (readOnly || group.status !== 'active') return;
    const selected = selectedGroupIds.includes(group.id);
    onSelectionChange(selected
      ? selectedGroupIds.filter((id) => id !== group.id)
      : [...selectedGroupIds, group.id]);
  };

  const openCreateGroup = () => {
    setEditingGroupId(null);
    setGroupForm(emptyGroupForm(defaultLanguage));
    setGroupFormOpen(true);
    setRuleFormOpen(false);
    setLocalError('');
  };

  const openEditGroup = (group: PronunciationGroupDetail) => {
    setEditingGroupId(group.id);
    setGroupForm({
      name: group.name,
      language: group.language,
      status: group.status,
      description: group.description ?? '',
    });
    setGroupFormOpen(true);
    setRuleFormOpen(false);
    setLocalError('');
  };

  const saveGroup = async () => {
    if (readOnly || groupSaving) return;
    if (!groupForm.name.trim()) { setLocalError('Group name is required.'); return; }
    if (!groupForm.language.trim()) { setLocalError('Language is required.'); return; }
    setGroupSaving(true);
    setLocalError('');
    try {
      const saved = await apiRequest<PronunciationGroup>(
        editingGroupId ? `/pronunciation-groups/${editingGroupId}` : '/pronunciation-groups',
        {
          method: editingGroupId ? 'PATCH' : 'POST',
          body: JSON.stringify({
            name: groupForm.name.trim(),
            language: groupForm.language.trim(),
            status: groupForm.status,
            description: groupForm.description.trim() || null,
          }),
        },
      );
      const nextGroups = await loadGroups();
      setSelectedManagerGroupId(saved.id);
      setGroupFormOpen(false);
      setEditingGroupId(null);
      await loadDetail(saved.id);
      onSuccess?.(`Pronunciation group ${editingGroupId ? 'updated' : 'created'} successfully.`);
      if (!nextGroups.some((group) => group.id === saved.id)) setGroups((current) => [saved, ...current]);
    } catch (error) {
      reportError(error, 'Pronunciation group could not be saved');
    } finally {
      setGroupSaving(false);
    }
  };

  const deleteGroup = async (group: PronunciationGroupDetail) => {
    if (readOnly || !window.confirm(`Delete pronunciation group "${group.name}" and all its rules?`)) return;
    setLocalError('');
    try {
      await apiRequest(`/pronunciation-groups/${group.id}`, { method: 'DELETE' });
      onSelectionChange(selectedGroupIds.filter((id) => id !== group.id));
      const next = await loadGroups();
      const nextId = next[0]?.id ?? '';
      setSelectedManagerGroupId(nextId);
      setGroupDetail(null);
      if (nextId) await loadDetail(nextId);
      onSuccess?.('Pronunciation group deleted successfully.');
    } catch (error) {
      reportError(error, 'Pronunciation group could not be deleted');
    }
  };

  const openCreateRule = () => {
    setEditingRuleId(null);
    setRuleForm(emptyRuleForm());
    setRuleFormOpen(true);
    setGroupFormOpen(false);
    setLocalError('');
  };

  const openEditRule = (rule: PronunciationRule) => {
    setEditingRuleId(rule.id);
    setRuleForm({
      writtenText: rule.writtenText,
      spokenReplacement: rule.spokenReplacement,
      matchType: rule.matchType,
      caseSensitive: rule.caseSensitive,
      priority: rule.priority,
      enabled: rule.enabled,
    });
    setRuleFormOpen(true);
    setGroupFormOpen(false);
    setLocalError('');
  };

  const saveRule = async () => {
    if (!selectedManagerGroupId || readOnly || ruleSaving) return;
    if (!ruleForm.writtenText.trim() || !ruleForm.spokenReplacement.trim()) {
      setLocalError('Written text and spoken replacement are required.');
      return;
    }
    setRuleSaving(true);
    setLocalError('');
    try {
      await apiRequest(
        editingRuleId
          ? `/pronunciation-groups/${selectedManagerGroupId}/rules/${editingRuleId}`
          : `/pronunciation-groups/${selectedManagerGroupId}/rules`,
        {
          method: editingRuleId ? 'PATCH' : 'POST',
          body: JSON.stringify({
            sourceText: ruleForm.writtenText.trim(),
            spokenText: ruleForm.spokenReplacement.trim(),
            matchType: ruleForm.matchType,
            caseSensitive: ruleForm.caseSensitive,
            priority: ruleForm.priority,
            enabled: ruleForm.enabled,
          }),
        },
      );
      setRuleFormOpen(false);
      setEditingRuleId(null);
      await Promise.all([loadDetail(selectedManagerGroupId), loadGroups()]);
      onSuccess?.(`Pronunciation rule ${editingRuleId ? 'updated' : 'created'} successfully.`);
    } catch (error) {
      reportError(error, 'Pronunciation rule could not be saved');
    } finally {
      setRuleSaving(false);
    }
  };

  const deleteRule = async (rule: PronunciationRule) => {
    if (readOnly || !window.confirm(`Delete the rule for "${rule.writtenText}"?`)) return;
    setLocalError('');
    try {
      await apiRequest(`/pronunciation-groups/${rule.groupId}/rules/${rule.id}`, { method: 'DELETE' });
      await Promise.all([loadDetail(rule.groupId), loadGroups()]);
      onSuccess?.('Pronunciation rule deleted successfully.');
    } catch (error) {
      reportError(error, 'Pronunciation rule could not be deleted');
    }
  };

  const testPronunciation = async () => {
    if (!agentId) {
      setLocalError('Save this agent before testing its selected TTS voice.');
      return;
    }
    if (!previewText.trim() || previewLoading) return;
    setPreviewLoading(true);
    setPreview(null);
    setLocalError('');
    try {
      setPreview(await apiRequest<PronunciationPreview>(`/agents/${agentId}/pronunciation-preview`, {
        method: 'POST',
        body: JSON.stringify({ text: previewText.trim(), groupIds: selectedGroupIds }),
      }));
    } catch (error) {
      reportError(error, 'Pronunciation preview could not be generated');
    } finally {
      setPreviewLoading(false);
    }
  };

  const selectedGroups = selectedGroupIds
    .map((id) => groups.find((group) => group.id === id))
    .filter((group): group is PronunciationGroup => Boolean(group));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider">
          PRONUNCIATION / PUNCTUATION GROUPS
        </label>
        {!readOnly && (
          <button type="button" onClick={() => setManagerOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-pink-200 bg-pink-50 px-3 py-1.5 text-[10px] font-black text-pink-700 hover:bg-pink-100">
            <Languages className="h-3.5 w-3.5" /> Manage groups
          </button>
        )}
      </div>

      <div className="relative">
        <button type="button" disabled={loading} onClick={() => setSelectorOpen((value) => !value)}
          className="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left hover:border-pink-200 disabled:opacity-60">
          <span className="flex flex-wrap gap-1.5">
            {loading ? <span className="text-xs font-semibold text-slate-400">Loading groups...</span>
              : selectedGroups.length ? selectedGroups.map((group) => (
                <span key={group.id} className="rounded-lg border border-pink-100 bg-pink-50 px-2.5 py-1 text-xs font-bold text-pink-700">
                  {group.name}
                </span>
              )) : <span className="text-xs font-semibold text-slate-400">No groups selected</span>}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${selectorOpen ? 'rotate-180' : ''}`} />
        </button>
        {selectorOpen && (
          <div className="absolute z-30 mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
            {groups.length === 0 ? (
              <div className="p-4 text-center text-xs font-semibold text-slate-400">No groups available. Create the first group.</div>
            ) : groups.map((group) => {
              const checked = selectedGroupIds.includes(group.id);
              const disabled = readOnly || group.status !== 'active';
              return (
                <button type="button" key={group.id} disabled={disabled} onClick={() => toggleSelection(group)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                  <span className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? 'border-pink-500 bg-pink-500 text-white' : 'border-slate-300'}`}>
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-slate-700">{group.name}</span>
                    <span className="text-[10px] font-semibold text-slate-400">{group.language} · {group.ruleCount} rules · {group.status}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <p className="text-[10px] font-semibold text-slate-400">
        Select reusable company rule sets. Assignments are applied when this agent is saved.
      </p>
      {!readOnly && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input value={previewText} maxLength={300} onChange={(event) => setPreviewText(event.target.value)}
              placeholder="Enter text to test pronunciation"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold text-slate-800 outline-none focus:border-pink-400" />
            <button type="button" disabled={previewLoading || !previewText.trim()} onClick={() => void testPronunciation()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-black text-white hover:bg-slate-800 disabled:opacity-50">
              {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {previewLoading ? 'Generating...' : 'Test pronunciation'}
            </button>
          </div>
          <p className="mt-1.5 text-[9px] font-semibold text-slate-400">Uses the saved agent’s real TTS provider, model and voice. Provider usage charges may apply.</p>
          {preview && (
            <div className="mt-3 rounded-lg border border-emerald-100 bg-white p-3">
              <audio controls preload="metadata" className="h-9 w-full" src={`data:${preview.mimeType};base64,${preview.audioBase64}`}>
                <track kind="captions" />
              </audio>
              <div className="mt-2 grid gap-1 text-[10px] font-semibold text-slate-500 sm:grid-cols-2">
                <span>Spoken text: <strong className="text-slate-700">{preview.spokenText}</strong></span>
                <span>{preview.provider} · {preview.model} · {(preview.durationMs / 1000).toFixed(1)}s · {preview.replacementCount} replacements</span>
              </div>
            </div>
          )}
        </div>
      )}
      {localError && <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{localError}</p>}

      {managerOpen && (
        <div className="fixed inset-0 z-[100] overflow-y-auto bg-slate-950/40 p-4 backdrop-blur-sm">
          <div className="mx-auto my-4 flex min-h-[600px] max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <h3 className="text-base font-black text-slate-800">Pronunciation Groups</h3>
                <p className="text-xs font-semibold text-slate-500">Company-isolated rules used only before TTS synthesis.</p>
              </div>
              <button type="button" onClick={() => setManagerOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
              <aside className="border-b border-slate-200 bg-slate-50/70 p-4 md:border-b-0 md:border-r">
                {!readOnly && (
                  <button type="button" onClick={openCreateGroup}
                    className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-pink-600 px-3 py-2.5 text-xs font-black text-white hover:bg-pink-700">
                    <Plus className="h-4 w-4" /> Create group
                  </button>
                )}
                <div className="max-h-[540px] space-y-1.5 overflow-y-auto">
                  {groups.map((group) => (
                    <button type="button" key={group.id} onClick={() => { setSelectedManagerGroupId(group.id); setGroupFormOpen(false); setRuleFormOpen(false); }}
                      className={`w-full rounded-xl border p-3 text-left transition ${selectedManagerGroupId === group.id && !groupFormOpen ? 'border-pink-200 bg-pink-50' : 'border-transparent bg-white hover:border-slate-200'}`}>
                      <span className="block truncate text-xs font-black text-slate-800">{group.name}</span>
                      <span className="mt-1 block text-[10px] font-semibold text-slate-400">{group.language} · {group.ruleCount} rules</span>
                      <span className={`mt-2 inline-block rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${group.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{group.status}</span>
                    </button>
                  ))}
                  {!groups.length && !loading && <p className="p-4 text-center text-xs font-semibold text-slate-400">No groups created yet.</p>}
                </div>
              </aside>

              <main className="min-w-0 p-5 md:p-6">
                {localError && <div className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700">{localError}</div>}

                {groupFormOpen ? (
                  <div className="mx-auto max-w-2xl space-y-5">
                    <div>
                      <h4 className="text-base font-black text-slate-800">{editingGroupId ? 'Edit group' : 'Create pronunciation group'}</h4>
                      <p className="text-xs font-semibold text-slate-500">Groups can be reused by any agent inside this company.</p>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <label className="space-y-1.5 text-[10px] font-black uppercase text-slate-500">Group name
                        <input value={groupForm.name} maxLength={160} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })}
                          placeholder="e.g. Shanmuga Medical Terms" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-semibold normal-case text-slate-800 outline-none focus:border-pink-400" />
                      </label>
                      <label className="space-y-1.5 text-[10px] font-black uppercase text-slate-500">Language
                        <input value={groupForm.language} maxLength={35} onChange={(event) => setGroupForm({ ...groupForm, language: event.target.value })}
                          placeholder="ta-IN" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 font-mono text-xs font-semibold normal-case text-slate-800 outline-none focus:border-pink-400" />
                      </label>
                      <label className="space-y-1.5 text-[10px] font-black uppercase text-slate-500">Status
                        <select value={groupForm.status} onChange={(event) => setGroupForm({ ...groupForm, status: event.target.value as GroupStatus })}
                          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-semibold normal-case text-slate-800 outline-none focus:border-pink-400">
                          <option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option>
                        </select>
                      </label>
                    </div>
                    <label className="block space-y-1.5 text-[10px] font-black uppercase text-slate-500">Description
                      <textarea value={groupForm.description} maxLength={1000} rows={3} onChange={(event) => setGroupForm({ ...groupForm, description: event.target.value })}
                        placeholder="What this group is used for" className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-semibold normal-case text-slate-800 outline-none focus:border-pink-400" />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button type="button" disabled={groupSaving} onClick={() => setGroupFormOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600">Cancel</button>
                      <button type="button" disabled={groupSaving} onClick={() => void saveGroup()} className="inline-flex items-center gap-2 rounded-xl bg-pink-600 px-4 py-2.5 text-xs font-black text-white disabled:opacity-60">
                        {groupSaving && <Loader2 className="h-4 w-4 animate-spin" />} Save group
                      </button>
                    </div>
                  </div>
                ) : detailLoading ? (
                  <div className="flex h-64 items-center justify-center text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
                ) : groupDetail ? (
                  <div className="space-y-5">
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-lg font-black text-slate-800">{groupDetail.name}</h4>
                          <span className="rounded bg-slate-100 px-2 py-1 font-mono text-[10px] font-bold text-slate-600">{groupDetail.language}</span>
                          <span className={`rounded px-2 py-1 text-[9px] font-black uppercase ${groupDetail.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{groupDetail.status}</span>
                        </div>
                        <p className="mt-1 text-xs font-semibold text-slate-500">{groupDetail.description || 'No description provided.'}</p>
                        <p className="mt-1 text-[10px] font-semibold text-slate-400">Used by {groupDetail.assignedAgentCount} agents</p>
                      </div>
                      {!readOnly && (
                        <div className="flex gap-2">
                          <button type="button" onClick={() => openEditGroup(groupDetail)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-black text-slate-600 hover:bg-slate-50"><Edit3 className="h-3.5 w-3.5" /> Edit</button>
                          <button type="button" onClick={() => void deleteGroup(groupDetail)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[10px] font-black text-red-600 hover:bg-red-100"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                        </div>
                      )}
                    </div>

                    <div className="border-t border-slate-200 pt-5">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div><h5 className="text-sm font-black text-slate-800">Pronunciation rules</h5><p className="text-[10px] font-semibold text-slate-400">Written text is changed only in the audio sent to TTS.</p></div>
                        {!readOnly && groupDetail.status !== 'archived' && (
                          <button type="button" onClick={openCreateRule} className="inline-flex items-center gap-1.5 rounded-lg bg-pink-600 px-3 py-2 text-[10px] font-black text-white hover:bg-pink-700"><Plus className="h-3.5 w-3.5" /> Add rule</button>
                        )}
                      </div>

                      {ruleFormOpen && (
                        <div className="mb-4 rounded-xl border border-pink-100 bg-pink-50/40 p-4">
                          <h6 className="mb-3 text-xs font-black text-slate-700">{editingRuleId ? 'Edit rule' : 'New rule'}</h6>
                          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                            <label className="space-y-1 text-[10px] font-black uppercase text-slate-500">Written text
                              <input value={ruleForm.writtenText} maxLength={500} onChange={(event) => setRuleForm({ ...ruleForm, writtenText: event.target.value })} placeholder="Shanmuga"
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold normal-case text-slate-800 outline-none focus:border-pink-400" />
                            </label>
                            <label className="space-y-1 text-[10px] font-black uppercase text-slate-500">Spoken replacement
                              <input value={ruleForm.spokenReplacement} maxLength={500} onChange={(event) => setRuleForm({ ...ruleForm, spokenReplacement: event.target.value })} placeholder="சண்முகா"
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold normal-case text-slate-800 outline-none focus:border-pink-400" />
                            </label>
                            <label className="space-y-1 text-[10px] font-black uppercase text-slate-500">Match type
                              <select value={ruleForm.matchType} onChange={(event) => setRuleForm({ ...ruleForm, matchType: event.target.value as MatchType })}
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold normal-case text-slate-800 outline-none">
                                <option value="whole_word">Whole word</option><option value="exact">Exact text</option>
                              </select>
                            </label>
                            <label className="space-y-1 text-[10px] font-black uppercase text-slate-500">Priority
                              <input type="number" min={0} max={10000} value={ruleForm.priority} onChange={(event) => setRuleForm({ ...ruleForm, priority: Number(event.target.value) })}
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold normal-case text-slate-800 outline-none" />
                            </label>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-5 text-xs font-bold text-slate-600">
                            <label className="flex items-center gap-2"><input type="checkbox" checked={ruleForm.caseSensitive} onChange={(event) => setRuleForm({ ...ruleForm, caseSensitive: event.target.checked })} className="accent-pink-600" /> Case sensitive</label>
                            <label className="flex items-center gap-2"><input type="checkbox" checked={ruleForm.enabled} onChange={(event) => setRuleForm({ ...ruleForm, enabled: event.target.checked })} className="accent-pink-600" /> Enabled</label>
                          </div>
                          <div className="mt-4 flex justify-end gap-2">
                            <button type="button" onClick={() => setRuleFormOpen(false)} className="rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-black text-slate-600">Cancel</button>
                            <button type="button" disabled={ruleSaving} onClick={() => void saveRule()} className="inline-flex items-center gap-1.5 rounded-lg bg-pink-600 px-3 py-2 text-[10px] font-black text-white disabled:opacity-60">{ruleSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save rule</button>
                          </div>
                        </div>
                      )}

                      <div className="space-y-2">
                        {groupDetail.rules.map((rule) => (
                          <div key={rule.id} className={`grid grid-cols-1 gap-3 rounded-xl border p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-center ${rule.enabled ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-65'}`}>
                            <div className="min-w-0"><span className="block text-[9px] font-black uppercase text-slate-400">Written</span><span className="block break-words text-xs font-bold text-slate-800">{rule.writtenText}</span></div>
                            <span className="hidden text-slate-300 sm:block">→</span>
                            <div className="min-w-0"><span className="block text-[9px] font-black uppercase text-slate-400">Speak as</span><span className="block break-words text-xs font-bold text-pink-700">{rule.spokenReplacement}</span><span className="mt-1 block text-[9px] font-semibold text-slate-400">{rule.matchType.replace('_', ' ')} · priority {rule.priority}{rule.caseSensitive ? ' · case sensitive' : ''}</span></div>
                            {!readOnly && (
                              <div className="flex gap-1 justify-self-end">
                                <button type="button" onClick={() => openEditRule(rule)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Edit3 className="h-3.5 w-3.5" /></button>
                                <button type="button" onClick={() => void deleteRule(rule)} className="rounded-lg p-2 text-red-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                              </div>
                            )}
                          </div>
                        ))}
                        {!groupDetail.rules.length && <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs font-semibold text-slate-400">No rules yet. Add a written word and its spoken replacement.</div>}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-64 flex-col items-center justify-center text-center text-slate-400">
                    <Languages className="mb-3 h-8 w-8" /><p className="text-xs font-semibold">Select a group or create the first one.</p>
                  </div>
                )}
              </main>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
