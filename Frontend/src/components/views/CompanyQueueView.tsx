import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';
import { useAppState } from '../../store/AppState';

interface QueueRow {
  id: string; phone: string; agentName?: string; campaignId?: string; campaignName?: string;
  campaignStatus?: string; source?: string; direction?: string; status?: string;
  waitSeconds?: number; durationSeconds?: number; reason?: string; scheduledFor?: string;
}
interface CompanyQueueData {
  queueEnabled: boolean;
  totals: { active: number; inboundWaiting: number; outboundWaiting: number };
  settings: { maxTotalConcurrency: number; maxInboundQueueSize: number; maxInboundWaitSeconds: number; maxOutboundQueuedTasks: number };
  active: QueueRow[]; inbound: QueueRow[]; outbound: QueueRow[];
  pagination: { page: number; totalPages: number }; permissions: { canManage: boolean }; updatedAt: string;
}
const reasonLabels: Record<string, string> = {
  ready: 'Waiting for dispatch', scheduled: 'Scheduled call or retry', calling_hours: 'Outside calling hours',
  waiting_credits: 'Waiting for credits', campaign_paused: 'Campaign paused or draft', queue_unavailable: 'Queue unavailable',
  company_capacity: 'Company call limit reached', campaign_capacity: 'Campaign call limit reached',
  coordination_unavailable: 'Call coordination unavailable',
};
const elapsed = (seconds = 0) => `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

export function CompanyQueueView() {
  const { role } = useAppState();
  const [data, setData] = useState<CompanyQueueData | null>(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [acting, setActing] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const load = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        controller = new AbortController();
        try {
          const result = await apiRequest<CompanyQueueData>(`/queues?page=${page}&pageSize=50`, { signal: controller.signal, zeaCache: 'bypass' });
          if (!stopped) { setData(result); setError(''); }
        } catch (requestError) {
          if (!stopped && !isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Queue could not be loaded.');
        }
      }
      if (!stopped) timer = window.setTimeout(() => void load(), 5000);
    };
    void load();
    return () => { stopped = true; controller?.abort(); if (timer) window.clearTimeout(timer); };
  }, [page, refresh]);
  const canManage = role === 'DEVELOPER' && data?.permissions.canManage;
  const manage = async (path: string, key: string) => {
    if (acting) return;
    setActing(key); setError('');
    try { await apiRequest(path, { method: 'POST' }); setRefresh(value => value + 1); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Queue action failed.'); }
    finally { setActing(''); }
  };
  const table = (title: string, rows: QueueRow[], kind: 'active' | 'inbound' | 'outbound', count: number) => (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-lg font-bold text-slate-800">{title} <span className="text-sm text-slate-500">({count})</span></h3>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500"><tr>
            <th className="p-3">Phone</th><th className="p-3">Agent</th><th className="p-3">Campaign</th>
            <th className="p-3">Service</th><th className="p-3">{kind === 'active' ? 'Duration' : 'Waiting'}</th>
            <th className="p-3">{kind === 'active' ? 'Status' : 'Waiting reason'}</th>
            {canManage && kind === 'outbound' && <th className="p-3">Actions</th>}
          </tr></thead>
          <tbody>{rows.map(row => <tr key={row.id} className="border-b border-slate-100 last:border-0">
            <td className="p-3 font-medium text-slate-800">{row.phone || 'Preparing call'}</td>
            <td className="p-3">{row.agentName || '—'}</td><td className="p-3">{row.campaignName || '—'}</td>
            <td className="p-3 capitalize">{row.source?.replace('_', ' ') || row.direction || 'Inbound'}</td>
            <td className="p-3 whitespace-nowrap">{elapsed(kind === 'active' ? row.durationSeconds : row.waitSeconds)}</td>
            <td className="p-3"><span>{kind === 'active' ? row.status : reasonLabels[row.reason ?? 'ready'] ?? row.reason}</span>
              {kind === 'outbound' && row.reason === 'scheduled' && row.scheduledFor && <div className="mt-1 text-xs text-slate-500">{new Date(row.scheduledFor).toLocaleString()}</div>}
            </td>
            {canManage && kind === 'outbound' && <td className="p-3"><div className="flex gap-2 whitespace-nowrap">
              {row.campaignId && ['running', 'scheduled', 'paused'].includes(row.campaignStatus ?? '') && <button type="button" disabled={Boolean(acting)}
                onClick={() => void manage(`/queues/campaigns/${row.campaignId}/${row.campaignStatus === 'paused' ? 'resume' : 'pause'}`, row.id)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold disabled:opacity-50">{row.campaignStatus === 'paused' ? 'Resume campaign' : 'Pause campaign'}</button>}
              <button type="button" disabled={Boolean(acting)} onClick={() => {
                if (window.confirm(`Cancel the waiting call to ${row.phone}?`)) void manage(`/queues/tasks/${row.id}/cancel`, row.id);
              }} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-50">Cancel task</button>
            </div></td>}
          </tr>)}</tbody>
        </table>
        {!rows.length && <p className="py-6 text-center text-sm text-slate-500">No {kind === 'active' ? 'active calls' : 'waiting calls'} on this page.</p>}
      </div>
    </section>
  );
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-2xl font-bold text-slate-800">Call Queue</h2><p className="mt-1 text-sm text-slate-500">Live calls and waiting callers across your company. Refreshes every five seconds.</p></div>
      <button type="button" onClick={() => setRefresh(value => value + 1)} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><RefreshCw className="h-4 w-4" />Refresh</button>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {data && !data.queueEnabled && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Call waiting is not enabled for this company. Existing waiting callers can finish; queue management and new waiting-task limits are inactive.</p>}
    {!data ? <p className="py-8 text-slate-500">Loading company queue…</p> : <>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">Active calls</p><p className="mt-2 text-2xl font-bold">{data.totals.active} / {data.settings.maxTotalConcurrency}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">Inbound waiting</p><p className="mt-2 text-2xl font-bold">{data.totals.inboundWaiting} / {data.settings.maxInboundQueueSize}</p><p className="mt-1 text-xs text-slate-500">Maximum wait: {elapsed(data.settings.maxInboundWaitSeconds)}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">Outbound waiting</p><p className="mt-2 text-2xl font-bold">{data.totals.outboundWaiting} / {data.settings.maxOutboundQueuedTasks}</p></div>
      </div>
      <p className="text-xs text-slate-500">Queue limits are assigned by Super Admin. {canManage ? 'You can manage waiting outbound tasks and campaign dispatch.' : 'Your queue access is read-only.'} Updated {new Date(data.updatedAt).toLocaleTimeString()}.</p>
      {table('Active calls', data.active, 'active', data.totals.active)}
      {table('Inbound waiting callers', data.inbound, 'inbound', data.totals.inboundWaiting)}
      {table('Outbound waiting tasks', data.outbound, 'outbound', data.totals.outboundWaiting)}
      <div className="flex items-center justify-end gap-3 text-sm">
        <button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Previous</button>
        <span>Page {page} of {data.pagination.totalPages}</span>
        <button type="button" disabled={page >= data.pagination.totalPages} onClick={() => setPage(value => value + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Next</button>
      </div>
    </>}
  </div>;
}
