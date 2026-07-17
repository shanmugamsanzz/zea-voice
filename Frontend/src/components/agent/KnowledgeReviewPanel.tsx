import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, RefreshCw, RotateCcw, Save, X, XCircle } from 'lucide-react';
import { apiRequest } from '../../lib/api';

type DocumentType = 'faq' | 'catalog' | 'workflow_rules' | 'conversation_script' | 'general_knowledge';
type RecordStatus = 'draft' | 'approved' | 'rejected' | 'archived';

interface ReviewRecord extends Record<string, unknown> {
  id: string;
  kind: 'faq' | 'catalog' | 'catalog_item' | 'workflow_rule' | 'conversation_node' | 'knowledge_chunk';
  status: RecordStatus;
  sourcePageStart?: number | null;
  sourcePageEnd?: number | null;
}

interface ReviewResponse {
  document: {
    documentId: string;
    documentType: DocumentType;
    displayName: string;
    status: string;
    versionNumber: number;
    totalCount: number;
    draftCount: number;
    approvedCount: number;
    rejectedCount: number;
    ready: boolean;
  };
  catalogs?: ReviewRecord[];
  records: ReviewRecord[];
}

interface KnowledgeReviewPanelProps {
  knowledgeBaseId: string;
  documentId: string;
  documentName: string;
  readOnly: boolean;
  onClose: () => void;
  onReviewUpdated: () => void;
}

type FieldKind = 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'json-object' | 'json-array';
interface ReviewField { key: string; label: string; kind: FieldKind; required?: boolean; integer?: boolean; nullable?: boolean }

const fieldsByKind: Record<ReviewRecord['kind'], ReviewField[]> = {
  faq: [
    { key: 'question', label: 'Question', kind: 'textarea', required: true },
    { key: 'answer', label: 'Answer', kind: 'textarea', required: true },
    { key: 'language', label: 'Language', kind: 'text', required: true },
    { key: 'usageDirection', label: 'Usage Direction', kind: 'select', required: true },
  ],
  catalog: [
    { key: 'catalogType', label: 'Catalog Type', kind: 'text', required: true },
    { key: 'name', label: 'Catalog Name', kind: 'text', required: true },
    { key: 'description', label: 'Description', kind: 'textarea', nullable: true },
    { key: 'defaultCurrency', label: 'Default Currency', kind: 'text', nullable: true },
  ],
  catalog_item: [
    { key: 'name', label: 'Item / Package Name', kind: 'text', required: true },
    { key: 'description', label: 'Description', kind: 'textarea', nullable: true },
    { key: 'price', label: 'Price', kind: 'number', nullable: true },
    { key: 'currency', label: 'Currency', kind: 'text', nullable: true },
    { key: 'displayOrder', label: 'Display Order', kind: 'number', integer: true },
  ],
  workflow_rule: [
    { key: 'name', label: 'Rule Name', kind: 'text', required: true },
    { key: 'intent', label: 'Intent', kind: 'text', required: true },
    { key: 'priority', label: 'Priority', kind: 'number', integer: true },
    { key: 'usageDirection', label: 'Usage Direction', kind: 'select', required: true },
    { key: 'actionType', label: 'Action Type', kind: 'text', required: true },
    { key: 'responseTemplate', label: 'Response Template', kind: 'textarea', nullable: true },
    { key: 'conditions', label: 'Conditions (JSON object)', kind: 'json-object' },
    { key: 'actionConfig', label: 'Action Configuration (JSON object)', kind: 'json-object' },
  ],
  conversation_node: [
    { key: 'flowKey', label: 'Flow Key', kind: 'text', required: true },
    { key: 'nodeKey', label: 'Node Key', kind: 'text', required: true },
    { key: 'nodeType', label: 'Node Type', kind: 'text', required: true },
    { key: 'language', label: 'Language', kind: 'text', required: true },
    { key: 'sequenceOrder', label: 'Sequence Order', kind: 'number', integer: true },
    { key: 'isEntry', label: 'Entry Node', kind: 'checkbox' },
    { key: 'content', label: 'Conversation Content', kind: 'textarea', required: true },
    { key: 'usageDirection', label: 'Usage Direction', kind: 'select', required: true },
    { key: 'variables', label: 'Variables (JSON array)', kind: 'json-array' },
    { key: 'transitions', label: 'Transitions (JSON array)', kind: 'json-array' },
  ],
  knowledge_chunk: [
    { key: 'content', label: 'Knowledge Content', kind: 'textarea', required: true },
    { key: 'usageDirection', label: 'Usage Direction', kind: 'select', required: true },
  ],
};

