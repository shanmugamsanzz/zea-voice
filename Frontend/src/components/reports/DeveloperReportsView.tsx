import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Calendar, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download,
  Eye, FileSpreadsheet, Filter, LoaderCircle, Phone, PhoneIncoming, PhoneOutgoing,
  RefreshCw, Search, User, X, XCircle,
} from 'lucide-react';
import { apiBlobRequest, apiRequest, isAbortError } from '../../lib/api';

type CallDirection = 'inbound' | 'outbound';
type CallStatus = 'queued' | 'ringing' | 'connected' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled';

interface TranscriptEntry {
  id: string;
  sequenceNumber: number;
  speaker: 'agent' | 'user' | 'system';
  text: string;
  offsetMs: number;
  isFinal: boolean;
  createdAt: string;
}

interface CallRecord {
  id: string;
  providerCallId: string | null;
  agentId: string | null;
  agentName: string | null;
  campaignId: string | null;
  campaignName: string | null;
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
  transcript?: TranscriptEntry[];
}

interface ReportRow {
  key: string;
  dateKey: string;
  dateLabel: string;
  agentName: string;
  campaignName: string;
  currency: string;
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  completedCalls: number;
  failedCalls: number;
  busyCalls: number;
  noAnswerCalls: number;
  canceledCalls: number;
  totalDurationSeconds: number;
  positiveCalls: number;
  neutralCalls: number;
  negativeCalls: number;
  unknownSentimentCalls: number;
  totalCost: number;
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

function reportDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { key: 'invalid', label: 'Unknown date' };
  const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
  return { key, label: new Intl.DateTimeFormat('en-IN', {
    year: 'numeric', month: 'short', day: '2-digit',
  }).format(date) };
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
      : ['failed', 'canceled'].includes(status) ? 'border-rose-200 bg-rose-50 text-rose-700'
        : ['busy', 'no_answer'].includes(status) ? 'border-amber-200 bg-amber-50 text-amber-700'
          : 'border-slate-200 bg-slate-100 text-slate-600';
  return <span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-black uppercase ${style}`}>{statusLabel[status]}</span>;
}

function ReportsAggregateTable({ rows, loading }: { rows: ReportRow[]; loading: boolean }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[2200px] text-left">
    <thead className="border-b border-slate-200 bg-slate-50 text-[9px] font-black uppercase tracking-wider text-slate-400"><tr>
      {['Date', 'Agent', 'Campaign', 'Total', 'Inbound', 'Outbound', 'Completed', 'Failed', 'Busy',
        'No Answer', 'Canceled', 'Completion', 'Avg Duration', 'Total Duration', 'Positive', 'Neutral',
        'Negative', 'Unknown', 'Total Cost', 'Currency'].map((heading) => <th key={heading} className="px-4 py-4">{heading}</th>)}
    </tr></thead>
    <tbody className="divide-y divide-slate-100 text-xs">{loading
      ? <tr><td colSpan={20} className="py-16 text-center"><LoaderCircle className="mx-auto h-7 w-7 animate-spin text-pink-500" /><p className="mt-3 font-bold text-slate-400">Building reports from real call records…</p></td></tr>
      : rows.length ? rows.map((row) => <tr key={row.key} className="hover:bg-slate-50">
        <td className="px-4 py-4 font-bold text-slate-600">{row.dateLabel}</td>
        <td className="px-4 py-4 font-black text-slate-700">{row.agentName}</td>
        <td className="px-4 py-4 font-bold text-slate-600">{row.campaignName}</td>
        <td className="px-4 py-4 font-black text-slate-800">{row.totalCalls}</td>
        <td className="px-4 py-4 font-bold text-blue-600">{row.inboundCalls}</td>
        <td className="px-4 py-4 font-bold text-pink-600">{row.outboundCalls}</td>
        <td className="px-4 py-4 font-bold text-emerald-600">{row.completedCalls}</td>
        <td className="px-4 py-4 font-bold text-rose-600">{row.failedCalls}</td>
        <td className="px-4 py-4 font-bold text-amber-600">{row.busyCalls}</td>
        <td className="px-4 py-4 font-bold text-amber-600">{row.noAnswerCalls}</td>
        <td className="px-4 py-4 font-bold text-rose-500">{row.canceledCalls}</td>
        <td className="px-4 py-4 font-black text-slate-700">{row.totalCalls ? Math.round((row.completedCalls / row.totalCalls) * 100) : 0}%</td>
        <td className="px-4 py-4 font-mono text-slate-600">{duration(row.totalCalls ? row.totalDurationSeconds / row.totalCalls : 0)}</td>
        <td className="px-4 py-4 font-mono text-slate-600">{duration(row.totalDurationSeconds)}</td>
        <td className="px-4 py-4 font-bold text-emerald-600">{row.positiveCalls}</td>
        <td className="px-4 py-4 font-bold text-slate-600">{row.neutralCalls}</td>
        <td className="px-4 py-4 font-bold text-rose-600">{row.negativeCalls}</td>
        <td className="px-4 py-4 font-bold text-slate-400">{row.unknownSentimentCalls}</td>
        <td className="px-4 py-4 font-mono font-bold text-slate-700">{row.totalCost.toFixed(2)}</td>
        <td className="px-4 py-4 font-bold text-slate-500">{row.currency}</td>
      </tr>) : <tr><td colSpan={20} className="py-16 text-center text-slate-400"><FileSpreadsheet className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 font-bold">No report data matches these filters.</p></td></tr>}
    </tbody>
  </table></div>;
}

function DetailedCallLogsTable({ calls, loading, page, openDetails }: {
  calls: CallRecord[];
  loading: boolean;
  page: number;
  openDetails: (call: CallRecord) => Promise<void>;
}) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[2350px] text-left">
    <thead className="border-b border-slate-200 bg-slate-50 text-[9px] font-black uppercase tracking-wider text-slate-400"><tr>
      {['#', 'Started At', 'Direction', 'From Number', 'To Number', 'Agent', 'Campaign', 'Outcome',
        'Ringing At', 'Answered At', 'Ended At', 'Duration', 'Sentiment', 'Cost', 'Currency', 'Recording'].map((heading) => <th key={heading} className="px-4 py-4">{heading}</th>)}
      <th className="px-4 py-4 text-center">Review</th>
    </tr></thead>
    <tbody className="divide-y divide-slate-100 text-xs">{loading
      ? <tr><td colSpan={17} className="py-16 text-center"><LoaderCircle className="mx-auto h-7 w-7 animate-spin text-pink-500" /><p className="mt-3 font-bold text-slate-400">Loading real call records…</p></td></tr>
      : calls.length ? calls.map((call, index) => <tr key={call.id} className="hover:bg-slate-50">
        <td className="px-4 py-4 font-mono text-slate-400">{(page - 1) * TABLE_PAGE_SIZE + index + 1}</td>
        <td className="whitespace-nowrap px-4 py-4 font-semibold text-slate-600">{timestamp(call.startedAt, true)}</td>
        <td className="px-4 py-4"><span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-black uppercase ${call.direction === 'inbound' ? 'border-blue-100 bg-blue-50 text-blue-600' : 'border-pink-100 bg-pink-50 text-pink-600'}`}>{call.direction === 'inbound' ? <PhoneIncoming className="h-3 w-3" /> : <PhoneOutgoing className="h-3 w-3" />}{call.direction}</span></td>
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
        <td className="px-4 py-4 text-center"><button onClick={() => void openDetails(call)} title="View real call details" className="rounded-lg p-2 text-slate-400 hover:bg-pink-50 hover:text-pink-600"><Eye className="h-4 w-4" /></button></td>
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
  title = 'Call Reports',
  subtitle = 'Daily agent and campaign performance calculated from real tenant calls',
  variant = 'reports',
}: DeveloperReportsViewProps = {}) {
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
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CallRecord | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingError, setRecordingError] = useState('');
  const [exportMessage, setExportMessage] = useState('');

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
    return !query || [call.fromNumber, call.toNumber, call.agentName, call.campaignName, call.providerCallId]
      .some((value) => String(value ?? '').toLowerCase().includes(query));
  }), [calls, directionFilter, statusFilter, agentFilter, campaignFilter, durationFilter, dateFilter, search]);

  const reportRows = useMemo(() => {
    const groups = new Map<string, ReportRow>();
    for (const call of filtered) {
      const date = reportDate(call.startedAt);
      const agentName = call.agentName || 'Unassigned Agent';
      const campaignName = call.campaignName || 'No Campaign';
      const currency = call.currency || 'INR';
      const key = [date.key, call.agentId || 'unassigned', call.campaignId || 'none', currency].join('|');
      const row = groups.get(key) ?? {
        key, dateKey: date.key, dateLabel: date.label, agentName, campaignName, currency,
        totalCalls: 0, inboundCalls: 0, outboundCalls: 0, completedCalls: 0,
        failedCalls: 0, busyCalls: 0, noAnswerCalls: 0, canceledCalls: 0,
        totalDurationSeconds: 0, positiveCalls: 0, neutralCalls: 0,
        negativeCalls: 0, unknownSentimentCalls: 0, totalCost: 0,
      };
      row.totalCalls += 1;
      if (call.direction === 'inbound') row.inboundCalls += 1; else row.outboundCalls += 1;
      if (call.status === 'completed') row.completedCalls += 1;
      if (call.status === 'failed') row.failedCalls += 1;
      if (call.status === 'busy') row.busyCalls += 1;
      if (call.status === 'no_answer') row.noAnswerCalls += 1;
      if (call.status === 'canceled') row.canceledCalls += 1;
      row.totalDurationSeconds += Math.max(0, Number(call.durationSeconds) || 0);
      const sentiment = String(call.sentiment || 'unknown').toLowerCase();
      if (sentiment === 'positive') row.positiveCalls += 1;
      else if (sentiment === 'neutral') row.neutralCalls += 1;
      else if (sentiment === 'negative') row.negativeCalls += 1;
      else row.unknownSentimentCalls += 1;
      row.totalCost += Math.max(0, Number(call.cost) || 0);
      groups.set(key, row);
    }
    return [...groups.values()].sort((left, right) => right.dateKey.localeCompare(left.dateKey)
      || left.agentName.localeCompare(right.agentName) || left.campaignName.localeCompare(right.campaignName));
  }, [filtered]);

  useEffect(() => { setPage(1); }, [directionFilter, statusFilter, agentFilter, campaignFilter, durationFilter, dateFilter, search]);

  const rowCount = variant === 'reports' ? reportRows.length : filtered.length;
  const totalPages = Math.max(1, Math.ceil(rowCount / TABLE_PAGE_SIZE));
  const visible = filtered.slice((page - 1) * TABLE_PAGE_SIZE, page * TABLE_PAGE_SIZE);
  const visibleReportRows = reportRows.slice((page - 1) * TABLE_PAGE_SIZE, page * TABLE_PAGE_SIZE);
  const inbound = calls.filter((call) => call.direction === 'inbound').length;
  const outbound = calls.length - inbound;
  const completed = filtered.filter((call) => call.status === 'completed').length;
  const completionRate = filtered.length ? `${Math.round((completed / filtered.length) * 100)}%` : '0%';
  const reportCurrencies = [...new Set(filtered.map((call) => call.currency || 'INR'))];
  const totalCost = filtered.reduce((sum, call) => sum + Math.max(0, Number(call.cost) || 0), 0);
  const totalCostLabel = reportCurrencies.length === 1
    ? `${reportCurrencies[0]} ${totalCost.toFixed(2)}` : totalCost.toFixed(2);

  useEffect(() => { setPage((current) => Math.min(current, totalPages)); }, [totalPages]);

  const clearFilters = () => {
    setDirectionFilter('all'); setStatusFilter('all'); setDateFilter('all'); setAgentFilter('all');
    setCampaignFilter('all'); setDurationFilter('all'); setSearch('');
  };

  const openDetails = async (call: CallRecord) => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(''); setRecordingError(''); setRecordingLoading(false);
    setSelected(call); setDetailsLoading(true); setDetailsError('');
    try {
      const detail = await apiRequest<CallRecord>(`/calls/${call.id}`, { zeaCache: 'reload' });
      setSelected(detail);
      if (detail.recordingAvailable) {
        setRecordingLoading(true);
        try {
          const blob = await apiBlobRequest(`/calls/${call.id}/recording`);
          setRecordingUrl(URL.createObjectURL(blob));
        } catch (requestError) {
          setRecordingError(requestError instanceof Error ? requestError.message : 'Recording could not be loaded');
        } finally { setRecordingLoading(false); }
      }
    } catch (requestError) {
      setDetailsError(requestError instanceof Error ? requestError.message : 'Call details could not be loaded');
    } finally { setDetailsLoading(false); }
  };

  const closeDetails = () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(''); setRecordingError(''); setSelected(null);
  };

  useEffect(() => () => { if (recordingUrl) URL.revokeObjectURL(recordingUrl); }, [recordingUrl]);

  const exportCsv = () => {
    const rows = variant === 'reports'
      ? [['Date', 'Agent', 'Campaign', 'Total Calls', 'Inbound', 'Outbound', 'Completed', 'Failed', 'Busy',
        'No Answer', 'Canceled', 'Completion Rate', 'Average Duration Seconds', 'Total Duration Seconds',
        'Positive', 'Neutral', 'Negative', 'Unknown Sentiment', 'Total Cost', 'Currency'],
      ...reportRows.map((row) => [row.dateLabel, row.agentName, row.campaignName, row.totalCalls,
        row.inboundCalls, row.outboundCalls, row.completedCalls, row.failedCalls, row.busyCalls,
        row.noAnswerCalls, row.canceledCalls, row.totalCalls ? Math.round((row.completedCalls / row.totalCalls) * 100) : 0,
        row.totalCalls ? Math.round(row.totalDurationSeconds / row.totalCalls) : 0, row.totalDurationSeconds,
        row.positiveCalls, row.neutralCalls, row.negativeCalls, row.unknownSentimentCalls,
        row.totalCost.toFixed(4), row.currency])]
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
    URL.revokeObjectURL(url); setExportMessage(variant === 'reports'
      ? `Exported ${reportRows.length} aggregated report rows.` : `Exported ${filtered.length} real call records.`);
    window.setTimeout(() => setExportMessage(''), 3500);
  };

  return <div className="space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div><h2 className="text-xl font-black text-slate-800">{title}</h2><p className="mt-1 text-xs font-semibold text-slate-400">{subtitle}</p></div>
      <div className="flex items-center gap-2">
        <button onClick={refresh} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</button>
        <button onClick={exportCsv} disabled={!filtered.length} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"><FileSpreadsheet className="h-4 w-4 text-emerald-400" />Export CSV</button>
      </div>
    </div>

    {exportMessage && <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-700"><CheckCircle2 className="h-4 w-4" />{exportMessage}</div>}
    {error && <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-700"><span>{error}</span><button onClick={refresh}>Retry</button></div>}

    <div className="grid gap-4 md:grid-cols-3">
      {(variant === 'reports' ? [
        { label: 'Total Calls', value: filtered.length, Icon: Phone, style: 'bg-pink-50 text-pink-600' },
        { label: 'Completion Rate', value: completionRate, Icon: CheckCircle2, style: 'bg-emerald-50 text-emerald-600' },
        { label: 'Total Cost', value: totalCostLabel, Icon: Activity, style: 'bg-violet-50 text-violet-600' },
      ] : [
        { label: 'Total Calls', value: calls.length, Icon: Phone, style: 'bg-pink-50 text-pink-600' },
        { label: 'Inbound', value: inbound, Icon: PhoneIncoming, style: 'bg-blue-50 text-blue-600' },
        { label: 'Outbound', value: outbound, Icon: PhoneOutgoing, style: 'bg-violet-50 text-violet-600' },
      ]).map(({ label, value, Icon, style }) => <div key={label} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-3xl font-black text-slate-800">{value}</p></div><div className={`rounded-2xl p-3 ${style}`}><Icon className="h-5 w-5" /></div></div>)}
    </div>

    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-xs font-black uppercase text-slate-600"><Filter className="h-4 w-4" />Filters</span><button onClick={clearFilters} className="flex items-center gap-1 text-xs font-bold text-pink-600"><XCircle className="h-4 w-4" />Clear</button></div>
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value as typeof dateFilter)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Time</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">Last 7 Days</option><option value="30d">Last 30 Days</option></select>
        <select value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value as typeof directionFilter)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Directions</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Outcomes</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Agents</option>{agents.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Campaigns</option>{campaigns.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select value={durationFilter} onChange={(e) => setDurationFilter(e.target.value as typeof durationFilter)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option value="all">All Durations</option><option value="0-30">0–30 sec</option><option value="31-60">31–60 sec</option><option value="61-120">1–2 min</option><option value="121-300">2–5 min</option><option value="301+">5+ min</option></select>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-lg flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search phone, agent, campaign or call ID" className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-xs font-semibold outline-none focus:border-pink-400" /></div><span className="text-xs font-bold text-slate-400">{variant === 'reports' ? `${reportRows.length} report groups from ${filtered.length} calls` : `${filtered.length} call records`} · {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Loading'}</span></div>
    </div>

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {variant === 'reports'
        ? <ReportsAggregateTable rows={visibleReportRows} loading={loading} />
        : <DetailedCallLogsTable calls={visible} loading={loading} page={page} openDetails={openDetails} />}
      <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-4"><span className="text-xs font-bold text-slate-400">Page {page} of {totalPages}</span><div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-slate-200 bg-white p-2 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button><button disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="rounded-lg border border-slate-200 bg-white p-2 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button></div></div>
    </div>

    {selected && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/45 backdrop-blur-sm"><div className="flex h-full w-full max-w-xl flex-col bg-slate-50 shadow-2xl"><div className="flex items-center justify-between border-b border-slate-200 bg-white p-6"><div><p className="text-[10px] font-black uppercase tracking-wider text-pink-500">Real Call Record</p><h3 className="text-xl font-black text-slate-800">Call Details</h3></div><button onClick={closeDetails} className="rounded-xl border border-slate-200 p-2 text-slate-500"><X className="h-4 w-4" /></button></div>
      <div className="flex-1 space-y-5 overflow-y-auto p-6">{detailsLoading && <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 text-xs font-bold text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Loading transcript…</div>}{detailsError && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-700">{detailsError}</div>}
        <div className="grid grid-cols-2 gap-3">{[['Agent', selected.agentName || '—'], ['Timestamp', timestamp(selected.startedAt, true)], ['Direction', selected.direction.toUpperCase()], ['Outcome', statusLabel[selected.status]], ['Duration', duration(selected.durationSeconds)], ['Sentiment', selected.sentiment || 'Not analyzed']].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</p><p className="mt-2 break-words text-xs font-black text-slate-800">{value}</p></div>)}</div>
        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white p-5 text-xs">{[['From', selected.fromNumber], ['To', selected.toNumber], ['Agent ID', selected.agentId || '—'], ['Campaign', selected.campaignName || '—'], ['Plivo Call UUID', selected.providerCallId || '—'], ['Internal Call ID', selected.id]].map(([label, value]) => <div key={label} className="flex items-start justify-between gap-5 py-3"><span className="shrink-0 font-black uppercase text-slate-400">{label}</span><span className="break-all text-right font-mono font-bold text-slate-700">{value}</span></div>)}</div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><h4 className="text-sm font-black text-slate-800">Transcript</h4><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-500">{selected.transcript?.length ?? 0} entries</span></div>{selected.transcript?.length ? <div className="space-y-4">{selected.transcript.map((entry) => <div key={entry.id} className={`flex flex-col ${entry.speaker === 'agent' ? 'items-end' : 'items-start'}`}><span className="mb-1 text-[9px] font-black uppercase tracking-wider text-slate-400">{entry.speaker} · {elapsed(entry.offsetMs)}</span><div className={`max-w-[88%] rounded-2xl px-4 py-3 text-xs font-semibold leading-relaxed ${entry.speaker === 'agent' ? 'rounded-tr-none bg-gradient-to-r from-violet-600 to-pink-500 text-white' : entry.speaker === 'system' ? 'border border-amber-200 bg-amber-50 text-amber-800' : 'rounded-tl-none border border-slate-200 bg-slate-50 text-slate-800'}`}>{entry.text}</div></div>)}</div> : <p className="py-8 text-center text-xs font-semibold text-slate-400">No finalized transcript entries were saved for this call.</p>}</div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-3 flex items-center gap-2"><Download className="h-4 w-4 text-emerald-500" /><h4 className="text-sm font-black text-slate-800">Call Recording</h4></div>{recordingLoading ? <div className="flex items-center gap-2 py-3 text-xs font-bold text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin text-emerald-500" />Loading private recording from B2...</div> : recordingUrl ? <><audio controls preload="metadata" src={recordingUrl} className="w-full" /><a href={recordingUrl} download={`call-${selected.id}.mp3`} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[10px] font-black text-emerald-700"><Download className="h-3.5 w-3.5" />Download recording</a></> : recordingError ? <p className="text-xs font-bold text-rose-600">{recordingError}</p> : <div className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Activity className="h-4 w-4 text-slate-400" />No recording is available for this call.</div>}</div>
      </div><div className="border-t border-slate-200 bg-white p-5 text-right"><button onClick={closeDetails} className="rounded-xl bg-slate-900 px-5 py-2.5 text-xs font-bold text-white">Close</button></div></div></div>}
  </div>;
}
