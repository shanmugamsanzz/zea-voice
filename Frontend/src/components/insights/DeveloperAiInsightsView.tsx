import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Brain, CheckCircle2, Clock3, FileText, Lightbulb, LoaderCircle,
  MessageSquareText, Phone, RefreshCw, ShieldAlert, Sparkles, Users,
} from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

interface InsightSlice { name: string; label: string; value: number; percentage: number }
interface AgentInsight {
  agentId: string; agentName: string | null; totalCalls: number; completedCalls: number;
  negativeCalls: number; summarizedCalls: number; followUpRequiredCalls: number;
  completionRate: number; averageDurationSeconds: number;
}
interface FlaggedCall {
  id: string; providerCallId: string | null; agentName: string | null; direction: 'inbound' | 'outbound';
  status: string; sentiment: string; startedAt: string; durationSeconds: number;
  fromNumber: string; toNumber: string; failureReason: string | null; customerExcerpt: string | null;
  summaryStatus: string | null; aiSummary: string | null; aiOutcome: string | null;
  customerIntent: string | null; followUpRequired: boolean; followUpReason: string | null;
}
interface Recommendation {
  code: string; severity: 'success' | 'info' | 'warning' | 'critical';
  title: string; description: string; evidence: string;
}
interface InsightReport {
  periodDays: number; generatedAt: string;
  summary: {
    totalCalls: number; answeredCalls: number; completedCalls: number; unsuccessfulCalls: number;
    transcriptCalls: number; sentimentCalls: number; averageDurationSeconds: number;
    summarizedCalls: number; summaryFailedCalls: number; followUpRequiredCalls: number;
    completionRate: number; transcriptCoverage: number; sentimentCoverage: number;
    summaryCoverage: number; positiveRate: number; negativeRate: number;
  };
  sentiments: InsightSlice[]; outcomes: InsightSlice[]; agents: AgentInsight[];
  flaggedCalls: FlaggedCall[]; recommendations: Recommendation[];
}

const sentimentColors: Record<string, string> = {
  positive: 'bg-emerald-500', neutral: 'bg-blue-500', negative: 'bg-red-500', unknown: 'bg-slate-400',
};
const outcomeColors = ['bg-[#dfa822]', 'bg-amber-500', 'bg-blue-500', 'bg-orange-500', 'bg-emerald-500', 'bg-red-500'];

function MetricCard({ label, value, helper, Icon, tone }: {
  label: string; value: string | number; helper: string; Icon: typeof Phone; tone: string;
}) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p><p className="mt-2 text-2xl font-black text-slate-800">{value}</p><p className="mt-1 text-[10px] font-semibold text-slate-400">{helper}</p></div><div className={`rounded-xl p-3 ${tone}`}><Icon className="h-5 w-5" /></div></div></div>;
}

