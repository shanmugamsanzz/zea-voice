import { useEffect, useState } from 'react';
import {
  ChevronDown, Clock, FileSpreadsheet, Filter, Grid, RefreshCw, X,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';

type CallStatus = 'queued' | 'ringing' | 'connected' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled';

interface CallRecord {
  id: string;
  providerCallId: string | null;
  agentId: string | null;
  agentName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  fromNumber: string;
  toNumber: string;
  direction: 'inbound' | 'outbound';
  status: CallStatus;
  sentiment: 'unknown' | 'positive' | 'neutral' | 'negative';
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  cost: number;
  currency: string;
  recordingAvailable: boolean;
  transcript?: Array<{
    id: string;
    sequenceNumber: number;
    speaker: 'agent' | 'user' | 'system';
    text: string;
    offsetMs: number;
    isFinal: boolean;
    createdAt: string;
  }>;
}

interface CallListResponse {
  items: CallRecord[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  summary: { total: number; inbound: number; outbound: number };
}

const statusLabels: Record<CallStatus, string> = {
  queued: 'Queued', ringing: 'Ringing', connected: 'Connected', completed: 'Completed',
  failed: 'Failed', busy: 'Busy', no_answer: 'No Answer', canceled: 'Canceled',
};

const statusStyles: Record<CallStatus, string> = {
  queued: 'border-amber-200 bg-amber-50 text-amber-700',
  ringing: 'border-blue-200 bg-blue-50 text-blue-700',
  connected: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-rose-200 bg-rose-50 text-rose-700',
  busy: 'border-slate-200 bg-slate-100 text-slate-600',
  no_answer: 'border-slate-200 bg-slate-100 text-slate-600',
  canceled: 'border-rose-200 bg-rose-50 text-rose-700',
};

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const remaining = safe % 60;
  return minutes ? String(minutes) + 'm ' + String(remaining) + 's' : String(remaining) + 's';
}

function csvCell(value: unknown) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

export function CallLogsAnalyticsView() {
  const [dateRange, setDateRange] = useState<'7' | '30' | 'all'>('7');
  const [currentPage, setCurrentPage] = useState(1);
  const [result, setResult] = useState<CallListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [activeCall, setActiveCall] = useState<CallRecord | null>(null);
  const [drawerMode, setDrawerMode] = useState<'details' | 'transcript'>('details');
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const pageSize = 10;

  const buildQuery = (page: number, size = pageSize) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(size) });
    if (dateRange !== 'all') {
      const startedFrom = new Date(Date.now() - Number(dateRange) * 24 * 60 * 60 * 1000);
      params.set('startedFrom', startedFrom.toISOString());
    }
    return params.toString();
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiRequest<CallListResponse>('/calls?' + buildQuery(currentPage), { zeaCache: 'bypass' })
      .then((data) => { if (active) setResult(data); })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Unable to load call logs');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [currentPage, dateRange]);

  const openReview = async (call: CallRecord, mode: 'details' | 'transcript') => {
    setActiveCall(call);
    setDrawerMode(mode);
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      setActiveCall(await apiRequest<CallRecord>('/calls/' + call.id, { zeaCache: 'bypass' }));
    } catch (requestError) {
      setDetailsError(requestError instanceof Error ? requestError.message : 'Unable to load call details');
    } finally {
      setDetailsLoading(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    setError(null);
    try {
      const first = await apiRequest<CallListResponse>('/calls?' + buildQuery(1, 100), { zeaCache: 'bypass' });
      const remaining = await Promise.all(Array.from(
        { length: Math.max(0, first.pagination.totalPages - 1) },
        (_, index) => apiRequest<CallListResponse>('/calls?' + buildQuery(index + 2, 100), { zeaCache: 'bypass' }),
      ));
      const records = [first, ...remaining].flatMap((page) => page.items);
      const rows = [
        ['S.No', 'Call ID', 'Date & Time', 'Agent Name', 'Campaign Name', 'Direction', 'From Number',
          'To Number', 'Duration Seconds', 'Outcome', 'Sentiment', 'Cost', 'Currency', 'Recording Available'],
        ...records.map((call, index) => [
          index + 1, call.id, call.startedAt, call.agentName ?? '', call.campaignName ?? '',
          call.direction, call.fromNumber, call.toNumber, call.durationSeconds, call.status,
          call.sentiment, call.cost, call.currency, call.recordingAvailable ? 'Yes' : 'No',
        ]),
      ];
      const blob = new Blob([rows.map((row) => row.map(csvCell).join(',')).join('\n')], {
        type: 'text/csv;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ZeaVoice_Call_Logs_' + new Date().toISOString().slice(0, 10) + '.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to export call logs');
    } finally {
      setExporting(false);
    }
  };

  const items = result?.items ?? [];
  const pagination = result?.pagination ?? { page: currentPage, pageSize, total: 0, totalPages: 0 };
  const activeFilterCount = dateRange === 'all' ? 0 : 1;
  const dateRangeLabel = dateRange === 'all' ? 'All Time' : dateRange + ' Days';

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-4 rounded-3xl border border-slate-100 bg-white p-6 shadow-xs md:flex-row md:items-center">
        <div className="flex items-center space-x-4">
          <div className="shrink-0 rounded-2xl bg-pink-50 p-3"><FileSpreadsheet className="h-6 w-6 text-pink-600" /></div>
          <div>
            <h2 className="text-xl font-extrabold leading-tight tracking-tight text-slate-800">Call Logs Analytics</h2>
            <p className="mt-0.5 text-xs font-semibold text-slate-400">Tenant-isolated database call history and transcripts</p>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 md:w-auto">
          <div className="relative">
            <select
              value={dateRange}
              onChange={(event) => { setDateRange(event.target.value as '7' | '30' | 'all'); setCurrentPage(1); }}
              className="appearance-none rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-4 pr-8 text-xs font-bold text-slate-700 outline-none"
            >
              <option value="7">7 Days</option>
              <option value="30">30 Days</option>
              <option value="all">All Time</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-3.5 w-3.5 text-slate-400" />
          </div>
          <button
            type="button"
            disabled={exporting}
            onClick={() => { void exportCsv(); }}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-fuchsia-500 px-5 py-2.5 text-xs font-extrabold text-white disabled:opacity-60"
          >
            {exporting && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
            {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700">Unable to load database call logs: {error}</div>}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {[
          { label: 'Total Records', value: pagination.total, icon: Filter, tone: 'bg-blue-50 text-blue-500' },
          { label: 'Selected Columns', value: 13, icon: Grid, tone: 'bg-pink-50 text-pink-600' },
          { label: 'Active Filters', value: activeFilterCount, icon: Clock, tone: 'bg-violet-50 text-violet-600' },
        ].map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="flex items-center justify-between rounded-3xl border border-slate-100 bg-white p-6 shadow-xs">
            <div><span className="block text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span><span className="mt-1 block text-4xl font-black tracking-tight text-slate-800">{value}</span></div>
            <div className={'flex h-12 w-12 items-center justify-center rounded-2xl ' + tone}><Icon className="h-5 w-5" /></div>
          </div>
        ))}
      </div>

      <div className="space-y-4 rounded-3xl border border-slate-100 bg-white p-6 shadow-xs">
        <div className="flex items-end justify-between gap-4">
          <div><h3 className="text-base font-extrabold tracking-tight text-slate-800">Database Call Records</h3><p className="mt-0.5 text-[11px] font-semibold text-slate-400">Date filter: {dateRangeLabel}</p></div>
          <span className="text-[10px] font-bold text-slate-400">{pagination.total} records</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead><tr className="border-b border-slate-200 bg-slate-50 text-[9px] font-black uppercase tracking-widest text-slate-400">
              {['S.No', 'Date & Time', 'Agent Name', 'Campaign Name', 'Direction', 'From Number', 'To Number', 'Duration', 'Outcome', 'Sentiment', 'Cost', 'Recording', 'Transcript'].map((heading) => <th key={heading} className="whitespace-nowrap px-5 py-4">{heading}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 text-xs font-semibold text-slate-700">
              {loading ? <tr><td colSpan={13} className="px-6 py-14 text-center text-slate-400"><RefreshCw className="mx-auto mb-3 h-5 w-5 animate-spin text-pink-500" />Loading database call logs...</td></tr>
                : items.length === 0 ? <tr><td colSpan={13} className="px-6 py-14 text-center text-slate-400">No database call records match this date range.</td></tr>
                  : items.map((call, index) => (
                    <tr key={call.id} className="transition hover:bg-slate-50/50">
                      <td className="px-5 py-4 font-mono text-slate-400">{(pagination.page - 1) * pagination.pageSize + index + 1}</td>
                      <td className="whitespace-nowrap px-5 py-4 font-bold text-slate-500">{formatTimestamp(call.startedAt)}</td>
                      <td className="px-5 py-4 font-black text-slate-800">{call.agentName || 'Unassigned'}</td>
                      <td className="px-5 py-4 text-slate-500">{call.campaignName || '—'}</td>
                      <td className={'px-5 py-4 font-black ' + (call.direction === 'inbound' ? 'text-blue-500' : 'text-pink-500')}>{call.direction}</td>
                      <td className="px-5 py-4 font-mono font-bold text-slate-600">{call.fromNumber}</td>
                      <td className="px-5 py-4 font-mono font-bold text-slate-600">{call.toNumber}</td>
                      <td className="whitespace-nowrap px-5 py-4 font-mono text-slate-500">{formatDuration(call.durationSeconds)}</td>
                      <td className="px-5 py-4"><span className={'whitespace-nowrap rounded-md border px-2 py-0.5 text-[9px] font-black uppercase ' + statusStyles[call.status]}>{statusLabels[call.status]}</span></td>
                      <td className="px-5 py-4 capitalize text-slate-500">{call.sentiment}</td>
                      <td className="whitespace-nowrap px-5 py-4 font-mono text-slate-600">{call.currency} {Number(call.cost).toFixed(2)}</td>
                      <td className="px-5 py-4">{call.recordingAvailable ? <span className="font-bold text-emerald-600">Stored</span> : <span className="text-slate-300">—</span>}</td>
                      <td className="px-5 py-4"><button type="button" onClick={() => { void openReview(call, 'transcript'); }} className="font-black text-indigo-600 hover:underline">View</button></td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 px-6 py-4">
            <span className="text-xs font-bold text-slate-400">Page {pagination.page} of {pagination.totalPages}</span>
            <div className="flex gap-2">
              <button disabled={pagination.page <= 1 || loading} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 disabled:opacity-50">Previous</button>
              <button disabled={pagination.page >= pagination.totalPages || loading} onClick={() => setCurrentPage((page) => Math.min(pagination.totalPages, page + 1))} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </div>

      {activeCall && (
        <div className="fixed inset-0 z-50 flex items-center justify-end bg-slate-900/50 backdrop-blur-xs">
          <div className="flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-slate-50 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white p-6">
              <div><span className="block text-[10px] font-black uppercase tracking-widest text-slate-400">Database record</span><h3 className="mt-0.5 text-xl font-extrabold text-slate-800">Call Details</h3></div>
              <div className="flex gap-2">
                <button type="button" disabled={detailsLoading} onClick={() => setDrawerMode((mode) => mode === 'details' ? 'transcript' : 'details')} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700">{drawerMode === 'details' ? 'View Transcript' : 'View Details'}</button>
                <button type="button" onClick={() => setActiveCall(null)} className="rounded-xl border border-slate-200 bg-white p-2 text-slate-400"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {detailsLoading ? <div className="py-20 text-center text-xs font-semibold text-slate-400"><RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin text-pink-500" />Loading stored call details...</div>
                : drawerMode === 'transcript' ? (
                  <div className="space-y-5">
                    {detailsError && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{detailsError}</div>}
                    {activeCall.transcript?.length ? activeCall.transcript.map((entry) => (
                      <div key={entry.id} className={'flex flex-col ' + (entry.speaker === 'agent' ? 'items-end' : 'items-start')}>
                        <span className="mb-1 text-[9px] font-extrabold uppercase tracking-widest text-slate-400">{entry.speaker === 'agent' ? activeCall.agentName || 'Agent' : entry.speaker === 'user' ? 'Customer' : 'System'}</span>
                        <div className={'max-w-[85%] rounded-2xl p-4 text-xs font-semibold leading-relaxed ' + (entry.speaker === 'agent' ? 'rounded-tr-none bg-gradient-to-r from-purple-600 to-fuchsia-500 text-white' : 'rounded-tl-none border border-slate-200 bg-white text-slate-800')}>{entry.text}</div>
                        <span className="mt-1 text-[9px] text-slate-400">{formatDuration(Math.floor(entry.offsetMs / 1000))}</span>
                      </div>
                    )) : <div className="py-16 text-center text-xs font-semibold text-slate-400">No transcript entries are stored for this call.</div>}
                  </div>
                ) : (
                  <div className="space-y-5">
                    {detailsError && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{detailsError}</div>}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {[
                        ['Agent', activeCall.agentName || 'Unassigned'],
                        ['Timestamp', formatTimestamp(activeCall.startedAt)],
                        ['Direction', activeCall.direction.toUpperCase()],
                        ['Outcome', statusLabels[activeCall.status]],
                        ['From', activeCall.fromNumber],
                        ['To', activeCall.toNumber],
                        ['Duration', formatDuration(activeCall.durationSeconds)],
                        ['Cost', activeCall.currency + ' ' + Number(activeCall.cost).toFixed(2)],
                        ['Sentiment', activeCall.sentiment],
                        ['Campaign', activeCall.campaignName || 'None'],
                      ].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"><span className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</span><span className="mt-2 block break-words text-sm font-black capitalize text-slate-800">{value}</span></div>)}
                    </div>
                    <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white p-5 text-[11px] font-semibold">
                      {[
                        ['Call ID', activeCall.id],
                        ['Provider Call ID', activeCall.providerCallId || 'Not available'],
                        ['Agent ID', activeCall.agentId || 'Not assigned'],
                        ['Campaign ID', activeCall.campaignId || 'Not assigned'],
                        ['Recording', activeCall.recordingAvailable ? 'Stored' : 'Not available'],
                      ].map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-2.5"><span className="font-bold uppercase tracking-wider text-slate-400">{label}</span><span className="break-all text-right font-mono font-bold text-slate-800">{value}</span></div>)}
                    </div>
                  </div>
                )}
            </div>
            <div className="flex shrink-0 items-center justify-between border-t border-slate-200 bg-white p-6">
              <span className="truncate font-mono text-[10px] font-black uppercase tracking-widest text-slate-400">ID: {activeCall.id}</span>
              <button type="button" onClick={() => setActiveCall(null)} className="rounded-xl bg-slate-800 px-5 py-2.5 text-xs font-bold text-white">Close Review</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
