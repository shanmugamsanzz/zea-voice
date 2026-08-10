import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity, BookOpen, Brain, Calendar, CheckCircle2, ChevronDown, ChevronLeft,
  ChevronRight, Clock, Database, Download, Eye, FileSpreadsheet, FileText, Filter,
  History, LoaderCircle, Phone, PhoneIncoming, PhoneOutgoing, RefreshCw, Search,
  Settings, User, Wrench, X, XCircle,
} from 'lucide-react';
import { apiBlobRequest, apiRequest, isAbortError } from '../../lib/api';
import { useAppState } from '../../store/AppState';

type CallDirection = 'inbound' | 'outbound';
type CallStatus = 'queued' | 'ringing' | 'connected' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled' | 'manual_follow_up_required';

type MessageSourceType = 'welcome_configuration' | 'system_prompt' | 'pre_call_context'
  | 'conversation_memory' | 'knowledge' | 'tool' | 'llm' | 'silent_message'
  | 'call_check_configuration' | 'runtime_fallback' | 'post_call_closing';

interface MessageSource {
  type: MessageSourceType;
  id: string | number | boolean | null;
  label: string | number | boolean | null;
  metadata: Record<string, string | number | boolean | null>;
}

interface TranscriptEntry {
  id: string;
  sequenceNumber: number;
  speaker: 'agent' | 'user' | 'system';
  text: string;
  offsetMs: number;
  isFinal: boolean;
  sources: MessageSource[];
  createdAt: string;
}

interface CallRecord {
  id: string;
  providerCallId: string | null;
  agentId: string | null;
  agentName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  contactName: string | null;
  fromNumber: string;
  toNumber: string;
  direction: CallDirection;
  status: CallStatus;
  sentiment: string | null;
  startedAt: string;
  ringingAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  cost: number;
  currency: string;
  recordingAvailable: boolean;
  aiSummary: {
    id: string; status: 'queued' | 'processing' | 'completed' | 'failed' | 'skipped';
    summary: string | null; outcome: string | null; customerIntent: string | null;
    sentiment: string | null; collectedData: Record<string, unknown>;
    followUpRequired: boolean | null; followUpReason: string | null;
    usage: Record<string, unknown>; webhookDelivery: { delivered?: boolean; status?: number; error?: string };
    errorCode: string | null; errorMessage: string | null;
    completedAt: string | null;
  } | null;
  transcript?: TranscriptEntry[];
}

