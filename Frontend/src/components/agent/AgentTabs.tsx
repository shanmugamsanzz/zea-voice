/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../../store/AppState';
import { VoiceAgent } from '../../types';
import { apiRequest, isAbortError, uploadApiFormData } from '../../lib/api';
import { KnowledgeReviewPanel } from './KnowledgeReviewPanel';
import { KnowledgePublishPanel } from './KnowledgePublishPanel';
import { DocumentVersionPanel } from './DocumentVersionPanel';
import { knowledgeDocumentMetric } from './knowledgeDocumentMetric';
import { PronunciationGroupManager } from './PronunciationGroupManager';
import { AmbienceManager } from './AmbienceManager';
import { TableActionsMenu } from '../common/TableActionsMenu';
import {
  KNOWLEDGE_SOURCE_MAX_BYTES,
  knowledgeSourceDisplayName,
  knowledgeSourceUploadError,
  validateKnowledgeSourceFile,
} from './knowledgeSourceFile';
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
  ShieldCheck,
  Clock,
  Terminal,
  Music,
  PhoneOff,
  Globe,
  RefreshCw,
  BookOpen,
  AlertCircle,
  Upload,
  Copy,
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

interface AgentConfigurationApiData {
  limits: { systemPromptMaxCharacters: number };
}

interface ProviderModelOption {
  id: string; providerId: string; providerName: string; providerType: 'stt' | 'llm' | 'tts';
  modelKey: string; displayName: string; capabilities: Record<string, unknown>; settings: Record<string, unknown>;
}
interface AgentPhoneOption { id: string; number: string; status: string }

interface AgentToolApiData {
  id: string;
  name: string;
  type: string;
  status: string;
  description: string | null;
  configuration: Record<string, unknown>;
  hasSecretConfiguration?: boolean;
}

type KnowledgeBaseStatus = 'draft' | 'processing' | 'ready' | 'partially_failed' | 'published' | 'deleting' | 'deleted';
type KnowledgeDocumentType = 'faq' | 'catalog' | 'workflow_rules' | 'conversation_script' | 'general_knowledge';
type SelectedKnowledgeFile = { name: string; size: number; type: string };

const DEFAULT_ACKNOWLEDGEMENT_PHRASES = ['ம்', 'ஹம்', 'ஆமா', 'சரி', 'ok', 'okay', 'sure', 'சொல்லுங்க'];
const DEFAULT_EXPLICIT_STOP_PHRASES = ['நிறுத்துங்க', 'ஒரு நிமிஷம்', 'கொஞ்சம் இருங்க', 'wait', 'stop', 'வேண்டாம்'];
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

function emptyKnowledgeFiles(): Record<KnowledgeDocumentType, SelectedKnowledgeFile | null> {
  return { faq: null, catalog: null, workflow_rules: null, conversation_script: null, general_knowledge: null };
}

function emptyKnowledgeFileObjects(): Record<KnowledgeDocumentType, File | null> {
  return { faq: null, catalog: null, workflow_rules: null, conversation_script: null, general_knowledge: null };
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unavailable';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeGreetingMode(value: unknown): 'agent_initiates' | 'user_initiates' {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'user_initiates' || normalized === 'user initiates'
    ? 'user_initiates'
    : 'agent_initiates';
}

function normalizeCachePolicy(value: unknown): 'persistent_24h' | 'session_only' | 'disabled' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'session_only' || normalized === 'session only') return 'session_only';
  if (normalized === 'disabled' || normalized === 'disable' || normalized === 'none') return 'disabled';
  return 'persistent_24h';
}

function normalizeConversationContextMode(value: unknown): 'last_n_turns' | 'full_current_call' {
  return String(value ?? '').trim().toLowerCase() === 'full_current_call'
    ? 'full_current_call'
    : 'last_n_turns';
}

function legacySpeechConfirmationDelay(settings: Record<string, unknown>) {
  const configured = Number(settings.speechConfirmationDelayMs);
  if (Number.isFinite(configured)) return Math.min(1500, Math.max(150, Math.round(configured)));
  const label = String(settings.interruptionSensitivityLabel ?? '').toLowerCase();
  if (label.startsWith('low')) return 700;
  if (label.startsWith('high')) return 150;
  return 350;
}

function parseToolJsonObject(value: string, fieldName: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
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
  deletionJob: KnowledgeDeletionJob | null;
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
    recordCount: number;
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
  errorCode?: string | null;
  errorMessage: string | null;
  failedStage?: string | null;
}

