/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useAppState } from '../../store/AppState';
import { VoiceAgent } from '../../types';
import { apiRequest } from '../../lib/api';
import { 
  Bot, 
  Settings, 
  Brain, 
  Volume2, 
  PhoneCall, 
  FileText, 
  Wrench, 
  Database, 
  BarChart2, 
  Save, 
  CheckCircle,
  Plus,
  Trash2,
  Lock,
  Sliders,
  ChevronDown,
  Mic,
  Info,
  Sparkles,
  MessageSquare,
  Clock,
  Terminal,
  Music,
  PhoneOff,
  Globe
} from 'lucide-react';

interface AgentTabsProps {
  agentId: string | null; // null means "Create Agent"
  onSave: (agent: VoiceAgent) => void;
  onCancel: () => void;
}

interface AgentApiData {
  id: string; name: string; description: string | null; goal: string | null; language: string;
  status: 'active' | 'draft' | 'archived'; phoneNumberId: string | null; phoneNumber: string | null;
  stt: { modelId: string; providerName: string; modelName: string };
  llm: { modelId: string; providerName: string; modelName: string };
  tts: { modelId: string; providerName: string; modelName: string };
  voiceId: string; prompt: string; welcomeMessage: string | null; temperature: number;
  interruptionSensitivity: number; silenceTimeoutMs: number; inactivityTimeoutSeconds: number;
  settings: Record<string, unknown>; createdAt: string; updatedAt: string;
  metrics: { totalCalls: number; averageDurationSeconds: number; successRate: number };
}

interface ProviderModelOption {
  id: string; providerId: string; providerName: string; providerType: 'stt' | 'llm' | 'tts';
  modelKey: string; displayName: string; capabilities: Record<string, unknown>; settings: Record<string, unknown>;
}
interface AgentPhoneOption { id: string; number: string; status: string }

