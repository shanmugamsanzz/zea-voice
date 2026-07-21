import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  MessageSquareText,
  PhoneCall,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';
import { useAppState } from '../../store/AppState';

type Distribution = { name: string; value: number; percentage: number };
type Performance = {
  id: string | null;
  name: string;
  totalCalls: number;
  completedCalls: number;
  failedCalls: number;
  completionRate: number;
  positiveRate: number;
  averageDurationSeconds: number;
};
type QueueCall = {
  callId: string;
  startedAt: string;
  agentName: string | null;
  campaignName: string | null;
  direction: string;
  status: string;
  sentiment: string;
  transcriptTurns: number;
  summary: string;
  reasons: string[];
  evidence: string | null;
  reviewedAt: string | null;
};
type AiInsightsData = {
  periodDays: number;
  access: {
    mode: 'developer' | 'user';
    readOnly: boolean;
    canExport: boolean;
    canReview: boolean;
    providerImpactVisible: boolean;
    assignmentScope: 'tenant';
  };
  appliedFilters: {
    agentId: string | null;
    campaignId: string | null;
    direction: string | null;
    status: string | null;
  };
  filterOptions: {
    agents: Array<{ id: string; name: string }>;
    campaigns: Array<{ id: string; name: string }>;
  };
  summary: {
    totalCalls: number;
    completedCalls: number;
    failedCalls: number;
    completionRate: number;
    positiveCalls: number;
    negativeCalls: number;
    transcriptCoverage: number;
    averageTranscriptTurns: number;
  };
  sentimentTrend: Array<{ date: string; positive: number; negative: number }>;
  outcomeTrend: Array<{ date: string; completed: number; failed: number }>;
  sentiments: Distribution[];
  outcomes: Distribution[];
  transcriptQuality: { good: number; incomplete: number; missing: number; averageTurns: number };
  agentAnalytics: Performance[];
  campaignAnalytics: Performance[];
  failedReasons: Distribution[];
  reviewQueue: QueueCall[];
  callbackQueue: QueueCall[];
  transferQueue: QueueCall[];
  providerImpact: Array<{
    kind: string;
    providerName: string;
    modelKey: string;
    callCount: number;
    requestCount: number;
    averageLatencyMs: number;
    quality: 'good' | 'fair' | 'slow';
  }>;
  recentReviewed: QueueCall[];
  recommendations: Array<{ type: string; message: string; evidence: string }>;
};