function deletionStageLabel(job?: KnowledgeDeletionJob) {
  if (job?.failedStage) return job.failedStage;
  const code = String(job?.errorCode ?? '').toUpperCase();
  if (code.includes('QUEUE') || code.includes('BULLMQ')) return 'BullMQ jobs';
  if (code.includes('QDRANT')) return 'Qdrant vectors';
  if (code.includes('B2')) return 'Backblaze B2 files';
  if (code.includes('CACHE') || code.includes('REDIS')) return 'Redis caches';
  if (code.includes('POSTGRES') || code.includes('CASCADE')) return 'PostgreSQL records';
  return 'cleanup verification';
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

function knowledgeBaseStatusLabel(status: KnowledgeBaseStatus) {
  return status === 'deleting' ? 'Deleting permanently' : knowledgeStatusLabel(status);
}

function FieldInfoTooltip({ id, text, triggerContent }: { id: string; text: string; triggerContent?: React.ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; placement: 'top' | 'bottom' } | null>(null);

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const tooltipHalfWidth = 144;
    const viewportPadding = 12;
    const left = Math.min(
      window.innerWidth - tooltipHalfWidth - viewportPadding,
      Math.max(tooltipHalfWidth + viewportPadding, rect.left + rect.width / 2),
    );
    const placement = rect.bottom + 110 > window.innerHeight ? 'top' : 'bottom';

    setPosition({
      left,
      top: placement === 'top' ? rect.top - 8 : rect.bottom + 8,
      placement,
    });
  };

  const showTooltip = () => {
    updatePosition();
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen) return undefined;

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-describedby={id}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setIsOpen(false)}
        onFocus={showTooltip}
        onBlur={() => setIsOpen(false)}
        className={triggerContent
          ? 'cursor-help text-left'
          : 'zea-field-info-trigger flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-amber-100 text-amber-600'}
      >
        {triggerContent ?? <Info className="h-3 w-3" aria-hidden="true" />}
      </button>
      {isOpen && position && typeof document !== 'undefined' && createPortal(
        <span
          id={id}
          role="tooltip"
          className="zea-field-info-tooltip pointer-events-none fixed z-[2147483647] w-72 rounded-xl border p-3 text-left text-xs font-medium normal-case leading-relaxed tracking-normal shadow-2xl"
          style={{
            left: position.left,
            top: position.top,
            transform: position.placement === 'top' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
          }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
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
      sttLanguage: base.sttLanguage || 'ta-IN',
      sttPunctuate: base.sttPunctuate !== undefined ? base.sttPunctuate : true,
      sttSmartFormat: base.sttSmartFormat !== undefined ? base.sttSmartFormat : true,
      sttPriceMin: base.sttPriceMin !== undefined ? base.sttPriceMin : 0.05,
      timeBasedInterruptionEnabled: base.timeBasedInterruptionEnabled !== undefined ? base.timeBasedInterruptionEnabled : true,
      wordBasedInterruptionEnabled: true,
      wordInterruptionMinWords: base.wordInterruptionMinWords ?? 2,
      wordInterruptionTriggerWords: base.wordInterruptionTriggerWords || [],
      interruptionPolicy: base.interruptionPolicy || 'any',
      interruptionSensitivityLabel: base.interruptionSensitivityLabel || 'Medium (ideal for regular conversations)',
      speechConfirmationDelayMs: base.speechConfirmationDelayMs ?? 350,
      minimumMeaningfulWords: base.minimumMeaningfulWords ?? base.wordInterruptionMinWords ?? 2,
      acknowledgementPhrases: base.acknowledgementPhrases?.length ? base.acknowledgementPhrases : DEFAULT_ACKNOWLEDGEMENT_PHRASES,
      explicitStopPhrases: base.explicitStopPhrases?.length
        ? base.explicitStopPhrases
        : (base.wordInterruptionTriggerWords?.length ? base.wordInterruptionTriggerWords : DEFAULT_EXPLICIT_STOP_PHRASES),
      callCheckPhrases: base.callCheckPhrases?.length ? base.callCheckPhrases : [],
      callCheckResponse: base.callCheckResponse || '',
      llmProvider: base.llmProvider || 'Gemini',
      llmModel: base.llmModel || 'gemini-2.5-flash',
      greetingMode: normalizeGreetingMode(base.greetingMode),
      cachePolicy: normalizeCachePolicy(base.cachePolicy),
      contextId: base.contextId || '',
      conversationContextMode: normalizeConversationContextMode(base.conversationContextMode),
      conversationContextTurns: base.conversationContextTurns ?? 5,
      knowledgeHighConfidence: base.knowledgeHighConfidence ?? 0.86,
      knowledgeClarificationConfidence: base.knowledgeClarificationConfidence ?? 0.64,
      knowledgeAmbiguityMargin: base.knowledgeAmbiguityMargin ?? 0.06,
      knowledgeClarificationMessage: base.knowledgeClarificationMessage || 'I may not have heard the item correctly. Did you mean {{candidates}}?',
      latencyAcknowledgementMessage: base.latencyAcknowledgementMessage || 'One moment while I check the information.',
      technicalFailureMessage: base.technicalFailureMessage || '',
      informationUnavailableMessage: base.informationUnavailableMessage || '',
      conversationMemoryFields: base.conversationMemoryFields || [],
      callbackEnabled: base.callbackEnabled !== undefined ? base.callbackEnabled : true,
      callbackMinimumDelaySeconds: base.callbackMinimumDelaySeconds ?? 30,
      callbackMaximumDelayDays: base.callbackMaximumDelayDays ?? 30,
      callbackCloseAfterScheduling: base.callbackCloseAfterScheduling !== undefined ? base.callbackCloseAfterScheduling : true,
      callbackConfirmationInstructions: base.callbackConfirmationInstructions || 'Briefly confirm the scheduled callback time in the customer language.',
      callbackClarificationInstructions: base.callbackClarificationInstructions || 'Ask the caller for a clear relative callback time.',
      callbackFailureInstructions: base.callbackFailureInstructions || 'Explain briefly that the callback could not be scheduled and do not promise it.',
      callbackFollowUpOpeningInstructions: base.callbackFollowUpOpeningInstructions || 'Mention that the caller requested this callback and ask whether now is a good time to continue.',
      welcomeMessage: base.welcomeMessage || '',
      inactivityTimeout: base.inactivityTimeout !== undefined ? base.inactivityTimeout : 5,
      maxInactivityPrompts: base.maxInactivityPrompts ?? 1,
      silentMessage: base.silentMessage || "I can't hear you.Are you still on the call?",
      ttsProvider: base.ttsProvider || 'ElevenLabs Premium',
      ttsModel: base.ttsModel || 'eleven_flash_v2_5',
      voiceId: base.voiceId || '',
      ttsAmbienceType: base.ttsAmbienceType || 'Silent (Default)',
      ttsMaxCharactersPerResponse: base.ttsMaxCharactersPerResponse ?? 0,
      ttsMaxCharactersPerMinute: base.ttsMaxCharactersPerMinute ?? 0,
      maxCallDurationMinutes: base.maxCallDurationMinutes ?? 0,
      ttsLimitFallbackMessage: base.ttsLimitFallbackMessage || '',
      pronunciationGroups: base.pronunciationGroups || [],
      preCallProvider: base.preCallProvider || 'Select Provider',
      preCallDescription: base.preCallDescription || base.preCallPrompt || '',
      preCallApiActive: base.preCallApiActive !== undefined ? base.preCallApiActive : true,
      preCallApiUrl: base.preCallApiUrl || '',
      preCallApiMethod: base.preCallApiMethod || 'POST',
      preCallApiHeaders: base.preCallApiHeaders || '',
      preCallApiRequestBody: base.preCallApiRequestBody || '{ "event": "pre_call", "direction": "${direction}", "customer_number": "${customer_number}", "caller": "${caller}", "callee": "${callee}", "call_uuid": "${call_uuid}", "agent_id": "${agent_id}", "company_id": "${company_id}", "workspace_id": "${workspace_id}" }',
      preCallApiResponseMappings: base.preCallApiResponseMappings || [],
      postCallPrompt: base.postCallPrompt || 'Use this to end the call when the task is complete, the user asks to hang up, is busy, unresponsive, sends to voicemail, is abusive, provides a time to call back later, or when explicitly instructed in the prompt.',
      postCallMessageType: base.postCallMessageType || 'Dynamic',
      postCallStaticMessage: base.postCallStaticMessage || '',
      postCallDynamicClosing: base.postCallDynamicClosing || 'The AI agent will automatically generate a natural, contextual closing message in the customer\'s language before ending the call.',
      postCallUninterruptibleReasons: base.postCallUninterruptibleReasons || [],
      callEndTriggerPhrases: base.callEndTriggerPhrases || [],
      taskCompletionEnabled: base.taskCompletionEnabled === true,
      taskCompletionIntent: base.taskCompletionIntent || '',
      taskCompletionRequiredFields: base.taskCompletionRequiredFields || [],
      taskCompletionConfirmationMessage: base.taskCompletionConfirmationMessage || '',
      taskCompletionRequiresCatalogItem: base.taskCompletionRequiresCatalogItem === true,
      taskCompletionCatalogField: base.taskCompletionCatalogField || '',
      postCallSummaryEnabled: base.postCallSummaryEnabled !== undefined ? base.postCallSummaryEnabled : false,
      postCallSummaryModelId: base.postCallSummaryModelId || '',
      postCallSummaryInstructions: base.postCallSummaryInstructions || 'Create a concise, factual summary of the call. Capture the customer intent, outcome, sentiment, collected information and required follow-up. Do not invent missing information.',
      postCallIncludeTranscript: base.postCallIncludeTranscript !== undefined ? base.postCallIncludeTranscript : true,
      postCallIncludeSummary: base.postCallIncludeSummary !== undefined ? base.postCallIncludeSummary : true,
      postCallIncludePhoneNumbers: base.postCallIncludePhoneNumbers === true,
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
  const [systemPromptMaxCharacters, setSystemPromptMaxCharacters] = useState<number | null>(null);
  const promptCharacterCount = Array.from(agent.prompt).length;
  const promptLimitError = systemPromptMaxCharacters !== null && promptCharacterCount > systemPromptMaxCharacters
    ? `System Prompt cannot exceed ${systemPromptMaxCharacters.toLocaleString()} characters. Current: ${promptCharacterCount.toLocaleString()}.`
    : '';
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [modelCatalogRefreshKey, setModelCatalogRefreshKey] = useState(0);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [phoneNumbers, setPhoneNumbers] = useState<AgentPhoneOption[]>([]);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [sttModelId, setSttModelId] = useState('');
  const [llmModelId, setLlmModelId] = useState('');
  const [ttsModelId, setTtsModelId] = useState('');
  const [pronunciationGroupIds, setPronunciationGroupIds] = useState<string[]>([]);
  const [ambienceAssetId, setAmbienceAssetId] = useState<string | null>(null);
  const [newReason, setNewReason] = useState('');
  const [newCallEndTriggerPhrase, setNewCallEndTriggerPhrase] = useState('');
  const [newCompletionRequiredField, setNewCompletionRequiredField] = useState('');
  const [newAcknowledgementPhrase, setNewAcknowledgementPhrase] = useState('');
  const [newExplicitStopPhrase, setNewExplicitStopPhrase] = useState('');
  const [newCallCheckPhrase, setNewCallCheckPhrase] = useState('');

  const applyApiAgent = (value: AgentApiData) => {
    const savedSettings = value.settings ?? {};
    setAgent((current) => ({
      ...current, ...(savedSettings as Partial<VoiceAgent>), id: value.id, name: value.name,
      status: value.status, description: value.description ?? '', goal: value.goal ?? '', language: value.language,
      agentUsage: value.usageDirection,
      voiceId: value.voiceId, temperature: value.temperature, prompt: value.prompt,
      interruptionSensitivity: value.interruptionSensitivity, silenceTimeout: value.silenceTimeoutMs,
      sttProvider: value.stt.providerName, sttModel: value.stt.modelName,
      llmProvider: value.llm.providerName, llmModel: value.llm.modelName,
      ttsProvider: value.tts.providerName, ttsModel: value.tts.modelName,
      welcomeMessage: value.welcomeMessage ?? '', inactivityTimeout: value.inactivityTimeoutSeconds,
      maxInactivityPrompts: Number(savedSettings.maxInactivityPrompts ?? 1),
      createdAt: value.createdAt, updatedAt: value.updatedAt,
      totalCalls: value.metrics.totalCalls, avgDuration: value.metrics.averageDurationSeconds, successRate: value.metrics.successRate,
      greetingMode: normalizeGreetingMode(savedSettings.greetingMode),
      cachePolicy: normalizeCachePolicy(savedSettings.cachePolicy),
      contextId: String(savedSettings.contextId ?? '').trim(),
      conversationContextMode: normalizeConversationContextMode(savedSettings.conversationContextMode),
      conversationContextTurns: Number(savedSettings.conversationContextTurns ?? 5),
      conversationMemoryFields: Array.isArray(savedSettings.conversationMemoryFields)
        ? savedSettings.conversationMemoryFields as VoiceAgent['conversationMemoryFields']
        : [],
      wordBasedInterruptionEnabled: true,
      speechConfirmationDelayMs: legacySpeechConfirmationDelay(savedSettings),
      minimumMeaningfulWords: Number(savedSettings.minimumMeaningfulWords ?? savedSettings.wordInterruptionMinWords ?? 2),
      acknowledgementPhrases: Array.isArray(savedSettings.acknowledgementPhrases) && savedSettings.acknowledgementPhrases.length
        ? savedSettings.acknowledgementPhrases.map(String)
        : DEFAULT_ACKNOWLEDGEMENT_PHRASES,
      explicitStopPhrases: Array.isArray(savedSettings.explicitStopPhrases) && savedSettings.explicitStopPhrases.length
        ? savedSettings.explicitStopPhrases.map(String)
        : (Array.isArray(savedSettings.wordInterruptionTriggerWords) && savedSettings.wordInterruptionTriggerWords.length
          ? savedSettings.wordInterruptionTriggerWords.map(String)
          : DEFAULT_EXPLICIT_STOP_PHRASES),
      callCheckPhrases: Array.isArray(savedSettings.callCheckPhrases)
        ? savedSettings.callCheckPhrases.map(String).map((phrase) => phrase.trim()).filter(Boolean).slice(0, 20)
        : [],
      callCheckResponse: String(savedSettings.callCheckResponse ?? '').trim(),
    }));
    setPhoneNumberId(value.phoneNumberId ?? '');
    setSttModelId(value.stt.modelId); setLlmModelId(value.llm.modelId); setTtsModelId(value.tts.modelId);
  };

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      setLoading(true); setError('');
      try {
        const [catalogResult, phonesResult, existingResult, ambienceResult, configurationResult] = await Promise.allSettled([
          apiRequest<ProviderModelOption[]>('/catalog/providers', { zeaCache: 'reload' }),
          apiRequest<AgentPhoneOption[]>('/phone-numbers'),
          agentId ? apiRequest<AgentApiData>(`/agents/${agentId}`) : Promise.resolve(null),
          agentId ? apiRequest<{ ambienceAssetId: string | null }>(`/agents/${agentId}/ambience`, { zeaCache: 'reload' }) : Promise.resolve(null),
          apiRequest<AgentConfigurationApiData>('/agents/configuration', { zeaCache: 'reload' }),
        ]);
        if (catalogResult.status === 'rejected') throw catalogResult.reason;
        if (existingResult.status === 'rejected') throw existingResult.reason;
        if (configurationResult.status === 'rejected') throw configurationResult.reason;
        const catalog = catalogResult.value;
        const phones = phonesResult.status === 'fulfilled' ? phonesResult.value : [];
        const existing = existingResult.value;
        if (stopped) return;
        setModels(catalog); setPhoneNumbers(phones.filter((phone) => phone.status === 'active'));
        setSystemPromptMaxCharacters(configurationResult.value.limits.systemPromptMaxCharacters);
        if (phonesResult.status === 'rejected') setError('Models loaded, but assigned phone numbers could not be loaded.');
        if (existing) applyApiAgent(existing);
        else {
          setSttModelId(''); setLlmModelId(''); setTtsModelId('');
          setPhoneNumberId(phones.find((phone) => phone.status === 'active')?.id ?? '');
          setAgent((current) => ({ ...current,
            sttProvider: '', sttModel: '', llmProvider: '', llmModel: '',
            ttsProvider: '', ttsModel: '', voiceId: '',
          }));
        }
        setAmbienceAssetId(ambienceResult.status === 'fulfilled' ? (ambienceResult.value?.ambienceAssetId ?? null) : null);
        if (ambienceResult.status === 'rejected' && !isAbortError(ambienceResult.reason)) {
          setError('Agent loaded, but its background ambience assignment could not be loaded.');
        }
      } catch (requestError) {
        if (!stopped && !isAbortError(requestError)) {
          setError(requestError instanceof Error ? requestError.message : 'Agent configuration could not be loaded');
        }
      }
      finally { if (!stopped) setLoading(false); }
    };
    void load(); return () => { stopped = true; };
  }, [agentId]);

  useEffect(() => {
    if (modelCatalogRefreshKey === 0) return;
    let stopped = false;
    setModelsRefreshing(true);
    setError('');
    apiRequest<ProviderModelOption[]>('/catalog/providers', { zeaCache: 'reload' })
      .then((catalog) => {
        if (stopped) return;
        setModels(catalog);
        setSttModelId((current) => current && !catalog.some((model) => model.id === current && model.providerType === 'stt') ? '' : current);
        setLlmModelId((current) => current && !catalog.some((model) => model.id === current && model.providerType === 'llm') ? '' : current);
        setTtsModelId((current) => current && !catalog.some((model) => model.id === current && model.providerType === 'tts') ? '' : current);
      })
      .catch((requestError) => {
        if (!stopped && !isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Model catalog could not be refreshed');
      })
      .finally(() => { if (!stopped) setModelsRefreshing(false); });
    return () => { stopped = true; };
  }, [modelCatalogRefreshKey]);

  // Tools state
  const [tools, setTools] = useState<AgentToolApiData[]>([]);

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
  const [retryingKnowledgeDeletionJobIds, setRetryingKnowledgeDeletionJobIds] = useState<string[]>([]);
  const knowledgeFileObjects = useRef<Record<KnowledgeDocumentType, File | null>>(emptyKnowledgeFileObjects());
  const [knowledgeFiles, setKnowledgeFiles] = useState<Record<KnowledgeDocumentType, SelectedKnowledgeFile | null>>(() => emptyKnowledgeFiles());
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
  const [newToolName, setNewToolName] = useState('');
  const [newToolType, setNewToolType] = useState('Webhook API');
  const [newToolDescription, setNewToolDescription] = useState('');
  const [newToolWebhookUrl, setNewToolWebhookUrl] = useState('');
  const [newToolMethod, setNewToolMethod] = useState<'POST' | 'PUT' | 'PATCH'>('POST');
  const [newToolTimeoutSeconds, setNewToolTimeoutSeconds] = useState('15');
  const [newToolHeaders, setNewToolHeaders] = useState('{\n  "Content-Type": "application/json"\n}');
  const [newToolSecretHeaders, setNewToolSecretHeaders] = useState('{}');
  const [newToolInputSchema, setNewToolInputSchema] = useState('{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": true\n}');
  const [showToolRegistration, setShowToolRegistration] = useState(false);
  const [editingTool, setEditingTool] = useState<AgentToolApiData | null>(null);
  const [toolSaving, setToolSaving] = useState(false);
  const [testingToolId, setTestingToolId] = useState<string | null>(null);
  const [toolTestArguments, setToolTestArguments] = useState('{}');
  const [toolTestRunning, setToolTestRunning] = useState(false);
  const [toolTestResult, setToolTestResult] = useState<unknown>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolRefreshKey, setToolRefreshKey] = useState(0);
  const [toolStatusUpdatingId, setToolStatusUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) { setTools([]); return; }
    const controller = new AbortController();
    setToolsLoading(true);
    apiRequest<AgentToolApiData[]>(`/agents/${agentId}/tools`, { signal: controller.signal, zeaCache: toolRefreshKey > 0 ? 'reload' : 'default' })
      .then(setTools)
      .catch((requestError) => { if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Agent tools could not be loaded'); })
      .finally(() => { if (!controller.signal.aborted) setToolsLoading(false); });
    return () => controller.abort();
  }, [agentId, toolRefreshKey]);

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
        const persistedBaseDeletionJobs = list.items
          .map((knowledgeBase) => knowledgeBase.deletionJob)
          .filter((job): job is KnowledgeDeletionJob => Boolean(job?.id));
        if (persistedBaseDeletionJobs.length) {
          setKnowledgeDeletionJobs((current) => {
            const next = { ...current };
            persistedBaseDeletionJobs.forEach((job) => { next[job.id] = job; });
            return next;
          });
        }
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
    knowledgeFileObjects.current = emptyKnowledgeFileObjects();
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
        const persistedDocumentDeletionJobs = result.items
          .filter((document) => document.processingJob?.type === 'delete_document')
          .map((document) => ({
            id: document.processingJob!.id,
            knowledgeBaseId: document.knowledgeBaseId,
            documentId: document.id,
            type: 'delete_document' as const,
            status: document.processingJob!.status,
            progress: document.processingJob!.progress,
            errorCode: document.processingJob!.errorCode,
            errorMessage: document.processingJob!.errorMessage,
          }));
        if (persistedDocumentDeletionJobs.length) {
          setKnowledgeDeletionJobs((current) => {
            const next = { ...current };
            persistedDocumentDeletionJobs.forEach((job) => { next[job.id] = job; });
            return next;
          });
        }
        const active = result.items.some((document) => ['uploading', 'queued', 'processing'].includes(document.status)
          || (document.status === 'deleting' && document.processingJob?.status !== 'failed')
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
      const settled = await Promise.allSettled(activeJobs.map(async (job) => {
        try {
          return await apiRequest<KnowledgeDeletionJob>(
            `/knowledge-bases/deletion-jobs/${job.id}`,
            { zeaCache: 'bypass' },
          );
        } catch (requestError) {
          // A successful permanent delete cascades its own PostgreSQL cleanup
          // job. A 404 therefore becomes "Deleted" only after the guarded
          // external cleanup and hard-delete transaction have completed.
          if ((requestError as { status?: unknown })?.status === 404) {
            return { ...job, status: 'completed' as const, progress: 100 };
          }
          throw requestError;
        }
      }));
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
        setSuccessMsg(completed.some((job) => job.type === 'delete_knowledge_base')
          ? 'Knowledge Base permanently deleted from every storage system.'
          : 'Document permanently deleted from every storage system.');
        window.setTimeout(() => setSuccessMsg(null), 3000);
        setKnowledgeRefreshKey((value) => value + 1);
      }
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [knowledgeDeletionJobs]);

  const saveAgent = async () => {
    if (isReadOnly || saving) return;
    if (!Number.isInteger(systemPromptMaxCharacters) || Number(systemPromptMaxCharacters) <= 0) {
      setActiveTab('brain');
      setError('The System Prompt character limit could not be loaded. Refresh the page and try again.'); return;
    }
    const systemPromptCharacterCount = Array.from(agent.prompt.trim()).length;
    if (systemPromptCharacterCount > Number(systemPromptMaxCharacters)) {
      setActiveTab('brain');
      setError(`System Prompt cannot exceed ${Number(systemPromptMaxCharacters).toLocaleString()} characters. Current: ${systemPromptCharacterCount.toLocaleString()}.`); return;
    }
    if (!sttModelId || !llmModelId || !ttsModelId) { setError('Connected STT, LLM and TTS models are required.'); return; }
    const postCallMessageType = agent.postCallMessageType || 'Dynamic';
    if (postCallMessageType === 'Dynamic' && !agent.postCallPrompt?.trim()) {
      setError('Dynamic Closing Prompt is required when Message Type is Dynamic.'); return;
    }
    if (postCallMessageType === 'Static' && !agent.postCallStaticMessage?.trim()) {
      setError('Static Closing Message is required when Message Type is Static.'); return;
    }
    if ((agent.postCallPrompt?.trim().length ?? 0) > 20_000) {
      setError('Dynamic Closing Prompt cannot exceed 20,000 characters.'); return;
    }
    if ((agent.postCallStaticMessage?.trim().length ?? 0) > 10_000) {
      setError('Static Closing Message cannot exceed 10,000 characters.'); return;
    }
    if (!Array.isArray(agent.callEndTriggerPhrases)) {
      setError('Call End Trigger Phrases must be a list of phrases.'); return;
    }
    const normalizedEndTriggerPhrases: string[] = [];
    const seenEndTriggerPhrases = new Set<string>();
    for (const rawPhrase of agent.callEndTriggerPhrases) {
      const phrase = String(rawPhrase ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
      if (!phrase) { setError('Call End Trigger Phrases cannot contain an empty phrase.'); return; }
      if (phrase.length > 160) { setError('Each Call End Trigger Phrase cannot exceed 160 characters.'); return; }
      const key = phrase.toLocaleLowerCase();
      if (seenEndTriggerPhrases.has(key)) continue;
      seenEndTriggerPhrases.add(key);
      normalizedEndTriggerPhrases.push(phrase);
    }
    if (normalizedEndTriggerPhrases.length > 50) {
      setError('Call End Trigger Phrases cannot contain more than 50 phrases.'); return;
    }
    if (!Array.isArray(agent.callCheckPhrases)) {
      setError('Call Check Phrases must be a list of phrases.'); return;
    }
    const normalizedCallCheckPhrases: string[] = [];
    const seenCallCheckPhrases = new Set<string>();
    for (const rawPhrase of agent.callCheckPhrases) {
      const phrase = String(rawPhrase ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
      if (!phrase) continue;
      if (Array.from(phrase).length > 100) {
        setError('Each Call Check Phrase cannot exceed 100 characters.'); return;
      }
      const key = phrase.toLocaleLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').trim();
      if (!key || seenCallCheckPhrases.has(key)) continue;
      seenCallCheckPhrases.add(key);
      normalizedCallCheckPhrases.push(phrase);
    }
    if (normalizedCallCheckPhrases.length > 20) {
      setError('Call Check Phrases cannot contain more than 20 phrases.'); return;
    }
    const normalizedCallCheckResponse = String(agent.callCheckResponse ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (Array.from(normalizedCallCheckResponse).length > 500) {
      setError('Call Check Response cannot exceed 500 characters.'); return;
    }
    if (normalizedCallCheckPhrases.length > 0 && !normalizedCallCheckResponse) {
      setError('Call Check Response is required when Call Check Phrases are configured.'); return;
    }
    if (agent.postCallSummaryEnabled) {
      if (!agent.postCallSummaryModelId) { setError('Select an active LLM model for Post-Call AI Summary.'); return; }
      if (!models.some((model) => model.id === agent.postCallSummaryModelId && model.providerType === 'llm')) {
        setError('The selected Post-Call Summary LLM is no longer active or its provider is disconnected. Refresh models and select another LLM.'); return;
      }
      if (!agent.postCallSummaryInstructions?.trim()) { setError('Post-Call Summary Instructions are required when AI Summary is enabled.'); return; }
      if (agent.postCallSummaryInstructions.trim().length > 20_000) { setError('Post-Call Summary Instructions cannot exceed 20,000 characters.'); return; }
    }
    if ((agent.callbackMinimumDelaySeconds ?? 30) < 30 || (agent.callbackMinimumDelaySeconds ?? 30) > 86400) {
      setError('Minimum callback delay must be between 30 and 86,400 seconds.'); return;
    }
    if ((agent.callbackMaximumDelayDays ?? 30) < 1 || (agent.callbackMaximumDelayDays ?? 30) > 30) {
      setError('Maximum callback delay must be between 1 and 30 days.'); return;
    }
    const maximumCharactersPerMinute = agent.ttsMaxCharactersPerMinute ?? 0;
    if (!Number.isInteger(maximumCharactersPerMinute)
      || maximumCharactersPerMinute < 0
      || (maximumCharactersPerMinute !== 0 && (maximumCharactersPerMinute < 100 || maximumCharactersPerMinute > 10_000))) {
      setError('Maximum Characters Per Minute must be 0 (unlimited) or between 100 and 10,000.'); return;
    }
    const maximumCharactersPerResponse = agent.ttsMaxCharactersPerResponse ?? 0;
    if (!Number.isInteger(maximumCharactersPerResponse)
      || maximumCharactersPerResponse < 0
      || (maximumCharactersPerResponse !== 0 && (maximumCharactersPerResponse < 50 || maximumCharactersPerResponse > 5_000))) {
      setError('Maximum Characters Per Response must be 0 (unlimited) or between 50 and 5,000.'); return;
    }
    const completeFallbackMessage = agent.ttsLimitFallbackMessage?.trim() ?? '';
    if (completeFallbackMessage.length > 500) {
      setError('Complete Fallback Message cannot exceed 500 characters.'); return;
    }
    if (maximumCharactersPerResponse > 0 && !completeFallbackMessage) {
      setError('Complete Fallback Message is required when Maximum Characters Per Response is enabled.'); return;
    }
    const activeCharacterLimits = [maximumCharactersPerResponse, maximumCharactersPerMinute].filter((value) => value > 0);
    const effectiveCharacterLimit = activeCharacterLimits.length ? Math.min(...activeCharacterLimits) : 0;
    if (maximumCharactersPerResponse > 0 && Array.from(completeFallbackMessage).length > effectiveCharacterLimit) {
      setError('Complete Fallback Message must fit within the smaller active character limit.'); return;
    }
    if (maximumCharactersPerResponse > 0
      && !/[.!?\u2026\u0964\u3002\uff01\uff1f]["'\u201d\u2019)\]]*$/u.test(completeFallbackMessage)) {
      setError('Complete Fallback Message must end with sentence punctuation.'); return;
    }
    const maximumCallMinutes = agent.maxCallDurationMinutes ?? 0;
    if (!Number.isInteger(maximumCallMinutes)
      || maximumCallMinutes < 0
      || (maximumCallMinutes !== 0 && (maximumCallMinutes < 1 || maximumCallMinutes > 120))) {
      setError('Maximum Minutes Per Call must be 0 (unlimited) or between 1 and 120.'); return;
    }
    const maxInactivityPrompts = Number(agent.maxInactivityPrompts ?? 1);
    if (!Number.isInteger(maxInactivityPrompts)
      || maxInactivityPrompts < 1 || maxInactivityPrompts > 10) {
      setError('Maximum Inactivity Prompts must be between 1 and 10.'); return;
    }
    const conversationContextMode = normalizeConversationContextMode(agent.conversationContextMode);
    const conversationContextTurns = Number(agent.conversationContextTurns ?? 5);
    if (!Number.isInteger(conversationContextTurns) || conversationContextTurns < 1 || conversationContextTurns > 10) {
      setError('Recent Turns must be between 1 and 10 to protect live response latency.'); return;
    }
    const knowledgeHighConfidence = Number(agent.knowledgeHighConfidence ?? 0.86);
    const knowledgeClarificationConfidence = Number(agent.knowledgeClarificationConfidence ?? 0.64);
    const knowledgeAmbiguityMargin = Number(agent.knowledgeAmbiguityMargin ?? 0.06);
    const knowledgeClarificationMessage = String(agent.knowledgeClarificationMessage ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const latencyAcknowledgementMessage = String(agent.latencyAcknowledgementMessage ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const technicalFailureMessage = String(agent.technicalFailureMessage ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const informationUnavailableMessage = String(agent.informationUnavailableMessage ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (knowledgeHighConfidence < 0.7 || knowledgeHighConfidence > 1) {
      setError('High Confidence must be between 0.70 and 1.00.'); return;
    }
    if (knowledgeClarificationConfidence < 0.4 || knowledgeClarificationConfidence >= knowledgeHighConfidence) {
      setError('Clarification Confidence must be at least 0.40 and lower than High Confidence.'); return;
    }
    if (knowledgeAmbiguityMargin < 0.01 || knowledgeAmbiguityMargin > 0.25) {
      setError('Ambiguity Margin must be between 0.01 and 0.25.'); return;
    }
    if (!knowledgeClarificationMessage || knowledgeClarificationMessage.length > 500) {
      setError('Clarification Message is required and cannot exceed 500 characters.'); return;
    }
    if (!latencyAcknowledgementMessage || latencyAcknowledgementMessage.length > 500) {
      setError('Latency Acknowledgement is required and cannot exceed 500 characters.'); return;
    }
    if (technicalFailureMessage.length > 500
      || (agent.status === 'active' && !technicalFailureMessage)) {
      setError('Technical Failure Message is required for an active agent and cannot exceed 500 characters.'); return;
    }
    if (informationUnavailableMessage.length > 500
      || (agent.status === 'active' && !informationUnavailableMessage)) {
      setError('Information Unavailable Message is required for an active agent and cannot exceed 500 characters.'); return;
    }
    if (!Array.isArray(agent.conversationMemoryFields) || agent.conversationMemoryFields.length > 30) {
      setError('Important Information Fields must be a list with no more than 30 fields.'); return;
    }
    const normalizedMemoryFields: NonNullable<VoiceAgent['conversationMemoryFields']> = [];
    const seenMemoryFieldKeys = new Set<string>();
    for (const rawField of agent.conversationMemoryFields) {
      const key = String(rawField?.key ?? '').normalize('NFKC').trim().toLowerCase();
      const label = String(rawField?.label ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
      const question = String(rawField?.question ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
      const type = rawField?.type || 'text';
      const requiredAction = String(rawField?.requiredAction ?? '').normalize('NFKC').trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
        setError('Each Information Field key must use lowercase letters, numbers and underscores only.'); return;
      }
      if (seenMemoryFieldKeys.has(key)) { setError('Information Field keys must be unique.'); return; }
      if (!label || label.length > 100) { setError('Each Information Field requires a label of 100 characters or fewer.'); return; }
      if (!question || question.length > 500) { setError('Each Information Field requires a question of 500 characters or fewer.'); return; }
      if (requiredAction && !/^[a-z][a-z0-9_-]{0,79}$/.test(requiredAction)) {
        setError('Required Action must use lowercase letters, numbers, underscores or hyphens.'); return;
      }
      seenMemoryFieldKeys.add(key);
      normalizedMemoryFields.push({ key, label, type, required: rawField.required !== false, question, ...(requiredAction ? { requiredAction } : {}) });
    }
    const taskCompletionEnabled = agent.taskCompletionEnabled === true;
    const taskCompletionIntent = String(agent.taskCompletionIntent || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const taskCompletionConfirmationMessage = String(agent.taskCompletionConfirmationMessage || '').normalize('NFKC').trim();
    const taskCompletionRequiresCatalogItem = agent.taskCompletionRequiresCatalogItem === true;
    const taskCompletionCatalogField = String(agent.taskCompletionCatalogField || '').normalize('NFKC').trim().toLowerCase();
    if (!Array.isArray(agent.taskCompletionRequiredFields)) {
      setError('Required Information must be a list of field identifiers.'); return;
    }
    const normalizedCompletionFields: string[] = [];
    const seenCompletionFields = new Set<string>();
    for (const rawField of agent.taskCompletionRequiredFields) {
      const field = String(rawField ?? '').normalize('NFKC').trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(field)) {
        setError('Each Required Information field must use lowercase letters, numbers and underscores only.'); return;
      }
      if (!seenCompletionFields.has(field)) {
        seenCompletionFields.add(field);
        normalizedCompletionFields.push(field);
      }
    }
    if (normalizedCompletionFields.length > 20) {
      setError('Required Information cannot contain more than 20 fields.'); return;
    }
    if (taskCompletionEnabled) {
      if (!/^[a-z][a-z0-9_-]{0,79}$/.test(taskCompletionIntent)) {
        setError('Completion Intent is required and must use lowercase letters, numbers, underscores or hyphens only.'); return;
      }
      if (!normalizedCompletionFields.length) {
        setError('Add at least one Required Information field when Task Completion Auto Close is enabled.'); return;
      }
      if (!taskCompletionConfirmationMessage) {
        setError('Completion Confirmation Message is required when Task Completion Auto Close is enabled.'); return;
      }
      if (taskCompletionConfirmationMessage.length > 2_000) {
        setError('Completion Confirmation Message cannot exceed 2,000 characters.'); return;
      }
      if (taskCompletionRequiresCatalogItem
        && (!taskCompletionCatalogField || !normalizedCompletionFields.includes(taskCompletionCatalogField))) {
        setError('Catalog Field must be one of Required Information when Catalog selection is required.'); return;
      }
    }
    setSaving(true); setError('');
    try {
      const {
        id: _id, name: _name, status: _status, createdAt: _createdAt, updatedAt: _updatedAt,
        totalCalls: _totalCalls, avgDuration: _avgDuration, successRate: _successRate,
        pronunciationGroups: _legacyPronunciationGroups,
        ...rawAgentSettings
      } = agent;
      const deprecatedAgentSettings = new Set([
        'ttsSpeed', 'ttsStyle', 'ttsStyleDegree', 'ttsLanguage', 'ttsStability',
        'ttsPrice1k', 'ttsSimilarityBoost', 'ttsEmotion', 'ttsVolume',
        'preCallPrompt',
      ]);
      const agentSettings = {
        ...Object.fromEntries(
        Object.entries(rawAgentSettings).filter(([key]) => !deprecatedAgentSettings.has(key)),
        ),
        callEndTriggerPhrases: normalizedEndTriggerPhrases,
        callCheckPhrases: normalizedCallCheckPhrases,
        callCheckResponse: normalizedCallCheckResponse,
        taskCompletionEnabled,
        taskCompletionIntent,
        taskCompletionRequiredFields: normalizedCompletionFields,
        taskCompletionConfirmationMessage,
        taskCompletionRequiresCatalogItem,
        taskCompletionCatalogField,
        conversationContextMode,
        conversationContextTurns,
        knowledgeHighConfidence,
        knowledgeClarificationConfidence,
        knowledgeAmbiguityMargin,
        knowledgeClarificationMessage,
        latencyAcknowledgementMessage,
        technicalFailureMessage,
        informationUnavailableMessage,
        maxInactivityPrompts,
        conversationMemoryFields: normalizedMemoryFields,
      };
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
      await apiRequest(`/agents/${saved.id}/pronunciation-groups`, {
        method: 'PUT', body: JSON.stringify({ groupIds: pronunciationGroupIds }),
      });
      await apiRequest(`/agents/${saved.id}/ambience`, {
        method: 'PUT', body: JSON.stringify({ ambienceAssetId }),
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

  const addInterruptionPhrases = (field: 'acknowledgementPhrases' | 'explicitStopPhrases' | 'callCheckPhrases', rawValue: string) => {
    const additions = rawValue.split(',')
      .map((value) => value.normalize('NFKC').trim().replace(/\s+/gu, ' '))
      .filter(Boolean);
    if (!additions.length) return;
    setAgent((current) => {
      const phrases: string[] = [];
      const seen = new Set<string>();
      for (const phrase of [...(current[field] || []), ...additions]) {
        const key = phrase.toLocaleLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          phrases.push(phrase);
        }
      }
      return { ...current, [field]: phrases.slice(0, 20) };
    });
    if (field === 'acknowledgementPhrases') setNewAcknowledgementPhrase('');
    else if (field === 'explicitStopPhrases') setNewExplicitStopPhrase('');
    else setNewCallCheckPhrase('');
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
      showKnowledgeSuccess('Permanent Knowledge Base deletion started successfully.');
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

  const selectKnowledgeSource = async (documentType: KnowledgeDocumentType, file: File | null) => {
    if (!file) return;
    let validationError = '';
    if (!selectedKnowledgeBase) validationError = 'Select a Knowledge Base before choosing a file.';
    else validationError = await validateKnowledgeSourceFile(file);

    if (validationError) {
      knowledgeFileObjects.current[documentType] = null;
      setKnowledgeFiles((current) => ({ ...current, [documentType]: null }));
      setKnowledgeFileErrors((current) => ({ ...current, [documentType]: validationError }));
      return;
    }
    knowledgeFileObjects.current[documentType] = file;
    setKnowledgeFiles((current) => ({
      ...current,
      [documentType]: { name: file.name, size: file.size, type: file.type },
    }));
    setKnowledgeFileErrors((current) => ({ ...current, [documentType]: undefined }));
    window.setTimeout(() => { void uploadKnowledgeSource(documentType); }, 0);
  };

  const retryKnowledgeDeletion = async (job: KnowledgeDeletionJob) => {
    if (isReadOnly || job.status !== 'failed' || retryingKnowledgeDeletionJobIds.includes(job.id)) return;
    setRetryingKnowledgeDeletionJobIds((current) => [...current, job.id]);
    if (job.type === 'delete_knowledge_base') setKnowledgeError('');
    else setKnowledgeDocumentsError('');
    try {
      const retried = await apiRequest<KnowledgeDeletionJob>(
        `/knowledge-bases/deletion-jobs/${job.id}/retry`,
        { method: 'POST', zeaCache: 'bypass' },
      );
      setKnowledgeDeletionJobs((current) => ({ ...current, [retried.id]: retried }));
      showKnowledgeSuccess(`Deletion retry started from ${deletionStageLabel(job)}.`);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Deletion retry could not be started';
      if (job.type === 'delete_knowledge_base') setKnowledgeError(message);
      else setKnowledgeDocumentsError(message);
    } finally {
      setRetryingKnowledgeDeletionJobIds((current) => current.filter((id) => id !== job.id));
    }
  };

  const removeKnowledgeSource = (documentType: KnowledgeDocumentType) => {
    knowledgeFileObjects.current[documentType] = null;
    setKnowledgeFiles((current) => ({ ...current, [documentType]: null }));
    setKnowledgeFileErrors((current) => ({ ...current, [documentType]: undefined }));
  };

  const uploadKnowledgeSource = async (documentType: KnowledgeDocumentType) => {
    const file = knowledgeFileObjects.current[documentType];
    if (!selectedKnowledgeBase || !file || isReadOnly || uploadingKnowledgeCategories[documentType]) return;
    const overlayStartedAt = performance.now();
    const category = knowledgeDocumentCategories.find((item) => item.type === documentType);
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('documentType', documentType);
    form.append('displayName', knowledgeSourceDisplayName(file) || category?.title || 'Knowledge document');
    form.append('metadata', JSON.stringify({
      usageDirection: selectedKnowledgeBase.usageDirection,
      categoryLabel: category?.title,
    }));

    setUploadingKnowledgeCategories((current) => ({ ...current, [documentType]: true }));
    setKnowledgeUploadProgress((current) => ({ ...current, [documentType]: 5 }));
    setKnowledgeFileErrors((current) => ({ ...current, [documentType]: undefined }));
    try {
      // Let React commit the portal before XMLHttpRequest starts. This keeps the
      // loading screen visible even when the request succeeds or fails quickly.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await uploadApiFormData<KnowledgeDocumentApiData>(
        `/knowledge-bases/${selectedKnowledgeBase.id}/documents`,
        form,
        (percent) => setKnowledgeUploadProgress((current) => ({ ...current, [documentType]: percent })),
      );
      setKnowledgeUploadProgress((current) => ({ ...current, [documentType]: 100 }));
      knowledgeFileObjects.current[documentType] = null;
      setKnowledgeFiles((current) => ({ ...current, [documentType]: null }));
      setKnowledgeBases((current) => current.map((knowledgeBase) => knowledgeBase.id === selectedKnowledgeBase.id
        ? { ...knowledgeBase, status: 'processing', documentCount: knowledgeBase.documentCount + 1, processingDocumentCount: knowledgeBase.processingDocumentCount + 1 }
        : knowledgeBase));
      // Reload the canonical document shape instead of rendering the partial
      // upload response. The upload endpoint can return before processing and
      // version fields are populated.
      setKnowledgeDocumentPollTick((value) => value + 1);
      showKnowledgeSuccess(`${category?.title ?? 'Knowledge'} file uploaded and queued for processing.`);
    } catch (requestError) {
      setKnowledgeFileErrors((current) => ({
        ...current,
        [documentType]: knowledgeSourceUploadError(requestError, 'Knowledge file could not be uploaded'),
      }));
    } finally {
      const remainingOverlayMs = Math.max(0, 700 - (performance.now() - overlayStartedAt));
      if (remainingOverlayMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, remainingOverlayMs));
      }
      setUploadingKnowledgeCategories((current) => ({ ...current, [documentType]: false }));
      window.setTimeout(() => setKnowledgeUploadProgress((current) => ({ ...current, [documentType]: undefined })), 600);
    }
  };

  const resetToolForm = () => {
    setNewToolName('');
    setNewToolType('Webhook API');
    setNewToolDescription('');
    setNewToolWebhookUrl('');
    setNewToolMethod('POST');
    setNewToolTimeoutSeconds('15');
    setNewToolHeaders('{\n  "Content-Type": "application/json"\n}');
    setNewToolSecretHeaders('{}');
    setNewToolInputSchema('{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": true\n}');
  };

  const openToolRegistration = () => {
    setEditingTool(null);
    resetToolForm();
    setShowToolRegistration(true);
  };

  const openToolEditor = (tool: AgentToolApiData) => {
    const configuration = tool.configuration ?? {};
    setEditingTool(tool);
    setNewToolName(tool.name);
    setNewToolType('Webhook API');
    setNewToolDescription(tool.description ?? '');
    setNewToolWebhookUrl(typeof configuration.url === 'string' ? configuration.url : '');
    setNewToolMethod(['POST', 'PUT', 'PATCH'].includes(String(configuration.method)) ? configuration.method as 'POST' | 'PUT' | 'PATCH' : 'POST');
    const timeoutMs = Number(configuration.timeoutMs);
    setNewToolTimeoutSeconds(Number.isFinite(timeoutMs) ? String(timeoutMs / 1000) : '15');
    setNewToolHeaders(JSON.stringify(configuration.headers ?? {}, null, 2));
    setNewToolSecretHeaders('{}');
    setNewToolInputSchema(JSON.stringify(configuration.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true }, null, 2));
    setShowToolRegistration(true);
  };

  const closeToolEditor = () => {
    setShowToolRegistration(false);
    setEditingTool(null);
    resetToolForm();
  };

  const addTool = async () => {
    if (!newToolName.trim() || !agentId || toolSaving) return;
    try {
      setToolSaving(true);
      setError('');
      if (newToolType !== 'Webhook API') throw new Error('This service type is planned for a later phase.');
      const headers = parseToolJsonObject(newToolHeaders, 'Request headers');
      const secretHeaders = parseToolJsonObject(newToolSecretHeaders, 'Secret headers');
      const inputSchema = parseToolJsonObject(newToolInputSchema, 'Input schema');
      const timeoutSeconds = Number(newToolTimeoutSeconds);
      const saved = await apiRequest<AgentToolApiData>(editingTool ? `/agents/${agentId}/tools/${editingTool.id}` : `/agents/${agentId}/tools`, {
        method: editingTool ? 'PUT' : 'POST',
        body: JSON.stringify({
          name: newToolName.trim(),
          type: 'webhook_api',
          status: editingTool?.status === 'inactive' ? 'inactive' : 'active',
          description: newToolDescription.trim() || null,
          configuration: {
            version: 1,
            url: newToolWebhookUrl.trim(),
            method: newToolMethod,
            timeoutMs: Number.isFinite(timeoutSeconds) ? Math.round(timeoutSeconds * 1000) : 15000,
            headers,
            inputSchema,
            responseMode: 'synchronous',
          },
          ...(Object.keys(secretHeaders).length ? { secretConfiguration: { headers: secretHeaders } } : {}),
        }),
      });
      setTools((current) => editingTool
        ? current.map((tool) => tool.id === saved.id ? saved : tool)
        : [...current, saved]);
      setSuccessMsg(editingTool ? `Tool ${saved.name} was updated.` : `Tool ${saved.name} is assigned and active for this agent.`);
      window.setTimeout(() => setSuccessMsg(null), 3000);
      closeToolEditor();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : `Agent tool could not be ${editingTool ? 'updated' : 'created'}`); }
    finally { setToolSaving(false); }
  };

  const removeTool = async (id: string) => {
    if (!agentId) return;
    try { await apiRequest(`/agents/${agentId}/tools/${id}`, { method: 'DELETE' }); setTools((current) => current.filter((tool) => tool.id !== id)); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Agent tool could not be deleted'); }
  };

  const updateToolStatus = async (tool: AgentToolApiData) => {
    if (!agentId || toolStatusUpdatingId) return;
    try {
      setToolStatusUpdatingId(tool.id);
      setError('');
      const updated = await apiRequest<AgentToolApiData>(`/agents/${agentId}/tools/${tool.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status: tool.status === 'active' ? 'inactive' : 'active' }),
      });
      setTools((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSuccessMsg(updated.status === 'active' ? 'Tool activated for this agent.' : 'Tool deactivated for this agent.');
      window.setTimeout(() => setSuccessMsg(null), 3000);
      if (updated.status !== 'active' && testingToolId === updated.id) setTestingToolId(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Tool status could not be updated');
    } finally {
      setToolStatusUpdatingId(null);
    }
  };

  const testTool = async (toolId: string) => {
    if (!agentId || toolTestRunning) return;
    try {
      setToolTestRunning(true);
      setError('');
      setToolTestResult(null);
      const argumentsValue = parseToolJsonObject(toolTestArguments, 'Test arguments');
      const result = await apiRequest<unknown>(`/agents/${agentId}/tools/${toolId}/test`, {
        method: 'POST', body: JSON.stringify({ arguments: argumentsValue }),
      });
      setToolTestResult(result);
      setSuccessMsg('Webhook tool test completed successfully.');
      window.setTimeout(() => setSuccessMsg(null), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Webhook tool test failed');
    } finally {
      setToolTestRunning(false);
    }
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
  const selectedSummaryLlmModel = llmModels.find((model) => model.id === agent.postCallSummaryModelId);
  const summaryLlmUnavailable = Boolean(agent.postCallSummaryModelId && !selectedSummaryLlmModel);
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
  const renderModelParameters = (model: ProviderModelOption | undefined, variant: 'default' | 'stt' | 'tts' = 'default') => {
    if (!model) return <div className="mt-5 rounded-xl border border-dashed border-slate-200 p-4 text-xs font-semibold text-slate-400">Select a Super Admin model to view its configuration.</div>;
    const entries = [...Object.entries(model.settings), ...Object.entries(model.capabilities).map(([key, value]) => [`capability.${key}`, value] as const)];
    if (variant === 'stt') {
      return (
        <div className="zea-stt-parameters mt-5 rounded-2xl border border-amber-200/70 bg-amber-50/15 p-4">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <div>
                <span className="block text-sm font-black uppercase tracking-wide text-slate-800">Super Admin Model Parameters</span>
              </div>
            </div>
            <span className="zea-stt-model-badge self-start rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 font-mono text-xs font-bold text-[#b78513]">{model.modelKey}</span>
          </div>
          {entries.length ? (
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {entries.map(([key, value]) => {
                return (
                  <div key={key} className="zea-model-parameter-item flex min-w-0 items-center rounded-xl border border-slate-200 bg-white px-3.5 py-3">
                    <div className="min-w-0">
                      <span className="block truncate text-xs font-black uppercase tracking-wide text-slate-800" title={key}>{key}</span>
                      <span className="mt-0.5 block break-words font-mono text-sm font-medium leading-tight text-slate-600">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-5 text-center text-xs font-semibold text-slate-400">No model parameters were configured by Super Admin.</div>
          )}
        </div>
      );
    }
    return (
      <div className="zea-model-parameters mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><span className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Super Admin Model Parameters</span><span className="text-[10px] font-semibold text-slate-400">Read-only for company developers</span></div>
          <span className={`${variant === 'tts' ? 'zea-tts-model-badge' : ''} zea-super-admin-model-badge rounded-md border border-indigo-100 bg-indigo-50 px-2 py-1 font-mono text-[10px] font-bold text-indigo-700`}>{model.modelKey}</span>
        </div>
        {entries.length ? <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${variant === 'tts' ? 'xl:grid-cols-3' : ''}`}>{entries.map(([key, value]) => (
          <div key={key} className="zea-model-parameter-item min-w-0 rounded-lg border border-slate-200 bg-white p-3">
            <span className="block truncate text-[9px] font-black uppercase tracking-wider text-slate-400" title={key}>{key}</span>
            <span className="mt-1 block break-words font-mono text-[11px] font-semibold text-slate-700">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
          </div>
        ))}</div> : <div className="rounded-lg border border-dashed border-slate-200 bg-white p-4 text-center text-[10px] font-semibold text-slate-400">No model parameters were configured by Super Admin.</div>}
      </div>
    );
  };

  if (loading) return <div className="w-full space-y-4" aria-label="Loading agent editor">
    <div className="animate-pulse rounded-2xl border border-slate-200 bg-white p-6"><div className="h-6 w-52 rounded bg-slate-200" /><div className="mt-3 h-3 w-full max-w-md rounded bg-slate-100" /></div>
    <div className="flex gap-3 overflow-hidden rounded-2xl border border-slate-200 bg-white p-3">{[1, 2, 3, 4, 5, 6, 7, 8].map((item) => <div key={item} className="h-10 w-24 shrink-0 animate-pulse rounded-xl bg-slate-100" />)}</div>
    <div className="animate-pulse overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="border-b border-slate-200 p-6"><div className="h-5 w-44 rounded bg-slate-200" /><div className="mt-3 h-3 w-72 max-w-full rounded bg-slate-100" /></div><div className="grid grid-cols-1 gap-5 p-6 md:grid-cols-2">{[1, 2, 3, 4].map((item) => <div key={item}><div className="mb-2 h-3 w-28 rounded bg-slate-200" /><div className="h-12 rounded-xl bg-slate-100" /></div>)}</div></div>
    <div className="animate-pulse overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="border-b border-slate-200 p-6"><div className="h-5 w-36 rounded bg-slate-200" /></div><div className="grid grid-cols-1 gap-5 p-6 md:grid-cols-2"><div><div className="mb-2 h-3 w-24 rounded bg-slate-200" /><div className="h-12 rounded-xl bg-slate-100" /></div><div><div className="mb-2 h-3 w-24 rounded bg-slate-200" /><div className="h-12 rounded-xl bg-slate-100" /></div></div></div>
  </div>;

  return (
    <>
    <form onSubmit={handleSave} className={`zea-agent-editor flex min-h-full flex-col overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xs ${role === 'DEVELOPER' ? 'zea-developer-agent-editor' : ''}`}>
      {/* Upper Status strip / Banner */}
      <div className="zea-agent-editor-header bg-gradient-to-r from-violet-600 via-indigo-600 to-amber-500 p-6 text-white flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <span className="text-xs font-bold uppercase tracking-widest text-violet-100">AGENT EDITOR</span>
          <h2 className="text-2xl font-bold mt-1 tracking-tight">{agentId ? agent.name : 'Provision New Voice Agent'}</h2>
          {/* <p className="zea-agent-editor-subtitle text-xs text-violet-100/80 font-medium mt-0.5">Customize real-time listening, speech engines, prompting brains, and integrations.</p> */}
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
      <div className={`border-b border-slate-100 bg-slate-50/50 p-4 ${role === 'DEVELOPER' ? 'zea-developer-agent-tabs' : ''}`}>
        <div className="flex w-full items-center justify-between gap-4">
          <div className="zea-agent-tabs-scroll flex-1 overflow-x-auto overflow-y-hidden py-1">
            <div className="bg-[#f1f5f9] rounded-full p-1 flex items-center gap-0.5 w-max">
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
                        ? `${role === 'DEVELOPER' ? 'zea-developer-agent-tab-active' : ''} bg-white text-slate-800 shadow-sm border border-slate-200/50 font-black`
                        : `${role === 'DEVELOPER' ? 'zea-developer-agent-tab-inactive' : ''} text-slate-500 hover:text-slate-800`
                    }`}
                    id={`agent-tab-${t.id}`}
                  >
                    <Icon className={`w-3.5 h-3.5 ${isActive ? (role === 'DEVELOPER' ? 'zea-developer-agent-tab-icon-active' : 'text-[#dfa822]') : 'text-slate-400'}`} />
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
          <div className="w-full space-y-8">
            {/* Agent Identity Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-amber-50/40 p-5 border-b border-amber-100/50 flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center border border-amber-200/50">
                  <Sliders className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Agent Identity</h3>
                  <p className="text-xs text-slate-500 font-semibold">Basic information about your agent.</p>
                </div>
              </div>
              
              <div className="p-6 space-y-6">
                {agentId && (
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <label className="block text-xs font-bold text-slate-600 uppercase tracking-wide">Agent ID</label>
                      <FieldInfoTooltip
                        id="agent-id-information"
                        text="Use this identifier in authenticated API and n8n call-task requests."
                      />
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2 pl-4">
                      <span className="min-w-0 flex-1 break-all font-mono text-xs font-bold text-slate-700">{agentId}</span>
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(agentId)}
                        title="Copy Agent ID"
                        className="rounded-lg border border-slate-200 bg-white p-2.5 text-slate-500 transition hover:border-amber-200 hover:text-amber-600"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
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
                    className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
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
                    className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                    placeholder="Provide a detailed description of what the agent does..."
                  />
                </div>

                <div>
                  <div className="flex items-center space-x-1.5 mb-1.5">
                    <label className="block text-xs font-bold text-slate-600 uppercase tracking-wide">
                      Agent Goal <span className="text-amber-500">*</span>
                    </label>
                    <FieldInfoTooltip
                      id="agent-goal-information"
                      text="The primary objectives or goals this agent is set up to achieve during phone conversations."
                    />
                  </div>
                  <textarea
                    rows={4}
                    required
                    value={agent.goal || ''}
                    disabled={isReadOnly}
                    onChange={(e) => setAgent({ ...agent, goal: e.target.value })}
                    className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                    placeholder="What is the ultimate objective of the agent?"
                  />
                </div>
              </div>
            </div>

            {/* Configuration Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-slate-50/55 p-5 border-b border-slate-100">
                <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Configuration</h3>
              </div>
              
              <div className="p-6 space-y-5">
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label className="block text-xs font-bold text-slate-600 uppercase tracking-wide">
                      Agent Usage <span className="text-red-500">*</span>
                    </label>
                    <FieldInfoTooltip
                      id="agent-usage-information"
                      text="Controls whether this agent can be used for incoming calls, campaigns, or both."
                    />
                  </div>
                  <div className="relative">
                    <select
                      required
                      value={agent.agentUsage || 'both'}
                      disabled={isReadOnly}
                      onChange={(event) => setAgent({ ...agent, agentUsage: event.target.value as 'inbound' | 'outbound' | 'both' })}
                      className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                    >
                      <option value="inbound">Inbound</option>
                      <option value="outbound">Outbound</option>
                      <option value="both">Both</option>
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
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
                      className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
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
                </div>
                
                  <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label className="block text-xs font-bold text-slate-600 uppercase tracking-wide">Assigned Phone Number</label>
                    <FieldInfoTooltip
                      id="assigned-phone-number-information"
                      text="Only numbers assigned to this company are available."
                    />
                  </div>
                  <select value={phoneNumberId} disabled={isReadOnly} onChange={(event) => setPhoneNumberId(event.target.value)} className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 outline-none">
                    <option value="">No inbound number</option>
                    {phoneNumbers.map((phone) => <option key={phone.id} value={phone.id}>{phone.number}</option>)}
                  </select>
                </div>
            </div>
          </div>
          </div>
        )}

        {/* TAB: LISTENER */}
        {activeTab === 'listener' && (
          <div className="w-full space-y-8">
            {/* Speech to Text Card */}
            <div className="zea-stt-card overflow-hidden rounded-2xl border border-amber-200/70 bg-white shadow-xs">
              <div className="flex items-center space-x-4 border-b border-amber-200/60 bg-amber-50/30 p-6 sm:p-7">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-200/70 bg-amber-50 text-[#dfa822]">
                  <Mic className="zea-main-stt-icon h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-xl font-extrabold tracking-tight text-slate-900">Speech to Text</h3>
                  <p className="mt-1 text-sm font-medium text-slate-600">Configure speech recognition and processing settings.</p>
                </div>
              </div>
              
              <div className="p-6 sm:p-8">
                <div className="grid grid-cols-1 gap-7 md:grid-cols-2">
                  {/* STT Provider dropdown */}
                  <div>
                    <label className="mb-3 flex items-center text-xs font-black uppercase tracking-wider text-slate-800">
                      STT PROVIDER <span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <select
                        value={agent.sttProvider}
                        disabled
                        className="w-full appearance-none rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm font-semibold text-slate-800 outline-none transition focus:border-amber-500"
                      >
                        <option value={selectedSttModel?.providerName ?? agent.sttProvider}>{(selectedSttModel?.providerName ?? agent.sttProvider) || 'Select a model below'}</option>
                      </select>
                    </div>
                  </div>

                  {/* Model dropdown */}
                  <div>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <label className="text-xs font-black uppercase tracking-wider text-slate-800">
                        MODEL / LANGUAGE MODEL <span className="text-red-500 ml-0.5">*</span>
                      </label>
                      <button type="button" disabled={modelsRefreshing} onClick={() => setModelCatalogRefreshKey((value) => value + 1)} className="flex items-center gap-1.5 text-xs font-bold text-[#c48b10] transition hover:text-[#9a6900] disabled:opacity-50">
                        {modelsRefreshing ? 'Refreshing...' : 'Refresh models'}
                      </button>
                    </div>
                    <div className="relative">
                      <select
                        value={sttModelId}
                        disabled={isReadOnly}
                        onChange={(e) => { const model = sttModels.find((item) => item.id === e.target.value); setSttModelId(e.target.value); setAgent({ ...agent, sttProvider: model?.providerName ?? '', sttModel: model?.displayName ?? '' }); }}
                        className="w-full cursor-pointer appearance-none rounded-2xl border border-slate-200 bg-white py-4 pl-5 pr-20 text-sm font-semibold text-slate-800 outline-none transition focus:border-amber-500"
                      >
                        <option value="">Unselect STT model</option>
                        {sttModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.providerName}</option>)}
                      </select>
                      <div className="absolute inset-y-0 right-4 flex items-center gap-2 text-slate-700">
                        {sttModelId && !isReadOnly && <button type="button" title="Unselect STT model" aria-label="Unselect STT model" onClick={() => { setSttModelId(''); setAgent({ ...agent, sttProvider: '', sttModel: '' }); }} className="rounded-md px-2 py-1 text-[10px] font-bold text-slate-500 hover:bg-red-50 hover:text-red-500">Clear</button>}
                      </div>
                    </div>
                  </div>
                </div>

                {renderModelParameters(selectedSttModel, 'stt')}
              </div>
            </div>

            {/* Transcript-confirmed interruption control */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-start space-x-3">
                    <div>
                      <h4 className="text-sm font-extrabold text-slate-800 tracking-tight flex items-center gap-1">
                        Interruption Control
                      </h4>
                      <p className="text-xs text-slate-500 font-medium">The agent stops only after STT confirms meaningful customer speech. Sound alone never interrupts.</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isReadOnly}
                    onClick={() => setAgent({ ...agent, timeBasedInterruptionEnabled: !agent.timeBasedInterruptionEnabled })}
                    className={`zea-interruption-toggle relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 transition-colors duration-200 ease-in-out focus:outline-none ${
                      agent.timeBasedInterruptionEnabled ? 'border-[#dfa822] bg-[#dfa822]' : 'zea-toggle-inactive border-slate-400 bg-slate-300'
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
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <FieldInfoTooltip
                        id="speech-confirmation-delay-information"
                        text="After customer speech is confirmed by STT, this delay helps avoid accidental interruptions. It never interrupts on sound alone."
                        triggerContent={<span className="block text-[11px] font-black uppercase tracking-wider text-slate-500">Speech Confirmation Delay (ms)</span>}
                      />
                    </div>
                    <input
                      type="number"
                      min={150}
                      max={1500}
                      step={50}
                      value={agent.speechConfirmationDelayMs ?? 350}
                      disabled={isReadOnly}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setAgent({ ...agent, speechConfirmationDelayMs: Number.isFinite(value) ? Math.min(1500, Math.max(150, value)) : 350 });
                      }}
                      className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3.5 text-xs font-semibold text-slate-800 transition outline-none disabled:bg-slate-50"
                    />
                    <p className="mt-1.5 text-[11px] font-medium text-slate-400">Default: 350 ms. Allowed range: 150–1500 ms.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Transcript phrase rules */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-start space-x-3">
                    <div>
                      <h4 className="text-sm font-extrabold text-slate-800 tracking-tight flex items-center gap-1">
                        Speech Phrase Rules
                      </h4>
                      <p className="text-xs text-slate-500 font-medium">Continue phrases keep agent audio playing. Explicit stop phrases request a safe interruption.</p>
                    </div>
                  </div>
                </div>

                {agent.timeBasedInterruptionEnabled && (
                  <div className="mt-6 pt-6 border-t border-slate-100 space-y-5">
                    <div>
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <FieldInfoTooltip
                          id="minimum-meaningful-words-information"
                          text="Normal customer speech needs this many recognized words before it can interrupt the agent. Explicit stop phrases remain supported separately."
                          triggerContent={<span className="block text-[11px] font-black uppercase tracking-wider text-slate-500">Minimum Meaningful Words</span>}
                        />
                      </div>
                      <div className="relative">
                        <select
                          value={agent.minimumMeaningfulWords ?? 2}
                          disabled={isReadOnly}
                          onChange={(event) => setAgent({ ...agent, minimumMeaningfulWords: Number(event.target.value) })}
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                        >
                          {[1, 2, 3].map((count) => (
                            <option key={count} value={count}>{count} {count === 1 ? 'word' : 'words'}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <FieldInfoTooltip
                          id="acknowledgement-phrases-information"
                          text="While the agent is speaking, these short acknowledgements will not stop its audio. Enter one or more values separated by commas. Maximum 20."
                          triggerContent={<span className="block text-[11px] font-black uppercase tracking-wider text-slate-500">Acknowledgement / Continue Phrases</span>}
                        />
                        <button
                          type="button"
                          disabled={isReadOnly || !newAcknowledgementPhrase.trim() || (agent.acknowledgementPhrases?.length ?? 0) >= 20}
                          onClick={() => addInterruptionPhrases('acknowledgementPhrases', newAcknowledgementPhrase)}
                          className="zea-trigger-add-button rounded-lg border border-[#a8750d] bg-[#c18a12] px-3 py-1.5 text-xs font-black text-black transition hover:bg-[#ad790d] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          + Add
                        </button>
                      </div>
                      <input
                        type="text"
                        value={newAcknowledgementPhrase}
                        disabled={isReadOnly || (agent.acknowledgementPhrases?.length ?? 0) >= 20}
                        onChange={(event) => setNewAcknowledgementPhrase(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addInterruptionPhrases('acknowledgementPhrases', newAcknowledgementPhrase);
                          }
                        }}
                        placeholder="Example: ம், சரி, ok, சொல்லுங்க"
                        className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none disabled:bg-slate-50"
                      />
                      {(agent.acknowledgementPhrases?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {agent.acknowledgementPhrases?.map((phrase) => (
                            <span key={phrase} className="zea-interruption-trigger-chip inline-flex items-center gap-1.5 rounded-full bg-sky-50 border border-sky-100 px-3 py-1.5 text-xs font-bold text-sky-700">
                              {phrase}
                              {!isReadOnly && <button type="button" aria-label={`Remove ${phrase}`} onClick={() => setAgent({ ...agent, acknowledgementPhrases: agent.acknowledgementPhrases?.filter((value) => value !== phrase) })} className="zea-trigger-chip-remove inline-flex h-4 w-4 items-center justify-center rounded-full text-sky-700 transition hover:bg-sky-200/70"><X className="h-3 w-3" aria-hidden="true" /></button>}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1.5">
                          <FieldInfoTooltip
                            id="explicit-stop-phrases-information"
                            text="When STT confirms one of these phrases, the agent safely stops speaking and listens. Enter one or more values separated by commas. Maximum 20."
                            triggerContent={(
                              <span className="block text-[11px] font-black uppercase tracking-wider text-slate-500">
                                Explicit Stop Phrases <span className="normal-case font-semibold text-slate-400">(optional)</span>
                              </span>
                            )}
                          />
                        </div>
                        <button
                          type="button"
                          disabled={isReadOnly || !newExplicitStopPhrase.trim() || (agent.explicitStopPhrases?.length ?? 0) >= 20}
                          onClick={() => addInterruptionPhrases('explicitStopPhrases', newExplicitStopPhrase)}
                          className="zea-trigger-add-button rounded-lg border border-[#a8750d] bg-[#c18a12] px-3 py-1.5 text-xs font-black text-black transition hover:bg-[#ad790d] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          + Add
                        </button>
                      </div>
                      <div>
                        <input
                          type="text"
                          value={newExplicitStopPhrase}
                          disabled={isReadOnly || (agent.explicitStopPhrases?.length ?? 0) >= 20}
                          onChange={(event) => setNewExplicitStopPhrase(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              addInterruptionPhrases('explicitStopPhrases', newExplicitStopPhrase);
                            }
                          }}
                          placeholder="Example: ஒரு நிமிஷம், wait, stop"
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none disabled:bg-slate-50"
                        />
                      </div>
                      {(agent.explicitStopPhrases?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {agent.explicitStopPhrases?.map((trigger) => (
                            <span key={trigger} className="zea-interruption-trigger-chip inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-100 px-3 py-1.5 text-xs font-bold text-amber-700">
                              {trigger}
                              {!isReadOnly && (
                                <button
                                  type="button"
                                  aria-label={`Remove ${trigger}`}
                                  onClick={() => setAgent({
                                    ...agent,
                                    explicitStopPhrases: agent.explicitStopPhrases?.filter((value) => value !== trigger),
                                  })}
                                  className="zea-trigger-chip-remove inline-flex h-4 w-4 items-center justify-center rounded-full text-amber-700 transition hover:bg-amber-200/70 hover:text-amber-900"
                                >
                                  <X className="h-3 w-3" aria-hidden="true" />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-4">
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <FieldInfoTooltip
                          id="call-check-phrases-information"
                          text="Add short phrases callers use only to check whether the line is active. Save Tamil, Tanglish, or English phrases, separated by commas. Maximum 20."
                          triggerContent={<span className="block text-[11px] font-black uppercase tracking-wider text-slate-500">Call Check Phrases</span>}
                        />
                        <button
                          type="button"
                          disabled={isReadOnly || !newCallCheckPhrase.trim() || (agent.callCheckPhrases?.length ?? 0) >= 20}
                          onClick={() => addInterruptionPhrases('callCheckPhrases', newCallCheckPhrase)}
                          className="zea-trigger-add-button rounded-lg border border-violet-300 bg-violet-600 px-3 py-1.5 text-xs font-black text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          + Add
                        </button>
                      </div>
                      <input
                        type="text"
                        value={newCallCheckPhrase}
                        disabled={isReadOnly || (agent.callCheckPhrases?.length ?? 0) >= 20}
                        onChange={(event) => setNewCallCheckPhrase(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addInterruptionPhrases('callCheckPhrases', newCallCheckPhrase);
                          }
                        }}
                        placeholder="Example: hello, கேக்குதா, இருக்கீங்களா"
                        className="w-full bg-white border border-slate-200 focus:border-violet-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none disabled:bg-slate-50"
                      />
                      {(agent.callCheckPhrases?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {agent.callCheckPhrases?.map((phrase) => (
                            <span key={phrase} className="zea-interruption-trigger-chip inline-flex items-center gap-1.5 rounded-full bg-violet-100 border border-violet-200 px-3 py-1.5 text-xs font-bold text-violet-800">
                              {phrase}
                              {!isReadOnly && <button type="button" aria-label={`Remove ${phrase}`} onClick={() => setAgent({ ...agent, callCheckPhrases: agent.callCheckPhrases?.filter((value) => value !== phrase) })} className="zea-trigger-chip-remove inline-flex h-4 w-4 items-center justify-center rounded-full text-violet-700 transition hover:bg-violet-200"><X className="h-3 w-3" aria-hidden="true" /></button>}
                            </span>
                          ))}
                        </div>
                      )}

                      <label className="mt-4 block text-[11px] font-black uppercase tracking-wider text-slate-500" htmlFor="call-check-response">Call Check Response</label>
                      <textarea
                        id="call-check-response"
                        value={agent.callCheckResponse ?? ''}
                        disabled={isReadOnly}
                        maxLength={500}
                        onChange={(event) => setAgent({ ...agent, callCheckResponse: event.target.value })}
                        placeholder="Example: ஆமாங்க, கேக்குதுங்க. சொல்லுங்க."
                        className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-500 disabled:bg-slate-50"
                      />
                      <p className="mt-1.5 text-[11px] font-medium text-slate-500">Saved as the short immediate response for a configured call-check phrase. It is kept separate from Knowledge Base and LLM instructions.</p>
                    </div>

                    <div className="hidden" aria-hidden="true">
                      <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                        Policy
                      </label>
                      <div className="relative">
                        <select
                          value={agent.interruptionPolicy ?? 'any'}
                          disabled={isReadOnly}
                          onChange={(event) => setAgent({ ...agent, interruptionPolicy: event.target.value as 'any' | 'all' })}
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
                        >
                          <option value="any">Any — time or word condition can interrupt</option>
                          <option value="all">All — both time and word conditions must pass</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB: BRAIN */}
        {activeTab === 'brain' && (
          <div className="zea-brain-tab w-full space-y-8">
            {/* Model Configuration Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              {/* Header with Save Model button */}
              <div className="bg-amber-50/40 p-5 border-b border-amber-100/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <div className="zea-brain-icon-box w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center border border-amber-200/50">
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
                  className="flex items-center space-x-1.5 px-4 py-2 border border-[#dfa822] text-[#dfa822] hover:bg-amber-50 rounded-xl text-xs font-black transition cursor-pointer self-start sm:self-auto shadow-2xs"
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
                        className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
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
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <label className="text-[11px] font-black text-slate-500 uppercase tracking-wider">AI MODEL <span className="text-red-500 ml-0.5">*</span></label>
                      <button type="button" disabled={modelsRefreshing} onClick={() => setModelCatalogRefreshKey((value) => value + 1)} className="flex items-center gap-1 text-[10px] font-bold text-amber-600 hover:text-amber-700 disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${modelsRefreshing ? 'animate-spin' : ''}`} /> {modelsRefreshing ? 'Refreshing...' : 'Refresh models'}</button>
                    </div>
                    <div className="relative">
                      <select
                        value={llmModelId}
                        disabled={isReadOnly}
                        onChange={(e) => { const model = llmModels.find((item) => item.id === e.target.value); setLlmModelId(e.target.value); setAgent({ ...agent, llmProvider: model?.providerName ?? '', llmModel: model?.displayName ?? '' }); }}
                        className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-20"
                      >
                        <option value="">Unselect LLM model</option>
                        {llmModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.providerName}</option>)}
                      </select>
                      <div className="absolute inset-y-0 right-3 flex items-center gap-2 text-slate-400">
                        {llmModelId && !isReadOnly && <button type="button" title="Unselect LLM model" aria-label="Unselect LLM model" onClick={() => { setLlmModelId(''); setAgent({ ...agent, llmProvider: '', llmModel: '' }); }} className="rounded-md px-2 py-1 text-[10px] font-bold text-slate-500 hover:bg-red-50 hover:text-red-500">Clear</button>}
                        <ChevronDown className="w-4 h-4 pointer-events-none" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Interaction Settings Card */}
                <div className="lg:col-span-5 bg-white border border-slate-100 rounded-2xl p-5 shadow-2xs hover:border-amber-100 transition relative">
                  <div className="flex items-center space-x-1.5 text-[#dfa822] mb-4">
                    <Sparkles className="w-4 h-4" />
                    <span className="text-xs font-black uppercase tracking-wider">Interaction Settings</span>
                  </div>

                  <div className="space-y-4">
                    {/* Greeting Mode */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 mb-1.5 uppercase">Greeting Mode</label>
                      <div className="relative">
                        <select
                          value={agent.greetingMode || 'agent_initiates'}
                          disabled={isReadOnly}
                          onChange={(e) => setAgent({ ...agent, greetingMode: e.target.value as 'agent_initiates' | 'user_initiates' })}
                          className="w-full bg-slate-50 border border-slate-200 focus:border-amber-500 rounded-xl px-3 py-2.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-8"
                        >
                          <option value="agent_initiates">Agent Initiates (Standard)</option>
                          <option value="user_initiates">User Initiates</option>
                        </select>
                        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                          <ChevronDown className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    </div>

                  </div>
                </div>
              </div>
              <div className="px-6 pb-6">{renderModelParameters(selectedLlmModel)}</div>
            </div>

            {/* Conversation continuity and callback configuration */}
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
                <div className="zea-conversation-memory-header flex items-center gap-3 border-b border-violet-100 bg-violet-50/50 p-5">
                  <div className="zea-brain-icon-box flex h-10 w-10 items-center justify-center rounded-xl border border-violet-200 bg-violet-100 text-violet-600">
                    <BookOpen className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-extrabold text-slate-800">Conversation Memory</h3>
                      <FieldInfoTooltip
                        id="conversation-memory-information"
                        text="Live-call context controls what the agent remembers during one call. Cache Policy separately controls whether later calls continue it."
                      />
                    </div>
                    <p className="text-xs font-semibold text-slate-500">Control whether later calls continue the previous conversation.</p>
                  </div>
                </div>
                <div className="space-y-5 p-6">
                  <div>
                    <label className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Cache Policy</label>
                    <div className="relative">
                      <select
                        value={agent.cachePolicy || 'persistent_24h'}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, cachePolicy: event.target.value as 'persistent_24h' | 'session_only' | 'disabled' })}
                        className="w-full appearance-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 pr-10 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-500 focus:bg-white"
                      >
                        <option value="persistent_24h">24h Persistent + Permanent Memory</option>
                        <option value="session_only">Current Call Only</option>
                        <option value="disabled">Memory Disabled</option>
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-4 top-3.5 h-4 w-4 text-slate-400" />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Conversation Context Mode</label>
                      <div className="relative">
                        <select
                          value={agent.conversationContextMode || 'last_n_turns'}
                          disabled={isReadOnly}
                          onChange={(event) => setAgent({
                            ...agent,
                            conversationContextMode: event.target.value as 'last_n_turns' | 'full_current_call',
                          })}
                          className="w-full appearance-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 pr-10 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-500 focus:bg-white"
                        >
                          <option value="last_n_turns">Last N Turns</option>
                          <option value="full_current_call">Full Current Call</option>
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-4 top-3.5 h-4 w-4 text-slate-400" />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Recent Turns</label>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={agent.conversationContextTurns ?? 5}
                        disabled={isReadOnly || agent.conversationContextMode === 'full_current_call'}
                        onChange={(event) => setAgent({ ...agent, conversationContextTurns: Number(event.target.value) })}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-500 focus:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                  </div>
                  <p className="text-[10px] font-semibold leading-relaxed text-slate-400">
                    One turn contains a customer message and the related agent response. Full Current Call keeps the complete finalized conversation in process until hangup.
                  </p>
                  <div className="rounded-xl border border-violet-100 bg-violet-50/30 p-4">
                    <div className="mb-3">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Knowledge Match Confidence</label>
                      <p className="mt-1 text-[10px] font-semibold leading-relaxed text-slate-400">
                        High-confidence Workflow and Catalog matches answer directly. Uncertain matches ask for confirmation instead of guessing.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div>
                        <label className="mb-1 block text-[10px] font-bold text-slate-500">High Confidence</label>
                        <input
                          type="number"
                          min={0.7}
                          max={1}
                          step={0.01}
                          value={agent.knowledgeHighConfidence ?? 0.86}
                          disabled={isReadOnly}
                          onChange={(event) => setAgent({ ...agent, knowledgeHighConfidence: Number(event.target.value) })}
                          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-bold text-slate-500">Clarification Confidence</label>
                        <input
                          type="number"
                          min={0.4}
                          max={0.99}
                          step={0.01}
                          value={agent.knowledgeClarificationConfidence ?? 0.64}
                          disabled={isReadOnly}
                          onChange={(event) => setAgent({ ...agent, knowledgeClarificationConfidence: Number(event.target.value) })}
                          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-bold text-slate-500">Ambiguity Margin</label>
                        <input
                          type="number"
                          min={0.01}
                          max={0.25}
                          step={0.01}
                          value={agent.knowledgeAmbiguityMargin ?? 0.06}
                          disabled={isReadOnly}
                          onChange={(event) => setAgent({ ...agent, knowledgeAmbiguityMargin: Number(event.target.value) })}
                          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                        />
                      </div>
                    </div>
                    <div className="mt-3">
                      <label className="mb-1 block text-[10px] font-bold text-slate-500">Clarification Message</label>
                      <textarea
                        rows={2}
                        maxLength={500}
                        value={agent.knowledgeClarificationMessage || ''}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, knowledgeClarificationMessage: event.target.value })}
                        placeholder="I may not have heard the item correctly. Did you mean {{candidates}}?"
                        className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                      />
                      <p className="mt-1 text-[10px] font-semibold text-slate-400">Use {'{{candidates}}'} where the matched Workflow or Catalog names should appear.</p>
                    </div>
                    <div className="mt-3">
                      <label className="mb-1 block text-[10px] font-bold text-slate-500">Latency Acknowledgement</label>
                      <textarea
                        rows={2}
                        maxLength={500}
                        value={agent.latencyAcknowledgementMessage || ''}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, latencyAcknowledgementMessage: event.target.value })}
                        placeholder="One moment while I check the information."
                        className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                      />
                      <p className="mt-1 text-[10px] font-semibold text-slate-400">Spoken only when the grounded answer cannot begin before the first-audio deadline.</p>
                    </div>
                    <div className="mt-3">
                      <label className="mb-1 block text-[10px] font-bold text-slate-500">Technical Failure Message</label>
                      <textarea
                        rows={2}
                        maxLength={500}
                        required={agent.status === 'active'}
                        value={agent.technicalFailureMessage || ''}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, technicalFailureMessage: event.target.value })}
                        placeholder="Required tenant-configured speech for a technical failure"
                        className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                      />
                      <p className="mt-1 text-[10px] font-semibold text-slate-400">Used only for retrieval, hydration, prompt, provider, JSON, or validation failures. It is never used as clarification.</p>
                    </div>
                    <div className="mt-3">
                      <label className="mb-1 block text-[10px] font-bold text-slate-500">Information Unavailable Message</label>
                      <textarea
                        rows={2}
                        maxLength={500}
                        required={agent.status === 'active'}
                        value={agent.informationUnavailableMessage || ''}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, informationUnavailableMessage: event.target.value })}
                        placeholder="Configured speech when the question is clear but published knowledge has no answer"
                        className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                      />
                      <p className="mt-1 text-[10px] font-semibold text-slate-400">Used only when no caller-facing evidence answers a clear question. It is not a technical failure or inactivity prompt.</p>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Context Namespace</label>
                      <FieldInfoTooltip
                        id="context-namespace-information"
                        text="The backend combines this namespace with the tenant, workspace, agent, and customer identity. It never shares memory across companies."
                      />
                    </div>
                    <input
                      type="text"
                      value={agent.contextId || ''}
                      placeholder="Optional, e.g. sales_lead"
                      maxLength={160}
                      disabled={isReadOnly || agent.cachePolicy === 'disabled'}
                      onChange={(event) => setAgent({ ...agent, contextId: event.target.value })}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-500 focus:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div>
                        <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Important Information Fields</label>
                        <p className="mt-1 text-[10px] font-semibold text-slate-400">Define reusable information for this agent. No industry-specific fields are built into the runtime.</p>
                      </div>
                      {!isReadOnly && (
                        <button
                          type="button"
                          onClick={() => setAgent({
                            ...agent,
                            conversationMemoryFields: [
                              ...(agent.conversationMemoryFields || []),
                              { key: '', label: '', type: 'text', required: true, question: '', requiredAction: '' },
                            ],
                          })}
                          className="flex shrink-0 items-center gap-1 rounded-lg bg-violet-600 px-3 py-2 text-[10px] font-black text-white transition hover:bg-violet-700"
                        >
                          <Plus className="h-3.5 w-3.5" /> Add Field
                        </button>
                      )}
                    </div>
                    <div className="space-y-3">
                      {(agent.conversationMemoryFields || []).length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-4 text-center text-[10px] font-semibold text-slate-400">
                          No important information fields configured.
                        </div>
                      ) : agent.conversationMemoryFields?.map((field, index) => (
                        <div key={`${field.key}-${index}`} className="rounded-xl border border-violet-100 bg-violet-50/30 p-3">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <input
                              type="text"
                              value={field.key}
                              disabled={isReadOnly}
                              maxLength={64}
                              placeholder="Field key, e.g. customer_name"
                              onChange={(event) => {
                                const fields = [...(agent.conversationMemoryFields || [])];
                                fields[index] = { ...field, key: event.target.value };
                                setAgent({ ...agent, conversationMemoryFields: fields });
                              }}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                            />
                            <input
                              type="text"
                              value={field.label}
                              disabled={isReadOnly}
                              maxLength={100}
                              placeholder="Label, e.g. Customer Name"
                              onChange={(event) => {
                                const fields = [...(agent.conversationMemoryFields || [])];
                                fields[index] = { ...field, label: event.target.value };
                                setAgent({ ...agent, conversationMemoryFields: fields });
                              }}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                            />
                            <select
                              value={field.type}
                              disabled={isReadOnly}
                              onChange={(event) => {
                                const fields = [...(agent.conversationMemoryFields || [])];
                                fields[index] = { ...field, type: event.target.value as typeof field.type };
                                setAgent({ ...agent, conversationMemoryFields: fields });
                              }}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                            >
                              <option value="text">Text</option><option value="number">Number</option>
                              <option value="date">Date</option><option value="time">Time</option>
                              <option value="boolean">Yes / No</option><option value="select">Selection</option>
                              <option value="email">Email</option><option value="phone">Phone</option>
                            </select>
                            <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-600">
                              <input
                                type="checkbox"
                                checked={field.required !== false}
                                disabled={isReadOnly}
                                onChange={(event) => {
                                  const fields = [...(agent.conversationMemoryFields || [])];
                                  fields[index] = { ...field, required: event.target.checked };
                                  setAgent({ ...agent, conversationMemoryFields: fields });
                                }}
                              /> Required
                            </label>
                          </div>
                          <div className="mt-3 flex gap-2">
                            <input
                              type="text"
                              value={field.question}
                              disabled={isReadOnly}
                              maxLength={500}
                              placeholder="Question the agent should ask when this field is missing"
                              onChange={(event) => {
                                const fields = [...(agent.conversationMemoryFields || [])];
                                fields[index] = { ...field, question: event.target.value };
                                setAgent({ ...agent, conversationMemoryFields: fields });
                              }}
                              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                            />
                            {!isReadOnly && (
                              <button
                                type="button"
                                aria-label={`Remove ${field.label || field.key || 'information field'}`}
                                onClick={() => setAgent({
                                  ...agent,
                                  conversationMemoryFields: (agent.conversationMemoryFields || []).filter((_, fieldIndex) => fieldIndex !== index),
                                })}
                                className="rounded-lg border border-red-100 bg-red-50 px-3 text-red-600 hover:bg-red-100"
                              ><Trash2 className="h-4 w-4" /></button>
                            )}
                          </div>
                          <input
                            type="text"
                            value={field.requiredAction || ''}
                            disabled={isReadOnly}
                            maxLength={80}
                            placeholder="Required action (optional), e.g. appointment_booking"
                            onChange={(event) => {
                              const fields = [...(agent.conversationMemoryFields || [])];
                              fields[index] = { ...field, requiredAction: event.target.value };
                              setAgent({ ...agent, conversationMemoryFields: fields });
                            }}
                            className="mt-3 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold outline-none focus:border-violet-500"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                  {agent.cachePolicy !== 'session_only' && (
                    <div className={`rounded-xl border p-4 text-[11px] font-semibold leading-relaxed ${agent.cachePolicy === 'persistent_24h' ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                      {agent.cachePolicy === 'persistent_24h'
                        ? 'Redis provides the 24-hour fast cache. PostgreSQL remains the permanent tenant-isolated source of truth.'
                        : 'Previous-call context will not be loaded or saved for this agent.'}
                    </div>
                  )}
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
                <div className="flex items-center justify-between gap-4 border-b border-amber-100 bg-amber-50/50 p-5">
                  <div className="flex items-center gap-3">
                    <div className="zea-brain-icon-box flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200 bg-amber-100 text-amber-600">
                      <PhoneCall className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-extrabold text-slate-800">Customer Callback</h3>
                      <p className="text-xs font-semibold text-slate-500">Handle explicit callback requests during outbound campaigns.</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="zea-callback-badge-outbound rounded-full bg-blue-50 px-2 py-0.5 text-xs font-black uppercase leading-4 text-blue-700">Outbound campaigns</span>
                        <span className="zea-callback-badge-detection rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-black uppercase leading-4 text-emerald-800">Code + LLM detection</span>
                        <span className="zea-callback-badge-retry rounded-full bg-blue-50 px-2 py-0.5 text-xs font-black uppercase leading-4 text-blue-800">Uses one retry</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={agent.callbackEnabled !== false}
                    disabled={isReadOnly}
                    onClick={() => setAgent({ ...agent, callbackEnabled: agent.callbackEnabled === false })}
                    className={`inline-flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors ${
                      agent.callbackEnabled !== false ? 'justify-end bg-amber-500' : 'justify-start bg-slate-400'
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <span className="h-5 w-5 shrink-0 rounded-full bg-white shadow-sm" />
                  </button>
                </div>
                <div className={`space-y-5 p-6 ${agent.callbackEnabled === false ? 'pointer-events-none opacity-45' : ''}`}>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Minimum Delay (seconds)</label>
                      <input type="number" min={30} max={86400} value={agent.callbackMinimumDelaySeconds ?? 30} disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, callbackMinimumDelaySeconds: Number(event.target.value) })}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-800 outline-none focus:border-amber-500 focus:bg-white" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Maximum Delay (days)</label>
                      <input type="number" min={1} max={30} value={agent.callbackMaximumDelayDays ?? 30} disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, callbackMaximumDelayDays: Number(event.target.value) })}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-800 outline-none focus:border-amber-500 focus:bg-white" />
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <input type="checkbox" checked={agent.callbackCloseAfterScheduling !== false} disabled={isReadOnly}
                      onChange={(event) => setAgent({ ...agent, callbackCloseAfterScheduling: event.target.checked })}
                      className="mt-0.5 h-4 w-4 accent-amber-500" />
                    <span><span className="block text-xs font-extrabold text-slate-700">Confirm and end the current call</span><span className="mt-1 block text-[10px] font-semibold text-slate-400">When disabled, the agent confirms the callback and continues the conversation.</span></span>
                  </label>
                </div>
              </div>
            </div>

            {agent.callbackEnabled !== false && (
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
                <div className="border-b border-slate-100 p-5">
                  <h3 className="text-sm font-extrabold text-slate-800">Callback Language & Industry Instructions</h3>
                  <p className="mt-1 text-xs font-semibold text-slate-500">These trusted instructions are given to the selected LLM. Write them for this company and industry.</p>
                </div>
                <div className="grid grid-cols-1 gap-5 p-6 lg:grid-cols-2">
                  {([
                    ['Successful Scheduling', 'callbackConfirmationInstructions', 'Tell the agent how to confirm a successfully scheduled callback.'],
                    ['Unclear Time', 'callbackClarificationInstructions', 'Tell the agent how to ask for a clearer callback time.'],
                    ['Scheduling Failure', 'callbackFailureInstructions', 'Tell the agent what to say when scheduling fails or retries are exhausted.'],
                    ['Follow-Up Opening', 'callbackFollowUpOpeningInstructions', 'Tell the agent how the next connected callback should begin.'],
                  ] as const).map(([label, field, help]) => (
                    <div key={field}>
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</label>
                        <FieldInfoTooltip
                          id={`${field}-information`}
                          text={help}
                        />
                      </div>
                      <textarea rows={4} maxLength={2000} value={agent[field] || ''} disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, [field]: event.target.value })}
                        className="w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold leading-relaxed text-slate-800 outline-none transition focus:border-amber-500 focus:bg-white" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Welcome Message Section */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs p-6 space-y-4">
              <div className="flex items-center space-x-2">
                <MessageSquare className="w-4 h-4 text-[#dfa822]" />
                <h4 className="text-sm font-extrabold text-slate-800 tracking-tight">Welcome Message</h4>
              </div>

              {/* Purple input buffer header */}
              <div className="rounded-xl overflow-hidden border border-violet-100">
                <textarea
                  rows={3}
                  value={agent.welcomeMessage || ''}
                  disabled={isReadOnly}
                  onChange={(e) => setAgent({ ...agent, welcomeMessage: e.target.value })}
                  className="w-full bg-white p-4 text-xs font-semibold text-slate-800 outline-none resize-y transition focus:ring-1 focus:ring-[#dfa822]/30"
                  placeholder="Welcome sentence when user joins the call..."
                />
              </div>
            </div>

            {/* Silent Message Section */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4 text-[#dfa822]" />
                  <h4 className="text-sm font-extrabold text-slate-800 tracking-tight">Silent Message</h4>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex items-center space-x-2">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Inactivity Timeout (s)</span>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      value={agent.inactivityTimeout !== undefined ? agent.inactivityTimeout : 5}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({ ...agent, inactivityTimeout: parseInt(e.target.value) || 5 })}
                      className="w-16 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-bold text-center text-slate-800 outline-none focus:border-amber-500 transition"
                    />
                  </label>
                  <label className="flex items-center justify-end space-x-2">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Maximum Prompts</span>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={agent.maxInactivityPrompts ?? 1}
                      disabled={isReadOnly}
                      onChange={(e) => setAgent({
                        ...agent,
                        maxInactivityPrompts: Number.parseInt(e.target.value, 10) || 1,
                      })}
                      className="w-16 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-bold text-center text-slate-800 outline-none focus:border-amber-500 transition"
                    />
                  </label>
                </div>
              </div>

              {/* Orange/Yellow Banner for Hidden Context */}
              <div className="rounded-xl overflow-hidden border border-amber-100">
                <textarea
                  rows={3}
                  value={agent.silentMessage || ''}
                  disabled={isReadOnly}
                  onChange={(e) => setAgent({ ...agent, silentMessage: e.target.value })}
                  className="w-full bg-white p-4 text-xs font-semibold text-slate-800 outline-none resize-y transition focus:ring-1 focus:ring-[#dfa822]/30"
                  placeholder="e.g. I can't hear you. Are you still on the call?"
                />
              </div>
              <p className="text-[10px] font-semibold leading-relaxed text-slate-400">
                The agent repeats this message up to Maximum Prompts times. If the caller remains silent, the next timeout ends the call.
              </p>
            </div>

            {/* System Prompt / Instructions Section */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs p-6 space-y-4">
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-[#dfa822]" />
                <h4 className="text-sm font-extrabold text-slate-800 tracking-tight">System Prompt / Instructions</h4>
              </div>

              {/* Terminal code header style */}
              <div className="zea-core-directive-editor rounded-xl overflow-hidden border border-slate-200 shadow-sm">
                <div className="zea-core-directive-header bg-[#f8fafc] px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-xs font-extrabold text-slate-500 font-mono">CORE_DIRECTIVE.PY</span>
                </div>
                <textarea
                  rows={10}
                  value={agent.prompt}
                  disabled={isReadOnly}
                  aria-invalid={Boolean(promptLimitError)}
                  onChange={(e) => setAgent({ ...agent, prompt: e.target.value })}
                  className={`w-full bg-slate-950 p-5 text-xs text-[#38bdf8] font-mono leading-relaxed outline-none resize-y ${promptLimitError ? 'ring-2 ring-inset ring-red-500' : ''}`}
                  placeholder="Define the core system instructions and guidelines for your AI voice agent here..."
                />
              </div>
              <div className="flex items-start justify-between gap-4 text-[11px] font-semibold">
                <p className={promptLimitError ? 'text-red-600' : 'text-slate-500'}>
                  {promptLimitError || 'The maximum is loaded from the backend runtime configuration.'}
                </p>
                <span className={promptLimitError ? 'shrink-0 text-red-600' : 'shrink-0 text-slate-500'}>
                  {promptCharacterCount.toLocaleString()} / {systemPromptMaxCharacters?.toLocaleString() ?? '...'} characters
                </span>
              </div>
            </div>
          </div>
        )}

        {/* TAB: SPEAKER */}
        {activeTab === 'speaker' && (
          <div className="w-full space-y-8">
            {/* Voice Configuration Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-amber-50/40 p-5 border-b border-amber-100/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center border border-amber-200/50">
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
                  className="flex items-center space-x-1.5 px-4 py-2 border border-[#dfa822] text-[#dfa822] hover:bg-amber-50 rounded-xl text-xs font-black transition cursor-pointer self-start sm:self-auto shadow-2xs"
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
                        className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
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
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <label className="text-[11px] font-black text-slate-500 uppercase tracking-wider">MODEL <span className="text-red-500 ml-0.5">*</span></label>
                      <button type="button" disabled={modelsRefreshing} onClick={() => setModelCatalogRefreshKey((value) => value + 1)} className="flex items-center gap-1 text-[10px] font-bold text-amber-600 hover:text-amber-700 disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${modelsRefreshing ? 'animate-spin' : ''}`} /> {modelsRefreshing ? 'Refreshing...' : 'Refresh models'}</button>
                    </div>
                    <div className="relative">
                      <select
                        value={ttsModelId}
                        disabled={isReadOnly}
                        onChange={(e) => { const model = ttsModels.find((item) => item.id === e.target.value); setTtsModelId(e.target.value); setAgent({ ...agent, ttsProvider: model?.providerName ?? '', ttsModel: model?.displayName ?? '', voiceId: model ? modelVoiceId(model) : '' }); }}
                        className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-20"
                      >
                        <option value="">Unselect TTS model</option>
                        {ttsModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.providerName}</option>)}
                      </select>
                      <div className="absolute inset-y-0 right-3 flex items-center gap-2 text-slate-400">
                        {ttsModelId && !isReadOnly && <button type="button" title="Unselect TTS model" aria-label="Unselect TTS model" onClick={() => { setTtsModelId(''); setAgent({ ...agent, ttsProvider: '', ttsModel: '', voiceId: '' }); }} className="rounded-full p-1 hover:bg-red-50 hover:text-red-500"><X className="h-3.5 w-3.5" /></button>}
                        <ChevronDown className="w-4 h-4 pointer-events-none" />
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

                {renderModelParameters(selectedTtsModel, 'tts')}

                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/70">
                  <div className="border-b border-slate-200 bg-white px-5 py-4">
                    <h4 className="text-sm font-extrabold text-slate-800">Usage &amp; Call Limits</h4>
                    <p className="mt-1 text-[10px] font-semibold text-slate-500">Phase 1 limits saved separately for this agent. Enter 0 for unlimited.</p>
                  </div>
                  <div className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500">
                        <MessageSquare className="h-3.5 w-3.5 text-pink-500" />Maximum Characters Per Response
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={5000}
                        step={1}
                        value={agent.ttsMaxCharactersPerResponse ?? 0}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({
                          ...agent,
                          ttsMaxCharactersPerResponse: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                        })}
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold text-slate-800 outline-none transition focus:border-pink-500 disabled:cursor-not-allowed disabled:bg-slate-100"
                      />
                      <span className="mt-1.5 block text-[10px] font-semibold text-slate-400">Limits each individual agent answer. The runtime keeps only complete sentences.</span>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500">
                        <FileText className="h-3.5 w-3.5 text-pink-500" />Maximum Characters Per Minute
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step={1}
                        value={agent.ttsMaxCharactersPerMinute ?? 0}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({
                          ...agent,
                          ttsMaxCharactersPerMinute: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                        })}
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold text-slate-800 outline-none transition focus:border-pink-500 disabled:cursor-not-allowed disabled:bg-slate-100"
                      />
                      <span className="mt-1.5 block text-[10px] font-semibold text-slate-400">Limits the text sent to TTS during each rolling 60-second window.</span>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500">
                        <Clock className="h-3.5 w-3.5 text-pink-500" />Maximum Minutes Per Call
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={120}
                        step={1}
                        value={agent.maxCallDurationMinutes ?? 0}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({
                          ...agent,
                          maxCallDurationMinutes: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                        })}
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold text-slate-800 outline-none transition focus:border-pink-500 disabled:cursor-not-allowed disabled:bg-slate-100"
                      />
                      <span className="mt-1.5 block text-[10px] font-semibold text-slate-400">Defines the maximum connected duration for one call.</span>
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />Complete Fallback Message
                      </span>
                      <input
                        type="text"
                        maxLength={500}
                        value={agent.ttsLimitFallbackMessage ?? ''}
                        disabled={isReadOnly}
                        onChange={(event) => setAgent({ ...agent, ttsLimitFallbackMessage: event.target.value })}
                        placeholder="இந்த தகவலை சுருக்கமாகச் சொல்றேன். மீண்டும் கேட்க முடியுமா?"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold text-slate-800 outline-none transition focus:border-pink-500 disabled:cursor-not-allowed disabled:bg-slate-100"
                      />
                      <span className="mt-1.5 block text-[10px] font-semibold text-slate-400">Used only when no complete generated sentence fits. It must itself fit within the response limit.</span>
                    </label>
                    <div className="sm:col-span-2 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      <div><p className="text-[10px] font-black uppercase tracking-wider text-emerald-700">Complete Sentence Protection · Always On</p><p className="mt-1 text-[10px] font-semibold leading-relaxed text-emerald-700/80">Tamil, English and Tanglish responses are segmented before TTS. Words and sentences are never cut in the middle.</p></div>
                    </div>
                  </div>
                </div>

                <PronunciationGroupManager
                  agentId={agentId}
                  selectedGroupIds={pronunciationGroupIds}
                  onSelectionChange={setPronunciationGroupIds}
                  defaultLanguage={agent.language || 'und'}
                  readOnly={isReadOnly}
                  onError={setError}
                  onSuccess={(message) => {
                    setSuccessMsg(message);
                    window.setTimeout(() => setSuccessMsg(null), 3000);
                  }}
                />
              </div>
            </div>

            <div>
              {/* Background Sound Card */}
              <AmbienceManager
                selectedAssetId={ambienceAssetId}
                onSelectionChange={(id) => {
                  setAmbienceAssetId(id);
                  setAgent((current) => ({ ...current, ttsAmbienceType: id ? 'Company Ambience' : 'Silent (Default)' }));
                }}
                readOnly={isReadOnly}
                onError={setError}
                onSuccess={(message) => {
                  setSuccessMsg(message);
                  window.setTimeout(() => setSuccessMsg(null), 3000);
                }}
              />

            </div>
          </div>
        )}

        {/* TAB: PRECALL */}
        {activeTab === 'precall' && (
          <div className="w-full space-y-8">
            {/* PreCall Settings Header Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-amber-50/40 p-5 border-b border-amber-100/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center border border-amber-200/50">
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
                  className="flex items-center space-x-1.5 px-4 py-2 border border-[#dfa822] text-[#dfa822] hover:bg-amber-50 rounded-xl text-xs font-black transition cursor-pointer self-start sm:self-auto shadow-2xs"
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
                      className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
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

                {/* Description Field */}
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label className="block text-[11px] font-black uppercase tracking-wider text-slate-500">Description</label>
                    <FieldInfoTooltip
                      id="pre-call-description-information"
                      text="For developer reference only. This description is not sent to the AI or webhook."
                    />
                  </div>
                  <textarea
                    rows={4}
                    disabled={isReadOnly}
                    value={agent.preCallDescription || ''}
                    onChange={(e) => setAgent({ ...agent, preCallDescription: e.target.value })}
                    placeholder="Describe what this Pre-Call integration loads, for example customer details from your CRM."
                    className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-2xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                  />
                </div>

                {/* Pre-Call API Toggle & Fields */}
                <div className="border-t border-slate-100 pt-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <h4 className="text-xs font-black uppercase tracking-wider text-slate-700">Pre-Call API</h4>
                        <FieldInfoTooltip
                          id="pre-call-api-information"
                          text="Enable API execution prior to connecting the call."
                        />
                      </div>
                    </div>
                    <div className="flex items-center space-x-2.5">
                      <button
                        type="button"
                        disabled={isReadOnly}
                        onClick={() => setAgent({ ...agent, preCallApiActive: !agent.preCallApiActive })}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          agent.preCallApiActive ? 'bg-[#dfa822]' : 'bg-slate-200'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                            agent.preCallApiActive ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                      <span className={`text-xs font-bold ${agent.preCallApiActive ? 'text-[#dfa822]' : 'text-slate-400'}`}>
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
                            className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
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
                              className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
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
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                        />
                      </div>

                      {/* Request Body */}
                      <div>
                        <div className="mb-1.5 flex items-center gap-1.5">
                          <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Request Body</label>
                          <FieldInfoTooltip
                            id="pre-call-request-body-information"
                            text={'Variables: ${caller}, ${callee}, ${customer_number}, ${platform_number}, ${call_uuid}, ${direction}, ${agent_id}, ${company_id}, ${workspace_id}.'}
                          />
                        </div>
                        <input
                          type="text"
                          value={agent.preCallApiRequestBody || ''}
                          disabled={isReadOnly}
                          onChange={(e) => setAgent({ ...agent, preCallApiRequestBody: e.target.value })}
                          placeholder='{ "customer_number": "${customer_number}", "call_uuid": "${call_uuid}" }'
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                        />
                      </div>

                      {/* Response Mapping */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-1.5">
                          <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Response Mapping</label>
                          <FieldInfoTooltip
                            id="pre-call-response-mapping-information"
                            text={'Return { "context": { "customer_name": "Shanmugam" } } directly, or map fields from any JSON response below. Context values are available to the welcome message and AI.'}
                          />
                        </div>

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
                            className="flex items-center space-x-1.5 px-4 py-2 border border-[#dfa822] text-[#dfa822] hover:bg-amber-50 rounded-xl text-xs font-black transition cursor-pointer shadow-2xs"
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
          <div className="w-full space-y-8">
            {/* Post Call Configuration Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs animate-fade-in">
              <div className="bg-amber-50/40 p-5 border-b border-amber-100/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center border border-amber-200/50">
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
                  className="flex items-center space-x-1.5 px-4 py-2 border border-[#dfa822] text-[#dfa822] hover:bg-amber-50 rounded-xl text-xs font-black transition cursor-pointer self-start sm:self-auto shadow-2xs"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Post Call</span>
                </button>
              </div>

              <div className="p-6 space-y-6">
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
                      className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
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

                {(agent.postCallMessageType || 'Dynamic') === 'Dynamic' && <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                      Dynamic Closing Prompt
                    </label>
                    <textarea
                      rows={4}
                      disabled={isReadOnly}
                      value={agent.postCallPrompt || ''}
                      onChange={(e) => setAgent({ ...agent, postCallPrompt: e.target.value })}
                      placeholder="Describe when and how the AI should close the call..."
                      className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-2xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                    />
                  </div>
                  <div className="zea-postcall-llm-helper rounded-xl border border-violet-100 bg-violet-50 px-4 py-3 text-[10px] font-semibold leading-relaxed text-violet-700">
                    The selected LLM will generate one brief, contextual closing message in the customer&apos;s language.
                  </div>
                </div>}

                {agent.postCallMessageType === 'Static' && <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    Static Closing Message
                  </label>
                  <textarea
                    rows={3}
                    disabled={isReadOnly}
                    value={agent.postCallStaticMessage || ''}
                    onChange={(e) => setAgent({ ...agent, postCallStaticMessage: e.target.value })}
                    placeholder="Enter the exact message the agent should speak before ending the call..."
                    className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-2xl px-4 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                  />
                  <p className="mt-1.5 text-[10px] font-semibold text-slate-400">The agent will speak this exact text without asking the LLM to rewrite it.</p>
                </div>}

                {agent.postCallMessageType === 'None' && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[10px] font-semibold leading-relaxed text-amber-800">
                  No closing message will be spoken. The call will end after pending tools and required data operations are finished.
                </div>}

                {/* Uninterruptible Reasons */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    Uninterruptible Reasons
                  </label>
                  
                  <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs hover:border-amber-200 transition">
                    <div className="flex flex-wrap items-center gap-2">
                      {(!agent.postCallUninterruptibleReasons || agent.postCallUninterruptibleReasons.length === 0) ? (
                        <span className="text-xs font-bold text-slate-400 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100">
                          No uninterruptible reasons listed yet.
                        </span>
                      ) : (
                        agent.postCallUninterruptibleReasons.map((reason, idx) => (
                          <span key={idx} className="text-xs font-bold text-[#dfa822] bg-amber-50 border border-amber-100 px-3 py-1.5 rounded-lg flex items-center gap-1.5 animate-fade-in">
                            {reason}
                            {!isReadOnly && (
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = (agent.postCallUninterruptibleReasons || []).filter((_, i) => i !== idx);
                                  setAgent({ ...agent, postCallUninterruptibleReasons: updated });
                                }}
                                className="text-amber-400 hover:text-amber-600 font-extrabold focus:outline-none"
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
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl pl-4 pr-12 py-3 text-xs font-semibold text-slate-800 transition outline-none"
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
                          className="absolute right-2 w-8 h-8 rounded-full bg-amber-500 hover:bg-amber-600 text-white flex items-center justify-center transition cursor-pointer shadow-sm"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Call End Trigger Phrases */}
                <div>
                  <label className="block text-[11px] font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                    Call End Trigger Phrases
                  </label>
                  <p className="mb-3 text-[10px] font-semibold leading-relaxed text-slate-400">
                    Add phrases that mean the customer wants to end the call. Tamil, English and Tanglish are supported. The agent will use these phrases in a later runtime update.
                  </p>
                  <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs hover:border-amber-200 transition">
                    <div className="flex flex-wrap items-center gap-2">
                      {(!agent.callEndTriggerPhrases || agent.callEndTriggerPhrases.length === 0) ? (
                        <span className="text-xs font-bold text-slate-400 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100">
                          No call end trigger phrases added yet.
                        </span>
                      ) : (
                        agent.callEndTriggerPhrases.map((phrase, idx) => (
                          <span key={`${phrase}-${idx}`} className="text-xs font-bold text-rose-600 bg-rose-50 border border-rose-100 px-3 py-1.5 rounded-lg flex items-center gap-1.5 animate-fade-in">
                            {phrase}
                            {!isReadOnly && (
                              <button
                                type="button"
                                onClick={() => setAgent({
                                  ...agent,
                                  callEndTriggerPhrases: (agent.callEndTriggerPhrases || []).filter((_, index) => index !== idx),
                                })}
                                className="text-rose-400 hover:text-rose-600 font-extrabold focus:outline-none"
                                aria-label={`Remove ${phrase}`}
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
                          placeholder="Example: bye, வேண்டாம், பிறகு பேசலாம்"
                          value={newCallEndTriggerPhrase}
                          onChange={(event) => setNewCallEndTriggerPhrase(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            const phrase = newCallEndTriggerPhrase.normalize('NFKC').trim().replace(/\s+/gu, ' ');
                            if (!phrase) { setError('Enter a Call End Trigger Phrase before adding it.'); return; }
                            if (phrase.length > 160) { setError('Each Call End Trigger Phrase cannot exceed 160 characters.'); return; }
                            const current = agent.callEndTriggerPhrases || [];
                            if (current.some((entry) => entry.toLocaleLowerCase() === phrase.toLocaleLowerCase())) {
                              setError('This Call End Trigger Phrase is already added.'); return;
                            }
                            if (current.length >= 50) { setError('You can add up to 50 Call End Trigger Phrases.'); return; }
                            setAgent({ ...agent, callEndTriggerPhrases: [...current, phrase] });
                            setNewCallEndTriggerPhrase('');
                            setError('');
                          }}
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl pl-4 pr-12 py-3 text-xs font-semibold text-slate-800 transition outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const phrase = newCallEndTriggerPhrase.normalize('NFKC').trim().replace(/\s+/gu, ' ');
                            if (!phrase) { setError('Enter a Call End Trigger Phrase before adding it.'); return; }
                            if (phrase.length > 160) { setError('Each Call End Trigger Phrase cannot exceed 160 characters.'); return; }
                            const current = agent.callEndTriggerPhrases || [];
                            if (current.some((entry) => entry.toLocaleLowerCase() === phrase.toLocaleLowerCase())) {
                              setError('This Call End Trigger Phrase is already added.'); return;
                            }
                            if (current.length >= 50) { setError('You can add up to 50 Call End Trigger Phrases.'); return; }
                            setAgent({ ...agent, callEndTriggerPhrases: [...current, phrase] });
                            setNewCallEndTriggerPhrase('');
                            setError('');
                          }}
                          className="absolute right-2 w-8 h-8 rounded-full bg-amber-500 hover:bg-amber-600 text-white flex items-center justify-center transition cursor-pointer shadow-sm"
                          aria-label="Add call end trigger phrase"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Task Completion Auto Close */}
                <div className="overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50/40 shadow-2xs">
                  <div className="flex flex-col gap-4 border-b border-emerald-100 bg-emerald-50/70 p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h4 className="text-sm font-extrabold text-slate-800">Task Completion Auto Close</h4>
                      <p className="mt-1 text-[10px] font-semibold leading-relaxed text-slate-500">
                        After a future runtime update, the agent can confirm a completed task and end the call when every required item is collected.
                      </p>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={agent.taskCompletionEnabled === true}
                        disabled={isReadOnly}
                        onClick={() => setAgent({ ...agent, taskCompletionEnabled: agent.taskCompletionEnabled !== true })}
                        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                          agent.taskCompletionEnabled ? 'bg-emerald-600' : 'bg-slate-200'
                        }`}
                      >
                        <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition ${
                          agent.taskCompletionEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                      </button>
                      <span className={`text-xs font-bold ${agent.taskCompletionEnabled ? 'text-emerald-700' : 'text-slate-400'}`}>
                        {agent.taskCompletionEnabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                  </div>

                  <div className={`space-y-5 p-5 ${agent.taskCompletionEnabled ? '' : 'opacity-60'}`}>
                    <div>
                      <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-slate-500">Completion Intent</label>
                      <input
                        type="text"
                        disabled={isReadOnly || !agent.taskCompletionEnabled}
                        value={agent.taskCompletionIntent || ''}
                        onChange={(event) => setAgent({ ...agent, taskCompletionIntent: event.target.value })}
                        placeholder="Example: appointment_booking"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-semibold text-slate-800 outline-none transition focus:border-emerald-500 disabled:cursor-not-allowed"
                      />
                      <p className="mt-1.5 text-[10px] font-semibold text-slate-400">Use lowercase letters, numbers, underscores or hyphens.</p>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-slate-500">Required Information</label>
                      <p className="mb-3 text-[10px] font-semibold leading-relaxed text-slate-400">
                        The future completion flow will close only after every field is collected and validated. Example: patient_name, patient_age, selected_package, appointment_date, appointment_time.
                      </p>
                      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
                        <div className="flex flex-wrap gap-2">
                          {(agent.taskCompletionRequiredFields || []).length === 0 ? (
                            <span className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-400">No required information added yet.</span>
                          ) : agent.taskCompletionRequiredFields?.map((field, index) => (
                            <span key={`${field}-${index}`} className="flex items-center gap-1.5 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
                              {field}
                              {!isReadOnly && (
                                <button
                                  type="button"
                                  aria-label={`Remove ${field}`}
                                  onClick={() => setAgent({
                                    ...agent,
                                    taskCompletionRequiredFields: (agent.taskCompletionRequiredFields || []).filter((_, entryIndex) => entryIndex !== index),
                                  })}
                                  className="font-extrabold text-emerald-500 hover:text-emerald-700"
                                >&times;</button>
                              )}
                            </span>
                          ))}
                        </div>
                        {!isReadOnly && (
                          <div className="relative flex items-center">
                            <input
                              type="text"
                              disabled={!agent.taskCompletionEnabled}
                              value={newCompletionRequiredField}
                              onChange={(event) => setNewCompletionRequiredField(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter') return;
                                event.preventDefault();
                                const field = newCompletionRequiredField.trim().toLowerCase();
                                if (!field) return;
                                const current = agent.taskCompletionRequiredFields || [];
                                if (current.includes(field)) { setError('This Required Information field is already added.'); return; }
                                setAgent({ ...agent, taskCompletionRequiredFields: [...current, field] });
                                setNewCompletionRequiredField('');
                                setError('');
                              }}
                              placeholder="Example: patient_name"
                              className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-4 pr-12 text-xs font-semibold text-slate-800 outline-none transition focus:border-emerald-500 disabled:cursor-not-allowed"
                            />
                            <button
                              type="button"
                              disabled={!agent.taskCompletionEnabled}
                              onClick={() => {
                                const field = newCompletionRequiredField.trim().toLowerCase();
                                if (!field) return;
                                const current = agent.taskCompletionRequiredFields || [];
                                if (current.includes(field)) { setError('This Required Information field is already added.'); return; }
                                setAgent({ ...agent, taskCompletionRequiredFields: [...current, field] });
                                setNewCompletionRequiredField('');
                                setError('');
                              }}
                              className="absolute right-2 flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label="Add required information"
                            ><Plus className="h-4 w-4" /></button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold text-slate-600">
                        <input
                          type="checkbox"
                          checked={agent.taskCompletionRequiresCatalogItem === true}
                          disabled={isReadOnly || !agent.taskCompletionEnabled}
                          onChange={(event) => setAgent({ ...agent, taskCompletionRequiresCatalogItem: event.target.checked })}
                        />
                        Require a valid Catalog item before collecting fields
                      </label>
                      <div>
                        <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-slate-500">Catalog Field</label>
                        <input
                          type="text"
                          value={agent.taskCompletionCatalogField || ''}
                          disabled={isReadOnly || !agent.taskCompletionEnabled || !agent.taskCompletionRequiresCatalogItem}
                          maxLength={64}
                          onChange={(event) => setAgent({ ...agent, taskCompletionCatalogField: event.target.value })}
                          placeholder="Example: selected_item"
                          className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-semibold text-slate-800 outline-none transition focus:border-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-50"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-slate-500">Completion Confirmation Message</label>
                      <textarea
                        rows={3}
                        disabled={isReadOnly || !agent.taskCompletionEnabled}
                        value={agent.taskCompletionConfirmationMessage || ''}
                        onChange={(event) => setAgent({ ...agent, taskCompletionConfirmationMessage: event.target.value })}
                        placeholder="Example: சரிங்க {{patient_name}}, உங்க {{selected_package}} appointment பதிவு பண்ணியாச்சு."
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-semibold text-slate-800 outline-none transition focus:border-emerald-500 disabled:cursor-not-allowed"
                      />
                      <p className="mt-1.5 text-[10px] font-semibold text-slate-400">This will be spoken before the configured Post-Call closing and automatic hangup.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Post-Call AI Summary Configuration */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
              <div className="flex flex-col gap-4 border-b border-violet-100 bg-violet-50/40 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center space-x-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-200/50 bg-violet-100 text-violet-600">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold tracking-tight text-slate-800">AI Call Summary</h3>
                    <p className="text-xs font-semibold text-slate-500">Generate a structured summary after the call without affecting the live conversation.</p>
                  </div>
                </div>

                <div className="flex items-center space-x-2.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={agent.postCallSummaryEnabled === true}
                    disabled={isReadOnly}
                    onClick={() => setAgent({ ...agent, postCallSummaryEnabled: !agent.postCallSummaryEnabled })}
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                      agent.postCallSummaryEnabled ? 'bg-violet-600' : 'bg-slate-200'
                    }`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition duration-200 ${
                      agent.postCallSummaryEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`} />
                  </button>
                  <span className={`text-xs font-bold ${agent.postCallSummaryEnabled ? 'text-violet-700' : 'text-slate-400'}`}>
                    {agent.postCallSummaryEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </div>

              <div className={`space-y-6 p-6 ${agent.postCallSummaryEnabled ? '' : 'opacity-60'}`}>
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <label className="block text-[11px] font-black uppercase tracking-wider text-slate-500">Summary LLM</label>
                    <span className="text-[10px] font-semibold text-slate-400">Active Super Admin LLM models</span>
                  </div>
                  <div className="relative">
                    <select
                      value={agent.postCallSummaryModelId || ''}
                      disabled={isReadOnly || !agent.postCallSummaryEnabled}
                      onChange={(e) => setAgent({ ...agent, postCallSummaryModelId: e.target.value })}
                      className="w-full appearance-none rounded-xl border border-slate-200 bg-white px-4 py-3 pr-10 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-500 disabled:cursor-not-allowed disabled:bg-slate-50"
                    >
                      <option value="">Select summary LLM</option>
                      {summaryLlmUnavailable && (
                        <option value={agent.postCallSummaryModelId}>Previously selected model — unavailable</option>
                      )}
                      {llmModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.displayName} — {model.providerName}</option>
                      ))}
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4 text-slate-400">
                      <ChevronDown className="h-4 w-4" />
                    </div>
                  </div>
                  {summaryLlmUnavailable && (
                    <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-700">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <p className="text-[10px] font-semibold leading-4">This model is inactive, deleted, or its provider is disconnected. Refresh models and select an available LLM before saving.</p>
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label className="block text-[11px] font-black uppercase tracking-wider text-slate-500">Summary Instructions</label>
                    <FieldInfoTooltip
                      id="post-call-summary-instructions-information"
                      text="These instructions are used only by the selected post-call summarization model."
                    />
                  </div>
                  <textarea
                    rows={5}
                    value={agent.postCallSummaryInstructions || ''}
                    disabled={isReadOnly || !agent.postCallSummaryEnabled}
                    onChange={(e) => setAgent({ ...agent, postCallSummaryInstructions: e.target.value })}
                    placeholder="Describe what the summary must capture for this agent and industry."
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs font-semibold text-slate-800 outline-none transition focus:border-violet-500 disabled:cursor-not-allowed disabled:bg-slate-50"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {[
                    {
                      label: 'Include Transcript in Webhook',
                      description: 'Send the complete saved transcript with the Post-Call webhook.',
                      checked: agent.postCallIncludeTranscript !== false,
                      toggle: () => setAgent({ ...agent, postCallIncludeTranscript: agent.postCallIncludeTranscript === false }),
                    },
                    {
                      label: 'Include Summary in Webhook',
                      description: 'Send the structured AI summary with the Post-Call webhook.',
                      checked: agent.postCallIncludeSummary !== false,
                      toggle: () => setAgent({ ...agent, postCallIncludeSummary: agent.postCallIncludeSummary === false }),
                    },
                  ].map((option) => (
                    <div key={option.label} className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                      <div>
                        <p className="text-xs font-black text-slate-700">{option.label}</p>
                        <p className="mt-1 text-[10px] font-semibold leading-4 text-slate-400">{option.description}</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label={option.label}
                        aria-checked={option.checked}
                        disabled={isReadOnly || !agent.postCallSummaryEnabled}
                        onClick={option.toggle}
                        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${
                          option.checked ? 'bg-violet-600' : 'bg-slate-200'
                        }`}
                      >
                        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition duration-200 ${
                          option.checked ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 text-blue-700">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="text-[10px] font-semibold leading-4">Task 1 stores this configuration only. Background summary generation and webhook enrichment will be connected in the following tasks.</p>
                </div>
              </div>
            </div>

            {/* Endpoint Details Section Card */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-[#dfa822]">
                  <Globe className="w-5 h-5" />
                  <span className="text-xs font-black uppercase tracking-wider">Endpoint Details</span>
                </div>
                
                <div className="flex items-center space-x-2.5">
                  <button
                    type="button"
                    disabled={isReadOnly}
                    onClick={() => setAgent({ ...agent, postCallEndpointDetailsActive: !agent.postCallEndpointDetailsActive })}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      agent.postCallEndpointDetailsActive ? 'bg-[#dfa822]' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        agent.postCallEndpointDetailsActive ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                  <span className={`text-xs font-bold ${agent.postCallEndpointDetailsActive ? 'text-[#dfa822]' : 'text-slate-400'}`}>
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
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none appearance-none cursor-pointer pr-10"
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
                        className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                    <div>
                      <p className="text-xs font-black text-slate-800">Include Caller &amp; Callee Numbers in Webhook</p>
                      <p className="mt-1 text-[10px] font-semibold leading-4 text-slate-500">
                        Sends <code>fromNumber</code> and <code>toNumber</code> to this Post-Call webhook. For inbound calls: caller to company DID; for outbound calls: company DID to customer.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={isReadOnly}
                      onClick={() => setAgent({ ...agent, postCallIncludePhoneNumbers: agent.postCallIncludePhoneNumbers !== true })}
                      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${
                        agent.postCallIncludePhoneNumbers ? 'bg-[#dfa822]' : 'bg-slate-200'
                      } ${isReadOnly ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                      aria-label="Include caller and callee phone numbers in Post-Call webhook"
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition duration-200 ${
                        agent.postCallIncludePhoneNumbers ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
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
                        className="flex items-center space-x-1.5 px-4 py-2 border border-slate-200 hover:border-[#dfa822] text-slate-700 hover:text-[#dfa822] hover:bg-amber-50 rounded-xl text-xs font-black transition cursor-pointer shadow-2xs"
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
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Live Conversational Tool Integrations</h3><p className="mt-1 text-[11px] font-medium text-slate-400">Tools registered here belong only to this saved agent and company workspace.</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setToolRefreshKey((value) => value + 1)} disabled={!agentId || toolsLoading} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${toolsLoading ? 'animate-spin' : ''}`} />Refresh Tools</button>
                {!isReadOnly && (
                  <button type="button" onClick={openToolRegistration} disabled={!agentId} className="rounded-lg bg-[#dfa822] px-4 py-2 text-xs font-black text-black transition hover:bg-[#c99118] disabled:cursor-not-allowed disabled:opacity-50">
                    + Register Tool
                  </button>
                )}
              </div>
            </div>

            {!agentId && <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800"><Info className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-xs font-bold">Save this agent before registering tools.</p><p className="mt-1 text-[11px] font-medium text-amber-700">A saved Agent ID is required so every tool is assigned to exactly one agent, tenant and workspace.</p></div></div>}

            {showToolRegistration && typeof document !== 'undefined' && createPortal(
              <div
                className="fixed inset-0 z-[2147483646] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget && !toolSaving) closeToolEditor();
                }}
              >
              {/* Tool Creator Card */}
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="register-custom-api-tool-title"
                className="zea-tool-registration-modal flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
                  <span id="register-custom-api-tool-title" className="text-sm font-bold uppercase tracking-wider text-slate-700">{editingTool ? 'Edit Custom API Tool' : 'Register Custom API Tool'}</span>
                  <button type="button" onClick={closeToolEditor} disabled={toolSaving} className="rounded-lg px-3 py-1.5 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50">Close</button>
                </div>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
                
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="block text-[10px] font-bold text-slate-400">Tool Identifier</label>
                    <FieldInfoTooltip id="tool-identifier-information" text="This identifier must exactly match the published Workflow toolIdentifier or actionKey that authorizes the action. It remains tenant- and agent-specific." />
                  </div>
                  <input
                    type="text"
                    value={newToolName}
                    disabled={isReadOnly}
                    onChange={(e) => setNewToolName(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 outline-none"
                    placeholder="e.g. check_appointment_slots"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 mb-1">Description</label>
                  <textarea
                    value={newToolDescription}
                    disabled={isReadOnly}
                    onChange={(e) => setNewToolDescription(e.target.value)}
                    rows={3}
                    maxLength={5000}
                    className="w-full resize-y bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold text-slate-800 outline-none"
                    placeholder="When should the agent use this tool and what does it return?"
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
                    <option disabled>Cal.com Scheduler — Coming Soon</option>
                    <option disabled>HubSpot CRM — Coming Soon</option>
                    <option disabled>Salesforce Sync — Coming Soon</option>
                  </select>
                </div>

                {newToolType === 'Webhook API' && (
                  <div className="space-y-4 rounded-xl border border-violet-100 bg-white p-4">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-wider text-violet-600">Webhook Configuration</p>
                      <p className="mt-1 text-[9px] font-medium leading-relaxed text-slate-400">The endpoint must return JSON containing an explicit boolean success or ok field in the same HTTP request. Only true is treated as verified action success. In n8n, use Respond to Webhook.</p>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 mb-1">Webhook URL *</label>
                      <input
                        type="url"
                        value={newToolWebhookUrl}
                        disabled={isReadOnly}
                        onChange={(e) => setNewToolWebhookUrl(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 outline-none focus:border-violet-400"
                        placeholder="https://n8n.example.com/webhook/check-slots"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 mb-1">Method</label>
                        <select value={newToolMethod} disabled={isReadOnly} onChange={(e) => setNewToolMethod(e.target.value as 'POST' | 'PUT' | 'PATCH')} className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 outline-none">
                          <option value="POST">POST</option>
                          <option value="PUT">PUT</option>
                          <option value="PATCH">PATCH</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 mb-1">Timeout (seconds)</label>
                        <input type="number" min="1" max="30" step="1" value={newToolTimeoutSeconds} disabled={isReadOnly} onChange={(e) => setNewToolTimeoutSeconds(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 outline-none" />
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="block text-[10px] font-bold text-slate-400">Request Headers (JSON)</label>
                        <FieldInfoTooltip id="tool-request-headers-information" text="Use this only for non-secret headers. Add credentials in the encrypted field below." />
                      </div>
                      <textarea value={newToolHeaders} disabled={isReadOnly} onChange={(e) => setNewToolHeaders(e.target.value)} rows={4} spellCheck={false} className="w-full resize-y bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-[10px] text-emerald-300 outline-none" />
                    </div>

                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="block text-[10px] font-bold text-slate-400">Secret Headers (Encrypted JSON)</label>
                        <FieldInfoTooltip id="tool-secret-headers-information" text="Authorization tokens and API keys are encrypted and never returned to the browser." />
                      </div>
                      <textarea value={newToolSecretHeaders} disabled={isReadOnly} onChange={(e) => setNewToolSecretHeaders(e.target.value)} rows={4} spellCheck={false} className="w-full resize-y bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-[10px] text-amber-300 outline-none" placeholder={'{\n  "Authorization": "Bearer ..."\n}'} />
                      {editingTool?.hasSecretConfiguration && <p className="mt-1 text-[9px] font-semibold text-slate-400">Leave this as {'{}'} to keep the existing encrypted secret headers.</p>}
                    </div>

                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="block text-[10px] font-bold text-slate-400">Input Schema (JSON)</label>
                        <FieldInfoTooltip id="tool-input-schema-information" text="Describe the arguments the LLM must provide when it calls this tool." />
                      </div>
                      <textarea value={newToolInputSchema} disabled={isReadOnly} onChange={(e) => setNewToolInputSchema(e.target.value)} rows={7} spellCheck={false} className="w-full resize-y bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-[10px] text-sky-300 outline-none" />
                    </div>

                    <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2">
                      <span className="text-[9px] font-black uppercase tracking-wider text-emerald-700">Response Mode</span>
                      <p className="mt-0.5 text-[10px] font-semibold text-emerald-800">Synchronous JSON response</p>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void addTool()}
                  disabled={isReadOnly || !agentId || toolSaving || !newToolName.trim() || !newToolWebhookUrl.trim()}
                  className="w-full py-2 bg-gradient-to-r from-violet-600 to-amber-500 hover:from-violet-700 hover:to-amber-600 disabled:cursor-not-allowed disabled:opacity-50 text-white rounded-lg text-xs font-bold transition shadow-sm flex items-center justify-center space-x-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{toolSaving ? (editingTool ? 'Saving...' : 'Registering...') : (editingTool ? 'Save Tool' : 'Register Tool')}</span>
                </button>
              </div>
              </div>
              </div>,
              document.body,
            )}

              {/* Active Tools List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3"><span className="text-xs font-bold uppercase tracking-wider text-slate-400">Assigned to This Agent ({tools.length})</span><span className="rounded-md bg-emerald-50 px-2 py-1 text-[9px] font-black uppercase text-emerald-700">{tools.filter((tool) => tool.status === 'active').length} active in runtime</span></div>
                {!toolsLoading && agentId && tools.filter((tool) => tool.status === 'active').length === 0 && (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="text-xs font-bold">No active action tool is available at runtime.</p>
                      <p className="mt-1 text-[11px] font-medium text-amber-700">Register or activate the required tool, make its identifier exactly match the published Workflow authorization, configure its JSON field schema, and run a successful test before placing calls.</p>
                    </div>
                  </div>
                )}
                {!toolsLoading && tools.length === 0 && agentId && <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-xs font-semibold text-slate-400">No tools are assigned to this agent yet.</div>}
                {tools.map((t) => (
                  <div key={t.id} className="bg-white border border-slate-150 rounded-xl p-4 shadow-xs">
                    <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold text-slate-800">{t.name}</span>
                        <span className="bg-violet-50 text-violet-600 text-[9px] font-bold px-1.5 py-0.5 rounded-md">{t.type}</span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${t.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>{t.status}</span>
                        <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[9px] font-bold text-blue-600">assigned</span>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-1 font-medium">{t.description}</p>
                      {t.type === 'webhook_api' && typeof t.configuration?.url === 'string' && (
                        <p className="mt-1 max-w-xl truncate font-mono text-[9px] text-slate-400">
                          {String(t.configuration.method ?? 'POST')} {' | '} {t.configuration.url}
                        </p>
                      )}
                    </div>

                    {!isReadOnly && (
                      <div className="shrink-0">
                        <TableActionsMenu
                          ariaLabel={`Actions for ${t.name}`}
                          actions={[
                            {
                              label: 'Edit',
                              onClick: () => openToolEditor(t),
                            },
                            {
                              label: toolStatusUpdatingId === t.id ? 'Updating...' : t.status === 'active' ? 'Deactivate' : 'Activate',
                              disabled: toolStatusUpdatingId === t.id,
                              onClick: () => void updateToolStatus(t),
                            },
                            ...(t.type === 'webhook_api' && t.status === 'active'
                              ? [{
                                  label: testingToolId === t.id ? 'Close Test' : 'Test Tool',
                                  onClick: () => {
                                    setTestingToolId((current) => current === t.id ? null : t.id);
                                    setToolTestArguments('{}');
                                    setToolTestResult(null);
                                  },
                                }]
                              : []),
                            {
                              label: 'Delete',
                              danger: true,
                              onClick: () => void removeTool(t.id),
                            },
                          ]}
                        />
                      </div>
                    )}
                    </div>

                    {testingToolId === t.id && (
                      <div className="mt-4 space-y-3 rounded-xl border border-violet-100 bg-violet-50/40 p-4">
                        <div>
                          <label className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-500">Test Arguments (JSON)</label>
                          <textarea value={toolTestArguments} disabled={toolTestRunning} onChange={(event) => setToolTestArguments(event.target.value)} rows={5} spellCheck={false} className="w-full resize-y rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[10px] text-sky-300 outline-none" />
                        </div>
                        <div className="flex justify-end"><button type="button" disabled={toolTestRunning} onClick={() => void testTool(t.id)} className="rounded-lg bg-violet-600 px-3 py-2 text-[10px] font-bold text-white transition hover:bg-violet-700 disabled:opacity-50">{toolTestRunning ? 'Testing...' : 'Run Test'}</button></div>
                        {toolTestResult !== null && <div><span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-emerald-700">Response</span><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-[10px] text-emerald-300">{JSON.stringify(toolTestResult, null, 2)}</pre></div>}
                      </div>
                    )}
                  </div>
                ))}
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

            {knowledgeBases.length > 0 && <label className="zea-knowledge-selector-card block rounded-xl border border-slate-200 bg-slate-50 p-4"><span className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Selected Knowledge Base</span><select value={selectedKnowledgeBaseId} onChange={(event) => { setSelectedKnowledgeBaseId(event.target.value); setKnowledgeFormMode(null); }} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-800 outline-none focus:border-violet-400">{knowledgeBases.map((knowledgeBase) => <option key={knowledgeBase.id} value={knowledgeBase.id}>{knowledgeBase.name} — {knowledgeBaseStatusLabel(knowledgeBase.status)} — {knowledgeBase.usageDirection}</option>)}</select></label>}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="zea-knowledge-summary-card rounded-xl border border-slate-200 bg-slate-50 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Company Knowledge Bases</span><strong className="mt-1 block text-2xl text-slate-800">{knowledgeBases.length}</strong></div>
              <div className="zea-knowledge-summary-card zea-knowledge-summary-published rounded-xl border border-emerald-100 bg-emerald-50/60 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-emerald-600">Published</span><strong className="mt-1 block text-2xl text-emerald-800">{publishedKnowledgeBaseCount}</strong></div>
              <div className="zea-knowledge-summary-card zea-knowledge-summary-assigned rounded-xl border border-violet-100 bg-violet-50/60 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-violet-600">Assigned to Agent</span><strong className="mt-1 block text-2xl text-violet-800">{knowledgeAssignments.length}</strong></div>
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
                    className={`zea-knowledge-base-list-item ${selected ? 'zea-knowledge-base-list-item-selected' : ''} w-full rounded-xl border p-4 text-left transition ${selected ? 'border-violet-400 bg-violet-50/50 ring-2 ring-violet-100' : 'border-slate-200 bg-white hover:border-violet-200 hover:bg-slate-50'}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0"><span className="block truncate text-sm font-bold text-slate-800">{knowledgeBase.name}</span><p className="mt-1 line-clamp-2 text-[11px] font-medium text-slate-500">{knowledgeBase.description || 'No description provided.'}</p></div>
                      <div className="flex flex-wrap justify-end gap-1.5"><span className={`rounded-md px-2 py-1 text-[9px] font-black uppercase ${knowledgeStatusStyles[knowledgeBase.status]}`}>{knowledgeBaseStatusLabel(knowledgeBase.status)}</span>{assignment && <span className="rounded-md bg-violet-100 px-2 py-1 text-[9px] font-black uppercase text-violet-700">Assigned</span>}</div>
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
                  {selectedKnowledgeBase.status === 'deleting' && <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">
                    {selectedKnowledgeDeletionJob?.status === 'failed' ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
                    <div className="min-w-0 flex-1 text-[10px] font-semibold">
                      <p>{selectedKnowledgeDeletionJob?.status === 'failed'
                        ? `Cleanup failed at ${deletionStageLabel(selectedKnowledgeDeletionJob)}: ${selectedKnowledgeDeletionJob.errorMessage || 'verification did not complete.'}`
                        : ['KNOWLEDGE_DELETE_ACTIVE_CALLS', 'KNOWLEDGE_DELETE_QUEUE_BUSY'].includes(selectedKnowledgeDeletionJob?.errorCode ?? '')
                          ? `Deleting permanently is waiting safely: ${selectedKnowledgeDeletionJob.errorMessage || 'active work is still using this Knowledge Base.'}`
                          : `Deleting… (${selectedKnowledgeDeletionJob?.progress ?? 0}%): removing documents, approved data, stored files and vectors. Editing, publishing and repeated deletion are disabled.`}</p>
                      {selectedKnowledgeDeletionJob?.status === 'failed' && !isReadOnly && <button type="button" onClick={() => void retryKnowledgeDeletion(selectedKnowledgeDeletionJob)} disabled={retryingKnowledgeDeletionJobIds.includes(selectedKnowledgeDeletionJob.id)} className="mt-2 rounded-md border border-red-300 bg-white px-2.5 py-1 text-[9px] font-black uppercase text-red-700 disabled:opacity-50">{retryingKnowledgeDeletionJobIds.includes(selectedKnowledgeDeletionJob.id) ? 'Retrying…' : 'Retry cleanup'}</button>}
                    </div>
                  </div>}
                  <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-[11px] font-semibold text-slate-400">Choose one of the five categories below, then upload a PDF or UTF-8 TXT file.</div>
                </div>}
              </div>
            </div>}

            {selectedKnowledgeBase && <section className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div><span className="text-[10px] font-black uppercase tracking-wider text-violet-600">PDF and UTF-8 TXT Knowledge</span><h4 className="mt-1 text-base font-bold text-slate-800">Five-category document workspace</h4><p className="mt-1 text-xs font-medium text-slate-500">Choose the category that matches the file content. Auto-detection is not used.</p></div>
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
                    <div className="flex items-start justify-between gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${index % 3 === 0 ? 'bg-violet-100 text-violet-700' : index % 3 === 1 ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}><FileText className="h-4 w-4" /></div><div className="flex flex-wrap justify-end gap-1"><span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[9px] font-bold text-slate-500">{category.type}</span>{latestDocument && <span className={`rounded-md px-2 py-1 text-[9px] font-black uppercase ${knowledgeDocumentStatusStyles[latestDocument.status]}`}>{knowledgeStatusLabel(latestDocument.status)}</span>}</div></div>
                    <h5 className="mt-3 text-sm font-bold text-slate-800">{category.title}</h5>
                    <p className="mt-1 text-[11px] font-medium leading-4 text-slate-500">{category.description}</p>
                    <p className="mt-2 text-[10px] leading-4 text-slate-400">{category.examples}</p>

                    <label onDragOver={(event) => { if (disabled) return; event.preventDefault(); setDraggedKnowledgeCategory(category.type); }} onDragLeave={() => setDraggedKnowledgeCategory(null)} onDrop={(event) => { if (disabled) return; event.preventDefault(); setDraggedKnowledgeCategory(null); void selectKnowledgeSource(category.type, event.dataTransfer.files[0] ?? null); }}
                      className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-3 py-4 text-center transition ${disabled ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60' : dragging ? 'border-violet-500 bg-violet-50' : 'border-slate-300 bg-slate-50 hover:border-violet-400 hover:bg-violet-50/40'}`}>
                      <Upload className="h-5 w-5 text-slate-400" /><span className="mt-2 text-[11px] font-bold text-slate-600">{file ? 'Replace selected file' : 'Select or drop a file'}</span><span className="mt-1 text-[9px] font-medium text-slate-400">PDF or UTF-8 TXT · Maximum {formatFileSize(KNOWLEDGE_SOURCE_MAX_BYTES)}</span>
                      <input key={`${selectedKnowledgeBase.id}-${category.type}-${file?.name ?? 'empty'}`} type="file" accept=".pdf,application/pdf,.txt,text/plain" disabled={disabled} className="sr-only" onChange={(event) => { void selectKnowledgeSource(category.type, event.target.files?.[0] ?? null); }} />
                    </label>

                    <div className="mt-3">
                      {file && <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3"><div className="min-w-0"><span className="block truncate text-[11px] font-bold text-emerald-800" title={file.name}>{file.name}</span><span className="mt-0.5 block text-[9px] font-semibold text-emerald-600">{formatFileSize(file.size)} · Ready for upload</span></div>{!disabled && <button type="button" aria-label={`Remove ${category.title} file`} onClick={() => removeKnowledgeSource(category.type)} className="shrink-0 rounded-md p-1 text-emerald-700 transition hover:bg-emerald-100 hover:text-red-600"><X className="h-4 w-4" /></button>}</div>}
                      {fileError && <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="text-[10px] font-semibold leading-4">{fileError}</span></div>}
                      {!file && !fileError && <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-center text-[9px] font-semibold text-slate-400">No file selected</div>}
                      {file && !isReadOnly && <button type="button" onClick={() => void uploadKnowledgeSource(category.type)} disabled={disabled}
                        className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-60">
                        {uploading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}{uploading ? 'Uploading to B2...' : 'Upload File'}
                      </button>}
                      {uploading && <div className="mt-2 rounded-lg border border-violet-100 bg-violet-50 p-3"><div className="mb-1.5 flex items-center justify-between text-[9px] font-bold text-violet-700"><span>Uploading file securely</span><span>{uploadProgress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-violet-100"><div className="h-full rounded-full bg-gradient-to-r from-violet-600 to-amber-500 transition-all duration-300" style={{ width: `${uploadProgress}%` }} /></div><p className="mt-1.5 text-[9px] font-medium text-violet-600">Keep this page open. Extraction progress will appear below after storage completes.</p></div>}
                      {latestDocument && <div className="mt-2 border-t border-slate-100 pt-2 text-[9px] font-semibold text-slate-400">{categoryDocuments.length} uploaded document{categoryDocuments.length === 1 ? '' : 's'} · Latest v{latestDocument.currentVersion?.versionNumber ?? 1}</div>}
                    </div>
                  </article>;
                })}
              </div>

              <div className="mt-4 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-blue-700"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p className="text-[10px] font-semibold leading-4">Supported formats: PDF and UTF-8 TXT. For Tamil/Tanglish structured documents, TXT is recommended because it preserves the exact Unicode text and line structure. Selecting a file keeps it local; uploading stores it in tenant-isolated B2 and queues the existing category processor.</p></div>
            </section>}

            {selectedKnowledgeBase && <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <div><h4 className="text-sm font-bold text-slate-800">Documents and processing</h4><p className="mt-1 text-[11px] font-medium text-slate-400">Live extraction state for {selectedKnowledgeBase.name}.</p></div>

              {knowledgeDocumentsError && <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="text-[11px] font-semibold">{knowledgeDocumentsError}</span></div>}
              {knowledgeDocumentsLoading && knowledgeDocuments.length === 0 && <div className="mt-4 space-y-2">{[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}</div>}
              {!knowledgeDocumentsLoading && !knowledgeDocumentsError && knowledgeDocuments.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-xs font-semibold text-slate-400">No knowledge file has been uploaded to this Knowledge Base.</div>}

              {knowledgeDocuments.length > 0 && <div className="mt-4 space-y-3">{knowledgeDocuments.map((document) => {
                const category = knowledgeDocumentCategories.find((item) => item.type === document.documentType);
                const documentStatus: KnowledgeDocumentStatus = document.status && document.status in knowledgeDocumentStatusStyles ? document.status : 'queued';
                const deletionJob = Object.values(knowledgeDeletionJobs).find((job) => job.type === 'delete_document' && job.documentId === document.id);
                const progress = Math.max(0, Math.min(100, Number(document.processingJob?.progress ?? (documentStatus === 'ready' || documentStatus === 'review_required' ? 100 : 0))));
                const processing = ['uploading', 'queued', 'processing'].includes(documentStatus) || document.processingJob?.status === 'queued' || document.processingJob?.status === 'running';
                const errorMessage = document.processingJob?.errorMessage;
                return <article key={document.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-xs font-bold text-slate-800" title={document.displayName || 'Knowledge document'}>{document.displayName || 'Knowledge document'}</span><span className="rounded bg-white px-1.5 py-0.5 font-mono text-[8px] font-bold text-slate-500">{category?.title ?? document.documentType ?? 'Knowledge'}</span><span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase text-slate-500">{document.mimeType === 'text/plain' ? 'TXT' : 'PDF'}</span></div><p className="mt-1 text-[9px] font-semibold text-slate-400">{document.originalFilename || 'Knowledge document'} · {formatFileSize(Number(document.sizeBytes))} · Version {document.currentVersion?.versionNumber ?? 1}</p></div><div className="flex shrink-0 items-start gap-2"><span className={`w-fit rounded-md px-2 py-1 text-[9px] font-black uppercase ${knowledgeDocumentStatusStyles[documentStatus]}`}>{knowledgeStatusLabel(documentStatus)}</span><TableActionsMenu ariaLabel={`Actions for ${document.displayName || 'Knowledge document'}`} actions={[
                    { label: knowledgeDocumentsLoading ? 'Refreshing...' : 'Refresh Document', disabled: knowledgeDocumentsLoading, onClick: () => setKnowledgeDocumentPollTick((value) => value + 1) },
                    { label: 'Version History', disabled: document.status === 'deleting', onClick: () => { setVersionDocumentId(document.id); setReviewDocumentId(null); } },
                    ...(['review_required', 'ready'].includes(document.status) ? [{ label: document.status === 'ready' ? 'Review Approved Records' : 'Review Extracted Records', onClick: () => { setReviewDocumentId(document.id); setVersionDocumentId(null); } }] : []),
                    ...(!isReadOnly && !['deleting', 'deleted'].includes(document.status) ? [{ label: deletingKnowledgeDocumentIds.includes(document.id) ? 'Starting deletion...' : 'Delete Document', disabled: deletingKnowledgeDocumentIds.includes(document.id), danger: true, onClick: () => void deleteKnowledgeDocument(document) }] : []),
                  ]} /></div></div>

                  {(processing || document.processingJob) && <div className="mt-3"><div className="mb-1.5 flex items-center justify-between text-[9px] font-bold text-slate-400"><span>{processing ? 'Processing' : knowledgeStatusLabel(document.processingJob?.status ?? document.status)}</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className={`h-full rounded-full transition-all duration-500 ${document.status === 'failed' ? 'bg-red-500' : 'bg-gradient-to-r from-violet-500 to-amber-500'}`} style={{ width: `${progress}%` }} /></div></div>}

                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[9px] font-semibold text-slate-400"><span>{document.currentVersion?.pageCount ?? 0} pages</span><span>{knowledgeDocumentMetric(document.documentType, document.currentVersion ?? {})}</span><span>Attempt {document.processingJob?.attemptCount ?? 0}/{document.processingJob?.maxAttempts ?? 0}</span><span>Uploaded {new Date(document.createdAt).toLocaleString()}</span></div>
                  {(document.status === 'failed' || errorMessage) && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[10px] font-semibold text-red-700">{errorMessage || 'Document processing failed. Select the PDF again to retry with a new upload.'}</div>}
                  {document.status === 'review_required' && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[10px] font-semibold text-amber-700">Extraction completed. Developer review is required before publishing.</div>}
                  {document.status === 'deleting' && <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">
                    {deletionJob?.status === 'failed' ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
                    <div className="min-w-0 flex-1 text-[10px] font-semibold">
                      <p>{deletionJob?.status === 'failed'
                        ? `Cleanup failed at ${deletionStageLabel(deletionJob)}: ${deletionJob.errorMessage || 'verification did not complete.'}`
                        : `Deleting… every version, extracted record, B2 object and Qdrant vector (${deletionJob?.progress ?? 0}%). Editing and repeated deletion are disabled.`}</p>
                      {deletionJob?.status === 'failed' && !isReadOnly && <button type="button" onClick={() => void retryKnowledgeDeletion(deletionJob)} disabled={retryingKnowledgeDeletionJobIds.includes(deletionJob.id)} className="mt-2 rounded-md border border-red-300 bg-white px-2.5 py-1 text-[9px] font-black uppercase text-red-700 disabled:opacity-50">{retryingKnowledgeDeletionJobIds.includes(deletionJob.id) ? 'Retrying…' : 'Retry cleanup'}</button>}
                    </div>
                  </div>}
                </article>;
              })}</div>}
            </section>}

            {selectedKnowledgeBase && versionDocument && <DocumentVersionPanel
              knowledgeBaseId={selectedKnowledgeBase.id}
              document={{ id: versionDocument.id, displayName: versionDocument.displayName, status: versionDocument.status, documentType: versionDocument.documentType }}
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
                <div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600"><Trash2 className="h-5 w-5" /></div><div><h4 id="delete-knowledge-base-title" className="text-base font-bold text-slate-900">Permanently delete Knowledge Base?</h4><p className="mt-1 text-xs leading-5 text-slate-500">This permanently deletes all documents, approved data, vectors and files. This action cannot be undone.</p></div></div>
                <div className="mt-5 rounded-lg border border-red-100 bg-red-50 p-3 text-xs font-semibold text-red-700">Type <strong>{selectedKnowledgeBase.name}</strong> to confirm deletion.</div>
                <label className="mt-4 block"><span className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-500">Knowledge Base name</span><input autoFocus value={deleteKnowledgeBaseConfirmation} onChange={(event) => setDeleteKnowledgeBaseConfirmation(event.target.value)} disabled={knowledgeDeleting} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-xs font-semibold text-slate-800 outline-none focus:border-red-400 disabled:opacity-60" /></label>
                <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => { setShowKnowledgeBaseDeleteDialog(false); setDeleteKnowledgeBaseConfirmation(''); }} disabled={knowledgeDeleting} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button><button type="button" onClick={() => void deleteSelectedKnowledgeBase()} disabled={knowledgeDeleting || deleteKnowledgeBaseConfirmation.trim() !== selectedKnowledgeBase.name} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50">{knowledgeDeleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}{knowledgeDeleting ? 'Starting permanent deletion...' : 'Delete permanently'}</button></div>
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
    {isKnowledgeUploading && activeKnowledgeUploadCategory && (
      <div
        role="status"
        aria-live="assertive"
        aria-label="Uploading knowledge document"
        data-knowledge-upload-overlay="true"
        style={{
          position: 'fixed', inset: 0, zIndex: 2147483647, display: 'flex', alignItems: 'center',
          justifyContent: 'center', padding: 16, backgroundColor: 'rgba(15, 23, 42, 0.48)',
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 440, overflow: 'hidden', borderRadius: 20, border: '1px solid rgba(255,255,255,.8)', backgroundColor: '#ffffff', boxShadow: '0 24px 70px rgba(15,23,42,.35)' }}>
          <div style={{ position: 'relative', padding: '30px 24px 24px', textAlign: 'center', color: '#0f172a' }}>
            <div style={{ position: 'absolute', inset: '0 0 auto', height: 5, backgroundColor: '#ede9fe' }}><div style={{ width: `${activeKnowledgeUploadProgress}%`, height: '100%', background: 'linear-gradient(90deg,#7c3aed,#dfa822,#dfa822)', transition: 'width 300ms ease-out' }} /></div>
            <div style={{ width: 64, height: 64, margin: '0 auto', borderRadius: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6d28d9', backgroundColor: '#ede9fe' }}>
              <Upload className="h-7 w-7 animate-bounce" />
            </div>
            <h4 style={{ margin: '20px 0 0', fontSize: 18, lineHeight: 1.4, fontWeight: 800, color: '#0f172a' }}>Knowledge file uploading</h4>
            <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.6, fontWeight: 600, color: '#64748b' }}>Please wait while your knowledge document is uploaded securely.</p>
            <div style={{ marginTop: 20, padding: 14, borderRadius: 12, border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', textAlign: 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><FileText className="h-5 w-5 shrink-0 text-violet-600" /><div style={{ minWidth: 0 }}><span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 800, color: '#1e293b' }} title={activeKnowledgeUploadFile?.name}>{activeKnowledgeUploadFile?.name ?? 'Knowledge document'}</span><span style={{ display: 'block', marginTop: 3, fontSize: 10, fontWeight: 600, color: '#94a3b8' }}>{activeKnowledgeUploadCategory.title}{activeKnowledgeUploadFile ? ` · ${formatFileSize(activeKnowledgeUploadFile.size)}` : ''}</span></div></div>
            </div>
            <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, fontWeight: 800, color: '#6d28d9' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><RefreshCw className="h-4 w-4 animate-spin" />Uploading file...</span><span>{activeKnowledgeUploadProgress}%</span></div>
            <div style={{ height: 9, marginTop: 9, overflow: 'hidden', borderRadius: 999, backgroundColor: '#ede9fe' }}><div style={{ width: `${activeKnowledgeUploadProgress}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,#7c3aed,#dfa822)', transition: 'width 300ms ease-out' }} /></div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