interface CallListResponse {
  items: CallRecord[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

const PAGE_SIZE = 100;
const TABLE_PAGE_SIZE = 10;
const MAX_REPORT_CALLS = 5000;

const statusLabel: Record<CallStatus, string> = {
  queued: 'Queued', ringing: 'Ringing', connected: 'Connected', completed: 'Completed',
  failed: 'Failed', busy: 'Busy', no_answer: 'No Answer', canceled: 'Canceled',
  manual_follow_up_required: 'Manual Follow-Up Required',
};

function timestamp(value: string, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    month: 'short', day: '2-digit', ...(full ? { year: 'numeric' as const } : {}),
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(date);
}

function optionalTimestamp(value: string | null) {
  return value ? timestamp(value, true) : '—';
}

function duration(seconds: number) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function elapsed(offsetMs: number) {
  const seconds = Math.max(0, Math.floor((Number(offsetMs) || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const sourceDisplay: Record<MessageSourceType, { label: string; icon: typeof Database; style: string }> = {
  welcome_configuration: { label: 'Welcome configuration', icon: Settings, style: 'border-violet-200 bg-violet-50 text-violet-700' },
  system_prompt: { label: 'System instructions', icon: FileText, style: 'border-slate-200 bg-slate-50 text-slate-700' },
  pre_call_context: { label: 'Pre-call context', icon: Database, style: 'border-cyan-200 bg-cyan-50 text-cyan-700' },
  conversation_memory: { label: 'Conversation memory', icon: History, style: 'border-indigo-200 bg-indigo-50 text-indigo-700' },
  knowledge: { label: 'Knowledge', icon: BookOpen, style: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  tool: { label: 'Tool result', icon: Wrench, style: 'border-amber-200 bg-amber-50 text-amber-700' },
  llm: { label: 'LLM', icon: Brain, style: 'border-pink-200 bg-pink-50 text-pink-700' },
  silent_message: { label: 'Silent message', icon: Settings, style: 'border-blue-200 bg-blue-50 text-blue-700' },
  call_check_configuration: { label: 'Call check configuration', icon: Phone, style: 'border-violet-200 bg-violet-50 text-violet-700' },
  runtime_fallback: { label: 'Runtime fallback', icon: Activity, style: 'border-rose-200 bg-rose-50 text-rose-700' },
  post_call_closing: { label: 'Post-call closing', icon: Phone, style: 'border-purple-200 bg-purple-50 text-purple-700' },
};

function sourceDescription(source: MessageSource) {
  const metadata = source.metadata ?? {};
  if (source.type === 'knowledge') {
    const document = metadata.documentName || source.label || 'Published knowledge';
    const page = metadata.pageNumber ? ` · page ${metadata.pageNumber}${metadata.pageEnd && metadata.pageEnd !== metadata.pageNumber ? `–${metadata.pageEnd}` : ''}` : '';
    return `${document}${page}`;
  }
  if (source.type === 'tool') return `${source.label || 'Assigned tool'} · ${metadata.success === true ? 'successful' : 'used'}`;
  if (source.type === 'llm') return `${metadata.providerName || 'Selected provider'} · ${metadata.modelKey || source.label || 'selected model'}`;
  if (source.type === 'conversation_memory') return `${source.label || 'Saved context'} · ${metadata.policy || 'configured policy'}`;
  if (source.type === 'pre_call_context') return `${source.label || 'Pre-call API'}${metadata.mappedKeys ? ` · ${metadata.mappedKeys}` : ''}`;
  return String(source.label || sourceDisplay[source.type]?.label || source.type).replaceAll('_', ' ');
}

function TranscriptMessage({ entry, showSources = true }: { entry: TranscriptEntry; showSources?: boolean }) {
  const sources = Array.isArray(entry.sources) ? entry.sources : [];
  return <div className={`flex flex-col ${entry.speaker === 'agent' ? 'items-end' : 'items-start'}`}>
    <span className="mb-1 text-[9px] font-black uppercase tracking-wider text-slate-400">{entry.speaker} · {elapsed(entry.offsetMs)}</span>
    <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-xs font-semibold leading-relaxed ${entry.speaker === 'agent' ? 'rounded-tr-none bg-gradient-to-r from-violet-600 to-pink-500 text-white' : entry.speaker === 'system' ? 'border border-amber-200 bg-amber-50 text-amber-800' : 'rounded-tl-none border border-slate-200 bg-slate-50 text-slate-800'}`}>{entry.text}</div>
    {showSources && entry.speaker === 'agent' && sources.length > 0 && <details className="group mt-2 w-full max-w-[88%] rounded-xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-500">
        <span className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5 text-violet-500" />Answer sources ({sources.length})</span>
        <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
      </summary>
      <div className="space-y-2 border-t border-slate-100 p-3">
        {sources.map((source, index) => {
          const display = sourceDisplay[source.type] ?? sourceDisplay.runtime_fallback;
          const Icon = display.icon;
          return <div key={`${source.type}-${String(source.id ?? source.label ?? index)}-${index}`} className="flex items-start gap-2">
            <span className={`mt-0.5 rounded-md border p-1 ${display.style}`}><Icon className="h-3 w-3" /></span>
            <div className="min-w-0"><p className="text-[9px] font-black uppercase tracking-wider text-slate-500">{display.label}</p><p className="mt-0.5 break-words text-[10px] font-semibold leading-relaxed text-slate-700">{sourceDescription(source)}</p></div>
          </div>;
        })}
      </div>
    </details>}
  </div>;
}

function csvCell(value: unknown) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function loadAllCalls(signal: AbortSignal) {
  const calls: CallRecord[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const response = await apiRequest<CallListResponse>(`/calls?page=${page}&pageSize=${PAGE_SIZE}`, {
      signal, zeaCache: 'reload',
    });
    calls.push(...response.items);
    totalPages = response.pagination.totalPages;
    page += 1;
  } while (page <= totalPages && calls.length < MAX_REPORT_CALLS && !signal.aborted);
  return calls.slice(0, MAX_REPORT_CALLS);
}

function StatusBadge({ status }: { status: CallStatus }) {
  const style = status === 'completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : status === 'connected' ? 'border-blue-200 bg-blue-50 text-blue-700'
      : status === 'manual_follow_up_required' ? 'border-violet-200 bg-violet-50 text-violet-700'
      : ['failed', 'canceled'].includes(status) ? 'border-red-200 bg-red-50 text-red-700'
        : ['busy', 'no_answer'].includes(status) ? 'border-amber-200 bg-amber-50 text-amber-700'
          : 'border-slate-200 bg-slate-100 text-slate-600';
  return <span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-black uppercase ${style}`}>{statusLabel[status]}</span>;
}

function ReportsReviewTable({ calls, loading, page, openDetails, rowClickable = false }: {
  calls: CallRecord[];
  loading: boolean;
  page: number;
  openDetails: (call: CallRecord) => Promise<void>;
  rowClickable?: boolean;
}) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[1180px] text-left">
    <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500"><tr>
      {['S.No', 'Time Stamp', 'Contact Name', 'Call Type', 'Outcome', 'Duration', 'Prospect Number'].map((heading) => <th key={heading} className="px-5 py-4">{heading}</th>)}
      <th className="px-5 py-4 text-center">Action</th>
    </tr></thead>
    <tbody className="divide-y divide-slate-100 text-xs">{loading
      ? <tr><td colSpan={8} className="py-16 text-center"><LoaderCircle className="mx-auto h-7 w-7 animate-spin text-[#dfa822]" /><p className="mt-3 font-bold text-slate-400">Loading real call reports…</p></td></tr>
      : calls.length ? calls.map((call, index) => <tr
        key={call.id}
        tabIndex={rowClickable ? 0 : undefined}
        aria-label={rowClickable ? `Open details for call ${call.id}` : undefined}
        className={`${rowClickable ? 'cursor-pointer' : ''} transition-colors hover:bg-slate-50`}
        onClick={rowClickable ? (event) => {
          const target = event.target as Element;
          if (target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [data-row-click-ignore]')) return;
          void openDetails(call);
        } : undefined}
        onKeyDown={rowClickable ? (event) => {
          const target = event.target as Element;
          if (target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [data-row-click-ignore]')) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openDetails(call);
          }
        } : undefined}
      >
        <td className="px-5 py-4 font-mono text-slate-400">{(page - 1) * TABLE_PAGE_SIZE + index + 1}</td>
        <td className="whitespace-nowrap px-5 py-4 font-semibold text-slate-600">{timestamp(call.startedAt, true)}</td>
        <td className="px-5 py-4 font-black text-slate-700">{call.contactName || 'Unknown Caller'}</td>
        <td className="px-5 py-4"><span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-black uppercase ${call.direction === 'inbound' ? 'border-blue-100 bg-blue-50 text-blue-600' : 'border-amber-100 bg-amber-50 text-amber-600'}`}>{call.direction === 'inbound' ? <PhoneIncoming className="h-3 w-3" /> : <PhoneOutgoing className="h-3 w-3" />}{call.direction}</span></td>
        <td className="px-5 py-4"><StatusBadge status={call.status} />{call.aiSummary?.outcome && <p className="mt-1 max-w-40 truncate text-[9px] font-bold uppercase text-violet-600">AI: {call.aiSummary.outcome.replaceAll('_', ' ')}</p>}</td>
        <td className="px-5 py-4 font-mono font-bold text-slate-600">{duration(call.durationSeconds)}</td>
        <td className="px-5 py-4 font-mono font-bold text-slate-800">{call.direction === 'inbound' ? call.fromNumber : call.toNumber}</td>
        <td className="px-5 py-4 text-center"><button onClick={() => void openDetails(call)} title="Review call" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 font-bold text-slate-600 hover:border-amber-200 hover:bg-amber-50 hover:text-amber-600"><Eye className="h-4 w-4" />Review</button></td>
      </tr>) : <tr><td colSpan={8} className="py-16 text-center text-slate-400"><Phone className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 font-bold">No real calls match these filters.</p></td></tr>}
    </tbody>
  </table></div>;
}

function DetailedCallLogsTable({ calls, loading, page, openDetails }: {
  calls: CallRecord[];
  loading: boolean;
  page: number;
  openDetails: (call: CallRecord) => Promise<void>;
}) {
  return <div className="zea-call-logs-table-wrap overflow-x-auto"><table className="w-full min-w-[2350px] text-left">
    <thead className="border-b border-slate-200 bg-slate-50 text-[9px] font-black uppercase tracking-wider text-slate-400"><tr>
      {['#', 'Started At', 'Direction', 'From Number', 'To Number', 'Agent', 'Campaign', 'Outcome',
        'Ringing At', 'Answered At', 'Ended At', 'Duration', 'Sentiment', 'Cost', 'Currency', 'Recording'].map((heading) => <th key={heading} className="px-4 py-4">{heading}</th>)}
      <th className="px-4 py-4 text-center">Review</th>
    </tr></thead>
    <tbody className="divide-y divide-slate-100 text-xs">{loading
      ? <tr><td colSpan={17} className="py-16 text-center"><LoaderCircle className="mx-auto h-7 w-7 animate-spin text-[#dfa822]" /><p className="mt-3 font-bold text-slate-400">Loading real call records…</p></td></tr>
      : calls.length ? calls.map((call, index) => <tr
        key={call.id}
        tabIndex={0}
        aria-label={`Open details for call ${call.id}`}
        className="cursor-pointer transition-colors hover:bg-slate-50"
        onClick={(event) => {
          const target = event.target as Element;
          if (target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [data-row-click-ignore]')) return;
          void openDetails(call);
        }}
        onKeyDown={(event) => {
          const target = event.target as Element;
          if (target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [data-row-click-ignore]')) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openDetails(call);
          }
        }}
      >
        <td className="px-4 py-4 font-mono text-slate-400">{(page - 1) * TABLE_PAGE_SIZE + index + 1}</td>
        <td className="whitespace-nowrap px-4 py-4 font-semibold text-slate-600">{timestamp(call.startedAt, true)}</td>
        <td className="px-4 py-4"><span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-black uppercase ${call.direction === 'inbound' ? 'border-blue-100 bg-blue-50 text-blue-600' : 'border-amber-100 bg-amber-50 text-amber-600'}`}>{call.direction === 'inbound' ? <PhoneIncoming className="h-3 w-3" /> : <PhoneOutgoing className="h-3 w-3" />}{call.direction}</span></td>
        <td className="px-4 py-4 font-mono font-bold text-slate-700">{call.fromNumber}</td>
        <td className="px-4 py-4 font-mono font-bold text-slate-700">{call.toNumber}</td>
        <td className="px-4 py-4 font-bold text-slate-700">{call.agentName || '—'}</td>
        <td className="px-4 py-4 font-bold text-slate-600">{call.campaignName || '—'}</td>
        <td className="px-4 py-4"><StatusBadge status={call.status} /></td>
        <td className="whitespace-nowrap px-4 py-4 text-slate-500">{optionalTimestamp(call.ringingAt)}</td>
        <td className="whitespace-nowrap px-4 py-4 text-slate-500">{optionalTimestamp(call.answeredAt)}</td>
        <td className="whitespace-nowrap px-4 py-4 text-slate-500">{optionalTimestamp(call.endedAt)}</td>
        <td className="px-4 py-4 font-mono font-bold text-slate-600">{duration(call.durationSeconds)}</td>
        <td className="px-4 py-4 font-bold capitalize text-slate-600">{call.sentiment || 'unknown'}</td>
        <td className="px-4 py-4 font-mono font-bold text-slate-600">{Number(call.cost || 0).toFixed(2)}</td>
        <td className="px-4 py-4 font-bold text-slate-500">{call.currency}</td>
        <td className="px-4 py-4 font-bold text-slate-600">{call.recordingAvailable ? 'Available' : '—'}</td>
        <td className="px-4 py-4 text-center"><button onClick={() => void openDetails(call)} title="View real call details" className="rounded-lg p-2 text-slate-400 hover:bg-amber-50 hover:text-amber-600"><Eye className="h-4 w-4" /></button></td>
      </tr>) : <tr><td colSpan={17} className="py-16 text-center text-slate-400"><Phone className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 font-bold">No real calls match these filters.</p></td></tr>}
    </tbody>
  </table></div>;
}

interface DeveloperReportsViewProps {
  title?: string;
  subtitle?: string;
  variant?: 'reports' | 'call-logs';
}

export function DeveloperReportsView({
  variant = 'reports',
}: DeveloperReportsViewProps = {}) {
  const { role, selectedCallId, setSelectedCallId } = useAppState();
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [directionFilter, setDirectionFilter] = useState<'all' | CallDirection>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | CallStatus>('all');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'yesterday' | '7d' | '30d'>('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const [durationFilter, setDurationFilter] = useState<'all' | '0-30' | '31-60' | '61-120' | '121-300' | '301+'>('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState({
    direction: 'all' as 'all' | CallDirection,
    status: 'all' as 'all' | CallStatus,
    date: 'all' as 'all' | 'today' | 'yesterday' | '7d' | '30d',
    agent: 'all', campaign: 'all',
    duration: 'all' as 'all' | '0-30' | '31-60' | '61-120' | '121-300' | '301+',
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CallRecord | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingError, setRecordingError] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  const detailsRequestId = useRef(0);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    if (calls.length) setRefreshing(true); else setLoading(true);
    setError('');
    loadAllCalls(controller.signal)
      .then((items) => { setCalls(items); setLastUpdated(new Date()); })
      .catch((requestError) => {
        if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Call reports could not be loaded');
      })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); } });
    return () => controller.abort();
  }, [refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const agents = useMemo(() => [...new Map(calls.filter((call) => call.agentId)
    .map((call) => [call.agentId!, call.agentName || 'Unnamed Agent'])).entries()], [calls]);
  const campaigns = useMemo(() => [...new Map(calls.filter((call) => call.campaignId)
    .map((call) => [call.campaignId!, call.campaignName || 'Unnamed Campaign'])).entries()], [calls]);

  const filtered = useMemo(() => calls.filter((call) => {
    if (directionFilter !== 'all' && call.direction !== directionFilter) return false;
    if (statusFilter !== 'all' && call.status !== statusFilter) return false;
    if (agentFilter !== 'all' && call.agentId !== agentFilter) return false;
    if (campaignFilter !== 'all' && call.campaignId !== campaignFilter) return false;
    const seconds = Number(call.durationSeconds) || 0;
    if (durationFilter === '0-30' && seconds > 30) return false;
    if (durationFilter === '31-60' && (seconds <= 30 || seconds > 60)) return false;
    if (durationFilter === '61-120' && (seconds <= 60 || seconds > 120)) return false;
    if (durationFilter === '121-300' && (seconds <= 120 || seconds > 300)) return false;
    if (durationFilter === '301+' && seconds <= 300) return false;
    if (dateFilter !== 'all') {
      const started = new Date(call.startedAt);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
      const daysAgo = (days: number) => { const value = new Date(today); value.setDate(today.getDate() - days + 1); return value; };
      if (dateFilter === 'today' && (started < today || started >= tomorrow)) return false;
      if (dateFilter === 'yesterday' && (started < yesterday || started >= today)) return false;
      if (dateFilter === '7d' && started < daysAgo(7)) return false;
      if (dateFilter === '30d' && started < daysAgo(30)) return false;
    }
    const query = search.trim().toLowerCase();
    return !query || [call.fromNumber, call.toNumber, call.contactName, call.agentName, call.campaignName, call.providerCallId]
      .some((value) => String(value ?? '').toLowerCase().includes(query));
  }), [calls, directionFilter, statusFilter, agentFilter, campaignFilter, durationFilter, dateFilter, search]);

  useEffect(() => { setPage(1); }, [directionFilter, statusFilter, agentFilter, campaignFilter, durationFilter, dateFilter, search]);

  const rowCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(rowCount / TABLE_PAGE_SIZE));
  const visible = filtered.slice((page - 1) * TABLE_PAGE_SIZE, page * TABLE_PAGE_SIZE);
  const inbound = calls.filter((call) => call.direction === 'inbound').length;
  const outbound = calls.length - inbound;

  useEffect(() => { setPage((current) => Math.min(current, totalPages)); }, [totalPages]);

  const clearFilters = () => {
    setDirectionFilter('all'); setStatusFilter('all'); setDateFilter('all'); setAgentFilter('all');
    setCampaignFilter('all'); setDurationFilter('all'); setSearch(''); setSearchInput('');
    setDraftFilters({ direction: 'all', status: 'all', date: 'all', agent: 'all', campaign: 'all', duration: 'all' });
  };

  const activeFilterCount = [directionFilter, statusFilter, dateFilter, agentFilter, campaignFilter, durationFilter]
    .filter((value) => value !== 'all').length;
  const openFilters = () => {
    setDraftFilters({ direction: directionFilter, status: statusFilter, date: dateFilter, agent: agentFilter, campaign: campaignFilter, duration: durationFilter });
    setFiltersOpen(true);
  };
  const applyFilters = () => {
    setDirectionFilter(draftFilters.direction); setStatusFilter(draftFilters.status); setDateFilter(draftFilters.date);
    setAgentFilter(draftFilters.agent); setCampaignFilter(draftFilters.campaign); setDurationFilter(draftFilters.duration);
    setPage(1); setFiltersOpen(false); refresh();
  };

  const openDetails = async (call: CallRecord) => {
    const requestId = ++detailsRequestId.current;
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(''); setRecordingError(''); setRecordingLoading(false);
    setSelected(call); setDetailsLoading(true); setDetailsError('');
    try {
      const detail = await apiRequest<CallRecord>(`/calls/${call.id}`, { zeaCache: 'reload' });
      if (requestId !== detailsRequestId.current) return;
      setSelected(detail);
      if (detail.recordingAvailable) {
        setRecordingLoading(true);
        try {
          const blob = await apiBlobRequest(`/calls/${call.id}/recording`);
          if (requestId !== detailsRequestId.current) return;
          setRecordingUrl(URL.createObjectURL(blob));
        } catch (requestError) {
          if (requestId !== detailsRequestId.current) return;
          setRecordingError(requestError instanceof Error ? requestError.message : 'Recording could not be loaded');
        } finally { if (requestId === detailsRequestId.current) setRecordingLoading(false); }
      }
    } catch (requestError) {
      if (requestId !== detailsRequestId.current) return;
      setDetailsError(requestError instanceof Error ? requestError.message : 'Call details could not be loaded');
    } finally { if (requestId === detailsRequestId.current) setDetailsLoading(false); }
  };

  const closeDetails = () => {
    detailsRequestId.current += 1;
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setSelectedCallId(null);
    setRecordingUrl(''); setRecordingError(''); setRecordingLoading(false);
    setDetailsError(''); setDetailsLoading(false); setSelected(null);
  };

  useEffect(() => {
    if (!selectedCallId || !calls.length || selected) return;
    const requestedCall = calls.find((call) => call.id === selectedCallId);
    if (!requestedCall) return;
    setSelectedCallId(null);
    void openDetails(requestedCall);
  }, [calls, selected, selectedCallId, setSelectedCallId]);

  useEffect(() => () => { if (recordingUrl) URL.revokeObjectURL(recordingUrl); }, [recordingUrl]);

  const exportCsv = () => {
    const rows = variant === 'reports'
      ? [['S.No', 'Time Stamp', 'Contact Name', 'Call Type', 'Outcome', 'Duration Seconds', 'Prospect Number'],
      ...filtered.map((call, index) => [index + 1, timestamp(call.startedAt, true),
        call.contactName || 'Unknown Caller', call.direction, call.aiSummary?.outcome || statusLabel[call.status], call.durationSeconds,
        call.direction === 'inbound' ? call.fromNumber : call.toNumber])]
      : [['Started At', 'Direction', 'From', 'To', 'Agent', 'Campaign', 'Status', 'Ringing At',
        'Answered At', 'Ended At', 'Duration Seconds', 'Sentiment', 'Cost', 'Currency', 'Recording Available',
        'Plivo Call UUID', 'Internal Call ID'],
      ...filtered.map((call) => [timestamp(call.startedAt, true), call.direction, call.fromNumber, call.toNumber,
        call.agentName ?? '', call.campaignName ?? '', statusLabel[call.status], optionalTimestamp(call.ringingAt),
        optionalTimestamp(call.answeredAt), optionalTimestamp(call.endedAt), call.durationSeconds,
        call.sentiment ?? 'unknown', call.cost, call.currency, call.recordingAvailable ? 'Yes' : 'No',
        call.providerCallId ?? '', call.id])];
    const blob = new Blob([rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.download = `zea-voice-${variant}-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    URL.revokeObjectURL(url); setExportMessage(`Exported ${filtered.length} real call records.`);
    window.setTimeout(() => setExportMessage(''), 3500);
  };

  return <div className="space-y-6">
    {exportMessage && <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-700"><CheckCircle2 className="h-4 w-4" />{exportMessage}</div>}
    {error && <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-bold text-red-700"><span>{error}</span><button onClick={refresh}>Retry</button></div>}

    <div className="grid gap-4 md:grid-cols-3">
      {(variant === 'reports' ? [
        { label: 'Total Calls', value: filtered.length, Icon: Phone, style: 'bg-amber-50 text-amber-600' },
        { label: 'Inbound', value: filtered.filter((call) => call.direction === 'inbound').length, Icon: PhoneIncoming, style: 'bg-blue-50 text-blue-600' },
        { label: 'Outbound', value: filtered.filter((call) => call.direction === 'outbound').length, Icon: PhoneOutgoing, style: 'bg-amber-50 text-amber-600' },
      ] : [
        { label: 'Total Calls', value: calls.length, Icon: Phone, style: 'bg-amber-50 text-amber-600' },
        { label: 'Inbound', value: inbound, Icon: PhoneIncoming, style: 'bg-blue-50 text-blue-600' },
        { label: 'Outbound', value: outbound, Icon: PhoneOutgoing, style: 'bg-violet-50 text-violet-600' },
      ]).map(({ label, value, Icon, style }) => <div key={label} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-3xl font-black text-slate-800">{value}</p></div><div className={`rounded-2xl p-3 ${style}`}><Icon className="h-5 w-5" /></div></div>)}
    </div>

    <div className="hidden">
      <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-xs font-black uppercase text-slate-600"><Filter className="h-4 w-4" />{variant === 'reports' ? 'Search Filters' : 'Filters'}</span><button onClick={clearFilters} className="flex items-center gap-1 text-xs font-bold text-amber-600"><XCircle className="h-4 w-4" />Clear Filters</button></div>
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
        <label className="flex flex-col gap-1.5"><span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Date Range</span><select value={dateFilter} onChange={(e) => setDateFilter(e.target.value as typeof dateFilter)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Time</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">Last 7 Days</option><option value="30d">Last 30 Days</option></select></label>
        <label className="flex flex-col gap-1.5"><span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Call Type</span><select value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value as typeof directionFilter)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Types</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select></label>
        <label className="flex flex-col gap-1.5"><span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Outcome</span><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Outcomes</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="flex flex-col gap-1.5"><span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Voice Agent</span><select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Agents</option>{agents.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label className="flex flex-col gap-1.5"><span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Call Duration</span><select value={durationFilter} onChange={(e) => setDurationFilter(e.target.value as typeof durationFilter)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Durations</option><option value="0-30">0–30 sec</option><option value="31-60">31–60 sec</option><option value="61-120">1–2 min</option><option value="121-300">2–5 min</option><option value="301+">5+ min</option></select></label>
        <label className="flex flex-col gap-1.5"><span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Outbound Campaign</span><select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Campaigns</option>{campaigns.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-lg flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, agent, campaign or call ID" className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-xs font-semibold outline-none focus:border-amber-400" /></div><span className="text-xs font-bold text-slate-400">{filtered.length} call records · {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Loading'}</span></div>
    </div>

    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button type="button" onClick={openFilters} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[#dfa822]/50 bg-[#dfa822]/10 px-4 py-2.5 text-xs font-black text-[#9a6900] transition hover:bg-[#dfa822]/20"><Filter className="h-4 w-4" />Search Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</button>
          <div className="relative min-w-0 flex-1 sm:min-w-[260px]"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSearch(searchInput); setPage(1); } }} placeholder="Search number, agent, campaign or call ID" className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-xs font-semibold outline-none focus:border-amber-400" /></div>
          <button type="button" onClick={() => { setSearch(searchInput); setPage(1); }} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#dfa822] px-5 py-2.5 text-xs font-black text-black transition hover:bg-[#efbd3d]"><Search className="h-4 w-4" />Search</button>
          <button type="button" onClick={refresh} disabled={refreshing} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</button>
          <button type="button" onClick={exportCsv} disabled={!filtered.length} className="zea-reports-export-csv inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"><FileSpreadsheet className="h-4 w-4 text-emerald-400" />Export CSV</button>
      </div>
    </div>

    {filtersOpen && createPortal(
      <div className="fixed inset-0 z-[10000] flex justify-end bg-slate-950/45" onMouseDown={(event) => { if (event.target === event.currentTarget) setFiltersOpen(false); }}>
        <aside role="dialog" aria-modal="true" aria-labelledby="reports-filter-title" className="zea-reports-filter-drawer flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 p-5"><div><p className="text-[10px] font-black uppercase tracking-wider text-[#b78513]">Reports</p><h3 id="reports-filter-title" className="text-lg font-black text-slate-800">Search Filters</h3></div><button type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)} className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"><X className="h-4 w-4" /></button></div>
          <div className="flex-1 space-y-5 overflow-y-auto p-5">
            <label className="flex flex-col gap-1.5"><span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Date Range</span><select value={draftFilters.date} onChange={(e) => setDraftFilters((current) => ({ ...current, date: e.target.value as typeof current.date }))} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-bold"><option value="all">All Time</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">Last 7 Days</option><option value="30d">Last 30 Days</option></select></label>
            <label className="flex flex-col gap-1.5"><span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Call Type</span><select value={draftFilters.direction} onChange={(e) => setDraftFilters((current) => ({ ...current, direction: e.target.value as typeof current.direction }))} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-bold"><option value="all">All Types</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select></label>
            <label className="flex flex-col gap-1.5"><span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Outcome</span><select value={draftFilters.status} onChange={(e) => setDraftFilters((current) => ({ ...current, status: e.target.value as typeof current.status }))} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-bold"><option value="all">All Outcomes</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="flex flex-col gap-1.5"><span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Voice Agent</span><select value={draftFilters.agent} onChange={(e) => setDraftFilters((current) => ({ ...current, agent: e.target.value }))} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-bold"><option value="all">All Agents</option>{agents.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
            <label className="flex flex-col gap-1.5"><span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Call Duration</span><select value={draftFilters.duration} onChange={(e) => setDraftFilters((current) => ({ ...current, duration: e.target.value as typeof current.duration }))} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-bold"><option value="all">All Durations</option><option value="0-30">0–30 sec</option><option value="31-60">31–60 sec</option><option value="61-120">1–2 min</option><option value="121-300">2–5 min</option><option value="301+">5+ min</option></select></label>
            <label className="flex flex-col gap-1.5"><span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Outbound Campaign</span><select value={draftFilters.campaign} onChange={(e) => setDraftFilters((current) => ({ ...current, campaign: e.target.value }))} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-bold"><option value="all">All Campaigns</option>{campaigns.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          </div>
          <div className="flex gap-3 border-t border-slate-200 bg-white p-5"><button type="button" onClick={clearFilters} className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-xs font-black text-slate-600 hover:bg-slate-50">Clear Filters</button><button type="button" onClick={applyFilters} className="flex-1 rounded-xl bg-[#dfa822] px-4 py-3 text-xs font-black text-black hover:bg-[#efbd3d]">Apply Filters</button></div>
        </aside>
      </div>, document.body,
    )}

    {variant === 'reports' && <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap gap-2">
        {([
          ['all', 'All Calls', calls.length, Phone],
          ['inbound', 'Inbound', inbound, PhoneIncoming],
          ['outbound', 'Outbound', outbound, PhoneOutgoing],
        ] as const).map(([value, label, count, Icon]) => <button key={value} type="button" onClick={() => setDirectionFilter(value)} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-black transition ${directionFilter === value ? 'bg-gradient-to-r from-violet-600 to-amber-500 text-white shadow-sm' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}><Icon className="h-4 w-4" />{label}<span className="text-[10px] opacity-80">{count}</span></button>)}
      </div>
      <span className="text-xs font-bold text-slate-400">{filtered.length} records</span>
    </div>}

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {variant === 'reports'
        ? <ReportsReviewTable calls={visible} loading={loading} page={page} openDetails={openDetails} rowClickable={role === 'USER'} />
        : <DetailedCallLogsTable calls={visible} loading={loading} page={page} openDetails={openDetails} />}
      <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-4"><span className="text-xs font-bold text-slate-400">Page {page} of {totalPages}</span><div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-slate-200 bg-white p-2 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button><button disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="rounded-lg border border-slate-200 bg-white p-2 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button></div></div>
    </div>

    {selected && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/45 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetails(); }}><div className="flex h-full w-full max-w-xl flex-col bg-slate-50 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 bg-white p-6"><div><p className="text-[10px] font-black uppercase tracking-wider text-amber-500">Real Call Record</p><h3 className="text-xl font-black text-slate-800">Call Details</h3></div><button onClick={closeDetails} className="rounded-xl border border-slate-200 p-2 text-slate-500"><X className="h-4 w-4" /></button></div>
      <div className="flex-1 space-y-5 overflow-y-auto p-6">{detailsLoading && <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 text-xs font-bold text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin text-[#dfa822]" />Loading transcript…</div>}{detailsError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-bold text-red-700">{detailsError}</div>}
        <div className="grid grid-cols-2 gap-3">{[['Agent', selected.agentName || '—'], ['Timestamp', timestamp(selected.startedAt, true)], ['Direction', selected.direction.toUpperCase()], ['Outcome', statusLabel[selected.status]], ['Duration', duration(selected.durationSeconds)], ['Sentiment', selected.sentiment || 'Not analyzed']].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</p><p className="mt-2 break-words text-xs font-black text-slate-800">{value}</p></div>)}</div>
        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white p-5 text-xs">{[['From', selected.fromNumber], ['To', selected.toNumber], ['Agent ID', selected.agentId || '—'], ['Campaign', selected.campaignName || '—'], ['Plivo Call UUID', selected.providerCallId || '—'], ['Internal Call ID', selected.id]].map(([label, value]) => <div key={label} className="flex items-start justify-between gap-5 py-3"><span className="shrink-0 font-black uppercase text-slate-400">{label}</span><span className="break-all text-right font-mono font-bold text-slate-700">{value}</span></div>)}</div>
        {false && <>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><h4 className="text-sm font-black text-slate-800">Transcript</h4><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-500">{selected.transcript?.length ?? 0} entries</span></div>{selected.transcript?.length ? <div className="space-y-4">{selected.transcript.map((entry) => <div key={entry.id} className={`flex flex-col ${entry.speaker === 'agent' ? 'items-end' : 'items-start'}`}><span className="mb-1 text-[9px] font-black uppercase tracking-wider text-slate-400">{entry.speaker} · {elapsed(entry.offsetMs)}</span><div className={`max-w-[88%] rounded-2xl px-4 py-3 text-xs font-semibold leading-relaxed ${entry.speaker === 'agent' ? 'rounded-tr-none bg-gradient-to-r from-violet-600 to-amber-500 text-white' : entry.speaker === 'system' ? 'border border-amber-200 bg-amber-50 text-amber-800' : 'rounded-tl-none border border-slate-200 bg-slate-50 text-slate-800'}`}>{entry.text}</div></div>)}</div> : <p className="py-8 text-center text-xs font-semibold text-slate-400">No finalized transcript entries were saved for this call.</p>}</div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><h4 className="text-sm font-black text-slate-800">AI Call Summary</h4><span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${selected.aiSummary?.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : selected.aiSummary?.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-500'}`}>{selected.aiSummary?.status || 'Not enabled'}</span></div>{selected.aiSummary?.status === 'completed' ? <div className="space-y-4"><p className="text-xs font-semibold leading-relaxed text-slate-700">{selected.aiSummary.summary}</p><div className="grid grid-cols-2 gap-3">{[['Outcome', selected.aiSummary.outcome || 'Unknown'], ['Customer Intent', selected.aiSummary.customerIntent || 'Not identified'], ['Sentiment', selected.aiSummary.sentiment || 'Unknown'], ['Follow-Up', selected.aiSummary.followUpRequired ? 'Required' : 'Not required']].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3"><p className="text-[8px] font-black uppercase text-slate-400">{label}</p><p className="mt-1 text-[10px] font-bold text-slate-700">{value}</p></div>)}</div>{selected.aiSummary.followUpReason && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] font-semibold text-amber-800">{selected.aiSummary.followUpReason}</div>}<p className={`text-[9px] font-bold ${selected.aiSummary.webhookDelivery?.delivered ? 'text-emerald-600' : 'text-slate-400'}`}>Post-Call webhook: {selected.aiSummary.webhookDelivery?.delivered ? `Delivered (${selected.aiSummary.webhookDelivery.status || 200})` : selected.aiSummary.webhookDelivery?.error || 'Not delivered or not configured'}</p></div> : selected.aiSummary?.status === 'failed' ? <p className="text-xs font-semibold text-red-600">{selected.aiSummary.errorMessage || 'Summary processing failed.'}</p> : <p className="text-xs font-semibold text-slate-400">No completed AI summary is available for this call.</p>}</div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-3 flex items-center gap-2"><Download className="h-4 w-4 text-emerald-500" /><h4 className="text-sm font-black text-slate-800">Call Recording</h4></div>{recordingLoading ? <div className="flex items-center gap-2 py-3 text-xs font-bold text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin text-[#dfa822]" />Loading private recording from B2...</div> : recordingUrl ? <><audio controls preload="metadata" src={recordingUrl} className="w-full" /><a href={recordingUrl} download={`call-${selected.id}.mp3`} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[10px] font-black text-emerald-700"><Download className="h-3.5 w-3.5" />Download recording</a></> : recordingError ? <p className="text-xs font-bold text-red-600">{recordingError}</p> : <div className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Activity className="h-4 w-4 text-slate-400" />No recording is available for this call.</div>}</div>
        </>}
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><h4 className="text-sm font-black text-slate-800">Transcript</h4><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-500">{selected.transcript?.length ?? 0} entries</span></div>{selected.transcript?.length ? <div className="space-y-4">{selected.transcript.map((entry) => <TranscriptMessage key={entry.id} entry={entry} showSources={role !== 'USER'} />)}</div> : <p className="py-8 text-center text-xs font-semibold text-slate-400">No finalized transcript entries were saved for this call.</p>}</div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><h4 className="text-sm font-black text-slate-800">AI Call Summary</h4><span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${selected.aiSummary?.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : selected.aiSummary?.status === 'failed' ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{selected.aiSummary?.status || 'Not enabled'}</span></div>{selected.aiSummary?.status === 'completed' ? <div className="space-y-4"><p className="text-xs font-semibold leading-relaxed text-slate-700">{selected.aiSummary.summary}</p><div className="grid grid-cols-2 gap-3">{[['Outcome', selected.aiSummary.outcome || 'Unknown'], ['Customer Intent', selected.aiSummary.customerIntent || 'Not identified'], ['Sentiment', selected.aiSummary.sentiment || 'Unknown'], ['Follow-Up', selected.aiSummary.followUpRequired ? 'Required' : 'Not required']].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3"><p className="text-[8px] font-black uppercase text-slate-400">{label}</p><p className="mt-1 text-[10px] font-bold text-slate-700">{value}</p></div>)}</div>{selected.aiSummary.followUpReason && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] font-semibold text-amber-800">{selected.aiSummary.followUpReason}</div>}<p className={`text-[9px] font-bold ${selected.aiSummary.webhookDelivery?.delivered ? 'text-emerald-600' : 'text-slate-400'}`}>Post-Call webhook: {selected.aiSummary.webhookDelivery?.delivered ? `Delivered (${selected.aiSummary.webhookDelivery.status || 200})` : selected.aiSummary.webhookDelivery?.error || 'Not delivered or not configured'}</p></div> : selected.aiSummary?.status === 'failed' ? <p className="text-xs font-semibold text-rose-600">{selected.aiSummary.errorMessage || 'Summary processing failed.'}</p> : <p className="text-xs font-semibold text-slate-400">No completed AI summary is available for this call.</p>}</div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-3 flex items-center gap-2"><Download className="h-4 w-4 text-emerald-500" /><h4 className="text-sm font-black text-slate-800">Call Recording</h4></div>{recordingLoading ? <div className="flex items-center gap-2 py-3 text-xs font-bold text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin text-emerald-500" />Loading private recording from B2...</div> : recordingUrl ? <><audio controls preload="metadata" src={recordingUrl} className="w-full" /><a href={recordingUrl} download={`call-${selected.id}.mp3`} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[10px] font-black text-emerald-700"><Download className="h-3.5 w-3.5" />Download recording</a></> : recordingError ? <p className="text-xs font-bold text-rose-600">{recordingError}</p> : <div className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Activity className="h-4 w-4 text-slate-400" />No recording is available for this call.</div>}</div>
      </div><div className="border-t border-slate-200 bg-white p-5 text-right"><button onClick={closeDetails} className="rounded-xl bg-slate-900 px-5 py-2.5 text-xs font-bold text-white">Close</button></div></div></div>}
  </div>;
}