export function AgentTabs({ agentId, onSave, onCancel }: AgentTabsProps) {
  const { role } = useAppState();
  const isReadOnly = role === 'USER'; // Restricted view

  const [agent, setAgent] = useState<VoiceAgent>(() => {
    const base: VoiceAgent = {
      id: '',
      name: '',
      status: 'draft' as const,
      voiceId: '',
      temperature: 0.7,
      prompt: '',
      interruptionSensitivity: 0.3,
      silenceTimeout: 600,
      sttProvider: 'Deepgram Nova-2',
      ttsProvider: 'ElevenLabs Multilingual v2',
      llmModel: 'OpenAI GPT-4o',
      createdAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0],
      totalCalls: 0,
      avgDuration: 0,
      successRate: 0
    };
    return {
      ...base,
      description: base.description || '',
      goal: base.goal || '',
      language: base.language || 'English (US)',
      sttProvider: base.sttProvider || 'Sarvam',
      sttModel: base.sttModel || 'saaras:v3',
      sttMode: base.sttMode || 'verbatim',
      sttLanguage: base.sttLanguage || 'tamil (india) (ta-IN)',
      sttPunctuate: base.sttPunctuate !== undefined ? base.sttPunctuate : true,
      sttSmartFormat: base.sttSmartFormat !== undefined ? base.sttSmartFormat : true,
      sttPriceMin: base.sttPriceMin !== undefined ? base.sttPriceMin : 0.05,
      timeBasedInterruptionEnabled: base.timeBasedInterruptionEnabled !== undefined ? base.timeBasedInterruptionEnabled : true,
      wordBasedInterruptionEnabled: base.wordBasedInterruptionEnabled !== undefined ? base.wordBasedInterruptionEnabled : false,
      interruptionSensitivityLabel: base.interruptionSensitivityLabel || 'Medium (ideal for regular conversations)',
      llmProvider: base.llmProvider || 'Gemini',
      llmModel: base.llmModel || 'gemini-2.5-flash',
      greetingMode: base.greetingMode || 'Agent Initiates (Standard)',
      cachePolicy: base.cachePolicy || '24h Persistent',
      contextId: base.contextId || 'Optional',
      welcomeMessage: base.welcomeMessage || '',
      inactivityTimeout: base.inactivityTimeout !== undefined ? base.inactivityTimeout : 5,
      silentMessage: base.silentMessage || "I can't hear you.Are you still on the call?",
      ttsProvider: base.ttsProvider || 'ElevenLabs Premium',
      ttsModel: base.ttsModel || 'eleven_flash_v2_5',
      voiceId: base.voiceId || '',
      ttsAmbienceType: base.ttsAmbienceType || 'Silent (Default)',
      ttsSpeed: base.ttsSpeed !== undefined ? base.ttsSpeed : 1,
      ttsStyle: base.ttsStyle !== undefined ? base.ttsStyle : 0.4,
      ttsLanguage: base.ttsLanguage || 'ta-IN',
      ttsStability: base.ttsStability !== undefined ? base.ttsStability : 0.78,
      ttsPrice1k: base.ttsPrice1k !== undefined ? base.ttsPrice1k : 0.015,
      ttsSimilarityBoost: base.ttsSimilarityBoost !== undefined ? base.ttsSimilarityBoost : 0.75,
      pronunciationGroups: base.pronunciationGroups || [],
      preCallProvider: base.preCallProvider || 'Select Provider',
      preCallPrompt: base.preCallPrompt || '',
      preCallApiActive: base.preCallApiActive !== undefined ? base.preCallApiActive : true,
      preCallApiUrl: base.preCallApiUrl || '',
      preCallApiMethod: base.preCallApiMethod || 'POST',
      preCallApiHeaders: base.preCallApiHeaders || '',
      preCallApiRequestBody: base.preCallApiRequestBody || '{ "mobile_number": "${caller}" }',
      preCallApiResponseMappings: base.preCallApiResponseMappings || [],
      postCallPrompt: base.postCallPrompt || 'Use this to end the call when the task is complete, the user asks to hang up, is busy, unresponsive, sends to voicemail, is abusive, provides a time to call back later, or when explicitly instructed in the prompt.',
      postCallMessageType: base.postCallMessageType || 'Dynamic',
      postCallDynamicClosing: base.postCallDynamicClosing || 'The AI agent will automatically generate a natural, contextual closing message in the customer\'s language before ending the call.',
      postCallUninterruptibleReasons: base.postCallUninterruptibleReasons || [],
      postCallEndpointDetailsActive: base.postCallEndpointDetailsActive !== undefined ? base.postCallEndpointDetailsActive : true,
      postCallApiMethod: base.postCallApiMethod || 'POST',
      postCallApiUrl: base.postCallApiUrl || '',
      postCallApiHeaders: base.postCallApiHeaders || [
        { key: 'content-type', value: 'application/json' }
      ],
    };
  });

  const [activeTab, setActiveTab] = useState<'overview' | 'listener' | 'brain' | 'speaker' | 'precall' | 'postcall' | 'tools' | 'knowledge' | 'analytics'>('overview');
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<AgentPhoneOption[]>([]);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [sttModelId, setSttModelId] = useState('');
  const [llmModelId, setLlmModelId] = useState('');
  const [ttsModelId, setTtsModelId] = useState('');
  const [newReason, setNewReason] = useState('');

  const applyApiAgent = (value: AgentApiData) => {
    setAgent((current) => ({
      ...current, ...(value.settings as Partial<VoiceAgent>), id: value.id, name: value.name,
      status: value.status, description: value.description ?? '', goal: value.goal ?? '', language: value.language,
      voiceId: value.voiceId, temperature: value.temperature, prompt: value.prompt,
      interruptionSensitivity: value.interruptionSensitivity, silenceTimeout: value.silenceTimeoutMs,
      sttProvider: value.stt.providerName, sttModel: value.stt.modelName,
      llmProvider: value.llm.providerName, llmModel: value.llm.modelName,
      ttsProvider: value.tts.providerName, ttsModel: value.tts.modelName,
      welcomeMessage: value.welcomeMessage ?? '', inactivityTimeout: value.inactivityTimeoutSeconds,
      createdAt: value.createdAt, updatedAt: value.updatedAt,
      totalCalls: value.metrics.totalCalls, avgDuration: value.metrics.averageDurationSeconds, successRate: value.metrics.successRate,
    }));
    setPhoneNumberId(value.phoneNumberId ?? '');
    setSttModelId(value.stt.modelId); setLlmModelId(value.llm.modelId); setTtsModelId(value.tts.modelId);
  };

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      setLoading(true); setError('');
      try {
        const [catalogResult, phonesResult, existingResult] = await Promise.allSettled([
          apiRequest<ProviderModelOption[]>('/catalog/providers', { zeaCache: 'reload' }),
          apiRequest<AgentPhoneOption[]>('/phone-numbers'),
          agentId ? apiRequest<AgentApiData>(`/agents/${agentId}`) : Promise.resolve(null),
        ]);
        if (catalogResult.status === 'rejected') throw catalogResult.reason;
        if (existingResult.status === 'rejected') throw existingResult.reason;
        const catalog = catalogResult.value;
        const phones = phonesResult.status === 'fulfilled' ? phonesResult.value : [];
        const existing = existingResult.value;
        if (stopped) return;
        setModels(catalog); setPhoneNumbers(phones.filter((phone) => phone.status === 'active'));
        if (phonesResult.status === 'rejected') setError('Models loaded, but assigned phone numbers could not be loaded.');
        if (existing) applyApiAgent(existing);
        else {
          const stt = catalog.find((model) => model.providerType === 'stt');
          const llm = catalog.find((model) => model.providerType === 'llm');
          const tts = catalog.find((model) => model.providerType === 'tts');
          setSttModelId(stt?.id ?? ''); setLlmModelId(llm?.id ?? ''); setTtsModelId(tts?.id ?? '');
          setPhoneNumberId(phones.find((phone) => phone.status === 'active')?.id ?? '');
          setAgent((current) => ({ ...current,
            sttProvider: stt?.providerName ?? '', sttModel: stt?.displayName ?? '',
            llmProvider: llm?.providerName ?? '', llmModel: llm?.displayName ?? '',
            ttsProvider: tts?.providerName ?? '', ttsModel: tts?.displayName ?? '',
            voiceId: tts ? String(tts.settings.voiceId ?? tts.settings.voice_id ?? tts.settings.voice ?? tts.modelKey) : '',
          }));
        }
      } catch (requestError) { if (!stopped) setError(requestError instanceof Error ? requestError.message : 'Agent configuration could not be loaded'); }
      finally { if (!stopped) setLoading(false); }
    };
    void load(); return () => { stopped = true; };
  }, [agentId]);

  // Tools state
  const [tools, setTools] = useState<Array<{ id: string; name: string; type: string; status: string; description: string | null }>>([]);

  // Knowledge base state
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<Array<{ id: string; name: string; size: string; uploaded: string }>>([]);
  const [newDocName, setNewDocName] = useState('');
  const [newToolName, setNewToolName] = useState('');
  const [newToolType, setNewToolType] = useState('Webhook API');

  useEffect(() => {
    if (!agentId) { setTools([]); setKnowledgeDocuments([]); return; }
    Promise.all([
      apiRequest<Array<{ id: string; name: string; type: string; status: string; description: string | null }>>(`/agents/${agentId}/tools`),
      apiRequest<Array<{ id: string; displayName: string; sizeBytes: number; createdAt: string }>>(`/agents/${agentId}/knowledge-documents`),
    ]).then(([toolData, documentData]) => {
      setTools(toolData);
      setKnowledgeDocuments(documentData.map((document) => ({ id: document.id, name: document.displayName,
        size: `${Math.max(1, Math.round(document.sizeBytes / 1024))} KB`, uploaded: new Date(document.createdAt).toLocaleDateString() })));
    }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Agent resources could not be loaded'));
  }, [agentId]);

  const saveAgent = async () => {
    if (isReadOnly || saving) return;
    if (!sttModelId || !llmModelId || !ttsModelId) { setError('Connected STT, LLM and TTS models are required.'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        name: agent.name, description: agent.description || null, goal: agent.goal || null,
        language: agent.language || 'English (US)', status: agent.status,
        phoneNumberId: phoneNumberId || null, sttModelId, llmModelId, ttsModelId,
        voiceId: agent.voiceId, prompt: agent.prompt, welcomeMessage: agent.welcomeMessage || null,
        temperature: agent.temperature, interruptionSensitivity: agent.interruptionSensitivity,
        silenceTimeoutMs: agent.silenceTimeout, inactivityTimeoutSeconds: agent.inactivityTimeout ?? 5,
        settings: { ...agent },
      };
      const saved = await apiRequest<AgentApiData>(agentId ? `/agents/${agentId}` : '/agents', {
        method: agentId ? 'PUT' : 'POST', body: JSON.stringify(payload),
      });
      applyApiAgent(saved);
      onSave({ ...agent, id: saved.id, name: saved.name, status: saved.status, updatedAt: saved.updatedAt });
      setSuccessMsg('Agent settings saved to the company database successfully.');
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Agent could not be saved'); }
    finally { setSaving(false); }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    void saveAgent();
  };

  const addDocument = async () => {
    if (!newDocName.trim() || !agentId) return;
    try {
      const extension = newDocName.toLowerCase().split('.').pop();
      const mimeType = extension === 'pdf' ? 'application/pdf' : extension === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain';
      const created = await apiRequest<{ id: string; displayName: string; sizeBytes: number; createdAt: string }>(`/agents/${agentId}/knowledge-documents`, {
        method: 'POST', body: JSON.stringify({ displayName: newDocName, fileName: newDocName, mimeType, sizeBytes: 1, metadata: {} }),
      });
      setKnowledgeDocuments((current) => [{ id: created.id, name: created.displayName, size: 'Pending upload', uploaded: new Date(created.createdAt).toLocaleDateString() }, ...current]);
      setNewDocName('');
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Knowledge document could not be registered'); }
  };

  const addTool = async () => {
    if (!newToolName.trim() || !agentId) return;
    try {
      const typeMap: Record<string, string> = { 'Webhook API': 'webhook_api', 'Cal.com': 'calcom', Hubspot: 'hubspot', Salesforce: 'salesforce' };
      const created = await apiRequest<{ id: string; name: string; type: string; status: string; description: string | null }>(`/agents/${agentId}/tools`, {
        method: 'POST', body: JSON.stringify({ name: newToolName, type: typeMap[newToolType] ?? 'webhook_api', status: 'active', description: 'Custom integrated developer tool connector', configuration: {} }),
      });
      setTools((current) => [...current, created]); setNewToolName('');
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Agent tool could not be created'); }
  };

  const removeTool = async (id: string) => {
    if (!agentId) return;
    try { await apiRequest(`/agents/${agentId}/tools/${id}`, { method: 'DELETE' }); setTools((current) => current.filter((tool) => tool.id !== id)); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Agent tool could not be deleted'); }
  };

  const removeDocument = async (id: string) => {
    if (!agentId) return;
    try { await apiRequest(`/agents/${agentId}/knowledge-documents/${id}`, { method: 'DELETE' }); setKnowledgeDocuments((current) => current.filter((document) => document.id !== id)); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Knowledge document could not be deleted'); }
  };

  const tabsList = [
    { id: 'overview', name: 'Overview', icon: Sliders },
    { id: 'listener', name: 'Listener (STT)', icon: Settings },
    { id: 'brain', name: 'Brain (LLM)', icon: Brain },
    { id: 'speaker', name: 'Speaker (TTS)', icon: Volume2 },
    { id: 'precall', name: 'Pre-Call', icon: PhoneCall },
    { id: 'postcall', name: 'Post-Call', icon: FileText },
    { id: 'tools', name: 'Tools', icon: Wrench },
    { id: 'knowledge', name: 'Knowledge', icon: Database },
    { id: 'analytics', name: 'Analytics', icon: BarChart2 }
  ] as const;
  const sttModels = models.filter((model) => model.providerType === 'stt');
  const llmModels = models.filter((model) => model.providerType === 'llm');
  const ttsModels = models.filter((model) => model.providerType === 'tts');
  const selectedSttModel = sttModels.find((model) => model.id === sttModelId);
  const selectedLlmModel = llmModels.find((model) => model.id === llmModelId);
  const selectedTtsModel = ttsModels.find((model) => model.id === ttsModelId);
  const modelVoiceId = (model: ProviderModelOption) => {
    const configured = model.settings.voiceId ?? model.settings.voice_id ?? model.settings.voice;
    return typeof configured === 'string' && configured.trim() ? configured : model.modelKey;
  };
  const renderModelParameters = (model: ProviderModelOption | undefined) => {
    if (!model) return <div className="mt-5 rounded-xl border border-dashed border-slate-200 p-4 text-xs font-semibold text-slate-400">Select a Super Admin model to view its configuration.</div>;
    const entries = [...Object.entries(model.settings), ...Object.entries(model.capabilities).map(([key, value]) => [`capability.${key}`, value] as const)];
    return (
      <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><span className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Super Admin Model Parameters</span><span className="text-[10px] font-semibold text-slate-400">Read-only for company developers</span></div>
          <span className="rounded-md border border-indigo-100 bg-indigo-50 px-2 py-1 font-mono text-[10px] font-bold text-indigo-700">{model.modelKey}</span>
        </div>
        {entries.length ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{entries.map(([key, value]) => (
          <div key={key} className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
            <span className="block truncate text-[9px] font-black uppercase tracking-wider text-slate-400" title={key}>{key}</span>
            <span className="mt-1 block break-words font-mono text-[11px] font-semibold text-slate-700">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
          </div>
        ))}</div> : <div className="rounded-lg border border-dashed border-slate-200 bg-white p-4 text-center text-[10px] font-semibold text-slate-400">No model parameters were configured by Super Admin.</div>}
      </div>
    );
  };

  if (loading) return <div className="h-96 animate-pulse rounded-2xl border border-slate-200 bg-white p-8"><div className="h-16 rounded-xl bg-slate-200" /><div className="mt-8 h-56 rounded-xl bg-slate-100" /></div>;

  return (
    <form onSubmit={handleSave} className="bg-white rounded-2xl shadow-xs border border-slate-100 overflow-hidden">
      {/* Upper Status strip / Banner */}
      <div className="bg-gradient-to-r from-violet-600 via-indigo-600 to-pink-500 p-6 text-white flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <span className="text-xs font-bold uppercase tracking-widest text-violet-100">Voice AI Architect</span>
          <h2 className="text-2xl font-bold mt-1 tracking-tight">{agentId ? `Edit Agent: ${agent.name}` : 'Provision New Voice Agent'}</h2>
          <p className="text-xs text-violet-100/80 font-medium mt-0.5">Customize real-time listening, speech engines, prompting brains, and integrations.</p>
        </div>
        
        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl text-xs font-bold transition text-white"
          >
            Go Back
          </button>
          
          {!isReadOnly && (
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-white text-violet-700 hover:bg-slate-50 rounded-xl text-xs font-bold transition shadow-md flex items-center space-x-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? 'Saving...' : 'Save Changes'}</span>
            </button>
          )}
        </div>
      </div>

      {isReadOnly && (
        <div className="bg-amber-50 border-b border-amber-100 text-amber-800 px-6 py-2.5 text-xs font-medium flex items-center space-x-2">
          <Lock className="w-3.5 h-3.5 text-amber-600" />
          <span>You are logged in as a <strong>Company User (Restricted)</strong>. You have read-only access to agent configurations and cannot modify parameters.</span>
        </div>
      )}

      {successMsg && (
        <div className="m-6 p-4 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-xl text-xs font-medium flex items-center space-x-2 animate-in fade-in duration-200">
          <CheckCircle className="w-4 h-4 text-emerald-600" />
          <span>{successMsg}</span>
        </div>
      )}
      {error && <div className="m-6 rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-semibold text-red-700">{error}</div>}

      {/* Horizontal Scrollable Tabs Strip */}
      <div className="border-b border-slate-100 bg-slate-50/50 p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex-1 overflow-x-auto scrollbar-none py-1">
            <div className="bg-[#f1f5f9] rounded-full p-1 flex items-center gap-1 w-max">
              {tabsList.map((t) => {
                const Icon = t.icon;
                const isActive = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={`flex items-center space-x-1.5 px-4 py-2 rounded-full text-xs font-bold transition flex-shrink-0 cursor-pointer ${
                      isActive 
                        ? 'bg-white text-slate-800 shadow-sm border border-slate-200/50 font-black' 
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                    id={`agent-tab-${t.id}`}
                  >
                    <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-[#ec4899]' : 'text-slate-400'}`} />
                    <span>{t.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

        </div>
      </div>

      {/* Tab Panel contents */}
      <div className="p-8 bg-slate-50/30">
        {/* TAB: OVERVIEW */}
        {activeTab === 'overview' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            {/* Agent Identity Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-pink-50/40 p-5 border-b border-pink-100/50 flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center border border-pink-200/50">
                  <Sliders className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Agent Identity</h3>
                  <p className="text-xs text-slate-500 font-semibold">Basic information about your agent.</p>
                </div>
              </div>
              
              <div className="p-6 space-y-6">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Agent Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={agent.name}
                    disabled={isReadOnly}
                    onChange={(e) => setAgent({ ...agent, name: e.target.value })}
                    className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                    placeholder="e.g. Shanmuga_test packages-Inbound"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Description
                  </label>
                  <textarea
                    rows={4}
                    value={agent.description || ''}
                    disabled={isReadOnly}
                    onChange={(e) => setAgent({ ...agent, description: e.target.value })}
                    className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                    placeholder="Provide a detailed description of what the agent does..."
                  />
                </div>

                <div>
                  <div className="flex items-center space-x-1.5 mb-1.5">
                    <label className="block text-xs font-bold text-slate-600 uppercase tracking-wide">
                      Agent Goal <span className="text-pink-500">*</span>
                    </label>
                    <div className="w-4 h-4 rounded-full bg-pink-100 text-pink-600 flex items-center justify-center text-[10px] font-extrabold cursor-help" title="The primary objectives or goals this agent is set up to achieve during phone conversations.">
                      ?
                    </div>
                  </div>
                  <textarea
                    rows={4}
                    required
                    value={agent.goal || ''}
                    disabled={isReadOnly}
                    onChange={(e) => setAgent({ ...agent, goal: e.target.value })}
                    className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                    placeholder="What is the ultimate objective of the agent?"
                  />
                  <p className="text-[11px] text-slate-400 mt-2 font-medium leading-relaxed">
                    This is used as the <span className="italic font-bold text-slate-500">'North Star'</span> for evaluations. The detailed <span className="font-bold text-slate-500">Golden Script</span> is configured in the <span className="text-pink-500 font-bold underline cursor-pointer hover:text-pink-600" onClick={() => setActiveTab('analytics')}>Analytics Tab</span>.
                  </p>
                </div>
              </div>
            </div>

            {/* Configuration Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-slate-50/55 p-5 border-b border-slate-100">
                <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Configuration</h3>
              </div>
              
              <div className="p-6 space-y-5">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Language <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <select
                      value={agent.language || 'English (US)'}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, language: e.target.value })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                    >
                      <option value="English (US)">English (US)</option>
                      <option value="English (UK)">English (UK)</option>
                      <option value="Spanish (LatAm)">Spanish (LatAm)</option>
                      <option value="French (France)">French (France)</option>
                      <option value="German (Germany)">German (Germany)</option>
                      <option value="Hindi (India)">Hindi (India)</option>
                      <option value="Tamil (India)">Tamil (India)</option>
                      <option value="Telugu (India)">Telugu (India)</option>
                      <option value="Kannada (India)">Kannada (India)</option>
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5 uppercase tracking-wide">Assigned Phone Number</label>
                  <select value={phoneNumberId} disabled={isReadOnly} onChange={(event) => setPhoneNumberId(event.target.value)} className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 outline-none">
                    <option value="">No inbound number</option>
                    {phoneNumbers.map((phone) => <option key={phone.id} value={phone.id}>{phone.number}</option>)}
                  </select>
                  <p className="mt-1 text-[10px] text-slate-400">Only numbers assigned to this company are available.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB: LISTENER */}
        {activeTab === 'listener' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            {/* Speech to Text Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-pink-50/40 p-5 border-b border-pink-100/50 flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center border border-pink-200/50">
                  <Mic className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Speech to Text</h3>
                  <p className="text-xs text-slate-500 font-semibold">Configure speech recognition and processing settings.</p>
                </div>
              </div>
              
              <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* STT Provider dropdown */}
                  <div>
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider flex items-center">
                      STT PROVIDER <span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <select
                        value={agent.sttProvider}
                        disabled
                        className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                      >
                        <option value={selectedSttModel?.providerName ?? agent.sttProvider}>{(selectedSttModel?.providerName ?? agent.sttProvider) || 'Select a model below'}</option>
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    </div>
                  </div>

                  {/* Model dropdown */}
                  <div>
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider flex items-center">
                      MODEL / LANGUAGE MODEL <span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <select
                        value={sttModelId}
                        disabled={isReadOnly}
                        onChange={(e) => { const model = sttModels.find((item) => item.id === e.target.value); setSttModelId(e.target.value); if (model) setAgent({ ...agent, sttProvider: model.providerName, sttModel: model.displayName }); }}
                        className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                      >
                        <option value="" disabled>Select an STT model</option>
                        {sttModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.providerName}</option>)}
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                </div>

                {renderModelParameters(selectedSttModel)}
              </div>
            </div>

            {/* Interruption (Time Based) Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-start space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-pink-50 text-[#ec4899] flex items-center justify-center border border-pink-100/50 flex-shrink-0">
                      <Sparkles className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-extrabold text-slate-800 tracking-tight flex items-center gap-1">
                        Interruption (Time Based)
                      </h4>
                      <p className="text-xs text-slate-500 font-medium">Configure agent's interruption behaviour.</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isReadOnly}
                    onClick={() => setAgent({ ...agent, timeBasedInterruptionEnabled: !agent.timeBasedInterruptionEnabled })}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      agent.timeBasedInterruptionEnabled ? 'bg-[#ec4899]' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        agent.timeBasedInterruptionEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {agent.timeBasedInterruptionEnabled && (
                  <div className="mt-6 pt-6 border-t border-slate-100">
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                      SENSITIVITY
                    </label>
                    <div className="relative">
                      <select
                        value={agent.interruptionSensitivityLabel || 'Medium (ideal for regular conversations)'}
                        disabled={isReadOnly}
                        onChange={(e) => setAgent({ ...agent, interruptionSensitivityLabel: e.target.value })}
                        className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                      >
                        <option value="Low (agent rarely gets interrupted by background noise)">Low (agent rarely gets interrupted by background noise)</option>
                        <option value="Medium (ideal for regular conversations)">Medium (ideal for regular conversations)</option>
                        <option value="High (agent stops speaking instantly at any user sound)">High (agent stops speaking instantly at any user sound)</option>
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Interruption (Word Based) Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-start space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-pink-50 text-[#ec4899] flex items-center justify-center border border-pink-100/50 flex-shrink-0">
                      <Sparkles className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-extrabold text-slate-800 tracking-tight flex items-center gap-1">
                        Interruption (Word Based)
                      </h4>
                      <p className="text-xs text-slate-500 font-medium">Configure whether the agent can be interrupted by speaking a minimum number of words.</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isReadOnly}
                    onClick={() => setAgent({ ...agent, wordBasedInterruptionEnabled: !agent.wordBasedInterruptionEnabled })}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      agent.wordBasedInterruptionEnabled ? 'bg-[#ec4899]' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        agent.wordBasedInterruptionEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB: BRAIN */}
        {activeTab === 'brain' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            {/* Model Configuration Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              {/* Header with Save Model button */}
              <div className="bg-pink-50/40 p-5 border-b border-pink-100/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center border border-pink-200/50">
                    <Brain className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Model Configuration</h3>
                    <p className="text-xs text-slate-500 font-semibold">Define the core AI models and reasoning logic.</p>
                  </div>
                </div>
                
                <button
                  type="button"
                  disabled={isReadOnly}
                  onClick={() => void saveAgent()}
                  className="flex items-center space-x-1.5 px-4 py-2 border border-[#ec4899] text-[#ec4899] hover:bg-pink-50 rounded-xl text-xs font-black transition cursor-pointer self-start sm:self-auto shadow-2xs"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Model</span>
                </button>
              </div>

              {/* Grid with LLM settings on left and Interaction Settings on right */}
              <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 space-y-6">
                  {/* LLM Provider */}
                  <div>
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider flex items-center">
                      LLM PROVIDER <span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <select
                        value={agent.llmProvider || ''}
                        disabled
                        className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                      >
                        <option value={selectedLlmModel?.providerName ?? agent.llmProvider}>{(selectedLlmModel?.providerName ?? agent.llmProvider) || 'Select a model below'}</option>
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    </div>
                  </div>

                  {/* AI Model */}
                  <div>
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider flex items-center">
                      AI MODEL <span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <select
                        value={llmModelId}
                        disabled={isReadOnly}
                        onChange={(e) => { const model = llmModels.find((item) => item.id === e.target.value); setLlmModelId(e.target.value); if (model) setAgent({ ...agent, llmProvider: model.providerName, llmModel: model.displayName }); }}
                        className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                      >
                        <option value="" disabled>Select an LLM model</option>
                        {llmModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.providerName}</option>)}
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Interaction Settings Card */}
                <div className="lg:col-span-5 bg-white border border-slate-100 rounded-2xl p-5 shadow-2xs hover:border-pink-100 transition relative">
                  <div className="flex items-center space-x-1.5 text-[#ec4899] mb-4">
                    <Sparkles className="w-4 h-4" />
                    <span className="text-xs font-black uppercase tracking-wider">Interaction Settings</span>
                  </div>

                  <div className="space-y-4">
                    {/* Greeting Mode */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Greeting Mode</label>
                      <div className="relative">
                        <select
                          value={agent.greetingMode || 'Agent Initiates (Standard)'}
                          disabled={isReadOnly}
                          onChange={(e) => setAgent({ ...agent, greetingMode: e.target.value })}
                          className="w-full bg-slate-50 border border-slate-200 focus:border-pink-500 rounded-xl px-3 py-2.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-8"
                        >
                          <option value="Agent Initiates (Standard)">Agent Initiates (Standard)</option>
                          <option value="User Initiates">User Initiates</option>
                        </select>
                        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                          <ChevronDown className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    </div>

                    {/* Cache Policy & Context ID in two cols */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Cache Policy</label>
                        <div className="relative">
                          <select
                            value={agent.cachePolicy || '24h Persistent'}
                            disabled={isReadOnly}
                            onChange={(e) => setAgent({ ...agent, cachePolicy: e.target.value })}
                            className="w-full bg-slate-50 border border-slate-200 focus:border-pink-500 rounded-xl px-3 py-2.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-8"
                          >
                            <option value="24h Persistent">24h Persistent</option>
                            <option value="Session Only">Session Only</option>
                            <option value="Disabled">Disabled</option>
                          </select>
                          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                            <ChevronDown className="w-3.5 h-3.5" />
                          </div>
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Context ID</label>
                        <input
                          type="text"
                          value={agent.contextId || ''}
                          placeholder="Optional"
                          disabled={isReadOnly}
                          onChange={(e) => setAgent({ ...agent, contextId: e.target.value })}
                          className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-pink-500 rounded-xl px-3 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="px-6 pb-6">{renderModelParameters(selectedLlmModel)}</div>
            </div>

            {/* Welcome Message Section */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs p-6 space-y-4">
              <div className="flex items-center space-x-2">
                <MessageSquare className="w-4 h-4 text-[#ec4899]" />
                <h4 className="text-sm font-extrabold text-slate-800 tracking-tight">Welcome Message</h4>
              </div>

              {/* Purple input buffer header */}
              <div className="rounded-xl overflow-hidden border border-violet-100">
                <div className="bg-[#e0e7ff]/60 px-4 py-2 border-b border-violet-100 flex items-center justify-between">
                  <span className="text-[10px] font-black text-[#4f46e5] uppercase tracking-widest">Input Buffer</span>
                  <Sliders className="w-3.5 h-3.5 text-[#4f46e5]" />
                </div>
                <textarea
                  rows={3}
                  value={agent.welcomeMessage || ''}
                  disabled={isReadOnly}
                  onChange={(e) => setAgent({ ...agent, welcomeMessage: e.target.value })}
                  className="w-full bg-white p-4 text-xs font-semibold text-slate-800 outline-none resize-y transition focus:ring-1 focus:ring-[#ec4899]/30"
                  placeholder="Welcome sentence when user joins the call..."
                />
              </div>
            </div>

            {/* Silent Message Section */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4 text-[#ec4899]" />
                  <h4 className="text-sm font-extrabold text-slate-800 tracking-tight">Silent Message</h4>
                </div>

                <div className="flex items-center space-x-2">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Inactivity Timeout (s)</span>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={agent.inactivityTimeout !== undefined ? agent.inactivityTimeout : 5}
                    disabled={isReadOnly}
                    onChange={(e) => setAgent({ ...agent, inactivityTimeout: parseInt(e.target.value) || 5 })}
                    className="w-16 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-bold text-center text-slate-800 outline-none focus:border-pink-500 transition"
                  />
                </div>
              </div>

              {/* Orange/Yellow Banner for Hidden Context */}
              <div className="rounded-xl overflow-hidden border border-amber-100">
                <div className="bg-amber-50 px-4 py-2 border-b border-amber-100 flex items-center justify-between">
                  <span className="text-[10px] font-black text-amber-700 uppercase tracking-widest flex items-center gap-1.5">
                    <Lock className="w-3 h-3" />
                    Hidden Context
                  </span>
                  <div className="w-3.5 h-3.5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-[10px]" title="Instructions sent to the model to handle user silence.">
                    ?
                  </div>
                </div>
                <textarea
                  rows={3}
                  value={agent.silentMessage || ''}
                  disabled={isReadOnly}
                  onChange={(e) => setAgent({ ...agent, silentMessage: e.target.value })}
                  className="w-full bg-white p-4 text-xs font-semibold text-slate-800 outline-none resize-y transition focus:ring-1 focus:ring-[#ec4899]/30"
                  placeholder="e.g. I can't hear you. Are you still on the call?"
                />
              </div>
            </div>

            {/* System Prompt / Instructions Section */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs p-6 space-y-4">
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-[#ec4899]" />
                <h4 className="text-sm font-extrabold text-slate-800 tracking-tight">System Prompt / Instructions</h4>
              </div>

              {/* Terminal code header style */}
              <div className="rounded-xl overflow-hidden border border-slate-200 shadow-sm">
                <div className="bg-[#f8fafc] px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <div className="w-3 h-3 rounded-full bg-red-400" />
                    <div className="w-3 h-3 rounded-full bg-yellow-400" />
                    <div className="w-3 h-3 rounded-full bg-green-400" />
                    <span className="text-xs font-extrabold text-slate-500 font-mono ml-2">CORE_DIRECTIVE.PY</span>
                  </div>
                </div>
                <textarea
                  rows={10}
                  value={agent.prompt}
                  disabled={isReadOnly}
                  onChange={(e) => setAgent({ ...agent, prompt: e.target.value })}
                  className="w-full bg-slate-950 p-5 text-xs text-[#38bdf8] font-mono leading-relaxed outline-none resize-y"
                  placeholder="Define the core system instructions and guidelines for your AI voice agent here..."
                />
              </div>
            </div>
          </div>
        )}

        {/* TAB: SPEAKER */}
        {activeTab === 'speaker' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            {/* Voice Configuration Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-pink-50/40 p-5 border-b border-pink-100/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center border border-pink-200/50">
                    <Volume2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Voice Configuration</h3>
                    <p className="text-xs text-slate-500 font-semibold">Configure the voice identity and speech synthesis settings.</p>
                  </div>
                </div>
                
                <button
                  type="button"
                  disabled={isReadOnly}
                  onClick={() => void saveAgent()}
                  className="flex items-center space-x-1.5 px-4 py-2 border border-[#ec4899] text-[#ec4899] hover:bg-pink-50 rounded-xl text-xs font-black transition cursor-pointer self-start sm:self-auto shadow-2xs"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Voice</span>
                </button>
              </div>

              <div className="p-6 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Provider Dropdown */}
                  <div>
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider flex items-center">
                      PROVIDER <span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <select
                        value={agent.ttsProvider || ''}
                        disabled
                        className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                      >
                        <option value={selectedTtsModel?.providerName ?? agent.ttsProvider}>{(selectedTtsModel?.providerName ?? agent.ttsProvider) || 'Select a model below'}</option>
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    </div>
                  </div>

                  {/* Model Dropdown */}
                  <div>
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider flex items-center">
                      MODEL <span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <select
                        value={ttsModelId}
                        disabled={isReadOnly}
                        onChange={(e) => { const model = ttsModels.find((item) => item.id === e.target.value); setTtsModelId(e.target.value); if (model) setAgent({ ...agent, ttsProvider: model.providerName, ttsModel: model.displayName, voiceId: modelVoiceId(model) }); }}
                        className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                      >
                        <option value="" disabled>Select a TTS model</option>
                        {ttsModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.providerName}</option>)}
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    </div>
                  </div>

                  {/* Voice configured by Super Admin */}
                  <div>
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider flex items-center">
                      CONFIGURED VOICE
                    </label>
                    <input value={selectedTtsModel ? modelVoiceId(selectedTtsModel) : ''} readOnly
                      placeholder="Select a TTS model"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-xs font-semibold text-slate-700 outline-none" />
                  </div>
                </div>

                {renderModelParameters(selectedTtsModel)}

                {/* Pronunciation / Punctuation Groups */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-2 uppercase tracking-wider">
                    PRONUNCIATION / PUNCTUATION GROUPS
                  </label>
                  
                  <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-2 shadow-2xs hover:border-pink-200 transition">
                    {(!agent.pronunciationGroups || agent.pronunciationGroups.length === 0) ? (
                      <span className="text-xs font-bold text-slate-400 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100">
                        No groups selected
                      </span>
                    ) : (
                      agent.pronunciationGroups.map((group, idx) => (
                        <span key={idx} className="text-xs font-bold text-[#ec4899] bg-pink-50 border border-pink-100 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
                          {group}
                          {!isReadOnly && (
                            <button
                              type="button"
                              onClick={() => {
                                const updated = (agent.pronunciationGroups || []).filter((_, i) => i !== idx);
                                setAgent({ ...agent, pronunciationGroups: updated });
                              }}
                              className="text-pink-400 hover:text-pink-600 font-extrabold focus:outline-none"
                            >
                              &times;
                            </button>
                          )}
                        </span>
                      ))
                    )}

                    {!isReadOnly && (
                      <button
                        type="button"
                        onClick={() => {
                          const name = prompt("Enter custom pronunciation group name:");
                          if (name && name.trim()) {
                            const updated = [...(agent.pronunciationGroups || []), name.trim()];
                            setAgent({ ...agent, pronunciationGroups: updated });
                          }
                        }}
                        className="w-7 h-7 rounded-full bg-slate-100 hover:bg-pink-100 text-slate-500 hover:text-pink-600 flex items-center justify-center border border-slate-200 hover:border-pink-200 transition cursor-pointer"
                        title="Add pronunciation group"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <span className="text-[10px] font-semibold text-slate-400 mt-1.5 block">
                    Select multiple rule sets for custom word pronunciations.
                  </span>
                </div>
              </div>
            </div>

            {/* Split row for Background Sound and Provider Settings */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Background Sound Card */}
              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
                <div>
                  <div className="flex items-center space-x-2 text-[#ec4899] mb-5">
                    <Music className="w-5 h-5" />
                    <span className="text-xs font-black uppercase tracking-wider">Background Sound</span>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Ambience Type</label>
                    <div className="relative">
                      <select
                        value={agent.ttsAmbienceType || 'Silent (Default)'}
                        disabled={isReadOnly}
                        onChange={(e) => setAgent({ ...agent, ttsAmbienceType: e.target.value })}
                        className="w-full bg-slate-50 border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                      >
                        <option value="Silent (Default)">Silent (Default)</option>
                        <option value="Office Chatter">Office Chatter</option>
                        <option value="Coffee Shop Ambient">Coffee Shop Ambient</option>
                        <option value="Gentle Rain">Gentle Rain</option>
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Provider Settings Card */}
              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs">
                <div className="flex items-center space-x-2 text-[#ec4899] mb-5 font-bold uppercase tracking-wider">
                  <Sliders className="w-5 h-5 text-[#ec4899]" />
                  <span className="text-xs font-black uppercase tracking-wider text-[#ec4899]">Provider Settings</span>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Speed */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Speed</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0.5"
                      max="2.0"
                      value={agent.ttsSpeed !== undefined ? agent.ttsSpeed : 1}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, ttsSpeed: parseFloat(e.target.value) || 1 })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-bold text-slate-800 outline-none transition"
                    />
                  </div>

                  {/* Style */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Style</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1.0"
                      value={agent.ttsStyle !== undefined ? agent.ttsStyle : 0.4}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, ttsStyle: parseFloat(e.target.value) || 0 })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-bold text-slate-800 outline-none transition"
                    />
                  </div>

                  {/* Language */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Language</label>
                    <input
                      type="text"
                      value={agent.ttsLanguage || 'ta-IN'}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, ttsLanguage: e.target.value })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-bold text-slate-800 outline-none transition"
                    />
                  </div>

                  {/* Stability */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Stability</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1.0"
                      value={agent.ttsStability !== undefined ? agent.ttsStability : 0.78}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, ttsStability: parseFloat(e.target.value) || 0 })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-bold text-slate-800 outline-none transition"
                    />
                  </div>

                  {/* Tts Price 1k */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Tts Price 1k</label>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={agent.ttsPrice1k !== undefined ? agent.ttsPrice1k : 0.015}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, ttsPrice1k: parseFloat(e.target.value) || 0 })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-bold text-slate-800 outline-none transition"
                    />
                  </div>

                  {/* Similarity Boost */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Similarity Boost</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1.0"
                      value={agent.ttsSimilarityBoost !== undefined ? agent.ttsSimilarityBoost : 0.75}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, ttsSimilarityBoost: parseFloat(e.target.value) || 0 })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-bold text-slate-800 outline-none transition"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB: PRECALL */}
        {activeTab === 'precall' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            {/* PreCall Settings Header Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-pink-50/40 p-5 border-b border-pink-100/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center border border-pink-200/50">
                    <PhoneCall className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-slate-800 tracking-tight">PreCall Settings</h3>
                    <p className="text-xs text-slate-500 font-semibold">Configure pre-call actions and logic.</p>
                  </div>
                </div>
                
                <button
                  type="button"
                  disabled={isReadOnly}
                  onClick={() => void saveAgent()}
                  className="flex items-center space-x-1.5 px-4 py-2 border border-[#ec4899] text-[#ec4899] hover:bg-pink-50 rounded-xl text-xs font-black transition cursor-pointer self-start sm:self-auto shadow-2xs"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save PreCall</span>
                </button>
              </div>

              <div className="p-6 space-y-6">
                {/* Provider Dropdown */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    Provider
                  </label>
                  <div className="relative">
                    <select
                      value={agent.preCallProvider || 'Select Provider'}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, preCallProvider: e.target.value })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                    >
                      <option value="Select Provider">Select Provider</option>
                      <option value="n8n Webhook">n8n Webhook</option>
                      <option value="Make.com">Make.com</option>
                      <option value="Zapier">Zapier</option>
                      <option value="Custom API">Custom API</option>
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                </div>

                {/* Prompt Field */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    Prompt
                  </label>
                  <textarea
                    rows={4}
                    disabled={isReadOnly}
                    value={agent.preCallPrompt || ''}
                    onChange={(e) => setAgent({ ...agent, preCallPrompt: e.target.value })}
                    placeholder="Enter PreCall prompt..."
                    className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-2xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                  />
                </div>

                {/* Pre-Call API Toggle & Fields */}
                <div className="border-t border-slate-100 pt-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-black text-slate-700 uppercase tracking-wider">Pre-Call API</h4>
                      <p className="text-[10px] text-slate-400 font-semibold">Enable API execution prior to connecting the call.</p>
                    </div>
                    <div className="flex items-center space-x-2.5">
                      <button
                        type="button"
                        disabled={isReadOnly}
                        onClick={() => setAgent({ ...agent, preCallApiActive: !agent.preCallApiActive })}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          agent.preCallApiActive ? 'bg-[#ec4899]' : 'bg-slate-200'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                            agent.preCallApiActive ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                      <span className={`text-xs font-bold ${agent.preCallApiActive ? 'text-[#ec4899]' : 'text-slate-400'}`}>
                        {agent.preCallApiActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>

                  {agent.preCallApiActive && (
                    <div className="bg-slate-50/50 border border-slate-150 rounded-2xl p-5 space-y-5">
                      {/* API URL and Method */}
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div className="md:col-span-3">
                          <label className="block text-[10px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                            API URL
                          </label>
                          <input
                            type="text"
                            value={agent.preCallApiUrl || ''}
                            disabled={isReadOnly}
                            onChange={(e) => setAgent({ ...agent, preCallApiUrl: e.target.value })}
                            placeholder="https://api.example.com/endpoint"
                            className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                            Method
                          </label>
                          <div className="relative">
                            <select
                              value={agent.preCallApiMethod || 'POST'}
                              disabled={isReadOnly}
                              onChange={(e) => setAgent({ ...agent, preCallApiMethod: e.target.value })}
                              className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                            >
                              <option value="POST">POST</option>
                              <option value="GET">GET</option>
                              <option value="PUT">PUT</option>
                              <option value="DELETE">DELETE</option>
                            </select>
                            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                              <ChevronDown className="w-3.5 h-3.5" />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Headers */}
                      <div>
                        <label className="block text-[10px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                          Headers
                        </label>
                        <input
                          type="text"
                          value={agent.preCallApiHeaders || ''}
                          disabled={isReadOnly}
                          onChange={(e) => setAgent({ ...agent, preCallApiHeaders: e.target.value })}
                          placeholder='{ "Authorization": "Bearer token" }'
                          className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                        />
                      </div>

                      {/* Request Body */}
                      <div>
                        <label className="block text-[10px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                          Request Body
                        </label>
                        <input
                          type="text"
                          value={agent.preCallApiRequestBody || ''}
                          disabled={isReadOnly}
                          onChange={(e) => setAgent({ ...agent, preCallApiRequestBody: e.target.value })}
                          placeholder='{ "mobile_number": "${caller}" }'
                          className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                        />
                      </div>

                      {/* Response Mapping */}
                      <div className="space-y-3">
                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider">
                          Response Mapping
                        </label>

                        <div className="space-y-2">
                          {(!agent.preCallApiResponseMappings || agent.preCallApiResponseMappings.length === 0) ? (
                            <div className="text-xs font-bold text-slate-400 bg-white border border-slate-200 rounded-xl p-4 text-center">
                              No response mappings defined yet.
                            </div>
                          ) : (
                            agent.preCallApiResponseMappings.map((mapping, idx) => (
                              <div key={idx} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 bg-white border border-slate-200 rounded-xl p-3 shadow-2xs">
                                <div className="flex-1">
                                  <label className="block text-[8px] font-black text-slate-400 uppercase mb-0.5">Variable Key</label>
                                  <input
                                    type="text"
                                    value={mapping.key}
                                    disabled={isReadOnly}
                                    onChange={(e) => {
                                      const updated = [...(agent.preCallApiResponseMappings || [])];
                                      updated[idx].key = e.target.value;
                                      setAgent({ ...agent, preCallApiResponseMappings: updated });
                                    }}
                                    placeholder="e.g. first_name"
                                    className="w-full bg-transparent border-none p-0 text-xs font-bold text-slate-800 outline-none focus:ring-0"
                                  />
                                </div>
                                <div className="hidden sm:block h-6 w-px bg-slate-150" />
                                <div className="flex-1">
                                  <label className="block text-[8px] font-black text-slate-400 uppercase mb-0.5">JSON Path</label>
                                  <input
                                    type="text"
                                    value={mapping.path}
                                    disabled={isReadOnly}
                                    onChange={(e) => {
                                      const updated = [...(agent.preCallApiResponseMappings || [])];
                                      updated[idx].path = e.target.value;
                                      setAgent({ ...agent, preCallApiResponseMappings: updated });
                                    }}
                                    placeholder="e.g. $.data.name"
                                    className="w-full bg-transparent border-none p-0 text-xs font-bold text-slate-800 outline-none focus:ring-0"
                                  />
                                </div>
                                {!isReadOnly && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const updated = (agent.preCallApiResponseMappings || []).filter((_, i) => i !== idx);
                                      setAgent({ ...agent, preCallApiResponseMappings: updated });
                                    }}
                                    className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition self-end sm:self-auto"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            ))
                          )}
                        </div>

                        {!isReadOnly && (
                          <button
                            type="button"
                            onClick={() => {
                              const updated = [...(agent.preCallApiResponseMappings || []), { key: '', path: '' }];
                              setAgent({ ...agent, preCallApiResponseMappings: updated });
                            }}
                            className="flex items-center space-x-1.5 px-4 py-2 border border-[#ec4899] text-[#ec4899] hover:bg-pink-50 rounded-xl text-xs font-black transition cursor-pointer shadow-2xs"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Add Response</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB: POSTCALL */}
        {activeTab === 'postcall' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            {/* Post Call Configuration Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs animate-fade-in">
              <div className="bg-pink-50/40 p-5 border-b border-pink-100/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center border border-pink-200/50">
                    <PhoneOff className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Post Call Configuration</h3>
                    <p className="text-xs text-slate-500 font-semibold">Define how the AI agent should end conversations.</p>
                  </div>
                </div>
                
                <button
                  type="button"
                  disabled={isReadOnly}
                  onClick={() => void saveAgent()}
                  className="flex items-center space-x-1.5 px-4 py-2 border border-[#ec4899] text-[#ec4899] hover:bg-pink-50 rounded-xl text-xs font-black transition cursor-pointer self-start sm:self-auto shadow-2xs"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Post Call</span>
                </button>
              </div>

              <div className="p-6 space-y-6">
                {/* Prompt textarea */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    Prompt
                  </label>
                  <textarea
                    rows={4}
                    disabled={isReadOnly}
                    value={agent.postCallPrompt || ''}
                    onChange={(e) => setAgent({ ...agent, postCallPrompt: e.target.value })}
                    placeholder="Enter PostCall prompt..."
                    className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-2xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                  />
                </div>

                {/* Message Type Dropdown */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    Message Type
                  </label>
                  <div className="relative">
                    <select
                      value={agent.postCallMessageType || 'Dynamic'}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, postCallMessageType: e.target.value })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                    >
                      <option value="Dynamic">Dynamic</option>
                      <option value="Static">Static</option>
                      <option value="None">None</option>
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                </div>

                {/* AI Dynamic Closing */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    AI Dynamic Closing
                  </label>
                  <input
                    type="text"
                    disabled
                    value={agent.postCallDynamicClosing || ''}
                    className="w-full bg-slate-50 border border-slate-150 rounded-xl px-4 py-3 text-xs font-semibold text-slate-500 outline-none"
                  />
                </div>

                {/* Uninterruptible Reasons */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    Uninterruptible Reasons
                  </label>
                  
                  <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs hover:border-pink-200 transition">
                    <div className="flex flex-wrap items-center gap-2">
                      {(!agent.postCallUninterruptibleReasons || agent.postCallUninterruptibleReasons.length === 0) ? (
                        <span className="text-xs font-bold text-slate-400 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100">
                          No uninterruptible reasons listed yet.
                        </span>
                      ) : (
                        agent.postCallUninterruptibleReasons.map((reason, idx) => (
                          <span key={idx} className="text-xs font-bold text-[#ec4899] bg-pink-50 border border-pink-100 px-3 py-1.5 rounded-lg flex items-center gap-1.5 animate-fade-in">
                            {reason}
                            {!isReadOnly && (
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = (agent.postCallUninterruptibleReasons || []).filter((_, i) => i !== idx);
                                  setAgent({ ...agent, postCallUninterruptibleReasons: updated });
                                }}
                                className="text-pink-400 hover:text-pink-600 font-extrabold focus:outline-none"
                              >
                                &times;
                              </button>
                            )}
                          </span>
                        ))
                      )}
                    </div>

                    {!isReadOnly && (
                      <div className="relative flex items-center">
                        <input
                          type="text"
                          placeholder="Add reason"
                          value={newReason}
                          onChange={(e) => setNewReason(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (newReason.trim()) {
                                const updated = [...(agent.postCallUninterruptibleReasons || []), newReason.trim()];
                                setAgent({ ...agent, postCallUninterruptibleReasons: updated });
                                setNewReason('');
                              }
                            }
                          }}
                          className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl pl-4 pr-12 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (newReason.trim()) {
                              const updated = [...(agent.postCallUninterruptibleReasons || []), newReason.trim()];
                              setAgent({ ...agent, postCallUninterruptibleReasons: updated });
                              setNewReason('');
                            }
                          }}
                          className="absolute right-2 w-8 h-8 rounded-full bg-pink-500 hover:bg-pink-600 text-white flex items-center justify-center transition cursor-pointer shadow-sm"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                    <span className="text-[10px] font-semibold text-slate-400 block">
                      Press Enter or click + to add reason
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Endpoint Details Section Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-[#ec4899]">
                  <Globe className="w-5 h-5" />
                  <span className="text-xs font-black uppercase tracking-wider">Endpoint Details</span>
                </div>
                
                <div className="flex items-center space-x-2.5">
                  <button
                    type="button"
                    disabled={isReadOnly}
                    onClick={() => setAgent({ ...agent, postCallEndpointDetailsActive: !agent.postCallEndpointDetailsActive })}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      agent.postCallEndpointDetailsActive ? 'bg-[#ec4899]' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        agent.postCallEndpointDetailsActive ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                  <span className={`text-xs font-bold ${agent.postCallEndpointDetailsActive ? 'text-[#ec4899]' : 'text-slate-400'}`}>
                    {agent.postCallEndpointDetailsActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>

              {agent.postCallEndpointDetailsActive && (
                <div className="space-y-6 border-t border-slate-100 pt-6 animate-fade-in">
                  {/* Method & URL Input row */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-[10px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                        Method
                      </label>
                      <div className="relative">
                        <select
                          value={agent.postCallApiMethod || 'POST'}
                          disabled={isReadOnly}
                          onChange={(e) => setAgent({ ...agent, postCallApiMethod: e.target.value })}
                          className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                        >
                          <option value="POST">POST</option>
                          <option value="GET">GET</option>
                          <option value="PUT">PUT</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                          <ChevronDown className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-[10px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                        Endpoint URL
                      </label>
                      <input
                        type="text"
                        value={agent.postCallApiUrl || ''}
                        disabled={isReadOnly}
                        onChange={(e) => setAgent({ ...agent, postCallApiUrl: e.target.value })}
                        placeholder="https://api.example.com/endpoint"
                        className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                      />
                    </div>
                  </div>

                  {/* Headers List */}
                  <div className="space-y-3">
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider">
                      Headers
                    </label>

                    <div className="space-y-2">
                      {(!agent.postCallApiHeaders || agent.postCallApiHeaders.length === 0) ? (
                        <div className="text-xs font-bold text-slate-400 bg-white border border-slate-200 rounded-xl p-4 text-center">
                          No custom headers defined.
                        </div>
                      ) : (
                        agent.postCallApiHeaders.map((header, idx) => (
                          <div key={idx} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 bg-white border border-slate-200 rounded-xl p-3 shadow-2xs">
                            <div className="flex-1">
                              <label className="block text-[8px] font-black text-slate-400 uppercase mb-0.5">Header Name</label>
                              <input
                                type="text"
                                value={header.key}
                                disabled={isReadOnly}
                                onChange={(e) => {
                                  const updated = [...(agent.postCallApiHeaders || [])];
                                  updated[idx].key = e.target.value;
                                  setAgent({ ...agent, postCallApiHeaders: updated });
                                }}
                                placeholder="e.g. content-type"
                                className="w-full bg-transparent border-none p-0 text-xs font-bold text-slate-800 outline-none focus:ring-0"
                              />
                            </div>
                            <div className="hidden sm:block h-6 w-px bg-slate-150" />
                            <div className="flex-1">
                              <label className="block text-[8px] font-black text-slate-400 uppercase mb-0.5">Value</label>
                              <input
                                type="text"
                                value={header.value}
                                disabled={isReadOnly}
                                onChange={(e) => {
                                  const updated = [...(agent.postCallApiHeaders || [])];
                                  updated[idx].value = e.target.value;
                                  setAgent({ ...agent, postCallApiHeaders: updated });
                                }}
                                placeholder="e.g. application/json"
                                className="w-full bg-transparent border-none p-0 text-xs font-bold text-slate-800 outline-none focus:ring-0"
                              />
                            </div>
                            {!isReadOnly && (
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = (agent.postCallApiHeaders || []).filter((_, i) => i !== idx);
                                  setAgent({ ...agent, postCallApiHeaders: updated });
                                }}
                                className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition self-end sm:self-auto"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </div>

                    {!isReadOnly && (
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...(agent.postCallApiHeaders || []), { key: '', value: '' }];
                          setAgent({ ...agent, postCallApiHeaders: updated });
                        }}
                        className="flex items-center space-x-1.5 px-4 py-2 border border-slate-200 hover:border-[#ec4899] text-slate-700 hover:text-[#ec4899] hover:bg-pink-50 rounded-xl text-xs font-black transition cursor-pointer shadow-2xs"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Header</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB: TOOLS */}
        {activeTab === 'tools' && (
          <div className="space-y-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-2">Live Conversational Tool Integrations</h3>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Tool Creator Card */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block">Register Custom API Tool</span>
                
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 mb-1">Tool Identifier</label>
                  <input
                    type="text"
                    value={newToolName}
                    disabled={isReadOnly}
                    onChange={(e) => setNewToolName(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 outline-none"
                    placeholder="e.g. BookingSystem"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 mb-1">Service Type</label>
                  <select
                    value={newToolType}
                    disabled={isReadOnly}
                    onChange={(e) => setNewToolType(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 outline-none"
                  >
                    <option>Webhook API</option>
                    <option>Cal.com Scheduler</option>
                    <option>Hubspot CRM</option>
                    <option>Salesforce Sync</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={addTool}
                  disabled={isReadOnly}
                  className="w-full py-2 bg-gradient-to-r from-violet-600 to-pink-500 hover:from-violet-700 hover:to-pink-600 text-white rounded-lg text-xs font-bold transition shadow-sm flex items-center justify-center space-x-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Register Tool</span>
                </button>
              </div>

              {/* Active Tools List */}
              <div className="lg:col-span-2 space-y-3">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1">Assigned Model Tools ({tools.length})</span>
                {tools.map((t) => (
                  <div key={t.id} className="bg-white border border-slate-150 rounded-xl p-4 flex justify-between items-center shadow-xs">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold text-slate-800">{t.name}</span>
                        <span className="bg-violet-50 text-violet-600 text-[9px] font-bold px-1.5 py-0.5 rounded-md">{t.type}</span>
                        <span className="bg-emerald-50 text-emerald-600 text-[9px] font-bold px-1.5 py-0.5 rounded-md">{t.status}</span>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-1 font-medium">{t.description}</p>
                    </div>

                    {!isReadOnly && (
                      <button
                        type="button"
                        onClick={() => void removeTool(t.id)}
                        className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB: KNOWLEDGE */}
        {activeTab === 'knowledge' && (
          <div className="space-y-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-2">Agent Knowledge Base / RAG Context</h3>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Document uploader */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block">Upload RAG Material</span>
                
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 mb-1">Document Display Name</label>
                  <input
                    type="text"
                    value={newDocName}
                    disabled={isReadOnly}
                    onChange={(e) => setNewDocName(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 outline-none"
                    placeholder="e.g. FAQ_Pricing_Sheet.pdf"
                  />
                </div>

                <div className="border border-dashed border-slate-300 rounded-lg p-4 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] text-slate-400 font-medium">Drag PDF, TXT or DOCX here</span>
                  <span className="text-[9px] text-slate-300 mt-0.5">Or click to select files manually</span>
                </div>

                <button
                  type="button"
                  onClick={addDocument}
                  disabled={isReadOnly}
                  className="w-full py-2 bg-gradient-to-r from-violet-600 to-pink-500 hover:from-violet-700 hover:to-pink-600 text-white rounded-lg text-xs font-bold transition shadow-sm flex items-center justify-center space-x-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Attach Context Document</span>
                </button>
              </div>

              {/* Active documents list */}
              <div className="lg:col-span-2 space-y-3">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1">Attached Corpora ({knowledgeDocuments.length})</span>
                {knowledgeDocuments.map((doc) => (
                  <div key={doc.id} className="bg-white border border-slate-150 rounded-xl p-4 flex justify-between items-center shadow-xs">
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 bg-violet-50 text-violet-600 rounded-lg flex items-center justify-center font-bold text-[10px]">
                        TXT
                      </div>
                      <div>
                        <span className="text-xs font-bold text-slate-800 block">{doc.name}</span>
                        <span className="text-[10px] text-slate-400 font-medium">Uploaded: {doc.uploaded} · {doc.size}</span>
                      </div>
                    </div>

                    {!isReadOnly && (
                      <button
                        type="button"
                        onClick={() => void removeDocument(doc.id)}
                        className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB: ANALYTICS */}
        {activeTab === 'analytics' && (
          <div className="space-y-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-2">Agent Operational Statistics</h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <span className="text-xs text-slate-400 font-bold uppercase block">Total Placed Calls</span>
                <span className="text-2xl font-black text-slate-800 block mt-1">{agent.totalCalls.toLocaleString()}</span>
                <span className="text-[10px] text-slate-500 font-semibold block mt-0.5">Stored call sessions</span>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <span className="text-xs text-slate-400 font-bold uppercase block">Avg Call Duration</span>
                <span className="text-2xl font-black text-slate-800 block mt-1">{agent.avgDuration} seconds</span>
                <span className="text-[10px] text-slate-500 font-medium block mt-0.5">Average completed duration</span>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <span className="text-xs text-slate-400 font-bold uppercase block">Conversion Success Rate</span>
                <span className="text-2xl font-black text-slate-800 block mt-1">{agent.successRate}%</span>
                <span className="text-[10px] text-violet-600 font-semibold block mt-0.5">Completed-call percentage</span>
              </div>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 text-[11px] font-semibold text-slate-500">Analytics are calculated from this agent's tenant-scoped call sessions. Evaluation summaries will appear after the evaluation pipeline stores results.</div>
          </div>
        )}
      </div>
    </form>
  );
}
