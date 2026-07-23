import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, AudioWaveform, CheckCircle2, Clock, Database, Gauge, LoaderCircle,
  MessageSquareText, Phone, RefreshCw, Server, TimerReset,
} from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

interface VqaRecord {
  id: string;
  providerCallId: string | null;
  agentId: string | null;
  agentName: string | null;
  direction: 'inbound' | 'outbound';
  status: string;
  startedAt: string;
  durationSeconds: number;
  transcriptEntries: number;
  failureReason: string | null;
  latency: {
    welcomeAudioStartMs: number | null;
    averageFirstResponseAudioMs: number | null;
    firstResponseSamples: number;
    welcomeCacheHit: boolean;
  };
  providers: Record<string, {
    providerName: string | null; modelKey: string | null; requests: number;
    audioInputMs: number; audioOutputMs: number; durationMs: number;
  }>;
}

interface VqaReport {
  periodDays: number;
  generatedAt: string;
  summary: {
    totalCalls: number; completedCalls: number; failedCalls: number; answeredCalls: number;
    completionRate: number; averageDurationSeconds: number; totalDurationSeconds: number;
    callsWithTranscript: number; averageWelcomeAudioStartMs: number | null;
    averageFirstResponseAudioMs: number | null; measuredWelcomeCalls: number; measuredResponseCalls: number;
  };
  records: VqaRecord[];
}

interface ProviderHealth {
  kind: 'stt' | 'llm' | 'tts';
  providerId: string | null;
  modelId: string | null;
  status: 'healthy' | 'degraded';
  successes: number;
  failures: number;
  lastCode: string | null;
  lastLatencyMs: number;
  checkedAt: string;
}

const label = (value: string) => value.split('_').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
const milliseconds = (value: number | null) => value === null ? 'Not measured' : `${Math.round(value)} ms`;

function MetricCard({ title, value, description, Icon, tone }: {
  title: string; value: string | number; description: string; Icon: typeof Activity; tone: string;
}) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{title}</p><p className="mt-2 text-2xl font-black text-slate-800">{value}</p><p className="mt-1 text-[10px] font-semibold text-slate-400">{description}</p></div><div className={`rounded-xl p-3 ${tone}`}><Icon className="h-5 w-5" /></div></div></div>;
}

