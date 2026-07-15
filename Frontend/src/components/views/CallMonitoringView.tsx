import React, { useEffect, useRef, useState } from 'react';
import { Activity, PhoneOff, Tv } from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

type CallStatus = 'queued' | 'ringing' | 'connected' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled';

interface CallItem {
  id: string;
  companyId: string;
  companyName: string;
  providerCallId: string | null;
  agentName: string | null;
  campaignName: string | null;
  fromNumber: string;
  toNumber: string;
  direction: 'inbound' | 'outbound';
  status: CallStatus;
  sentiment: 'unknown' | 'positive' | 'neutral' | 'negative';
  startedAt: string;
  ringingAt: string | null;
  answeredAt: string | null;
  durationSeconds: number;
  cost: number;
  currency: string;
}

interface CallDetail extends CallItem {
  transcript: Array<{ id: string; sequenceNumber: number; speaker: 'agent' | 'user' | 'system'; text: string; offsetMs: number; isFinal: boolean; createdAt: string }>;
}

interface CallList {
  items: CallItem[];
  pagination: { total: number };
}

const activeStatuses = new Set<CallStatus>(['queued', 'ringing', 'connected']);

const statusClass = (status: CallStatus) => status === 'connected'
  ? 'bg-emerald-50 border-emerald-100 text-emerald-700 animate-pulse'
  : status === 'ringing' ? 'bg-amber-50 border-amber-100 text-amber-700'
    : 'bg-indigo-50 border-indigo-100 text-indigo-700';

const offsetTime = (offsetMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};

