import { useState, useEffect, useRef } from 'react';
import { LoaderCircle, Phone, X } from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';
import { PhoneTestShareLinksPanel } from './PhoneTestShareLinksPanel';
import { useAppState } from '../../store/AppState';

interface PhoneTestResult { id?: string; phone: string; status: 'queued' | 'dispatching' | 'initiated' | 'failed' | 'canceled'; }

export function AgentPhoneTestButton({ agent }: { agent: { id: string; name: string; status: string } }) {
  const { role } = useAppState();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !queuedId) return;
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        const result = await apiRequest<PhoneTestResult>(`/agents/${agent.id}/phone-test-calls/${queuedId}`, { signal: controller.signal, zeaCache: 'bypass' });
        if (stopped) return;
        if (result.status === 'initiated') {
          setSuccess(`Call initiated to ${result.phone}. Please answer your phone.`); setQueuedId(null); return;
        }
        if (result.status === 'failed' || result.status === 'canceled') {
          setSuccess(''); setError(result.status === 'canceled' ? 'The waiting call was canceled.' : 'The call could not be placed. Check the company credits and agent configuration.');
          setQueuedId(null); requestKey.current = null; return;
        }
        setError('');
      } catch (failure) {
        if (!stopped && !isAbortError(failure)) setError('Your call request is saved. Its status could not be refreshed; check Call Queue.');
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 5000);
    };
    timer = window.setTimeout(() => void poll(), 5000);
    return () => { stopped = true; controller?.abort(); if (timer) window.clearTimeout(timer); };
  }, [open, queuedId, agent.id]);
  return <>
    <button type="button" disabled={agent.status !== 'active'} onClick={() => { setOpen(true); setError(''); setSuccess(''); setQueuedId(null); requestKey.current = null; }} className="inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-3 text-xs font-black text-slate-950 hover:bg-amber-300 disabled:opacity-40"><Phone className="h-4 w-4" />Call</button>
    {open && <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
      <form role="dialog" aria-modal="true" aria-labelledby="phone-test-title" className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-100" onSubmit={async (event) => {
        event.preventDefault(); if (busy) return;
        setBusy(true); setError(''); setSuccess('');
        try {
          requestKey.current ??= crypto.randomUUID();
          const result = await apiRequest<PhoneTestResult>(`/agents/${agent.id}/phone-test-calls`, { method: 'POST', body: JSON.stringify({ phone, requestId: requestKey.current }) });
          if (result.status === 'failed' || result.status === 'canceled') {
            setError('The call could not be placed. Check the company credits and agent configuration.'); requestKey.current = null;
          } else if (result.status === 'queued' || result.status === 'dispatching') {
            setSuccess(`Call to ${result.phone} is queued. It will dial automatically when a company call slot is available.`);
            setQueuedId(result.id ?? null);
          } else setSuccess(`Call initiated to ${result.phone}. Please answer your phone.`);
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Call could not be started.'); }
        finally { setBusy(false); }
      }}>
        <div className="flex items-center justify-between"><h3 id="phone-test-title" className="font-black">Call with {agent.name}</h3><button type="button" aria-label="Close call form" disabled={busy} onClick={() => setOpen(false)}><X className="h-5 w-5" /></button></div>
        <label className="mt-5 block text-sm font-bold">Phone number<input autoFocus required type="tel" autoComplete="tel" placeholder="+919876543210" value={phone} onChange={(event) => { setPhone(event.target.value); setSuccess(''); setError(''); setQueuedId(null); requestKey.current = null; }} disabled={busy} className="mt-2 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-3" /></label>
        <p className="mt-2 text-xs text-slate-500">Include the country code. This places a real phone call and uses call credits.</p>
        <p className="mt-2 text-xs text-slate-500">If all company slots are busy, the request waits in Call Queue. Enter another number to request another call.</p>
        {error && <p role="alert" className="mt-4 text-sm text-red-500">{error}</p>}
        {success && <p role="status" className="mt-4 text-sm text-emerald-600">{success}</p>}
        <div className="mt-5 flex justify-end gap-3"><button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded-lg px-4 py-2 text-sm font-bold">Close</button><button type="submit" disabled={busy || Boolean(success)} className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-5 py-2 text-sm font-black text-slate-950 disabled:opacity-50">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}{busy ? 'Calling...' : 'Call'}</button></div>
        {(role === 'SUPER_ADMIN' || role === 'DEVELOPER') && <PhoneTestShareLinksPanel agentId={agent.id} />}
      </form>
    </div>}
  </>;
}
