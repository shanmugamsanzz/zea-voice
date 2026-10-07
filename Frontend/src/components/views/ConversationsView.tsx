import React, { useEffect, useRef, useState } from 'react';
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
  return <div className="space-y-5">
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
  return <>
    <div className="flex flex-wrap gap-3"><form className="flex flex-1 gap-2" onSubmit={event => { event.preventDefault(); setQuery(search); setPage(1); }}><input aria-label="Search contacts" placeholder="Search name or phone number" maxLength={120} value={search} onChange={event => setSearch(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-200 p-3" /><button className={button}>Search</button></form><button className={button} onClick={() => setRefresh(value => value + 1)}>Refresh</button></div>
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <section aria-label="Contacts" className="rounded-xl border border-slate-200 bg-white p-4">
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {!data && !error && <p role="status">Loading contacts…</p>}
        {data?.items.map(contact => <button key={contact.id} onClick={() => setSelected(contact.id)} aria-pressed={selected === contact.id} className={`mb-2 w-full rounded-lg border p-3 text-left ${selected === contact.id ? 'border-amber-400 bg-amber-50' : 'border-slate-200'}`}><span className="block font-semibold">{contact.name || contact.phone}</span>{contact.name && <span className="block text-sm text-slate-500">{contact.phone}</span>}<span className="mt-1 block text-xs text-slate-500">{contact.callCount} calls · {date(contact.lastCallAt)}</span></button>)}
        {data && !data.items.length && <p className="text-sm text-slate-500">No conversations found.</p>}
        {data && <Pagination page={page} hasMore={data.hasMore} onChange={setPage} />}
      </section>
      {selected ? <ConversationHistory key={selected} id={selected} base={base} company={company} refresh={refresh} /> : <p className="p-5 text-sm text-slate-500">Select a contact to view their call history.</p>}
    </div>
  </>;
}
function ConversationHistory({ id, base, company, refresh }: { id: string; base: string; company: string; refresh: number }) {
  const { role } = useAppState();
  const [changed,setChanged]=useState(0);
  const [actionError,setActionError]=useState('');
  const [canceling,setCanceling]=useState('');
  const [page, setPage] = useState(1);
  const [followUpPage, setFollowUpPage] = useState(1);
  const [callId, setCallId] = useState<string | null>(null);
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
  return <section aria-label="Contact conversation" className="space-y-4">
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {actionError && <p role="alert" className="text-red-700">{actionError}</p>}
    {!data && !error && <p role="status">Loading call history…</p>}
    {data && <>
      <div><h3 className="text-xl font-bold">{data.contact.name || data.contact.phone}</h3>{data.contact.name && <p className="text-sm text-slate-500">{data.contact.phone}</p>}</div>
      <section className="rounded-xl border border-slate-200 bg-white p-4"><h4 className="font-bold">Pending follow-ups</h4>
        {!data.followUps.items.length && <p className="mt-2 text-sm text-slate-500">No pending follow-ups on this page.</p>}
        {data.followUps.items.map(task => <div key={task.id} className="mt-3 border-t border-slate-100 pt-3"><p className="font-semibold capitalize">{label(task.kind)} · {label(task.status)}</p><p className="whitespace-pre-wrap text-sm">{task.purpose}</p><p className="mt-1 text-xs text-slate-500">{date(task.scheduledFor)} · {task.agentName}</p>{['DEVELOPER','SUPER_ADMIN'].includes(role)&&['scheduled','queued'].includes(task.status)&&<button className={`${button} mt-2 text-red-700`} disabled={Boolean(canceling)} onClick={()=>void cancel(task)}>Cancel follow-up</button>}</div>)}
        {(followUpPage > 1 || data.followUps.hasMore) && <Pagination page={followUpPage} hasMore={data.followUps.hasMore} onChange={setFollowUpPage} />}
      </section>
      <h4 className="font-bold">Calls · oldest first</h4>
      {data.calls.items.map(call => {
        const pending = call.collectedData?.pending_questions;
        const questions = Array.isArray(pending) ? pending.filter(item => typeof item === 'string').join('; ') : typeof pending === 'string' ? pending : '';
        return <article key={call.id} className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold capitalize">{label(call.direction)} · {label(call.status)}</p><p className="mt-1 text-xs text-slate-500">{date(call.startedAt)} · {call.agentName} · {Math.floor(call.durationSeconds / 60)}m {call.durationSeconds % 60}s{call.campaignName ? ` · ${call.campaignName}` : ''}</p></div><button className={button} onClick={() => setCallId(call.id)}>View conversation</button></div>
          {call.summaryStatus === 'completed' ? <><p className="mt-3 text-sm font-semibold">Outcome: {label(call.outcome)}</p><p className="mt-2 whitespace-pre-wrap text-sm">{call.summary}</p>{questions && <p className="mt-3 text-sm"><strong>Pending questions:</strong> {questions}</p>}{call.followUpRequired && <p className="mt-2 text-sm"><strong>Follow-up noted:</strong> {call.followUpReason || 'See summary for details.'}</p>}</> : <p className="mt-3 text-sm text-slate-500">Summary: {call.summaryStatus ? label(call.summaryStatus) : 'not available'}. The conversation remains available.</p>}
        </article>;
      })}
      {!data.calls.items.length && <p className="text-sm text-slate-500">No calls on this page.</p>}
      <Pagination page={page} hasMore={data.calls.hasMore} onChange={setPage} />
    </>}
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
