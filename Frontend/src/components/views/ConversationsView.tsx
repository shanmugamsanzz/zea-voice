import React, { useEffect, useRef, useState } from 'react';
import { Phone, UserRound, Clock, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';
import { useAppState } from '../../store/AppState';

interface Contact { id: string; name: string | null; phone: string; callCount?: number; lastCallAt?: string }
interface Page<T> { items: T[]; page: number; hasMore: boolean }
interface Call { id: string; direction: string; status: string; agentName: string; campaignName?: string; startedAt: string;
  durationSeconds: number; summaryStatus?: string; summary?: string; outcome?: string; customerIntent?: string;
  collectedData?: { pending_questions?: unknown }; followUpRequired?: boolean; followUpReason?: string }
interface FollowUp { id: string; kind: string; purpose: string; status: string; scheduledFor: string; agentName: string }
interface History { contact: Contact; calls: Page<Call>; followUps: Page<FollowUp> }
interface Transcript { call: { id: string; startedAt: string }; transcript: Page<{ id: string; speaker: string; text: string }> }
const date = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const label = (value?: string) => (value || 'unknown').replace(/_/g, ' ');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Could not load conversations.';
const button = 'rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold disabled:opacity-40';
function CallSummary({ call, questions }: { call: Call; questions: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const element = text.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > Number.parseFloat(getComputedStyle(element).lineHeight) + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [call.summary]);
  return <>
    <p className="mt-3 text-sm font-semibold">Outcome: {label(call.outcome)}</p>
    <p id={`summary-${call.id}`} ref={text} className={`mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600 ${expanded ? '' : 'line-clamp-1'}`}>{call.summary}</p>
    {(overflowing || questions || call.followUpRequired) && <button type="button" aria-expanded={expanded}
      aria-controls={`summary-${call.id}`} onClick={() => setExpanded(value => !value)}
      className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-amber-700">{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{expanded ? 'View less' : 'View more'}</button>}
    {expanded && <>{questions && <p className="mt-3 text-sm"><strong>Pending questions:</strong> {questions}</p>}
      {call.followUpRequired && <p className="mt-2 text-sm"><strong>Follow-up noted:</strong> {call.followUpReason || 'See summary for details.'}</p>}</>}
  </>;
}
function Pagination({ page, hasMore, onChange }: { page: number; hasMore: boolean; onChange: (value: number) => void }) {
  return <div className="mt-4 flex items-center justify-between gap-3"><button className={button} disabled={page === 1} onClick={() => onChange(page - 1)}>Previous</button><span className="text-sm">Page {page}</span><button className={button} disabled={!hasMore} onClick={() => onChange(page + 1)}>Next</button></div>;
}
function useRead<T>(path: string | null, refresh = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setData(null); setError('');
    if (path) apiRequest<T>(path, { signal: controller.signal, zeaCache: 'bypass' })
      .then(result => { if (active) setData(result); })
      .catch(reason => { if (active && !isAbortError(reason)) setError(errorMessage(reason)); });
    return () => { active = false; controller.abort(); };
  }, [path, refresh]);
  return { data, error };
}
export function ConversationsView() {
  const { role } = useAppState();
  const admin = role === 'SUPER_ADMIN';
  const [companyId, setCompanyId] = useState('');
  const companies = useRead<Array<{ tenantId: string; businessName: string }>>(admin ? '/admin/companies/options' : null);
  return <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
    <div><h2 className="text-2xl font-bold">Conversations</h2><p className="mt-1 text-sm text-slate-500">Contact history, call summaries and pending follow-ups.</p></div>
    {admin && <label className="block text-sm font-semibold">Company<select aria-label="Company" value={companyId} onChange={event => setCompanyId(event.target.value)} className="ml-3 rounded-lg border border-slate-200 bg-white p-3"><option value="">Select company</option>{companies.data?.map(company => <option key={company.tenantId} value={company.tenantId}>{company.businessName}</option>)}</select></label>}
    {companies.error && <p role="alert" className="text-red-700">{companies.error}</p>}
    {(!admin || companyId) ? <ConversationBrowser key={admin ? companyId : role} base={admin ? '/admin/conversations' : '/conversations'} companyId={admin ? companyId : ''} /> : <p className="text-sm text-slate-500">Select a company to view its conversations.</p>}
  </div>;
}
function ConversationBrowser({ base, companyId }: { base: string; companyId: string }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const company = companyId ? `&companyId=${encodeURIComponent(companyId)}` : '';
  const { data, error } = useRead<Page<Contact>>(`${base}?page=${page}&pageSize=25&search=${encodeURIComponent(query)}${company}`, refresh);
  return <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,2fr)] gap-3 overflow-hidden md:grid-cols-[260px_minmax(0,1fr)] md:grid-rows-1">
      <section aria-label="Contacts" className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="shrink-0 border-b border-slate-100 p-3"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold">Contacts</h3><button aria-label="Refresh conversations" className="rounded-lg p-2 text-slate-500 hover:bg-amber-50" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button></div><form className="flex gap-1" onSubmit={event => { event.preventDefault(); setQuery(search); setPage(1); }}><input aria-label="Search contacts" placeholder="Search name or phone…" maxLength={120} value={search} onChange={event => setSearch(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-200 p-2 text-xs" /><button className="rounded-lg bg-amber-50 px-2 text-xs font-semibold text-amber-800">Search</button></form></div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {!data && !error && <p role="status">Loading contacts…</p>}
        {data?.items.map(contact => <button key={contact.id} onClick={() => setSelected(contact.id)} aria-pressed={selected === contact.id} className={`mb-2 w-full rounded-lg border p-3 text-left ${selected === contact.id ? 'border-amber-400 bg-amber-50' : 'border-slate-200'}`}><span className="block font-semibold">{contact.name || contact.phone}</span>{contact.name && <span className="block text-sm text-slate-500">{contact.phone}</span>}<span className="mt-1 block text-xs text-slate-500">{contact.callCount} calls · {date(contact.lastCallAt)}</span></button>)}
        {data && !data.items.length && <p className="text-sm text-slate-500">No conversations found.</p>}
        </div>
        {data && <div className="shrink-0 border-t border-slate-100 p-3"><Pagination page={page} hasMore={data.hasMore} onChange={setPage} /></div>}
      </section>
      {selected ? <ConversationHistory key={selected} id={selected} base={base} company={company} refresh={refresh} /> : <p className="p-5 text-sm text-slate-500">Select a contact to view their call history.</p>}
    </div>
  </div>;
}
function ConversationHistory({ id, base, company, refresh }: { id: string; base: string; company: string; refresh: number }) {
  const { role } = useAppState();
  const [changed,setChanged]=useState(0);
  const [actionError,setActionError]=useState('');
  const [canceling,setCanceling]=useState('');
  const [page, setPage] = useState(1);
  const [followUpPage, setFollowUpPage] = useState(1);
  const [callId, setCallId] = useState<string | null>(null);
  const [tab, setTab] = useState<'conversation' | 'calls' | 'follow-ups'>('conversation');
  const { data, error } = useRead<History>(`${base}/${id}?page=${page}&pageSize=25&followUpPage=${followUpPage}${company}`, refresh+changed);
  const cancel=async(task:FollowUp)=>{
    if(canceling || !window.confirm('Cancel this pending follow-up?'))return;
    setCanceling(task.id);setActionError('');
    try{
      const result=await apiRequest<{canceled:boolean;reason?:string}>(`${base}/${id}/follow-ups/${task.id}/cancel${company?`?${company.slice(1)}`:''}`,{method:'POST'});
      if(!result.canceled)setActionError('This follow-up has already started or changed. Refresh its status.');
      setChanged(value=>value+1);
    }catch(error){setActionError(errorMessage(error));}finally{setCanceling('');}
  };
  return <section aria-label="Contact conversation" className="flex min-h-0 min-w-0 flex-col overflow-hidden">
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {actionError && <p role="alert" className="text-red-700">{actionError}</p>}
    {!data && !error && <p role="status">Loading call history…</p>}
    {data && <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_230px]">
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="shrink-0 border-b border-slate-100 px-4 pt-4"><div className="flex items-center gap-3"><span className="rounded-full bg-amber-100 p-2 text-amber-700"><Phone size={18} /></span><div className="min-w-0"><h3 className="truncate font-bold">{data.contact.name || data.contact.phone}</h3>{data.contact.name && <p className="text-xs text-slate-500">{data.contact.phone}</p>}</div></div></div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain bg-slate-50/60 p-3 md:p-4">
      <div aria-label="Conversation sections" className="flex flex-wrap gap-1 border-b border-slate-200">{([['conversation','Conversation'],['calls','Call History'],['follow-ups','Follow-ups']] as const).map(([value,title]) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={`border-b-2 px-3 py-2 text-xs font-semibold ${tab === value ? 'border-amber-500 text-amber-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{title}</button>)}</div>
      {tab !== 'calls' && <section className="rounded-xl border border-amber-100 bg-amber-50/60 p-4"><h4 className="flex items-center gap-2 text-sm font-bold"><Clock size={17} className="text-amber-600" />Pending follow-ups</h4>
        {!data.followUps.items.length && <p className="mt-2 text-sm text-slate-500">No pending follow-ups on this page.</p>}
        {data.followUps.items.map(task => <div key={task.id} className="mt-3 border-t border-slate-100 pt-3"><p className="font-semibold capitalize">{label(task.kind)} · {label(task.status)}</p><p className="whitespace-pre-wrap text-sm">{task.purpose}</p><p className="mt-1 text-xs text-slate-500">{date(task.scheduledFor)} · {task.agentName}</p>{['DEVELOPER','SUPER_ADMIN'].includes(role)&&['scheduled','queued'].includes(task.status)&&<button className={`${button} mt-2 text-red-700`} disabled={Boolean(canceling)} onClick={()=>void cancel(task)}>Cancel follow-up</button>}</div>)}
        {(followUpPage > 1 || data.followUps.hasMore) && <Pagination page={followUpPage} hasMore={data.followUps.hasMore} onChange={setFollowUpPage} />}
      </section>}
      {tab !== 'follow-ups' && <><h4 className="font-bold">Calls · oldest first</h4>
      {data.calls.items.map(call => {
        const pending = call.collectedData?.pending_questions;
        const questions = Array.isArray(pending) ? pending.filter(item => typeof item === 'string').join('; ') : typeof pending === 'string' ? pending : '';
        return <article key={call.id} className={`w-full rounded-xl border border-slate-200 p-4 shadow-sm ${call.direction === 'outbound' ? 'bg-emerald-50/70' : 'bg-white'}`}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-2"><span className={`rounded-full p-2 ${call.direction === 'outbound' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}><Phone size={16} /></span><div><p className="text-sm font-semibold capitalize">{label(call.direction)} · {label(call.status)}</p><p className="mt-1 text-xs text-slate-500">{date(call.startedAt)} · {call.agentName} · {Math.floor(call.durationSeconds / 60)}m {call.durationSeconds % 60}s{call.campaignName ? ` · ${call.campaignName}` : ''}</p></div></div><button className={`${button} bg-white`} onClick={() => setCallId(call.id)}>View conversation</button></div>
          {call.summaryStatus === 'completed' ? <CallSummary call={call} questions={questions} /> : <p className="mt-3 text-sm text-slate-500">Summary: {call.summaryStatus ? label(call.summaryStatus) : 'not available'}. The conversation remains available.</p>}
        </article>;
      })}
      {!data.calls.items.length && <p className="text-sm text-slate-500">No calls on this page.</p>}
      <Pagination page={page} hasMore={data.calls.hasMore} onChange={setPage} />
      </>}
      </div>
      </div>
      <aside aria-label="Contact details" className="hidden min-h-0 overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-4 shadow-sm xl:block">
        <h4 className="text-sm font-bold">Contact Details</h4>
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-100 p-3"><span className="rounded-full bg-slate-100 p-2 text-slate-600"><UserRound size={20} /></span><div className="min-w-0"><p className="break-words text-sm font-semibold">{data.contact.name || data.contact.phone}</p><p className="break-words text-xs text-slate-500">{data.contact.name ? data.contact.phone : 'No name available'}</p></div></div>
        <dl className="mt-5 space-y-4 text-xs"><div className="flex justify-between gap-2"><dt className="text-slate-500">Total calls</dt><dd className="font-semibold">{data.contact.callCount ?? '—'}</dd></div><div><dt className="text-slate-500">Last call</dt><dd className="mt-1 font-semibold">{date(data.contact.lastCallAt)}</dd></div><div><dt className="text-slate-500">Phone number</dt><dd className="mt-1 break-words font-semibold">{data.contact.phone}</dd></div></dl>
        <p className="mt-6 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">View each conversation to read the full transcript. Scheduled callbacks appear under pending follow-ups.</p>
      </aside>
    </div>}
    {callId && <TranscriptDialog key={callId} path={`${base}/${id}/calls/${callId}/transcript`} company={company} onClose={() => setCallId(null)} />}
  </section>;
}
function TranscriptDialog({ path, company, onClose }: { path: string; company: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const { data, error } = useRead<Transcript>(`${path}?page=${page}&pageSize=100${company}`);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="conversation-transcript-title" className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl" onKeyDown={event => {
    if (event.key === 'Escape') onClose();
    if (event.key === 'Tab') {
      const nodes = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <div className="flex items-center justify-between gap-3"><h3 id="conversation-transcript-title" className="text-xl font-bold">Call conversation</h3><button className={button} onClick={onClose}>Close</button></div>
    {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
    {!data && !error && <p role="status" className="mt-4">Loading conversation…</p>}
    {data && <><p className="mt-2 text-sm text-slate-500">{date(data.call.startedAt)}</p><div className="mt-4 space-y-3">{data.transcript.items.map(entry => <div key={entry.id} className={`rounded-lg p-3 ${entry.speaker === 'agent' ? 'bg-amber-50' : 'bg-slate-50'}`}><p className="mb-1 text-xs font-bold capitalize">{entry.speaker === 'user' ? 'Caller' : label(entry.speaker)}</p><p className="whitespace-pre-wrap text-sm">{entry.text}</p></div>)}</div>{!data.transcript.items.length && <p className="mt-4 text-sm text-slate-500">No final transcript is available for this call.</p>}<Pagination page={page} hasMore={data.transcript.hasMore} onChange={setPage} /></>}
  </div></div>;
}