function Distribution({ title, items, colors }: { title: string; items: InsightSlice[]; colors?: string[] }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h3 className="text-sm font-black text-slate-800">{title}</h3><div className="mt-5 space-y-4">{items.length ? items.map((item, index) => <div key={item.name}><div className="mb-1.5 flex items-center justify-between text-xs font-bold text-slate-600"><span>{item.label} <span className="text-slate-400">({item.value})</span></span><span>{item.percentage}%</span></div><div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${colors?.[index % colors.length] || sentimentColors[item.name] || 'bg-[#dfa822]'}`} style={{ width: `${Math.max(item.value ? 2 : 0, item.percentage)}%` }} /></div></div>) : <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-xs font-semibold text-slate-400">No calls exist for this period.</div>}</div></div>;
}

function recommendationStyle(severity: Recommendation['severity']) {
  if (severity === 'critical') return { box: 'border-red-200 bg-red-50', icon: 'bg-red-100 text-red-700', badge: 'bg-red-100 text-red-700' };
  if (severity === 'warning') return { box: 'border-amber-200 bg-amber-50', icon: 'bg-amber-100 text-amber-700', badge: 'bg-amber-100 text-amber-700' };
  if (severity === 'success') return { box: 'border-emerald-200 bg-emerald-50', icon: 'bg-emerald-100 text-emerald-700', badge: 'bg-emerald-100 text-emerald-700' };
  return { box: 'border-blue-200 bg-blue-50', icon: 'bg-blue-100 text-blue-700', badge: 'bg-blue-100 text-blue-700' };
}

export function DeveloperAiInsightsView() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<InsightReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    if (report) setRefreshing(true); else setLoading(true);
    setError('');
    apiRequest<InsightReport>(`/insights?days=${days}`, { signal: controller.signal, zeaCache: 'reload' })
      .then(setReport)
      .catch((requestError) => {
        if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'AI insights could not be loaded');
      })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); } });
    return () => controller.abort();
  }, [days, refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (loading && !report) return <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-slate-200 bg-white"><div className="text-center"><LoaderCircle className="mx-auto h-8 w-8 animate-spin text-[#dfa822]" /><p className="mt-3 text-xs font-bold text-slate-400">Analyzing stored call measurements…</p></div></div>;

  return <div className="zea-ai-insights-view space-y-6">
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between"><div><div className="flex items-center gap-2"><Brain className="h-5 w-5 text-[#b78513]" /><h2 className="text-xl font-black text-slate-800">AI Insights</h2></div><p className="mt-1 text-xs font-semibold text-slate-500">Conversation intelligence calculated from this company’s persisted calls and transcripts.</p></div><div className="flex items-center gap-2"><select value={days} onChange={(event) => setDays(Number(event.target.value))} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-700"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select><button onClick={refresh} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</button></div></div>

    {error && <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-bold text-red-700"><span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{error}</span><button onClick={refresh}>Retry</button></div>}

    {report && <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Analyzed Calls" value={report.summary.totalCalls} helper={`${report.summary.answeredCalls} answered`} Icon={Phone} tone="bg-blue-50 text-blue-600" />
        <MetricCard label="Completion Rate" value={`${report.summary.completionRate}%`} helper={`${report.summary.completedCalls} completed`} Icon={CheckCircle2} tone="bg-emerald-50 text-emerald-600" />
        <MetricCard label="Transcript Coverage" value={`${report.summary.transcriptCoverage}%`} helper={`${report.summary.transcriptCalls} calls with transcripts`} Icon={FileText} tone="bg-amber-50 text-[#b78513]" />
        <MetricCard label="AI Summary Coverage" value={`${report.summary.summaryCoverage}%`} helper={`${report.summary.summarizedCalls} summarized · ${report.summary.summaryFailedCalls} failed`} Icon={Sparkles} tone="bg-amber-50 text-[#b78513]" />
        <MetricCard label="Follow-Up Required" value={report.summary.followUpRequiredCalls} helper={`${report.summary.negativeRate}% negative sentiment`} Icon={ShieldAlert} tone="bg-red-50 text-red-600" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2"><Distribution title="Persisted Sentiment Distribution" items={report.sentiments} /><Distribution title="Call Outcome Distribution" items={report.outcomes} colors={outcomeColors} /></div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-center gap-2"><Lightbulb className="h-5 w-5 text-amber-500" /><div><h3 className="text-sm font-black text-slate-800">Evidence-based Recommendations</h3><p className="mt-0.5 text-[10px] font-semibold text-slate-400">Generated from measured thresholds, not fabricated conversation topics</p></div></div><div className="mt-5 grid gap-4 lg:grid-cols-2">{report.recommendations.map((item) => { const style = recommendationStyle(item.severity); return <div key={item.code} className={`rounded-2xl border p-4 ${style.box}`}><div className="flex items-start gap-3"><div className={`rounded-xl p-2 ${style.icon}`}><Sparkles className="h-4 w-4" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h4 className="text-xs font-black text-slate-800">{item.title}</h4><span className={`rounded-full px-2 py-0.5 text-[8px] font-black uppercase ${style.badge}`}>{item.severity}</span></div><p className="mt-2 text-[11px] font-semibold leading-relaxed text-slate-600">{item.description}</p><p className="mt-2 text-[9px] font-bold text-slate-500">Evidence: {item.evidence}</p></div></div></div>; })}</div></div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center gap-2 border-b border-slate-200 p-5"><Users className="h-5 w-5 text-[#dfa822]" /><div><h3 className="text-sm font-black text-slate-800">Agent Performance</h3><p className="mt-0.5 text-[10px] font-semibold text-slate-400">Measured from call outcomes and stored AI summaries</p></div></div><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left"><thead className="bg-slate-50 text-[9px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-4">Agent</th><th className="px-5 py-4">Calls</th><th className="px-5 py-4">Completed</th><th className="px-5 py-4">Completion</th><th className="px-5 py-4">Summarized</th><th className="px-5 py-4">Follow-Up</th><th className="px-5 py-4">Avg Duration</th><th className="px-5 py-4">Negative</th></tr></thead><tbody className="divide-y divide-slate-100 text-xs">{report.agents.length ? report.agents.map((agent) => <tr key={agent.agentId} className="hover:bg-slate-50"><td className="px-5 py-4 font-black text-slate-700">{agent.agentName || 'Unnamed agent'}</td><td className="px-5 py-4 font-bold text-slate-600">{agent.totalCalls}</td><td className="px-5 py-4 font-bold text-emerald-600">{agent.completedCalls}</td><td className="px-5 py-4 font-bold text-slate-700">{agent.completionRate}%</td><td className="px-5 py-4 font-bold text-[#b78513]">{agent.summarizedCalls}</td><td className="px-5 py-4 font-bold text-amber-600">{agent.followUpRequiredCalls}</td><td className="px-5 py-4 font-mono font-bold text-slate-600">{Math.round(agent.averageDurationSeconds)}s</td><td className="px-5 py-4 font-bold text-red-600">{agent.negativeCalls}</td></tr>) : <tr><td colSpan={8} className="py-12 text-center text-xs font-semibold text-slate-400">No agent calls exist for this period.</td></tr>}</tbody></table></div></div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center gap-2 border-b border-slate-200 p-5"><MessageSquareText className="h-5 w-5 text-red-500" /><div><h3 className="text-sm font-black text-slate-800">Calls Requiring Review</h3><p className="mt-0.5 text-[10px] font-semibold text-slate-400">AI follow-up flags, negative sentiment and unsuccessful outcomes</p></div></div><div className="divide-y divide-slate-100">{report.flaggedCalls.length ? report.flaggedCalls.map((call) => <div key={call.id} className="grid min-w-0 gap-3 p-5 hover:bg-slate-50 lg:grid-cols-[minmax(0,180px)_minmax(0,1fr)_minmax(0,190px)]"><div className="min-w-0"><p className="line-clamp-2 max-w-full break-words text-xs font-black text-slate-700 [overflow-wrap:anywhere]" title={call.agentName || 'Unassigned agent'}>{call.agentName || 'Unassigned agent'}</p><p className="mt-1 text-[9px] font-semibold text-slate-400">{new Date(call.startedAt).toLocaleString('en-IN')}</p></div><div className="min-w-0"><p className="text-[10px] font-black uppercase text-slate-400">AI evidence</p><p className="mt-1 break-words text-xs font-semibold leading-relaxed text-slate-600 [overflow-wrap:anywhere]">{call.followUpReason || call.aiSummary || call.customerExcerpt || call.failureReason || 'No final customer transcript was stored.'}</p>{call.customerIntent && <p className="mt-2 break-words text-[9px] font-bold text-[#b78513] [overflow-wrap:anywhere]">Intent: {call.customerIntent}</p>}</div><div className="flex min-w-0 flex-wrap items-start gap-2 lg:justify-end">{call.followUpRequired && <span className="max-w-full break-words rounded-full bg-amber-50 px-2 py-1 text-[9px] font-black uppercase text-amber-700 [overflow-wrap:anywhere]">Follow-up</span>}<span className="max-w-full break-words rounded-full bg-red-50 px-2 py-1 text-[9px] font-black uppercase text-red-700 [overflow-wrap:anywhere]">{(call.aiOutcome || call.status).replaceAll('_', ' ')}</span><span className="max-w-full break-words rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-600 [overflow-wrap:anywhere]">{call.sentiment}</span></div></div>) : <div className="p-12 text-center"><CheckCircle2 className="mx-auto h-7 w-7 text-emerald-500" /><p className="mt-3 text-xs font-bold text-slate-500">No calls require review for this period.</p></div>}</div></div>

      <div className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-xs font-semibold leading-relaxed text-blue-800"><Clock3 className="mt-0.5 h-4 w-4 shrink-0" /><div>Insights refresh every 30 seconds. Sentiment is displayed only when it has been persisted by the call-analysis pipeline. Topic extraction and autonomous CRM actions are intentionally not invented by this page.</div></div>
    </>}
  </div>;
}
