import React, { useEffect, useState } from 'react';
import { apiRequest, isAbortError } from '../../lib/api';

interface QueueMetric {
  id: string;
  name: string;
  queueName: string;
  status: 'normal' | 'congested' | 'critical' | 'paused';
  paused: boolean;
  activeCalls: number;
  waitingCalls: number;
  avgWaitTime: number;
  maxWaitTime: number;
  completed: number;
  failed: number;
}

interface WorkerHeartbeat {
  workerId: string;
  queueName: string;
  concurrency: number;
  status: string;
  hostname: string;
  pid: number;
  lastHeartbeatAt: string;
}

const statusClass: Record<QueueMetric['status'], string> = {
  normal: 'bg-emerald-50 border-emerald-100 text-emerald-700',
  congested: 'bg-amber-50 border-amber-100 text-amber-700',
  critical: 'bg-red-50 border-red-100 text-red-700 animate-pulse',
  paused: 'bg-slate-100 border-slate-200 text-slate-600',
};

export function QueueMonitorView() {
  const [queues, setQueues] = useState<QueueMetric[]>([]);
  const [workers, setWorkers] = useState<WorkerHeartbeat[]>([]);
  const [queuesLoading, setQueuesLoading] = useState(true);
  const [workersLoading, setWorkersLoading] = useState(true);
  const [actingOn, setActingOn] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const loadMonitor = async (showLoader = true, signal?: AbortSignal) => {
    if (showLoader) { setQueuesLoading(true); setWorkersLoading(true); }
    setError('');
    await Promise.allSettled([
      apiRequest<QueueMetric[]>('/admin/queues', { signal })
        .then((data) => { setQueues(data); setLastUpdatedAt(new Date()); })
        .catch((requestError) => { if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Queue metrics could not be loaded'); })
        .finally(() => { if (showLoader) setQueuesLoading(false); }),
      apiRequest<WorkerHeartbeat[]>('/admin/queues/workers', { signal })
        .then(setWorkers)
        .catch((requestError) => { if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Worker heartbeats could not be loaded'); })
        .finally(() => { if (showLoader) setWorkersLoading(false); }),
    ]);
  };

  useEffect(() => {
    let stopped = false;
    let refreshTimer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async (showLoader = false) => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        controller = new AbortController();
        await loadMonitor(showLoader, controller.signal);
      }
      if (!stopped) refreshTimer = window.setTimeout(() => void poll(false), 5000);
    };
    void poll(true);
    const resume = () => {
      if (document.visibilityState === 'visible' && !stopped) {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        controller?.abort();
        void poll(false);
      }
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      controller?.abort();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  const setPaused = async (queue: QueueMetric) => {
    setActingOn(queue.queueName); setError(''); setSuccess('');
    try {
      await apiRequest(`/admin/queues/${queue.queueName}/${queue.paused ? 'resume' : 'pause'}`, {
        method: 'POST', body: '{}',
      });
      setSuccess(`${queue.name} ${queue.paused ? 'resumed' : 'paused'} successfully.`);
      await loadMonitor(false);
      window.setTimeout(() => setSuccess(''), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Queue state could not be changed');
    } finally { setActingOn(''); }
  };

  const emergencyFlush = async (queue: QueueMetric) => {
    const reason = window.prompt(`Reason for flushing ${queue.name}:`);
    if (!reason?.trim()) return;
    if (!window.confirm(`Remove all waiting and delayed jobs from ${queue.name}? Active calls will not be affected.`)) return;
    setActingOn(queue.queueName); setError(''); setSuccess('');
    try {
      const result = await apiRequest<{ removedJobs: number }>(`/admin/queues/${queue.queueName}/flush`, {
        method: 'POST', body: JSON.stringify({ confirm: true, reason: reason.trim() }),
      });
      setSuccess(`${result.removedJobs} queued job(s) removed from ${queue.name}.`);
      await loadMonitor(false);
      window.setTimeout(() => setSuccess(''), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Queue could not be flushed');
    } finally { setActingOn(''); }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">Queue Monitor</h2>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Live BullMQ call queues and worker heartbeats from Redis.</p>
          <p className="text-[9px] text-slate-400 mt-1">Auto-refreshes every 5 seconds{lastUpdatedAt ? ` · Last updated ${lastUpdatedAt.toLocaleTimeString()}` : ''}</p>
        </div>
        <button type="button" onClick={() => void loadMonitor()} disabled={queuesLoading || workersLoading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer">
          {queuesLoading || workersLoading ? 'Refreshing...' : 'Refresh Now'}
        </button>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-semibold">{error}</div>}
      {success && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs font-semibold">{success}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {queuesLoading && queues.length === 0 && [1, 2, 3].map((item) => <div key={item} className="h-56 animate-pulse rounded-xl border border-slate-200 bg-white p-6"><div className="h-4 w-40 rounded bg-slate-200" /><div className="mt-8 h-24 rounded bg-slate-100" /></div>)}
        {queues.map((queue) => (
          <div key={queue.id} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex flex-col justify-between hover:shadow-md transition duration-200">
            <div>
              <div className="flex justify-between items-start gap-3">
                <div><h4 className="font-bold text-slate-800 text-sm tracking-tight">{queue.name}</h4><span className="text-[9px] text-slate-400 font-mono">{queue.queueName}</span></div>
                <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${statusClass[queue.status]}`}>{queue.status}</span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-semibold mt-4">
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Active Jobs</span>
                  <span className="text-slate-800 font-bold text-lg">{queue.activeCalls}</span>
                </div>
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Waiting / Delayed</span>
                  <span className="text-rose-500 font-bold text-lg">{queue.waitingCalls}</span>
                </div>
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Average Wait</span>
                  <span className="text-slate-800 font-mono text-[11px] font-bold">{queue.avgWaitTime}s</span>
                </div>
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Maximum Wait</span>
                  <span className="text-amber-600 font-mono text-[11px] font-bold">{queue.maxWaitTime}s</span>
                </div>
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Completed</span>
                  <span className="text-emerald-700 font-mono text-[11px] font-bold">{queue.completed}</span>
                </div>
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Failed</span>
                  <span className="text-red-600 font-mono text-[11px] font-bold">{queue.failed}</span>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 mt-4 flex flex-wrap justify-end gap-2">
              <button onClick={() => void setPaused(queue)} disabled={actingOn === queue.queueName}
                className="px-3 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer">
                {queue.paused ? 'Resume Queue' : 'Pause Queue'}
              </button>
              {queue.waitingCalls > 0 && (
                <button onClick={() => void emergencyFlush(queue)} disabled={actingOn === queue.queueName}
                  className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 border border-rose-100 text-rose-600 rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer">
                  Emergency Flush
                </button>
              )}
            </div>
          </div>
        ))}
        {!queuesLoading && queues.length === 0 && <div className="xl:col-span-3 py-10 text-center bg-white border border-dashed border-slate-300 rounded-xl text-xs text-slate-500">No configured queues were returned.</div>}
      </div>

      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex justify-between items-center mb-4"><div><h3 className="font-bold text-slate-800">Campaign Workers</h3><p className="text-[10px] text-slate-400">Live Redis heartbeats from running queue workers.</p></div><span className="text-xs font-black text-indigo-600">{workers.length} online</span></div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {workersLoading && workers.length === 0 && [1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}
          {workers.map((worker) => (
            <div key={worker.workerId} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3 text-xs">
              <div className="flex justify-between"><span className="font-bold text-slate-800">{worker.queueName}</span><span className="text-[9px] uppercase font-bold text-emerald-700">{worker.status}</span></div>
              <p className="text-[10px] text-slate-500 mt-1 font-mono break-all">{worker.workerId}</p>
              <div className="flex flex-wrap gap-x-3 text-[9px] text-slate-400 mt-2"><span>{worker.hostname}</span><span>PID {worker.pid}</span><span>Concurrency {worker.concurrency}</span></div>
              <p className="text-[9px] text-slate-400 mt-1">Heartbeat: {new Date(worker.lastHeartbeatAt).toLocaleString()}</p>
            </div>
          ))}
          {!workersLoading && workers.length === 0 && <div className="md:col-span-2 xl:col-span-3 py-6 text-center text-xs text-slate-400">No active campaign worker heartbeat found.</div>}
        </div>
      </div>
    </div>
  );
}