export function DeveloperVqaView() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<VqaReport | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    if (report) setRefreshing(true); else setLoading(true);
    setError('');
    Promise.all([
      apiRequest<VqaReport>(`/vqa?days=${days}&limit=100`, { signal: controller.signal, zeaCache: 'reload' }),
      apiRequest<ProviderHealth[]>('/calls/runtime/provider-health', { signal: controller.signal, zeaCache: 'reload' }),
    ]).then(([nextReport, health]) => { setReport(nextReport); setProviderHealth(health); })
      .catch((requestError) => {
        if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Voice quality data could not be loaded');
      }).finally(() => { if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); } });
    return () => controller.abort();
  }, [days, refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const maxLatency = useMemo(() => Math.max(1, ...(report?.records.flatMap((record) => [
    record.latency.welcomeAudioStartMs ?? 0, record.latency.averageFirstResponseAudioMs ?? 0,
  ]) ?? [1])), [report]);

  if (loading && !report) return <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-slate-200 bg-white"><div className="text-center"><LoaderCircle className="mx-auto h-8 w-8 animate-spin text-pink-500" /><p className="mt-3 text-xs font-bold text-slate-400">Loading measured voice-quality data…</p></div></div>;

  return <div className="space-y-6">
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between"><div><div className="flex items-center gap-2"><AudioWaveform className="h-5 w-5 text-pink-500" /><h2 className="text-xl font-black text-slate-800">Voice Quality Assessment</h2></div><p className="mt-1 text-xs font-semibold text-slate-500">Tenant call reliability, latency, transcripts and runtime-provider health from PostgreSQL.</p></div><div className="flex items-center gap-2"><select value={days} onChange={(event) => setDays(Number(event.target.value))} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-700"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select><button onClick={refresh} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</button></div></div>

    {error && <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-700"><span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{error}</span><button onClick={refresh}>Retry</button></div>}

    {report && <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Audited Calls" value={report.summary.totalCalls} description={`${report.summary.answeredCalls} answered`} Icon={Phone} tone="bg-blue-50 text-blue-600" />
        <MetricCard title="Completion Rate" value={`${report.summary.completionRate}%`} description={`${report.summary.completedCalls} completed · ${report.summary.failedCalls} failed`} Icon={CheckCircle2} tone="bg-emerald-50 text-emerald-600" />
        <MetricCard title="Welcome Audio" value={milliseconds(report.summary.averageWelcomeAudioStartMs)} description={`${report.summary.measuredWelcomeCalls} measured calls`} Icon={TimerReset} tone="bg-violet-50 text-violet-600" />
        <MetricCard title="First Response Audio" value={milliseconds(report.summary.averageFirstResponseAudioMs)} description={`${report.summary.measuredResponseCalls} measured calls`} Icon={Gauge} tone="bg-pink-50 text-pink-600" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm xl:col-span-2"><div className="flex items-center justify-between"><div><h3 className="text-sm font-black text-slate-800">Measured Call Latency</h3><p className="mt-1 text-[10px] font-semibold text-slate-400">Latest {report.records.length} database records</p></div><Clock className="h-5 w-5 text-slate-400" /></div>
          {report.records.length ? <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">{report.records.slice(0, 30).map((record) => <div key={record.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center justify-between gap-4"><div className="min-w-0"><p className="truncate text-xs font-black text-slate-800">{record.agentName || 'Unassigned agent'}</p><p className="mt-1 text-[9px] font-semibold text-slate-400">{new Date(record.startedAt).toLocaleString('en-IN')} · {record.direction.toUpperCase()}</p></div><span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${record.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : record.status === 'failed' ? 'bg-rose-100 text-rose-700' : 'bg-slate-200 text-slate-600'}`}>{label(record.status)}</span></div><div className="mt-3 grid gap-3 sm:grid-cols-2">{[['Welcome', record.latency.welcomeAudioStartMs, 'bg-violet-500'], ['First response', record.latency.averageFirstResponseAudioMs, 'bg-pink-500']].map(([name, rawValue, color]) => { const value = rawValue as number | null; return <div key={String(name)}><div className="mb-1 flex justify-between text-[9px] font-bold text-slate-500"><span>{String(name)}</span><span>{milliseconds(value)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className={`h-full rounded-full ${String(color)}`} style={{ width: value === null ? '0%' : `${Math.max(2, Math.min(100, (value / maxLatency) * 100))}%` }} /></div></div>; })}</div>{record.failureReason && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[9px] font-bold text-rose-700">Failure reason: {record.failureReason}</p>}</div>)}</div> : <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center text-xs font-semibold text-slate-400">No calls exist for this period.</div>}
        </div>

        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div><h3 className="text-sm font-black text-slate-800">Runtime Provider Health</h3><p className="mt-1 text-[10px] font-semibold text-slate-400">Current backend process observations</p></div>{providerHealth.length ? providerHealth.map((provider) => <div key={`${provider.kind}:${provider.providerId}:${provider.modelId}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-xs font-black uppercase text-slate-700"><Server className="h-4 w-4 text-slate-400" />{provider.kind}</span><span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${provider.status === 'healthy' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{provider.status}</span></div><div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-semibold text-slate-500"><span>Success: <b className="text-slate-700">{provider.successes}</b></span><span>Failures: <b className="text-slate-700">{provider.failures}</b></span><span className="col-span-2">Last latency: <b className="text-slate-700">{Math.round(provider.lastLatencyMs)} ms</b></span>{provider.lastCode && <span className="col-span-2 text-rose-600">Last error: {provider.lastCode}</span>}</div></div>) : <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-xs font-semibold text-slate-400">Provider health appears after calls run on this backend instance.</div>}</div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 p-5"><div><h3 className="text-sm font-black text-slate-800">VQA Audit Records</h3><p className="mt-1 text-[10px] font-semibold text-slate-400">Stored calls and provider-usage measurements</p></div><Database className="h-5 w-5 text-slate-400" /></div><div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left"><thead className="bg-slate-50 text-[9px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-4">Call</th><th className="px-5 py-4">Agent</th><th className="px-5 py-4">Status</th><th className="px-5 py-4">Duration</th><th className="px-5 py-4">Transcript</th><th className="px-5 py-4">Welcome</th><th className="px-5 py-4">Response</th><th className="px-5 py-4">Providers</th></tr></thead><tbody className="divide-y divide-slate-100 text-xs">{report.records.length ? report.records.map((record) => <tr key={record.id} className="hover:bg-slate-50"><td className="px-5 py-4"><p className="font-semibold text-slate-600">{new Date(record.startedAt).toLocaleString('en-IN')}</p><p className="mt-1 max-w-[160px] truncate font-mono text-[9px] text-slate-400">{record.providerCallId || record.id}</p></td><td className="px-5 py-4 font-bold text-slate-700">{record.agentName || '—'}</td><td className="px-5 py-4 font-bold text-slate-600">{label(record.status)}</td><td className="px-5 py-4 font-mono font-bold text-slate-600">{record.durationSeconds}s</td><td className="px-5 py-4"><span className="inline-flex items-center gap-1 font-bold text-slate-600"><MessageSquareText className="h-4 w-4 text-slate-400" />{record.transcriptEntries}</span></td><td className="px-5 py-4 font-mono font-bold text-violet-600">{milliseconds(record.latency.welcomeAudioStartMs)}</td><td className="px-5 py-4 font-mono font-bold text-pink-600">{milliseconds(record.latency.averageFirstResponseAudioMs)}</td><td className="px-5 py-4"><div className="flex gap-1">{Object.keys(record.providers).map((kind) => <span key={kind} className="rounded bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-600">{kind}</span>)}{!Object.keys(record.providers).length && <span className="text-slate-400">—</span>}</div></td></tr>) : <tr><td colSpan={8} className="py-14 text-center text-xs font-semibold text-slate-400">No audit records for this period.</td></tr>}</tbody></table></div></div>

      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs font-semibold leading-relaxed text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><b>Accuracy and STT confidence are not fabricated.</b> They will appear only after the selected STT adapter persists provider confidence and a reference-transcript evaluation pipeline calculates accuracy. Current VQA values are measured operational data.</div></div>
    </>}
  </div>;
}
