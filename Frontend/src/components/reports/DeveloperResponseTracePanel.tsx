import React from 'react';
import { buildDeveloperResponseTrace, type TraceSource } from './developer-response-trace';

export function DeveloperResponseTracePanel({
  sources,
  visible,
}: {
  sources: TraceSource[];
  visible: boolean;
}) {
  const trace = visible ? buildDeveloperResponseTrace(sources) : null;
  if (!trace) return null;
  const sourceSummary = trace.knowledgeSources.map((source) => {
    const document = String(source.metadata.documentDisplayName
      ?? source.metadata.documentName ?? source.label ?? 'Published knowledge');
    const record = String(source.metadata.recordName ?? source.metadata.sourceSection ?? '').trim();
    return [document, record].filter(Boolean).join(' · ');
  }).join(', ');
  return <div data-testid="developer-response-trace" className="rounded-lg bg-violet-50/70 px-3 py-2 text-[10px] font-semibold text-slate-700">
    <p><span className="font-black uppercase tracking-wider text-violet-700">Route:</span> {trace.route}</p>
    {trace.knowledgeSources.length > 0
      && <p className="mt-1"><span className="font-black text-slate-600">Sources ({trace.knowledgeSources.length}):</span> {sourceSummary}</p>}
    {trace.knowledgeSources.length === 0 && !trace.sourcesRequired
      && <p className="mt-1"><span className="font-black text-slate-600">Sources:</span> None required</p>}
    {trace.knowledgeSources.length === 0 && trace.sourcesRequired
      && <p className="mt-1"><span className="font-black text-slate-600">Sources:</span> No cited source</p>}
    {trace.finalDecision === 'CLARIFY' && <p className="mt-1"><span className="font-black text-slate-600">Reason:</span> {trace.clarificationReason || 'Clarification requested'}</p>}
    {trace.initialDecision === 'TOOL' && <>
      <p className="mt-1"><span className="font-black text-slate-600">Workflow:</span> {trace.workflowId ? 'authorized' : 'not identified'}</p>
      {trace.toolResult && <p className="mt-1"><span className="font-black text-slate-600">Tool result:</span> {trace.toolResult}</p>}
    </>}
    {trace.validationResult && <p className="mt-1 text-slate-500">Validation: {trace.validationResult}</p>}
  </div>;
}