const statusStyle: Record<RecordStatus, string> = {
  draft: 'bg-amber-50 text-amber-700', approved: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-red-50 text-red-700', archived: 'bg-slate-100 text-slate-600',
};

function initialDraft(record: ReviewRecord) {
  const draft: Record<string, string | boolean> = {};
  for (const field of fieldsByKind[record.kind]) {
    const value = record[field.key];
    if (field.kind === 'checkbox') draft[field.key] = Boolean(value);
    else if (field.kind === 'json-object' || field.kind === 'json-array') draft[field.key] = JSON.stringify(value ?? (field.kind === 'json-array' ? [] : {}), null, 2);
    else draft[field.key] = value === null || value === undefined ? '' : String(value);
  }
  return draft;
}

function ReviewRecordCard({ record, readOnly, onChanged }: { record: ReviewRecord; readOnly: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() => initialDraft(record));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setDraft(initialDraft(record)), [record]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const payload: Record<string, unknown> = {};
      for (const field of fieldsByKind[record.kind]) {
        const value = draft[field.key];
        if (field.kind === 'checkbox') payload[field.key] = Boolean(value);
        else if (field.kind === 'number') {
          if (value === '') { if (field.nullable) payload[field.key] = null; continue; }
          const numeric = Number(value);
          if (!Number.isFinite(numeric) || (field.integer && !Number.isInteger(numeric))) throw new Error(`${field.label} must be ${field.integer ? 'a whole number' : 'a number'}.`);
          payload[field.key] = numeric;
        } else if (field.kind === 'json-object' || field.kind === 'json-array') {
          const parsed = JSON.parse(String(value || (field.kind === 'json-array' ? '[]' : '{}')));
          if (field.kind === 'json-array' && !Array.isArray(parsed)) throw new Error(`${field.label} must contain a JSON array.`);
          if (field.kind === 'json-object' && (Array.isArray(parsed) || !parsed || typeof parsed !== 'object')) throw new Error(`${field.label} must contain a JSON object.`);
          payload[field.key] = parsed;
        } else {
          const text = String(value ?? '').trim();
          if (field.required && !text) throw new Error(`${field.label} is required.`);
          payload[field.key] = !text && field.nullable ? null : text;
        }
      }
      await apiRequest(`/knowledge-bases/${String(record.knowledgeBaseId ?? '')}/documents/${String(record.documentId ?? '')}/review/${record.id}`, {
        method: 'PATCH', body: JSON.stringify(payload),
      });
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof SyntaxError ? 'A JSON field contains invalid JSON.' : requestError instanceof Error ? requestError.message : 'Review record could not be saved');
    } finally { setBusy(false); }
  };

  const decide = async (decision: 'approve' | 'reject' | 'reset') => {
    setBusy(true); setError('');
    try {
      await apiRequest(`/knowledge-bases/${String(record.knowledgeBaseId ?? '')}/documents/${String(record.documentId ?? '')}/review/${record.id}/decision`, {
        method: 'POST', body: JSON.stringify({ decision }),
      });
      await onChanged();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Review decision could not be saved'); }
    finally { setBusy(false); }
  };

  return <article className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="font-mono text-[9px] font-bold uppercase text-slate-400">{record.kind.replace(/_/g, ' ')}</span>{record.sourcePageStart && <span className="ml-2 text-[9px] font-semibold text-slate-400">Page {record.sourcePageStart}{record.sourcePageEnd && record.sourcePageEnd !== record.sourcePageStart ? `–${record.sourcePageEnd}` : ''}</span>}</div><span className={`rounded-md px-2 py-1 text-[9px] font-black uppercase ${statusStyle[record.status]}`}>{record.status}</span></div>
    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">{fieldsByKind[record.kind].map((field) => {
      const value = draft[field.key];
      const fullWidth = field.kind === 'textarea' || field.kind === 'json-object' || field.kind === 'json-array';
      return <label key={field.key} className={fullWidth ? 'md:col-span-2' : ''}><span className="mb-1 block text-[9px] font-black uppercase tracking-wider text-slate-400">{field.label}{field.required ? ' *' : ''}</span>
        {field.kind === 'textarea' || field.kind === 'json-object' || field.kind === 'json-array'
          ? <textarea value={String(value ?? '')} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} disabled={readOnly || busy} rows={field.kind === 'textarea' ? 4 : 5} className={`w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-violet-400 disabled:bg-slate-50 ${field.kind.startsWith('json') ? 'font-mono' : 'font-medium'}`} />
          : field.kind === 'select'
            ? <select value={String(value ?? 'both')} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} disabled={readOnly || busy} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold outline-none focus:border-violet-400 disabled:bg-slate-50"><option value="inbound">Inbound</option><option value="outbound">Outbound</option><option value="both">Both</option></select>
            : field.kind === 'checkbox'
              ? <input type="checkbox" checked={Boolean(value)} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.checked }))} disabled={readOnly || busy} className="h-4 w-4 rounded border-slate-300 text-violet-600" />
              : <input type={field.kind === 'number' ? 'number' : 'text'} value={String(value ?? '')} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} disabled={readOnly || busy} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold outline-none focus:border-violet-400 disabled:bg-slate-50" />}
      </label>;
    })}</div>
    {error && <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-[10px] font-semibold text-red-700"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
    {!readOnly && <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3"><button type="button" onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 px-3 py-2 text-[10px] font-bold text-violet-700 hover:bg-violet-50 disabled:opacity-50"><Save className="h-3.5 w-3.5" />Save Edit</button><button type="button" onClick={() => void decide('approve')} disabled={busy || record.status === 'approved'} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-[10px] font-bold text-white hover:bg-emerald-700 disabled:opacity-40"><CheckCircle className="h-3.5 w-3.5" />Approve</button><button type="button" onClick={() => void decide('reject')} disabled={busy || record.status === 'rejected'} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-[10px] font-bold text-white hover:bg-red-700 disabled:opacity-40"><XCircle className="h-3.5 w-3.5" />Reject</button><button type="button" onClick={() => void decide('reset')} disabled={busy || record.status === 'draft'} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-40"><RotateCcw className="h-3.5 w-3.5" />Reset</button></div>}
  </article>;
}

export function KnowledgeReviewPanel({ knowledgeBaseId, documentId, documentName, readOnly, onClose, onReviewUpdated }: KnowledgeReviewPanelProps) {
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const data = await apiRequest<ReviewResponse>(`/knowledge-bases/${knowledgeBaseId}/documents/${documentId}/review`, { zeaCache: 'bypass' });
      const attachContext = (record: ReviewRecord) => ({ ...record, knowledgeBaseId, documentId });
      setReview({ ...data, catalogs: data.catalogs?.map(attachContext), records: data.records.map(attachContext) });
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Document review could not be loaded'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [knowledgeBaseId, documentId]);
  const changed = async () => { await load(); onReviewUpdated(); };
  const records = review ? [...(review.catalogs ?? []), ...review.records] : [];

  return <section className="rounded-2xl border border-violet-200 bg-violet-50/30 p-4 sm:p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><span className="text-[10px] font-black uppercase tracking-wider text-violet-600">Developer Review</span><h4 className="mt-1 text-base font-bold text-slate-800">{documentName}</h4><p className="mt-1 text-[11px] font-medium text-slate-500">Correct extracted records, then approve or reject every draft record.</p></div><div className="flex gap-2"><button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button><button type="button" onClick={onClose} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50"><X className="h-4 w-4" /></button></div></div>
    {review && <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg border border-slate-200 bg-white p-3"><span className="text-[9px] font-black uppercase text-slate-400">Total</span><strong className="block text-lg text-slate-800">{review.document.totalCount}</strong></div><div className="rounded-lg border border-amber-200 bg-amber-50 p-3"><span className="text-[9px] font-black uppercase text-amber-600">Pending</span><strong className="block text-lg text-amber-800">{review.document.draftCount}</strong></div><div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3"><span className="text-[9px] font-black uppercase text-emerald-600">Approved</span><strong className="block text-lg text-emerald-800">{review.document.approvedCount}</strong></div><div className="rounded-lg border border-red-200 bg-red-50 p-3"><span className="text-[9px] font-black uppercase text-red-600">Rejected</span><strong className="block text-lg text-red-800">{review.document.rejectedCount}</strong></div></div>}
    {loading && !review && <div className="mt-4 space-y-3">{[1, 2].map((item) => <div key={item} className="h-40 animate-pulse rounded-xl bg-white" />)}</div>}
    {error && <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] font-semibold text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
    {!loading && !error && records.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-xs font-semibold text-slate-400">No extracted review records were returned for this document.</div>}
    {records.length > 0 && <div className="mt-4 space-y-4">{records.map((record) => <ReviewRecordCard key={record.id} record={record} readOnly={readOnly} onChanged={changed} />)}</div>}
  </section>;
}
