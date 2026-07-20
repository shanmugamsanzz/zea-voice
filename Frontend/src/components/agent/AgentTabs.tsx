/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../../store/AppState';
import { VoiceAgent } from '../../types';
import { apiRequest, uploadApiFormData } from '../../lib/api';
import { KnowledgeReviewPanel } from './KnowledgeReviewPanel';
import { KnowledgePublishPanel } from './KnowledgePublishPanel';
import { DocumentVersionPanel } from './DocumentVersionPanel';
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
  Globe,
  RefreshCw,
  BookOpen,
  AlertCircle,
  Upload,
  X
} from 'lucide-react';

interface AgentTabsProps {
  agentId: string | null; // null means "Create Agent"
  onSave: (agent: VoiceAgent) => void;
  onCancel: () => void;
}

interface AgentApiData {
  id: string; name: string; description: string | null; goal: string | null; language: string;
  usageDirection: 'inbound' | 'outbound' | 'both';
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

type KnowledgeBaseStatus = 'draft' | 'processing' | 'ready' | 'partially_failed' | 'published' | 'deleting' | 'deleted';
type KnowledgeDocumentType = 'faq' | 'catalog' | 'workflow_rules' | 'conversation_script' | 'general_knowledge';

const KNOWLEDGE_PDF_MAX_BYTES = 25 * 1024 * 1024;
const knowledgeDocumentCategories: Array<{
  type: KnowledgeDocumentType;
  title: string;
  description: string;
  examples: string;
}> = [
  { type: 'faq', title: 'FAQ', description: 'Short questions with approved answers.', examples: 'Locations, preparation, timings and common questions' },
  { type: 'catalog', title: 'Product / Package Catalog', description: 'Structured products, packages, prices and attributes.', examples: 'Health packages, tests, pricing and inclusions' },
  { type: 'workflow_rules', title: 'Workflow Rules', description: 'Business actions, escalation and transfer conditions.', examples: 'Transfer, callback, emergency and complaint rules' },
  { type: 'conversation_script', title: 'Conversation Script', description: 'Ordered inbound or outbound conversation flow.', examples: 'Introduction, qualification and closing scripts' },
  { type: 'general_knowledge', title: 'General Knowledge', description: 'Long-form information used for semantic retrieval.', examples: 'Explanations, policies and detailed reference material' },
];

function emptyKnowledgeFiles(): Record<KnowledgeDocumentType, File | null> {
  return { faq: null, catalog: null, workflow_rules: null, conversation_script: null, general_knowledge: null };
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unavailable';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface KnowledgeBaseApiData {
  id: string;
  name: string;
  description: string | null;
  status: KnowledgeBaseStatus;
  usageDirection: 'inbound' | 'outbound' | 'both';
  publicationRevision: number;
  publishedAt: string | null;
  documentCount: number;
  processingDocumentCount: number;
  failedDocumentCount: number;
  assignedAgentCount: number;
  semanticIndex: { status?: string; progress?: number; errorMessage?: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentKnowledgeBaseAssignment {
  agentId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  knowledgeBaseStatus: KnowledgeBaseStatus;
  usageDirection: 'inbound' | 'outbound' | 'both';
  priority: number;
  assignedAt: string;
}

interface KnowledgeBaseListResponse {
  items: KnowledgeBaseApiData[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

type KnowledgeDocumentStatus = 'uploading' | 'queued' | 'processing' | 'review_required' | 'ready' | 'failed' | 'archived' | 'deleting' | 'deleted';

interface KnowledgeDocumentApiData {
  id: string;
  knowledgeBaseId: string;
  documentType: KnowledgeDocumentType;
  displayName: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: KnowledgeDocumentStatus;
  metadata: Record<string, unknown>;
  currentVersion: {
    id: string;
    versionNumber: number;
    status: string;
    pageCount: number | null;
    chunkCount: number;
    createdAt: string;
  } | null;
  processingJob: {
    id: string;
    type: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    attemptCount: number;
    maxAttempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
  processingJobId?: string;
  createdAt: string;
  updatedAt: string;
}

interface KnowledgeDocumentListResponse {
  items: KnowledgeDocumentApiData[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface KnowledgeDeletionResponse {
  id: string;
  deleted: boolean;
  cleanupCompleted?: boolean;
  cleanupJob?: { id: string; status: string };
}

interface KnowledgeDeletionJob {
  id: string;
  knowledgeBaseId: string;
  documentId: string | null;
  type: 'delete_document' | 'delete_knowledge_base';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  errorMessage: string | null;
}

const knowledgeStatusStyles: Record<KnowledgeBaseStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  processing: 'bg-blue-50 text-blue-700',
  ready: 'bg-amber-50 text-amber-700',
  partially_failed: 'bg-orange-50 text-orange-700',
  published: 'bg-emerald-50 text-emerald-700',
  deleting: 'bg-red-50 text-red-600',
  deleted: 'bg-red-50 text-red-600',
};

const knowledgeDocumentStatusStyles: Record<KnowledgeDocumentStatus, string> = {
  uploading: 'bg-blue-50 text-blue-700',
  queued: 'bg-blue-50 text-blue-700',
  processing: 'bg-violet-50 text-violet-700',
  review_required: 'bg-amber-50 text-amber-700',
  ready: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  archived: 'bg-slate-100 text-slate-600',
  deleting: 'bg-red-50 text-red-600',
  deleted: 'bg-red-50 text-red-600',
};

function knowledgeStatusLabel(status: unknown) {
  if (typeof status !== 'string' || !status.trim()) return 'Queued';
  return status.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

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
      successRate: 0,
      agentUsage: 'both'
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
      agentUsage: value.usageDirection,
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

  // Real Knowledge Base state. Document upload and review actions are added in later Knowledge UI tasks.
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseApiData[]>([]);
  const [knowledgeAssignments, setKnowledgeAssignments] = useState<AgentKnowledgeBaseAssignment[]>([]);
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState('');
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState('');
  const [knowledgeRefreshKey, setKnowledgeRefreshKey] = useState(0);
  const [knowledgeFormMode, setKnowledgeFormMode] = useState<'create' | 'edit' | null>(null);
  const [knowledgeFormName, setKnowledgeFormName] = useState('');
  const [knowledgeFormDescription, setKnowledgeFormDescription] = useState('');
  const [knowledgeFormUsage, setKnowledgeFormUsage] = useState<'inbound' | 'outbound' | 'both'>('both');
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [knowledgeDeleting, setKnowledgeDeleting] = useState(false);
  const [knowledgeAssignmentSaving, setKnowledgeAssignmentSaving] = useState(false);
  const [deletingKnowledgeDocumentIds, setDeletingKnowledgeDocumentIds] = useState<string[]>([]);
  const [deleteKnowledgeBaseConfirmation, setDeleteKnowledgeBaseConfirmation] = useState('');
  const [showKnowledgeBaseDeleteDialog, setShowKnowledgeBaseDeleteDialog] = useState(false);
  const [knowledgeDeletionJobs, setKnowledgeDeletionJobs] = useState<Record<string, KnowledgeDeletionJob>>({});
  const [knowledgeFiles, setKnowledgeFiles] = useState<Record<KnowledgeDocumentType, File | null>>(() => emptyKnowledgeFiles());
  const [knowledgeFileErrors, setKnowledgeFileErrors] = useState<Partial<Record<KnowledgeDocumentType, string>>>({});
  const [draggedKnowledgeCategory, setDraggedKnowledgeCategory] = useState<KnowledgeDocumentType | null>(null);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocumentApiData[]>([]);
  const [knowledgeDocumentsLoading, setKnowledgeDocumentsLoading] = useState(false);
  const [knowledgeDocumentsError, setKnowledgeDocumentsError] = useState('');
  const [knowledgeDocumentPollTick, setKnowledgeDocumentPollTick] = useState(0);
  const [uploadingKnowledgeCategories, setUploadingKnowledgeCategories] = useState<Partial<Record<KnowledgeDocumentType, boolean>>>({});
  const [knowledgeUploadProgress, setKnowledgeUploadProgress] = useState<Partial<Record<KnowledgeDocumentType, number>>>({});
  const [reviewDocumentId, setReviewDocumentId] = useState<string | null>(null);
  const [versionDocumentId, setVersionDocumentId] = useState<string | null>(null);

  const isKnowledgeUploading = Object.values(uploadingKnowledgeCategories).some(Boolean);

  useEffect(() => {
    if (!isKnowledgeUploading) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isKnowledgeUploading]);
  const [newToolName, setNewToolName] = useState('');
  const [newToolType, setNewToolType] = useState('Webhook API');

  useEffect(() => {
    if (!agentId) { setTools([]); return; }
    apiRequest<Array<{ id: string; name: string; type: string; status: string; description: string | null }>>(`/agents/${agentId}/tools`)
      .then(setTools)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Agent tools could not be loaded'));
  }, [agentId]);

  useEffect(() => {
    const controller = new AbortController();
    const loadKnowledge = async () => {
      setKnowledgeLoading(true);
      setKnowledgeError('');
      try {
        const [list, assignments] = await Promise.all([
          apiRequest<KnowledgeBaseListResponse>('/knowledge-bases?page=1&pageSize=100', {
            signal: controller.signal,
            zeaCache: knowledgeRefreshKey > 0 ? 'reload' : 'default',
          }),
          agentId
            ? apiRequest<AgentKnowledgeBaseAssignment[]>(`/agents/${agentId}/knowledge-bases`, {
              signal: controller.signal,
              zeaCache: knowledgeRefreshKey > 0 ? 'reload' : 'default',
            })
            : Promise.resolve([]),
        ]);
        setKnowledgeBases(list.items);
        setKnowledgeAssignments(assignments);
        setSelectedKnowledgeBaseId((current) => {
          if (current && list.items.some((knowledgeBase) => knowledgeBase.id === current)) return current;
          const assignedId = assignments[0]?.knowledgeBaseId;
          return assignedId && list.items.some((knowledgeBase) => knowledgeBase.id === assignedId)
            ? assignedId
            : (list.items[0]?.id ?? '');
        });
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setKnowledgeError(requestError instanceof Error ? requestError.message : 'Knowledge Bases could not be loaded');
      } finally {
        if (!controller.signal.aborted) setKnowledgeLoading(false);
      }
    };
    void loadKnowledge();
    return () => controller.abort();
  }, [agentId, knowledgeRefreshKey]);

  useEffect(() => {
    setKnowledgeFiles(emptyKnowledgeFiles());
    setKnowledgeFileErrors({});
    setDraggedKnowledgeCategory(null);
    setKnowledgeDocuments([]);
    setKnowledgeDocumentsError('');
    setUploadingKnowledgeCategories({});
    setReviewDocumentId(null);
    setVersionDocumentId(null);
  }, [selectedKnowledgeBaseId]);

  useEffect(() => {
    if (!selectedKnowledgeBaseId) return;
    const controller = new AbortController();
    let nextPoll: number | undefined;
    const loadDocuments = async () => {
      setKnowledgeDocumentsLoading(true);
      setKnowledgeDocumentsError('');
      try {
        const result = await apiRequest<KnowledgeDocumentListResponse>(
          `/knowledge-bases/${selectedKnowledgeBaseId}/documents?page=1&pageSize=100`,
          { signal: controller.signal, zeaCache: 'bypass' },
        );
        if (controller.signal.aborted) return;
        setKnowledgeDocuments(result.items);
        const active = result.items.some((document) => ['uploading', 'queued', 'processing', 'deleting'].includes(document.status)
          || document.processingJob?.status === 'queued' || document.processingJob?.status === 'running');
        if (active) nextPoll = window.setTimeout(() => setKnowledgeDocumentPollTick((value) => value + 1), 2500);
        else if (knowledgeDocumentPollTick > 0) setKnowledgeRefreshKey((value) => value + 1);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setKnowledgeDocumentsError(requestError instanceof Error ? requestError.message : 'Knowledge documents could not be loaded');
      } finally {
        if (!controller.signal.aborted) setKnowledgeDocumentsLoading(false);
      }
    };
    void loadDocuments();
    return () => {
      controller.abort();
      if (nextPoll !== undefined) window.clearTimeout(nextPoll);
    };
  }, [selectedKnowledgeBaseId, knowledgeDocumentPollTick]);

  useEffect(() => {
    const activeJobs = Object.values(knowledgeDeletionJobs).filter((job) => ['queued', 'running'].includes(job.status));
    if (activeJobs.length === 0) return;
    const timer = window.setTimeout(async () => {
      const settled = await Promise.allSettled(activeJobs.map((job) => apiRequest<KnowledgeDeletionJob>(
        `/knowledge-bases/deletion-jobs/${job.id}`,
        { zeaCache: 'bypass' },
      )));
      const updates = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      if (updates.length === 0) {
        setKnowledgeDeletionJobs((current) => ({ ...current }));
        return;
      }
      setKnowledgeDeletionJobs((current) => {
        const next = { ...current };
        updates.forEach((job) => { next[job.id] = job; });
        return next;
      });
      const completed = updates.filter((job) => job.status === 'completed');
      if (completed.length > 0) {
        const completedDocumentIds = new Set(completed.map((job) => job.documentId).filter(Boolean));
        const completedKnowledgeBaseIds = new Set(completed.filter((job) => job.type === 'delete_knowledge_base').map((job) => job.knowledgeBaseId));
        setKnowledgeDocuments((current) => current.filter((document) => !completedDocumentIds.has(document.id)));
        setKnowledgeBases((current) => current.filter((knowledgeBase) => !completedKnowledgeBaseIds.has(knowledgeBase.id)));
        setSelectedKnowledgeBaseId((current) => completedKnowledgeBaseIds.has(current) ? '' : current);
        setKnowledgeRefreshKey((value) => value + 1);
      }
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [knowledgeDeletionJobs]);

  const saveAgent = async () => {
    if (isReadOnly || saving) return;
    if (!sttModelId || !llmModelId || !ttsModelId) { setError('Connected STT, LLM and TTS models are required.'); return; }
    setSaving(true); setError('');
    try {
      const {
        id: _id, name: _name, status: _status, createdAt: _createdAt, updatedAt: _updatedAt,
        totalCalls: _totalCalls, avgDuration: _avgDuration, successRate: _successRate,
        ...agentSettings
      } = agent;
      const payload = {
        name: agent.name, description: agent.description || null, goal: agent.goal || null,
        language: agent.language || 'English (US)', usageDirection: agent.agentUsage || 'both', status: agent.status,
        phoneNumberId: phoneNumberId || null, sttModelId, llmModelId, ttsModelId,
        voiceId: agent.voiceId, prompt: agent.prompt, welcomeMessage: agent.welcomeMessage || null,
        temperature: agent.temperature, interruptionSensitivity: agent.interruptionSensitivity,
        silenceTimeoutMs: agent.silenceTimeout, inactivityTimeoutSeconds: agent.inactivityTimeout ?? 5,
        settings: agentSettings,
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

  const showKnowledgeSuccess = (message: string) => {
    setSuccessMsg(message);
    window.setTimeout(() => setSuccessMsg(null), 3000);
  };

  const openCreateKnowledgeBase = () => {
    setKnowledgeFormMode('create');
    setKnowledgeFormName('');
    setKnowledgeFormDescription('');
    setKnowledgeFormUsage(agent.agentUsage === 'inbound' || agent.agentUsage === 'outbound' ? agent.agentUsage : 'both');
    setKnowledgeError('');
  };

  const openEditKnowledgeBase = (knowledgeBase: KnowledgeBaseApiData) => {
    setKnowledgeFormMode('edit');
    setKnowledgeFormName(knowledgeBase.name);
    setKnowledgeFormDescription(knowledgeBase.description ?? '');
    setKnowledgeFormUsage(knowledgeBase.usageDirection);
    setKnowledgeError('');
  };

  const closeKnowledgeForm = () => {
    if (knowledgeSaving) return;
    setKnowledgeFormMode(null);
    setKnowledgeError('');
  };

  const saveKnowledgeBase = async () => {
    const name = knowledgeFormName.trim();
    if (!name || knowledgeSaving || isReadOnly) {
      if (!name) setKnowledgeError('Knowledge Base name is required.');
      return;
    }
    if (knowledgeFormMode === 'edit' && !selectedKnowledgeBaseId) return;
    setKnowledgeSaving(true);
    setKnowledgeError('');
    try {
      const path = knowledgeFormMode === 'edit'
        ? `/knowledge-bases/${selectedKnowledgeBaseId}`
        : '/knowledge-bases';
      const saved = await apiRequest<KnowledgeBaseApiData>(path, {
        method: knowledgeFormMode === 'edit' ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name,
          description: knowledgeFormDescription.trim() || null,
          usageDirection: knowledgeFormUsage,
          ...(knowledgeFormMode === 'create' ? { settings: {} } : {}),
        }),
      });
      setKnowledgeBases((current) => knowledgeFormMode === 'edit'
        ? current.map((knowledgeBase) => knowledgeBase.id === saved.id ? saved : knowledgeBase)
        : [saved, ...current]);
      setSelectedKnowledgeBaseId(saved.id);
      setKnowledgeFormMode(null);
      showKnowledgeSuccess(knowledgeFormMode === 'edit'
        ? 'Knowledge Base updated successfully.'
        : 'Knowledge Base created successfully.');
    } catch (requestError) {
      setKnowledgeError(requestError instanceof Error ? requestError.message : 'Knowledge Base could not be saved');
    } finally {
      setKnowledgeSaving(false);
    }
  };

  const deleteSelectedKnowledgeBase = async () => {
    if (!selectedKnowledgeBase || isReadOnly || knowledgeDeleting) return;
    if (deleteKnowledgeBaseConfirmation.trim() !== selectedKnowledgeBase.name) return;
    setKnowledgeDeleting(true);
    setKnowledgeError('');
    try {
      const deletion = await apiRequest<KnowledgeDeletionResponse>(`/knowledge-bases/${selectedKnowledgeBase.id}`, { method: 'DELETE' });
      if (deletion.cleanupJob) {
        setKnowledgeDeletionJobs((current) => ({
          ...current,
          [deletion.cleanupJob!.id]: {
            id: deletion.cleanupJob!.id, knowledgeBaseId: selectedKnowledgeBase.id, documentId: null,
            type: 'delete_knowledge_base', status: deletion.cleanupJob!.status as KnowledgeDeletionJob['status'],
            progress: 0, errorMessage: null,
          },
        }));
        setKnowledgeBases((current) => current.map((knowledgeBase) => knowledgeBase.id === selectedKnowledgeBase.id
          ? { ...knowledgeBase, status: 'deleting' }
          : knowledgeBase));
      } else {
        const remaining = knowledgeBases.filter((knowledgeBase) => knowledgeBase.id !== selectedKnowledgeBase.id);
        setKnowledgeBases(remaining);
        setSelectedKnowledgeBaseId(remaining[0]?.id ?? '');
      }
      setKnowledgeAssignments((current) => current.filter((assignment) => assignment.knowledgeBaseId !== selectedKnowledgeBase.id));
      setKnowledgeFormMode(null);
      setShowKnowledgeBaseDeleteDialog(false);
      setDeleteKnowledgeBaseConfirmation('');
      showKnowledgeSuccess('Knowledge Base deletion started successfully.');
    } catch (requestError) {
      setKnowledgeError(requestError instanceof Error ? requestError.message : 'Knowledge Base could not be deleted');
    } finally {
      setKnowledgeDeleting(false);
    }
  };

  const toggleSelectedKnowledgeBaseAssignment = async () => {
    if (!agentId || !selectedKnowledgeBase || isReadOnly || knowledgeAssignmentSaving) return;
    setKnowledgeAssignmentSaving(true);
    setKnowledgeError('');
    try {
      if (selectedKnowledgeAssignment) {
        await apiRequest(`/agents/${agentId}/knowledge-bases/${selectedKnowledgeBase.id}`, { method: 'DELETE' });
        setKnowledgeAssignments((current) => current.filter((assignment) => assignment.knowledgeBaseId !== selectedKnowledgeBase.id));
        setKnowledgeBases((current) => current.map((knowledgeBase) => knowledgeBase.id === selectedKnowledgeBase.id
          ? { ...knowledgeBase, assignedAgentCount: Math.max(0, knowledgeBase.assignedAgentCount - 1) }
          : knowledgeBase));
        showKnowledgeSuccess('Knowledge Base unassigned from this agent.');
      } else {
        const assigned = await apiRequest<AgentKnowledgeBaseAssignment>(
          `/agents/${agentId}/knowledge-bases/${selectedKnowledgeBase.id}`,
          { method: 'POST', body: JSON.stringify({ priority: 100 }) },
        );
        setKnowledgeAssignments((current) => [...current.filter((assignment) => assignment.knowledgeBaseId !== assigned.knowledgeBaseId), assigned]);
        setKnowledgeBases((current) => current.map((knowledgeBase) => knowledgeBase.id === selectedKnowledgeBase.id
          ? { ...knowledgeBase, assignedAgentCount: knowledgeBase.assignedAgentCount + 1 }
          : knowledgeBase));
        showKnowledgeSuccess('Published Knowledge Base assigned to this agent.');
      }
    } catch (requestError) {
      setKnowledgeError(requestError instanceof Error ? requestError.message : 'Agent Knowledge Base assignment could not be updated');
    } finally {
      setKnowledgeAssignmentSaving(false);
    }
  };

  const deleteKnowledgeDocument = async (document: KnowledgeDocumentApiData) => {
    if (!selectedKnowledgeBase || isReadOnly || deletingKnowledgeDocumentIds.includes(document.id)) return;
    const confirmed = window.confirm(
      `Delete document "${document.displayName}" and every version? Its B2 files, extracted records and Qdrant vectors will be removed by the backend cleanup job. This cannot be undone.`,
    );
    if (!confirmed) return;
    setDeletingKnowledgeDocumentIds((current) => [...current, document.id]);
    setKnowledgeDocumentsError('');
    try {
      const deletion = await apiRequest<KnowledgeDeletionResponse>(`/knowledge-bases/${selectedKnowledgeBase.id}/documents/${document.id}`, { method: 'DELETE' });
      setKnowledgeDocuments((current) => current.map((item) => item.id === document.id
        ? { ...item, status: 'deleting' }
        : item));
      if (deletion.cleanupJob) {
        setKnowledgeDeletionJobs((current) => ({
          ...current,
          [deletion.cleanupJob!.id]: {
            id: deletion.cleanupJob!.id, knowledgeBaseId: selectedKnowledgeBase.id, documentId: document.id,
            type: 'delete_document', status: deletion.cleanupJob!.status as KnowledgeDeletionJob['status'],
            progress: 0, errorMessage: null,
          },
        }));
      }
      setReviewDocumentId((current) => current === document.id ? null : current);
      setVersionDocumentId((current) => current === document.id ? null : current);
      showKnowledgeSuccess('Document deletion started. Stored files and vectors are being cleaned safely.');
    } catch (requestError) {
      setKnowledgeDocumentsError(requestError instanceof Error ? requestError.message : 'Knowledge document could not be deleted');
    } finally {
      setDeletingKnowledgeDocumentIds((current) => current.filter((id) => id !== document.id));
    }
  };

  const selectKnowledgePdf = (documentType: KnowledgeDocumentType, file: File | null) => {
    if (!file) return;
    let validationError = '';
    if (!selectedKnowledgeBase) validationError = 'Select a Knowledge Base before choosing a PDF.';
    else if (!file.name.toLowerCase().endsWith('.pdf') || (file.type && file.type !== 'application/pdf')) validationError = 'Only PDF documents are supported in Phase 1.';
    else if (file.size <= 0) validationError = 'The selected PDF is empty.';
    else if (file.size > KNOWLEDGE_PDF_MAX_BYTES) validationError = `PDF must not exceed ${formatFileSize(KNOWLEDGE_PDF_MAX_BYTES)}.`;

    if (validationError) {
      setKnowledgeFileErrors((current) => ({ ...current, [documentType]: validationError }));
      return;
    }
    setKnowledgeFiles((current) => ({ ...current, [documentType]: file }));
    setKnowledgeFileErrors((current) => ({ ...current, [documentType]: undefined }));
  };

  const removeKnowledgePdf = (documentType: KnowledgeDocumentType) => {
    setKnowledgeFiles((current) => ({ ...current, [documentType]: null }));
    setKnowledgeFileErrors((current) => ({ ...current, [documentType]: undefined }));
  };

  const uploadKnowledgePdf = async (documentType: KnowledgeDocumentType) => {
    const file = knowledgeFiles[documentType];
    if (!selectedKnowledgeBase || !file || isReadOnly || uploadingKnowledgeCategories[documentType]) return;
    const category = knowledgeDocumentCategories.find((item) => item.type === documentType);
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('documentType', documentType);
    form.append('displayName', file.name.replace(/\.pdf$/i, '').trim() || category?.title || 'PDF document');
    form.append('metadata', JSON.stringify({
      usageDirection: selectedKnowledgeBase.usageDirection,
      categoryLabel: category?.title,
    }));

    setUploadingKnowledgeCategories((current) => ({ ...current, [documentType]: true }));
    setKnowledgeUploadProgress((current) => ({ ...current, [documentType]: 5 }));
    setKnowledgeFileErrors((current) => ({ ...current, [documentType]: undefined }));
    try {
      const uploaded = await uploadApiFormData<KnowledgeDocumentApiData>(
        `/knowledge-bases/${selectedKnowledgeBase.id}/documents`,
        form,
        (percent) => setKnowledgeUploadProgress((current) => ({ ...current, [documentType]: percent })),
      );
      setKnowledgeDocuments((current) => [uploaded, ...current.filter((document) => document.id !== uploaded.id)]);
      setKnowledgeUploadProgress((current) => ({ ...current, [documentType]: 100 }));
      setKnowledgeFiles((current) => ({ ...current, [documentType]: null }));
      setKnowledgeBases((current) => current.map((knowledgeBase) => knowledgeBase.id === selectedKnowledgeBase.id
        ? { ...knowledgeBase, status: 'processing', documentCount: knowledgeBase.documentCount + 1, processingDocumentCount: knowledgeBase.processingDocumentCount + 1 }
        : knowledgeBase));
      setKnowledgeDocumentPollTick((value) => value + 1);
      showKnowledgeSuccess(`${category?.title ?? 'Knowledge'} PDF uploaded and queued for processing.`);
    } catch (requestError) {
      setKnowledgeFileErrors((current) => ({
        ...current,
        [documentType]: requestError instanceof Error ? requestError.message : 'PDF could not be uploaded',
      }));
    } finally {
      setUploadingKnowledgeCategories((current) => ({ ...current, [documentType]: false }));
      window.setTimeout(() => setKnowledgeUploadProgress((current) => ({ ...current, [documentType]: undefined })), 600);
    }
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
  const selectedKnowledgeBase = knowledgeBases.find((knowledgeBase) => knowledgeBase.id === selectedKnowledgeBaseId);
  const selectedKnowledgeAssignment = knowledgeAssignments.find((assignment) => assignment.knowledgeBaseId === selectedKnowledgeBaseId);
  const selectedKnowledgeDeletionJob = Object.values(knowledgeDeletionJobs).find((job) => job.type === 'delete_knowledge_base' && job.knowledgeBaseId === selectedKnowledgeBaseId);
  const publishedKnowledgeBaseCount = knowledgeBases.filter((knowledgeBase) => knowledgeBase.status === 'published').length;
  const selectedKnowledgeFileCount = Object.values(knowledgeFiles).filter(Boolean).length;
  const activeKnowledgeUploadCategory = knowledgeDocumentCategories.find((category) => uploadingKnowledgeCategories[category.type]);
  const activeKnowledgeUploadFile = activeKnowledgeUploadCategory ? knowledgeFiles[activeKnowledgeUploadCategory.type] : null;
  const activeKnowledgeUploadProgress = activeKnowledgeUploadCategory
    ? Math.max(0, Math.min(100, knowledgeUploadProgress[activeKnowledgeUploadCategory.type] ?? 0))
    : 0;
  const reviewDocument = knowledgeDocuments.find((document) => document.id === reviewDocumentId);
  const versionDocument = knowledgeDocuments.find((document) => document.id === versionDocumentId);
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
    <>
    <form onSubmit={handleSave} className="flex min-h-full flex-col overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs">
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
      <div className="flex-1 bg-slate-50/30 p-8">
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
                    Agent Usage <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <select
                      required
                      value={agent.agentUsage || 'both'}
                      disabled={isReadOnly}
                      onChange={(event) => setAgent({ ...agent, agentUsage: event.target.value as 'inbound' | 'outbound' | 'both' })}
                      className="w-full bg-white border border-slate-200 focus:border-pink-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                    >
                      <option value="inbound">Inbound</option>
                      <option value="outbound">Outbound</option>
                      <option value="both">Both</option>
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                  <p className="mt-1.5 text-[10px] font-medium text-slate-400">Controls whether this agent can be used for incoming calls, campaigns, or both.</p>
                </div>
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
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">Agent Knowledge Bases</h3>
                <p className="mt-1 text-xs font-medium text-slate-400">Live company knowledge from PostgreSQL, B2 and Qdrant.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!isReadOnly && <button type="button" onClick={openCreateKnowledgeBase} disabled={knowledgeSaving || knowledgeDeleting}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-violet-700 disabled:opacity-50">
                  <Plus className="h-3.5 w-3.5" /> Create Knowledge Base
                </button>}
                <button type="button" onClick={() => setKnowledgeRefreshKey((value) => value + 1)} disabled={knowledgeLoading}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                  <RefreshCw className={`h-3.5 w-3.5 ${knowledgeLoading ? 'animate-spin' : ''}`} /> Refresh
                </button>
              </div>
            </div>

            {!agentId && <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800"><Info className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-xs font-bold">Save this agent before assigning knowledge.</p><p className="mt-1 text-[11px] font-medium text-amber-700">Company Knowledge Bases are visible, but assignment requires a saved Agent ID.</p></div></div>}

            {knowledgeFormMode && !isReadOnly && <div onKeyDown={(event) => { if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); void saveKnowledgeBase(); } }} className="rounded-xl border border-violet-200 bg-violet-50/40 p-5">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"><div><h4 className="text-sm font-bold text-slate-800">{knowledgeFormMode === 'create' ? 'Create Knowledge Base' : 'Edit Knowledge Base'}</h4><p className="mt-1 text-[11px] font-medium text-slate-500">Knowledge is isolated to this company tenant and workspace.</p></div><span className="mt-2 rounded-md bg-white px-2 py-1 text-[9px] font-black uppercase text-violet-600 sm:mt-0">{knowledgeFormMode}</span></div>
              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
                <label className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-500">Knowledge Base Name *</span><input value={knowledgeFormName} onChange={(event) => setKnowledgeFormName(event.target.value)} disabled={knowledgeSaving} maxLength={180} placeholder="e.g. Zea Hospital Knowledge" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-400 disabled:opacity-60" /></label>
                <label className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-500">Usage Direction *</span><select value={knowledgeFormUsage} onChange={(event) => setKnowledgeFormUsage(event.target.value as 'inbound' | 'outbound' | 'both')} disabled={knowledgeSaving} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-400 disabled:opacity-60"><option value="inbound">Inbound</option><option value="outbound">Outbound</option><option value="both">Both</option></select></label>
                <label className="block lg:col-span-3"><span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-500">Description</span><textarea value={knowledgeFormDescription} onChange={(event) => setKnowledgeFormDescription(event.target.value)} disabled={knowledgeSaving} maxLength={10000} rows={3} placeholder="Describe the information contained in this Knowledge Base." className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-400 disabled:opacity-60" /></label>
              </div>
              <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={closeKnowledgeForm} disabled={knowledgeSaving} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button><button type="button" onClick={() => void saveKnowledgeBase()} disabled={knowledgeSaving || !knowledgeFormName.trim()} className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-xs font-bold text-white hover:bg-violet-700 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{knowledgeSaving ? 'Saving...' : knowledgeFormMode === 'create' ? 'Create' : 'Save Changes'}</button></div>
            </div>}

            {knowledgeBases.length > 0 && <label className="block rounded-xl border border-slate-200 bg-slate-50 p-4"><span className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Selected Knowledge Base</span><select value={selectedKnowledgeBaseId} onChange={(event) => { setSelectedKnowledgeBaseId(event.target.value); setKnowledgeFormMode(null); }} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-800 outline-none focus:border-violet-400">{knowledgeBases.map((knowledgeBase) => <option key={knowledgeBase.id} value={knowledgeBase.id}>{knowledgeBase.name} — {knowledgeStatusLabel(knowledgeBase.status)} — {knowledgeBase.usageDirection}</option>)}</select></label>}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Company Knowledge Bases</span><strong className="mt-1 block text-2xl text-slate-800">{knowledgeBases.length}</strong></div>
              <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-emerald-600">Published</span><strong className="mt-1 block text-2xl text-emerald-800">{publishedKnowledgeBaseCount}</strong></div>
              <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-violet-600">Assigned to Agent</span><strong className="mt-1 block text-2xl text-violet-800">{knowledgeAssignments.length}</strong></div>
            </div>

            {knowledgeError && <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-xs font-bold">Unable to load Knowledge Bases</p><p className="mt-1 text-[11px] font-medium">{knowledgeError}</p></div></div>}

            {knowledgeLoading && knowledgeBases.length === 0 && <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">{[1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-xl border border-slate-200 bg-slate-100" />)}</div>}

            {!knowledgeLoading && !knowledgeError && knowledgeBases.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center"><BookOpen className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 text-sm font-bold text-slate-600">No Knowledge Base has been created for this company.</p><p className="mt-1 text-xs font-medium text-slate-400">Create the first tenant-isolated Knowledge Base before uploading category PDFs.</p></div>}

            {knowledgeBases.length > 0 && <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">

              <div className="space-y-3 lg:col-span-3">
                <span className="block text-[10px] font-black uppercase tracking-wider text-slate-400">Select a company Knowledge Base</span>
                {knowledgeBases.map((knowledgeBase) => {
                  const assignment = knowledgeAssignments.find((item) => item.knowledgeBaseId === knowledgeBase.id);
                  const selected = knowledgeBase.id === selectedKnowledgeBaseId;
                  return <button key={knowledgeBase.id} type="button" onClick={() => { setSelectedKnowledgeBaseId(knowledgeBase.id); setKnowledgeFormMode(null); }}
                    className={`w-full rounded-xl border p-4 text-left transition ${selected ? 'border-violet-400 bg-violet-50/50 ring-2 ring-violet-100' : 'border-slate-200 bg-white hover:border-violet-200 hover:bg-slate-50'}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0"><span className="block truncate text-sm font-bold text-slate-800">{knowledgeBase.name}</span><p className="mt-1 line-clamp-2 text-[11px] font-medium text-slate-500">{knowledgeBase.description || 'No description provided.'}</p></div>
                      <div className="flex flex-wrap justify-end gap-1.5"><span className={`rounded-md px-2 py-1 text-[9px] font-black uppercase ${knowledgeStatusStyles[knowledgeBase.status]}`}>{knowledgeStatusLabel(knowledgeBase.status)}</span>{assignment && <span className="rounded-md bg-violet-100 px-2 py-1 text-[9px] font-black uppercase text-violet-700">Assigned</span>}</div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-[10px] font-semibold text-slate-500"><span>{knowledgeBase.documentCount} documents</span><span>{knowledgeBase.processingDocumentCount} processing</span><span>{knowledgeBase.failedDocumentCount} failed</span><span className="capitalize">{knowledgeBase.usageDirection}</span></div>
                  </button>;
                })}
              </div>

              <div className="lg:col-span-2">
                <span className="mb-3 block text-[10px] font-black uppercase tracking-wider text-slate-400">Knowledge Base details</span>
                {selectedKnowledgeBase && <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><Database className="h-5 w-5" /></div>
                  <h4 className="mt-4 text-base font-bold text-slate-800">{selectedKnowledgeBase.name}</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{selectedKnowledgeBase.description || 'No description provided.'}</p>
                  <dl className="mt-5 space-y-3 border-t border-slate-200 pt-4 text-xs">
                    <div className="flex justify-between gap-3"><dt className="font-semibold text-slate-400">Usage</dt><dd className="font-bold capitalize text-slate-700">{selectedKnowledgeBase.usageDirection}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="font-semibold text-slate-400">Revision</dt><dd className="font-bold text-slate-700">{selectedKnowledgeBase.publicationRevision}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="font-semibold text-slate-400">Agent assignments</dt><dd className="font-bold text-slate-700">{selectedKnowledgeBase.assignedAgentCount}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="font-semibold text-slate-400">Semantic index</dt><dd className="font-bold capitalize text-slate-700">{selectedKnowledgeBase.semanticIndex?.status?.replace(/_/g, ' ') || 'Not indexed'}</dd></div>
                  </dl>
                  {selectedKnowledgeAssignment
                    ? <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-3"><div className="flex items-center gap-2 text-violet-700"><CheckCircle className="h-4 w-4" /><span className="text-xs font-bold">Assigned to this agent</span></div><p className="mt-1 text-[10px] font-semibold capitalize text-violet-600">{selectedKnowledgeAssignment.usageDirection} usage · Priority {selectedKnowledgeAssignment.priority}</p></div>
                    : <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-3 text-[11px] font-semibold text-slate-400">This Knowledge Base is not assigned to the current agent.</div>}
                  {!isReadOnly && agentId && !['deleting', 'deleted'].includes(selectedKnowledgeBase.status) && <button type="button" onClick={() => void toggleSelectedKnowledgeBaseAssignment()} disabled={knowledgeAssignmentSaving || (!selectedKnowledgeAssignment && selectedKnowledgeBase.status !== 'published')} title={!selectedKnowledgeAssignment && selectedKnowledgeBase.status !== 'published' ? 'Publish this Knowledge Base before assigning it' : undefined} className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${selectedKnowledgeAssignment ? 'border border-violet-200 bg-white text-violet-700 hover:bg-violet-50' : 'bg-violet-600 text-white hover:bg-violet-700'}`}>
                    {knowledgeAssignmentSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : selectedKnowledgeAssignment ? <X className="h-3.5 w-3.5" /> : <CheckCircle className="h-3.5 w-3.5" />}
                    {knowledgeAssignmentSaving ? 'Updating assignment...' : selectedKnowledgeAssignment ? 'Unassign from Agent' : selectedKnowledgeBase.status === 'published' ? 'Assign to Agent' : 'Publish Before Assignment'}
                  </button>}
                  {!isReadOnly && !['deleting', 'deleted'].includes(selectedKnowledgeBase.status) && <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" onClick={() => openEditKnowledgeBase(selectedKnowledgeBase)} disabled={knowledgeSaving || knowledgeDeleting} className="rounded-lg border border-violet-200 bg-white px-3 py-2 text-xs font-bold text-violet-700 transition hover:bg-violet-50 disabled:opacity-50">Edit</button><button type="button" onClick={() => { setDeleteKnowledgeBaseConfirmation(''); setShowKnowledgeBaseDeleteDialog(true); }} disabled={knowledgeSaving || knowledgeDeleting} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 transition hover:bg-red-50 disabled:opacity-50">Delete</button></div>}
                  {selectedKnowledgeBase.status === 'deleting' && <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">{selectedKnowledgeDeletionJob?.status === 'failed' ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}<span className="text-[10px] font-semibold">{selectedKnowledgeDeletionJob?.status === 'failed' ? `Cleanup failed: ${selectedKnowledgeDeletionJob.errorMessage || 'The backend will retain the failed job for reconciliation.'}` : `Deleting documents, stored B2 files and Qdrant vectors (${selectedKnowledgeDeletionJob?.progress ?? 0}%). The Knowledge Base cannot be changed or assigned.`}</span></div>}
                  <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-[11px] font-semibold text-slate-400">Choose one of the five PDF categories below to add knowledge.</div>
                </div>}
              </div>
            </div>}

            {selectedKnowledgeBase && <section className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div><span className="text-[10px] font-black uppercase tracking-wider text-violet-600">Phase 1 PDF Knowledge</span><h4 className="mt-1 text-base font-bold text-slate-800">Five-category document workspace</h4><p className="mt-1 text-xs font-medium text-slate-500">Choose the category that matches the PDF content. Auto-detection is not used in Phase 1.</p></div>
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-right"><span className="block text-[9px] font-black uppercase tracking-wider text-slate-400">Files selected</span><strong className="text-sm text-slate-700">{selectedKnowledgeFileCount} / {knowledgeDocumentCategories.length}</strong></div>
              </div>

              <div className="mt-5 grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                {knowledgeDocumentCategories.map((category, index) => {
                  const file = knowledgeFiles[category.type];
                  const fileError = knowledgeFileErrors[category.type];
                  const categoryDocuments = knowledgeDocuments.filter((document) => document.documentType === category.type);
                  const latestDocument = categoryDocuments[0];
                  const uploading = Boolean(uploadingKnowledgeCategories[category.type]);
                  const uploadProgress = knowledgeUploadProgress[category.type] ?? 0;
                  const disabled = isReadOnly || uploading || ['deleting', 'deleted'].includes(selectedKnowledgeBase.status);
                  const dragging = draggedKnowledgeCategory === category.type;
                  return <article key={category.type} className={`flex w-full flex-col rounded-xl border bg-white p-4 transition ${dragging ? 'border-violet-500 ring-2 ring-violet-100' : fileError ? 'border-red-200' : file ? 'border-emerald-200' : 'border-slate-200'}`}>
                    <div className="flex items-start justify-between gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${index % 3 === 0 ? 'bg-violet-100 text-violet-700' : index % 3 === 1 ? 'bg-blue-100 text-blue-700' : 'bg-pink-100 text-pink-700'}`}><FileText className="h-4 w-4" /></div><div className="flex flex-wrap justify-end gap-1"><span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[9px] font-bold text-slate-500">{category.type}</span>{latestDocument && <span className={`rounded-md px-2 py-1 text-[9px] font-black uppercase ${knowledgeDocumentStatusStyles[latestDocument.status]}`}>{knowledgeStatusLabel(latestDocument.status)}</span>}</div></div>
                    <h5 className="mt-3 text-sm font-bold text-slate-800">{category.title}</h5>
                    <p className="mt-1 text-[11px] font-medium leading-4 text-slate-500">{category.description}</p>
                    <p className="mt-2 text-[10px] leading-4 text-slate-400">{category.examples}</p>

                    <label onDragOver={(event) => { if (disabled) return; event.preventDefault(); setDraggedKnowledgeCategory(category.type); }} onDragLeave={() => setDraggedKnowledgeCategory(null)} onDrop={(event) => { if (disabled) return; event.preventDefault(); setDraggedKnowledgeCategory(null); selectKnowledgePdf(category.type, event.dataTransfer.files[0] ?? null); }}
                      className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-3 py-4 text-center transition ${disabled ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60' : dragging ? 'border-violet-500 bg-violet-50' : 'border-slate-300 bg-slate-50 hover:border-violet-400 hover:bg-violet-50/40'}`}>
                      <Upload className="h-5 w-5 text-slate-400" /><span className="mt-2 text-[11px] font-bold text-slate-600">{file ? 'Replace selected PDF' : 'Select or drop PDF'}</span><span className="mt-1 text-[9px] font-medium text-slate-400">PDF only · Maximum {formatFileSize(KNOWLEDGE_PDF_MAX_BYTES)}</span>
                      <input key={`${selectedKnowledgeBase.id}-${category.type}-${file?.name ?? 'empty'}`} type="file" accept=".pdf,application/pdf" disabled={disabled} className="sr-only" onChange={(event) => selectKnowledgePdf(category.type, event.target.files?.[0] ?? null)} />
                    </label>

                    <div className="mt-3">
                      {file && <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3"><div className="min-w-0"><span className="block truncate text-[11px] font-bold text-emerald-800" title={file.name}>{file.name}</span><span className="mt-0.5 block text-[9px] font-semibold text-emerald-600">{formatFileSize(file.size)} · Ready for upload</span></div>{!disabled && <button type="button" aria-label={`Remove ${category.title} PDF`} onClick={() => removeKnowledgePdf(category.type)} className="shrink-0 rounded-md p-1 text-emerald-700 transition hover:bg-emerald-100 hover:text-red-600"><X className="h-4 w-4" /></button>}</div>}
                      {fileError && <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="text-[10px] font-semibold leading-4">{fileError}</span></div>}
                      {!file && !fileError && <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-center text-[9px] font-semibold text-slate-400">No PDF selected</div>}
                      {file && !isReadOnly && <button type="button" onClick={() => void uploadKnowledgePdf(category.type)} disabled={disabled}
                        className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-60">
                        {uploading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}{uploading ? 'Uploading to B2...' : 'Upload PDF'}
                      </button>}
                      {uploading && <div className="mt-2 rounded-lg border border-violet-100 bg-violet-50 p-3"><div className="mb-1.5 flex items-center justify-between text-[9px] font-bold text-violet-700"><span>Uploading PDF securely</span><span>{uploadProgress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-violet-100"><div className="h-full rounded-full bg-gradient-to-r from-violet-600 to-pink-500 transition-all duration-300" style={{ width: `${uploadProgress}%` }} /></div><p className="mt-1.5 text-[9px] font-medium text-violet-600">Keep this page open. Extraction progress will appear below after storage completes.</p></div>}
                      {latestDocument && <div className="mt-2 border-t border-slate-100 pt-2 text-[9px] font-semibold text-slate-400">{categoryDocuments.length} uploaded document{categoryDocuments.length === 1 ? '' : 's'} · Latest v{latestDocument.currentVersion?.versionNumber ?? 1}</div>}
                    </div>
                  </article>;
                })}
              </div>

              <div className="mt-4 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-blue-700"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p className="text-[10px] font-semibold leading-4">Selecting a file keeps it local. Clicking Upload PDF stores it in B2, creates the tenant-scoped database record and queues text extraction.</p></div>
            </section>}

            {selectedKnowledgeBase && <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h4 className="text-sm font-bold text-slate-800">Documents and processing</h4><p className="mt-1 text-[11px] font-medium text-slate-400">Live extraction state for {selectedKnowledgeBase.name}.</p></div><button type="button" onClick={() => setKnowledgeDocumentPollTick((value) => value + 1)} disabled={knowledgeDocumentsLoading} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${knowledgeDocumentsLoading ? 'animate-spin' : ''}`} /> Refresh Documents</button></div>

              {knowledgeDocumentsError && <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="text-[11px] font-semibold">{knowledgeDocumentsError}</span></div>}
              {knowledgeDocumentsLoading && knowledgeDocuments.length === 0 && <div className="mt-4 space-y-2">{[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}</div>}
              {!knowledgeDocumentsLoading && !knowledgeDocumentsError && knowledgeDocuments.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-xs font-semibold text-slate-400">No PDF has been uploaded to this Knowledge Base.</div>}

              {knowledgeDocuments.length > 0 && <div className="mt-4 space-y-3">{knowledgeDocuments.map((document) => {
                const category = knowledgeDocumentCategories.find((item) => item.type === document.documentType);
                const documentStatus: KnowledgeDocumentStatus = document.status && document.status in knowledgeDocumentStatusStyles ? document.status : 'queued';
                const deletionJob = Object.values(knowledgeDeletionJobs).find((job) => job.type === 'delete_document' && job.documentId === document.id);
                const progress = Math.max(0, Math.min(100, Number(document.processingJob?.progress ?? (documentStatus === 'ready' || documentStatus === 'review_required' ? 100 : 0))));
                const processing = ['uploading', 'queued', 'processing'].includes(documentStatus) || document.processingJob?.status === 'queued' || document.processingJob?.status === 'running';
                const errorMessage = document.processingJob?.errorMessage;
                return <article key={document.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-xs font-bold text-slate-800" title={document.displayName || 'PDF document'}>{document.displayName || 'PDF document'}</span><span className="rounded bg-white px-1.5 py-0.5 font-mono text-[8px] font-bold text-slate-500">{category?.title ?? document.documentType ?? 'Knowledge'}</span></div><p className="mt-1 text-[9px] font-semibold text-slate-400">{document.originalFilename || 'PDF document'} · {formatFileSize(Number(document.sizeBytes))} · Version {document.currentVersion?.versionNumber ?? 1}</p></div><span className={`w-fit rounded-md px-2 py-1 text-[9px] font-black uppercase ${knowledgeDocumentStatusStyles[documentStatus]}`}>{knowledgeStatusLabel(documentStatus)}</span></div>

                  {(processing || document.processingJob) && <div className="mt-3"><div className="mb-1.5 flex items-center justify-between text-[9px] font-bold text-slate-400"><span>{processing ? 'Processing' : knowledgeStatusLabel(document.processingJob?.status ?? document.status)}</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className={`h-full rounded-full transition-all duration-500 ${document.status === 'failed' ? 'bg-red-500' : 'bg-gradient-to-r from-violet-500 to-pink-500'}`} style={{ width: `${progress}%` }} /></div></div>}

                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[9px] font-semibold text-slate-400"><span>{document.currentVersion?.pageCount ?? 0} pages</span><span>{document.currentVersion?.chunkCount ?? 0} chunks</span><span>Attempt {document.processingJob?.attemptCount ?? 0}/{document.processingJob?.maxAttempts ?? 0}</span><span>Uploaded {new Date(document.createdAt).toLocaleString()}</span></div>
                  {(document.status === 'failed' || errorMessage) && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[10px] font-semibold text-red-700">{errorMessage || 'Document processing failed. Select the PDF again to retry with a new upload.'}</div>}
                  {document.status === 'review_required' && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[10px] font-semibold text-amber-700">Extraction completed. Developer review is required before publishing.</div>}
                  {document.status === 'deleting' && <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">{deletionJob?.status === 'failed' ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}<span className="text-[10px] font-semibold">{deletionJob?.status === 'failed' ? `Cleanup failed: ${deletionJob.errorMessage || 'The backend retained this job for reconciliation.'}` : `Deleting every version, extracted record, B2 object and Qdrant vector (${deletionJob?.progress ?? 0}%).`}</span></div>}
                  <div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => { setVersionDocumentId(document.id); setReviewDocumentId(null); }} disabled={document.status === 'deleting'} className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-[10px] font-bold text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50">Version History</button>{['review_required', 'ready'].includes(document.status) && <button type="button" onClick={() => { setReviewDocumentId(document.id); setVersionDocumentId(null); }} className="rounded-lg bg-violet-600 px-3 py-2 text-[10px] font-bold text-white transition hover:bg-violet-700">{document.status === 'ready' ? 'Review Approved Records' : 'Review Extracted Records'}</button>}{!isReadOnly && !['deleting', 'deleted'].includes(document.status) && <button type="button" onClick={() => void deleteKnowledgeDocument(document)} disabled={deletingKnowledgeDocumentIds.includes(document.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-[10px] font-bold text-red-600 transition hover:bg-red-50 disabled:cursor-wait disabled:opacity-50">{deletingKnowledgeDocumentIds.includes(document.id) ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}{deletingKnowledgeDocumentIds.includes(document.id) ? 'Starting deletion...' : 'Delete Document'}</button>}</div>
                </article>;
              })}</div>}
            </section>}

            {selectedKnowledgeBase && versionDocument && <DocumentVersionPanel
              knowledgeBaseId={selectedKnowledgeBase.id}
              document={{ id: versionDocument.id, displayName: versionDocument.displayName, status: versionDocument.status }}
              readOnly={isReadOnly}
              refreshKey={knowledgeDocumentPollTick}
              onClose={() => setVersionDocumentId(null)}
              onUpdated={() => {
                setKnowledgeDocumentPollTick((value) => value + 1);
                setKnowledgeRefreshKey((value) => value + 1);
              }}
            />}

            {selectedKnowledgeBase && reviewDocument && <KnowledgeReviewPanel
              knowledgeBaseId={selectedKnowledgeBase.id}
              documentId={reviewDocument.id}
              documentName={reviewDocument.displayName}
              readOnly={isReadOnly}
              onClose={() => setReviewDocumentId(null)}
              onReviewUpdated={() => {
                setKnowledgeDocumentPollTick((value) => value + 1);
                setKnowledgeRefreshKey((value) => value + 1);
              }}
            />}

            {selectedKnowledgeBase && <KnowledgePublishPanel
              knowledgeBaseId={selectedKnowledgeBase.id}
              readOnly={isReadOnly}
              refreshKey={knowledgeRefreshKey + knowledgeDocumentPollTick}
              onPublished={() => {
                setKnowledgeRefreshKey((value) => value + 1);
                setKnowledgeDocumentPollTick((value) => value + 1);
              }}
            />}

            {showKnowledgeBaseDeleteDialog && selectedKnowledgeBase && <div role="dialog" aria-modal="true" aria-labelledby="delete-knowledge-base-title" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !knowledgeDeleting) setShowKnowledgeBaseDeleteDialog(false); }}>
              <div className="w-full max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-2xl">
                <div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600"><Trash2 className="h-5 w-5" /></div><div><h4 id="delete-knowledge-base-title" className="text-base font-bold text-slate-900">Permanently delete Knowledge Base?</h4><p className="mt-1 text-xs leading-5 text-slate-500">The backend will safely remove every document version, review record, B2 object, Qdrant vector and agent assignment. This action cannot be undone.</p></div></div>
                <div className="mt-5 rounded-lg border border-red-100 bg-red-50 p-3 text-xs font-semibold text-red-700">Type <strong>{selectedKnowledgeBase.name}</strong> to confirm deletion.</div>
                <label className="mt-4 block"><span className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Knowledge Base name</span><input autoFocus value={deleteKnowledgeBaseConfirmation} onChange={(event) => setDeleteKnowledgeBaseConfirmation(event.target.value)} disabled={knowledgeDeleting} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-xs font-semibold text-slate-800 outline-none focus:border-red-400 disabled:opacity-60" /></label>
                <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => { setShowKnowledgeBaseDeleteDialog(false); setDeleteKnowledgeBaseConfirmation(''); }} disabled={knowledgeDeleting} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button><button type="button" onClick={() => void deleteSelectedKnowledgeBase()} disabled={knowledgeDeleting || deleteKnowledgeBaseConfirmation.trim() !== selectedKnowledgeBase.name} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50">{knowledgeDeleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}{knowledgeDeleting ? 'Starting safe deletion...' : 'Delete permanently'}</button></div>
              </div>
            </div>}

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
    {isKnowledgeUploading && activeKnowledgeUploadCategory && createPortal(
      <div role="status" aria-live="assertive" aria-label="Uploading knowledge document" className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-md">
        <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/70 bg-white/95 shadow-2xl shadow-slate-950/25">
          <div className="relative px-6 pb-5 pt-7 text-center">
            <div className="absolute inset-x-0 top-0 h-1 bg-slate-100"><div className="h-full bg-gradient-to-r from-violet-600 via-fuchsia-500 to-pink-500 transition-[width] duration-300 ease-out" style={{ width: `${activeKnowledgeUploadProgress}%` }} /></div>
            <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-100 text-violet-700">
              <div className="absolute inset-0 animate-ping rounded-2xl bg-violet-300/35" />
              <Upload className="relative h-7 w-7" />
            </div>
            <h4 className="mt-5 text-base font-extrabold text-slate-900">Uploading knowledge document</h4>
            <p className="mt-1 text-xs font-semibold text-slate-500">Please keep this page open while the PDF is stored securely.</p>
            <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left">
              <div className="flex items-center gap-3"><FileText className="h-5 w-5 shrink-0 text-violet-600" /><div className="min-w-0"><span className="block truncate text-xs font-bold text-slate-800" title={activeKnowledgeUploadFile?.name}>{activeKnowledgeUploadFile?.name ?? 'PDF document'}</span><span className="mt-0.5 block text-[10px] font-semibold text-slate-400">{activeKnowledgeUploadCategory.title}{activeKnowledgeUploadFile ? ` · ${formatFileSize(activeKnowledgeUploadFile.size)}` : ''}</span></div></div>
            </div>
            <div className="mt-5 flex items-center justify-between text-[11px] font-bold text-violet-700"><span className="inline-flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5 animate-spin" />Uploading to B2</span><span>{activeKnowledgeUploadProgress}%</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-violet-100"><div className="h-full rounded-full bg-gradient-to-r from-violet-600 to-pink-500 transition-[width] duration-300 ease-out" style={{ width: `${activeKnowledgeUploadProgress}%` }} /></div>
          </div>
        </div>
      </div>,
      document.body,
    )}
    </>
  );
}
