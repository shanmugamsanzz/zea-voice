import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, RefreshCw, Rocket } from 'lucide-react';
import { apiRequest } from '../../lib/api';

interface ReviewDocumentSummary {
  documentId: string; displayName: string; documentType: string; status: string;
  totalCount: number; draftCount: number; approvedCount: number; rejectedCount: number; ready: boolean;
}
interface ReviewSummary {
  knowledgeBase: { id: string; name: string; status: string; publicationRevision: number; publishedAt: string | null };
  documents: ReviewDocumentSummary[];
  blockers: Array<{ code: string; message: string; documentId?: string }>;
  canPublish: boolean;
}
interface KnowledgeBaseDetail {
  id: string; status: string; publicationRevision: number; publishedAt: string | null;
  semanticIndex: { status?: string; progress?: number; attemptCount?: number; maxAttempts?: number; errorMessage?: string | null } | null;
}

export function KnowledgePublishPanel({ knowledgeBaseId, readOnly, refreshKey, onPublished }: {
  knowledgeBaseId: string; readOnly: boolean; refreshKey: number; onPublished: () => void;
}) {
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [detail, setDetail] = useState<KnowledgeBaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      setLoading(true); setError('');
      try {
        const [review, knowledgeBase] = await Promise.all([
          apiRequest<ReviewSummary>(`/knowledge-bases/${knowledgeBaseId}/review-summary`, { signal: controller.signal, zeaCache: 'bypass' }),
          apiRequest<KnowledgeBaseDetail>(`/knowledge-bases/${knowledgeBaseId}`, { signal: controller.signal, zeaCache: 'bypass' }),
        ]);
        if (controller.signal.aborted) return;
        setSummary(review); setDetail(knowledgeBase);
        if (knowledgeBase.semanticIndex?.status === 'queued' || knowledgeBase.semanticIndex?.status === 'running') {
          timer = window.setTimeout(() => setPollTick((value) => value + 1), 2500);
        }
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : 'Review summary could not be loaded');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [knowledgeBaseId, refreshKey, pollTick]);

  const publish = async () => {
    if (!summary?.canPublish || publishing || readOnly) return;
    if (!window.confirm(`Publish "${summary.knowledgeBase.name}" and build its semantic index?`)) return;
    setPublishing(true); setError('');
    try {
      await apiRequest(`/knowledge-bases/${knowledgeBaseId}/publish`, { method: 'POST', body: '{}' });
      setPollTick((value) => value + 1);
      onPublished();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Knowledge Base could not be published'); }
    finally { setPublishing(false); }
  };

  const totals = summary?.documents.reduce((value, document) => ({
    records: value.records + document.totalCount,
    pending: value.pending + document.draftCount,
    approved: value.approved + document.approvedCount,
    rejected: value.rejected + document.rejectedCount,
  }), { records: 0, pending: 0, approved: 0, rejected: 0 }) ?? { records: 0, pending: 0, approved: 0, rejected: 0 };
  const indexProgress = Math.max(0, Math.min(100, Number(detail?.semanticIndex?.progress ?? (detail?.semanticIndex?.status === 'completed' ? 100 : 0))));

  return <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><span className="text-[10px] font-black uppercase tracking-wider text-violet-600">Review and Publish</span><h4 className="mt-1 text-base font-bold text-slate-800">Knowledge Base readiness</h4><p className="mt-1 text-[11px] font-medium text-slate-500">Publishing is controlled by backend review blockers and creates a new immutable publication revision.</p></div><button type="button" onClick={() => setPollTick((value) => value + 1)} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh Summary</button></div>
    {error && <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-[10px] font-semibold text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
    {loading && !summary && <div className="mt-4 h-36 animate-pulse rounded-xl bg-slate-100" />}
    {summary && <>
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4"><div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><span className="text-[9px] font-black uppercase text-slate-400">Documents</span><strong className="block text-xl text-slate-800">{summary.documents.length}</strong></div><div className="rounded-lg border border-amber-200 bg-amber-50 p-3"><span className="text-[9px] font-black uppercase text-amber-600">Pending Records</span><strong className="block text-xl text-amber-800">{totals.pending}</strong></div><div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3"><span className="text-[9px] font-black uppercase text-emerald-600">Approved</span><strong className="block text-xl text-emerald-800">{totals.approved}</strong></div><div className="rounded-lg border border-red-200 bg-red-50 p-3"><span className="text-[9px] font-black uppercase text-red-600">Rejected</span><strong className="block text-xl text-red-800">{totals.rejected}</strong></div></div>
      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200"><table className="min-w-full text-left text-[10px]"><thead className="bg-slate-50 font-black uppercase text-slate-400"><tr><th className="px-3 py-2">Document</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Pending</th><th className="px-3 py-2">Approved</th><th className="px-3 py-2">Rejected</th></tr></thead><tbody>{summary.documents.map((document) => <tr key={document.documentId} className="border-t border-slate-100"><td className="px-3 py-2 font-bold text-slate-700">{document.displayName}</td><td className="px-3 py-2 font-semibold capitalize text-slate-500">{document.status.replace(/_/g, ' ')}</td><td className="px-3 py-2 text-amber-700">{document.draftCount}</td><td className="px-3 py-2 text-emerald-700">{document.approvedCount}</td><td className="px-3 py-2 text-red-700">{document.rejectedCount}</td></tr>)}</tbody></table></div>
      {summary.blockers.length > 0 && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><span className="text-[10px] font-black uppercase text-amber-700">Publishing blockers ({summary.blockers.length})</span><ul className="mt-2 space-y-1.5">{summary.blockers.map((blocker, index) => <li key={`${blocker.code}-${blocker.documentId ?? index}`} className="flex items-start gap-2 text-[10px] font-semibold text-amber-800"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{blocker.message}</li>)}</ul></div>}
      {summary.canPublish && <div className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-700"><CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-xs font-bold">Ready to publish</p><p className="mt-1 text-[10px] font-semibold">All documents contain approved content and no draft records remain.</p></div></div>}
      <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between"><div className="text-[10px] font-semibold text-slate-500">Revision <strong>{detail?.publicationRevision ?? summary.knowledgeBase.publicationRevision}</strong>{detail?.publishedAt && <> · Published {new Date(detail.publishedAt).toLocaleString()}</>}</div>{!readOnly && <button type="button" onClick={() => void publish()} disabled={!summary.canPublish || publishing} className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"><Rocket className="h-4 w-4" />{publishing ? 'Publishing...' : detail?.status === 'published' ? 'Published' : 'Publish Knowledge Base'}</button>}</div>
    </>}
    {detail?.semanticIndex && <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4"><div className="flex items-center justify-between gap-3 text-[10px] font-bold text-blue-700"><span className="capitalize">Semantic index: {detail.semanticIndex.status?.replace(/_/g, ' ')}</span><span>{indexProgress}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all" style={{ width: `${indexProgress}%` }} /></div>{detail.semanticIndex.errorMessage && <p className="mt-2 text-[10px] font-semibold text-red-700">{detail.semanticIndex.errorMessage}</p>}</div>}
  </section>;
}