function label(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Metric({
  title,
  value,
  detail,
  icon,
}: {
  title: string;
  value: string | number;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{title}</p>
          <p className="mt-2 text-2xl font-black text-slate-900">{value}</p>
          <p className="mt-1 text-[11px] font-semibold text-slate-500">{detail}</p>
        </div>
        <div className="rounded-xl bg-violet-50 p-2.5 text-violet-600">{icon}</div>
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="mb-4">
        <h3 className="text-sm font-black text-slate-800">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[10px] font-semibold text-slate-400">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-7 text-center text-xs font-semibold text-slate-400">
      {text}
    </div>
  );
}

function DistributionList({ rows, empty }: { rows: Distribution[]; empty: string }) {
  if (rows.length === 0) return <Empty text={empty} />;
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.name}>
          <div className="mb-1 flex justify-between text-[11px] font-bold text-slate-600">
            <span>{label(row.name)}</span>
            <span>{row.value} ({row.percentage}%)</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-violet-500" style={{ width: String(row.percentage) + '%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Trend({
  rows,
  first,
  second,
}: {
  rows: Array<Record<string, string | number>>;
  first: { key: string; label: string; color: string };
  second: { key: string; label: string; color: string };
}) {
  const maximum = Math.max(1, ...rows.flatMap((row) => [Number(row[first.key]), Number(row[second.key])]));
  return (
    <div>
      <div className="flex h-36 items-end gap-1 overflow-hidden rounded-xl border border-slate-100 bg-slate-50 p-3">
        {rows.map((row) => (
          <div key={String(row.date)} className="flex min-w-0 flex-1 items-end justify-center gap-px" title={String(row.date)}>
            <div className={first.color + ' w-1/2 rounded-t'} style={{ height: String((Number(row[first.key]) / maximum) * 100) + '%' }} />
            <div className={second.color + ' w-1/2 rounded-t'} style={{ height: String((Number(row[second.key]) / maximum) * 100) + '%' }} />
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-4 text-[10px] font-bold text-slate-500">
        <span>{first.label}</span>
        <span>{second.label}</span>
      </div>
    </div>
  );
}

function PerformanceTable({ rows, empty }: { rows: Performance[]; empty: string }) {
  if (rows.length === 0) return <Empty text={empty} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11px]">
        <thead className="border-b border-slate-100 text-[9px] font-black uppercase tracking-wider text-slate-400">
          <tr>
            <th className="pb-2">Name</th>
            <th className="pb-2 text-right">Calls</th>
            <th className="pb-2 text-right">Completed</th>
            <th className="pb-2 text-right">Positive</th>
            <th className="pb-2 text-right">Avg Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 font-semibold text-slate-600">
          {rows.map((row) => (
            <tr key={row.id || row.name}>
              <td className="py-3 font-bold text-slate-800">{row.name}</td>
              <td className="py-3 text-right">{row.totalCalls}</td>
              <td className="py-3 text-right">{row.completionRate}%</td>
              <td className="py-3 text-right">{row.positiveRate}%</td>
              <td className="py-3 text-right">{row.averageDurationSeconds}s</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueueList({
  rows,
  empty,
  canReview,
  reviewing,
  onReview,
}: {
  rows: QueueCall[];
  empty: string;
  canReview?: boolean;
  reviewing?: string | null;
  onReview?: (callId: string) => void;
}) {
  if (rows.length === 0) return <Empty text={empty} />;
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <article key={row.callId} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[11px] font-black text-slate-800">{row.agentName || 'Unassigned agent'}</p>
              <p className="text-[9px] font-semibold text-slate-400">
                {new Date(row.startedAt).toLocaleString()} · {row.campaignName || 'No campaign'}
              </p>
            </div>
            <span className="rounded-full bg-white px-2 py-1 text-[9px] font-black uppercase text-slate-500">
              {label(row.status)}
            </span>
          </div>
          <p className="mt-2 text-[10px] font-semibold leading-5 text-slate-600">{row.summary}</p>
          {row.evidence && (
            <p className="mt-2 rounded-lg border border-violet-100 bg-violet-50 px-2.5 py-2 text-[10px] italic text-violet-700">
              “{row.evidence}”
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {row.reasons.map((reason) => (
              <span key={reason} className="rounded-md bg-rose-50 px-2 py-1 text-[9px] font-bold text-rose-600">{reason}</span>
            ))}
          </div>
          {canReview && onReview && (
            <button
              type="button"
              disabled={reviewing === row.callId}
              onClick={() => onReview(row.callId)}
              className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-black text-slate-600 hover:border-violet-300 hover:text-violet-600 disabled:opacity-60"
            >
              {reviewing === row.callId ? 'Saving...' : 'Mark reviewed'}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

function csvCell(value: unknown) {
  return '"' + String(value ?? '').replaceAll('"', '""') + '"';
}

export function AiInsightsView() {
  const { role } = useAppState();
  const isDeveloper = role === 'DEVELOPER';
  const [days, setDays] = useState(30);
  const [agentId, setAgentId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState<AiInsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ days: String(days), queueLimit: '10' });
    if (agentId) params.set('agentId', agentId);
    if (campaignId) params.set('campaignId', campaignId);
    if (direction) params.set('direction', direction);
    if (status) params.set('status', status);
    return params.toString();
  }, [agentId, campaignId, days, direction, status]);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await apiRequest<AiInsightsData>('/ai-insights?' + query, {
        signal,
        zeaCache: 'bypass',
      });
      setData(response);
    } catch (requestError) {
      if (!isAbortError(requestError)) {
        setError(requestError instanceof Error ? requestError.message : 'Unable to load AI insights');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [query]);

  const reviewCall = async (callId: string) => {
    setReviewing(callId);
    setError('');
    try {
      await apiRequest('/ai-insights/reviews/' + callId, {
        method: 'POST',
        body: JSON.stringify({}),
        zeaCache: 'bypass',
      });
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to mark this call reviewed');
    } finally {
      setReviewing(null);
    }
  };

  const exportReport = () => {
    if (!data?.access.canExport) return;
    const rows = [
      ['section', 'name', 'calls', 'completed_rate', 'positive_rate', 'detail'],
      ['summary', 'Total calls', data.summary.totalCalls, data.summary.completionRate, '', ''],
      ...data.agentAnalytics.map((row) => ['agent', row.name, row.totalCalls, row.completionRate, row.positiveRate, row.averageDurationSeconds + 's avg']),
      ...data.campaignAnalytics.map((row) => ['campaign', row.name, row.totalCalls, row.completionRate, row.positiveRate, row.averageDurationSeconds + 's avg']),
      ...data.providerImpact.map((row) => ['provider', row.providerName + ' / ' + row.modelKey, row.callCount, '', '', row.averageLatencyMs + 'ms ' + row.quality]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'zea-ai-insights-' + new Date().toISOString().slice(0, 10) + '.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const options = data?.filterOptions;
  const summary = data?.summary;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div>
            <h2 className="text-xl font-black tracking-tight text-slate-800">AI Insights</h2>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              Real call, transcript, campaign and quality analytics from your tenant database.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!isDeveloper && (
              <span className="inline-flex items-center gap-1.5 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-[10px] font-black text-sky-700">
                <ShieldCheck className="h-3.5 w-3.5" /> READ ONLY
              </span>
            )}
            {isDeveloper && data?.access.canExport && (
              <button type="button" onClick={exportReport} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-xs font-black text-white hover:bg-violet-700">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            )}
            <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-60">
              <RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} /> Refresh
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700">
          Unable to load database insights: {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs sm:grid-cols-2 lg:grid-cols-5">
        <select value={days} onChange={(event) => setDays(Number(event.target.value))} className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600">
          <option value="">All agents</option>
          {(options?.agents || []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
        <select value={campaignId} onChange={(event) => setCampaignId(event.target.value)} className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600">
          <option value="">All campaigns</option>
          {(options?.campaigns || []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
        <select value={direction} onChange={(event) => setDirection(event.target.value)} className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600">
          <option value="">All directions</option>
          <option value="inbound">Inbound</option>
          <option value="outbound">Outbound</option>
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600">
          <option value="">All outcomes</option>
          {['completed', 'failed', 'busy', 'no_answer', 'canceled', 'connected', 'ringing', 'queued'].map((value) => (
            <option key={value} value={value}>{label(value)}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="Total calls" value={summary?.totalCalls ?? 0} detail="Calls matching current filters" icon={<PhoneCall className="h-5 w-5" />} />
        <Metric title="Completion" value={String(summary?.completionRate ?? 0) + '%'} detail={String(summary?.completedCalls ?? 0) + ' completed calls'} icon={<CheckCircle2 className="h-5 w-5" />} />
        <Metric title="Failed calls" value={summary?.failedCalls ?? 0} detail="Failed, busy, unanswered or canceled" icon={<AlertTriangle className="h-5 w-5" />} />
        <Metric title="Transcript coverage" value={String(summary?.transcriptCoverage ?? 0) + '%'} detail={String(summary?.averageTranscriptTurns ?? 0) + ' average turns'} icon={<MessageSquareText className="h-5 w-5" />} />
      </div>

      {loading && !data ? (
        <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white" />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel title="Sentiment Trend" subtitle="Positive and negative calls by day">
              <Trend rows={(data?.sentimentTrend || []) as Array<Record<string, string | number>>} first={{ key: 'positive', label: 'Positive', color: 'bg-emerald-400' }} second={{ key: 'negative', label: 'Negative', color: 'bg-rose-400' }} />
            </Panel>
            <Panel title="Outcome Trend" subtitle="Completed and failed calls by day">
              <Trend rows={(data?.outcomeTrend || []) as Array<Record<string, string | number>>} first={{ key: 'completed', label: 'Completed', color: 'bg-sky-400' }} second={{ key: 'failed', label: 'Failed', color: 'bg-amber-400' }} />
            </Panel>
            <Panel title="Sentiment Summary">
              <DistributionList rows={data?.sentiments || []} empty="No sentiment records match these filters." />
            </Panel>
            <Panel title="Call Outcomes">
              <DistributionList rows={data?.outcomes || []} empty="No call outcomes match these filters." />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Panel title="Agent Performance" subtitle="Tenant agents represented in persisted call records">
              <PerformanceTable rows={data?.agentAnalytics || []} empty="No agent call records match these filters." />
            </Panel>
            <Panel title="Campaign Performance" subtitle="Tenant campaigns represented in persisted call records">
              <PerformanceTable rows={data?.campaignAnalytics || []} empty="No campaign call records match these filters." />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel title="Transcript Quality Analysis" subtitle="Quality is based on persisted transcript turns and finalization state">
              <div className="grid grid-cols-3 gap-3">
                {[
                  ['Good', data?.transcriptQuality.good || 0, 'text-emerald-600 bg-emerald-50'],
                  ['Incomplete', data?.transcriptQuality.incomplete || 0, 'text-amber-600 bg-amber-50'],
                  ['Missing', data?.transcriptQuality.missing || 0, 'text-rose-600 bg-rose-50'],
                ].map(([name, value, tone]) => (
                  <div key={String(name)} className={'rounded-xl p-4 text-center ' + tone}>
                    <p className="text-xl font-black">{value}</p>
                    <p className="text-[9px] font-black uppercase">{name}</p>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Failed-call Reasons" subtitle="Campaign attempt errors when available; otherwise call outcome">
              <DistributionList rows={data?.failedReasons || []} empty="No failed calls match these filters." />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Panel title={isDeveloper ? 'Review Queue' : 'Flagged Calls'} subtitle="Failed, negative, missing or incomplete transcript calls">
              <QueueList rows={data?.reviewQueue || []} empty="No calls currently require review." canReview={isDeveloper && data?.access.canReview} reviewing={reviewing} onReview={reviewCall} />
            </Panel>
            <Panel title="Callback / Follow-up Queue" subtitle="Detected only from stored customer transcript language">
              <QueueList rows={data?.callbackQueue || []} empty="No callback requests were detected." />
            </Panel>
            <Panel title="Human Transfer Queue" subtitle="Detected only from stored customer transcript language">
              <QueueList rows={data?.transferQueue || []} empty="No human transfer requests were detected." />
            </Panel>
          </div>

          <Panel title="Recent Reviewed Calls" subtitle="Persisted review history from the tenant audit log">
            <QueueList rows={data?.recentReviewed || []} empty="No insight reviews have been recorded." />
          </Panel>

          {isDeveloper && (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <Panel title="Provider Quality Impact" subtitle="Actual persisted provider/model usage; cost is not included">
                {(data?.providerImpact.length || 0) === 0 ? <Empty text="No provider usage records match these filters." /> : (
                  <div className="space-y-2">
                    {data?.providerImpact.map((row) => (
                      <div key={row.kind + row.providerName + row.modelKey} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3 text-[10px]">
                        <div>
                          <p className="font-black text-slate-800">{row.providerName} · {row.modelKey}</p>
                          <p className="font-semibold text-slate-400">{label(row.kind)} · {row.callCount} calls · {row.requestCount} requests</p>
                        </div>
                        <span className={'rounded-lg px-2 py-1 font-black uppercase ' + (row.quality === 'good' ? 'bg-emerald-50 text-emerald-600' : row.quality === 'fair' ? 'bg-amber-50 text-amber-600' : 'bg-rose-50 text-rose-600')}>
                          {row.averageLatencyMs}ms · {row.quality}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
              <Panel title="Data-backed Recommendations" subtitle="Rules evaluate only the metrics shown in this report">
                {(data?.recommendations.length || 0) === 0 ? <Empty text="No recommendations were triggered by current data." /> : (
                  <div className="space-y-3">
                    {data?.recommendations.map((item) => (
                      <div key={item.type} className="rounded-xl border border-violet-100 bg-violet-50 p-3">
                        <p className="text-[11px] font-black text-violet-800">{item.message}</p>
                        <p className="mt-1 text-[10px] font-semibold text-violet-600">{item.evidence}</p>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>
          )}

          {!isDeveloper && (
            <div className="flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-[10px] font-bold text-sky-700">
              <Users className="h-4 w-4" />
              Company User access is tenant-scoped and read-only. Provider internals, export and review actions are hidden.
            </div>
          )}
        </>
      )}
    </div>
  );
}