export function CallMonitoringView() {
  const [calls, setCalls] = useState<CallItem[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const selectedCallIdRef = useRef<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<CallDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [hangingUp, setHangingUp] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const refreshMonitor = async (showLoader = false, signal?: AbortSignal) => {
    if (showLoader) setLoading(true);
    try {
      const list = await apiRequest<CallList>('/admin/calls?activeOnly=true&page=1&pageSize=25', { signal });
      const currentSelectedId = selectedCallIdRef.current;
      const nextSelectedId = currentSelectedId && list.items.some((call) => call.id === currentSelectedId)
        ? currentSelectedId : (list.items[0]?.id ?? null);
      setCalls(list.items); setSelectedCallId(nextSelectedId); selectedCallIdRef.current = nextSelectedId;
      if (nextSelectedId) {
        setSelectedCall(await apiRequest<CallDetail>(`/admin/calls/${nextSelectedId}`, { signal }));
      } else {
        setSelectedCall(null);
      }
      setLastUpdatedAt(new Date()); setError('');
    } catch (requestError) {
      if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Live calls could not be loaded');
    } finally { if (showLoader) setLoading(false); }
  };

  useEffect(() => {
    let stopped = false;
    let refreshTimer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async (showLoader = false) => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        controller = new AbortController();
        await refreshMonitor(showLoader, controller.signal);
      }
      if (!stopped) refreshTimer = window.setTimeout(() => void poll(false), 3000);
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

  const selectCall = async (callId: string) => {
    selectedCallIdRef.current = callId; setSelectedCallId(callId); setError('');
    try { setSelectedCall(await apiRequest<CallDetail>(`/admin/calls/${callId}`)); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Call details could not be loaded'); }
  };

  const forceHangup = async () => {
    if (!selectedCall || !activeStatuses.has(selectedCall.status)) return;
    const reason = window.prompt(`Reason for ending the call for ${selectedCall.companyName}:`);
    if (!reason?.trim()) return;
    if (!window.confirm('Force this live call to hang up through Plivo?')) return;
    setHangingUp(true); setError(''); setSuccess('');
    try {
      await apiRequest(`/admin/calls/${selectedCall.id}/hangup`, {
        method: 'POST', body: JSON.stringify({ confirm: true, reason: reason.trim() }),
      });
      setSuccess('The call was ended successfully.');
      selectedCallIdRef.current = null; setSelectedCallId(null); await refreshMonitor(false);
      window.setTimeout(() => setSuccess(''), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The call could not be ended');
    } finally { setHangingUp(false); }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div><h2 className="text-xl font-bold text-slate-800">Live Call Monitoring</h2><p className="text-xs text-slate-400">Active database call sessions and transcript entries · Refreshes every 3 seconds.</p></div>
        <div className="flex items-center gap-3"><span className="text-[10px] font-bold text-indigo-600">{calls.length} active</span><button type="button" onClick={() => void refreshMonitor(true)} disabled={loading} className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer">{loading ? 'Refreshing...' : 'Refresh Now'}</button></div>
      </div>
      {lastUpdatedAt && <p className="text-right text-[9px] text-slate-400">Last database refresh: {lastUpdatedAt.toLocaleTimeString()}</p>}
      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-semibold">{error}</div>}
      {success && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs font-semibold">{success}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4 h-[calc(100vh-190px)] overflow-y-auto">
          <div><h3 className="text-md font-bold text-slate-800">In-Flight Calls</h3><p className="text-xs text-slate-400">Queued, ringing and connected sessions.</p></div>
          <div className="space-y-3">
            {calls.map((call) => (
              <button key={call.id} type="button" onClick={() => void selectCall(call.id)}
                className={`w-full text-left border rounded-xl p-3.5 cursor-pointer transition text-xs font-semibold ${selectedCallId === call.id ? 'border-indigo-300 bg-indigo-50/30 shadow-sm' : 'border-slate-200 bg-slate-50/50 hover:bg-slate-50'}`}>
                <div className="flex justify-between items-start gap-2"><span className="font-bold text-slate-800">{call.companyName}</span><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${statusClass(call.status)}`}>{call.status.replace('_', ' ')}</span></div>
                <div className="mt-2 flex justify-between text-[10px] text-slate-400"><span>Agent: {call.agentName || 'Unassigned'}</span><span className="font-mono">{call.durationSeconds}s</span></div>
                <p className="mt-1 text-[9px] text-slate-400 font-mono truncate">{call.fromNumber} → {call.toNumber}</p>
              </button>
            ))}
            {!loading && calls.length === 0 && <div className="py-10 text-center text-xs text-slate-400">No active calls currently stored in the database.</div>}
          </div>
        </div>

        <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col h-[calc(100vh-190px)]">
          {selectedCall ? (
            <>
              <div className="border-b border-slate-200 pb-4 flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3 flex-shrink-0">
                <div><span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Database Call Session</span><h3 className="font-bold text-slate-800 text-md mt-0.5">{selectedCall.companyName}</h3><p className="text-xs text-slate-400 mt-0.5">{selectedCall.fromNumber} → {selectedCall.toNumber} · {selectedCall.direction} · Agent: {selectedCall.agentName || 'Unassigned'}</p><p className="text-[9px] text-slate-400 mt-1 font-mono">Session: {selectedCall.id}</p></div>
                <span className={`self-start px-2 py-1 rounded text-[9px] font-bold uppercase border ${statusClass(selectedCall.status)}`}>{selectedCall.status.replace('_', ' ')}</span>
              </div>

              <div className="flex-1 overflow-y-auto my-4 space-y-4 pr-2 text-xs">
                {selectedCall.transcript.length > 0 ? selectedCall.transcript.map((line) => (
                  <div key={line.id} className={`flex flex-col ${line.speaker === 'agent' ? 'items-start' : line.speaker === 'user' ? 'items-end' : 'items-center'}`}>
                    <span className="text-[9px] text-slate-400 font-bold mb-1 uppercase font-mono">{line.speaker} · {offsetTime(line.offsetMs)}{line.isFinal ? '' : ' · processing'}</span>
                    <div className={`p-3 rounded-xl max-w-md font-semibold ${line.speaker === 'agent' ? 'bg-slate-50 text-slate-800 rounded-tl-none' : line.speaker === 'user' ? 'bg-indigo-600 text-white rounded-tr-none shadow-sm' : 'bg-amber-50 text-amber-800'}`}>{line.text}</div>
                  </div>
                )) : (
                  <div className="h-full flex flex-col items-center justify-center text-center text-slate-400"><Activity className="w-8 h-8 text-slate-300 animate-pulse mb-2" /><span className="text-xs font-bold uppercase">Waiting for transcript entries</span><span className="text-[10px] text-slate-300 mt-1">The call session is {selectedCall.status}.</span></div>
                )}
              </div>

              <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 flex-shrink-0 text-xs font-semibold">
                <div className="flex flex-wrap gap-5"><div><span className="text-[9px] text-slate-400 block uppercase font-bold">Live Duration</span><span className="text-slate-700 font-mono font-bold text-sm">{selectedCall.durationSeconds}s</span></div><div><span className="text-[9px] text-slate-400 block uppercase font-bold">Call Cost</span><span className="text-slate-700 font-mono font-bold text-sm">{selectedCall.currency} {selectedCall.cost.toFixed(4)}</span></div><div><span className="text-[9px] text-slate-400 block uppercase font-bold">Sentiment</span><span className="text-indigo-600 font-bold capitalize text-sm">{selectedCall.sentiment}</span></div></div>
                <button type="button" onClick={() => void forceHangup()} disabled={hangingUp || !selectedCall.providerCallId}
                  className="px-3 py-2 bg-red-50 hover:bg-red-100 border border-red-100 text-red-600 rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"><PhoneOff className="w-3.5 h-3.5" />{hangingUp ? 'Ending Call...' : 'Force Hang Up'}</button>
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-400"><Tv className="w-10 h-10 text-slate-300 mb-2" /><p className="text-xs font-bold">No live call selected.</p><p className="text-[10px] mt-1">Active database sessions will appear automatically.</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
