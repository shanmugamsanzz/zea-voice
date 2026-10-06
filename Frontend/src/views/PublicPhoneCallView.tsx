import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Phone, LoaderCircle } from 'lucide-react';
import { createPublicPhoneClient, PublicPhoneApiError, SharedPhoneAgent, SharedPhoneRequest,
  sharedPhoneStatus, unavailablePhoneLink } from '../lib/publicPhoneCalls';

export function SharedPhoneCallForm({ agent, phone, consent, busy, request, error, onPhone, onConsent, onSubmit, onNew,
  website, onWebsite }: {
  agent: SharedPhoneAgent; phone: string; consent: boolean; busy: boolean; request: SharedPhoneRequest | null; error: string;
  website: string; onWebsite: (value: string) => void; onPhone: (value: string) => void; onConsent: (value: boolean) => void;
  onSubmit: (event: React.FormEvent) => void; onNew: () => void;
}) {
  return <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-lg sm:p-8">
    <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100"><Phone className="h-6 w-6 text-amber-700" /></div>
    <h1 className="text-2xl font-bold">Call with {agent.agentName}</h1>
    <p className="mt-2 text-sm text-slate-500">Enter your number to receive a call from this assistant.</p>
    <p className="mt-2 text-xs text-slate-500">{agent.permanent ? 'This link stays available until revoked.' : `Link expires ${new Date(agent.expiresAt!).toLocaleString()}.`}</p>
    <form className="mt-6 space-y-4" onSubmit={onSubmit}>
      <label className="block text-sm font-semibold" htmlFor="shared-phone">Phone number</label>
      <input id="shared-phone" required type="tel" autoComplete="tel" inputMode="tel" maxLength={40} placeholder="+919876543210"
        value={phone} disabled={busy || Boolean(request)} onChange={event => onPhone(event.target.value)}
        className="w-full rounded-xl border border-slate-300 px-4 py-3 disabled:bg-slate-50" />
      <p className="text-xs text-slate-500">Include the country code. Busy calls wait in the queue and dial automatically.</p>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" required checked={consent} disabled={busy || Boolean(request)}
        onChange={event => onConsent(event.target.checked)} className="mt-1" />I want to receive this call at my own phone number.</label>
      <div className="absolute -left-[10000px]" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={event => onWebsite(event.target.value)} /></label></div>
      {request && <p role="status" aria-live="polite" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{sharedPhoneStatus(request)}</p>}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!request ? <button type="submit" disabled={busy || !consent || !phone.trim()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 font-bold text-slate-950 disabled:opacity-50">
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}{busy ? 'Sending request...' : 'Call me'}</button>
        : <button type="button" disabled={busy} onClick={onNew} className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold">Request another call</button>}
      <p className="text-xs text-slate-500">Closing this page will not cancel a saved call request.</p>
    </form>
  </section>;
}

export function PublicPhoneCallView({ token }: { token: string | null }) {
  const client = useMemo(() => createPublicPhoneClient(token ?? ''), [token]);
  const [agent, setAgent] = useState<SharedPhoneAgent | null>(null);
  const [screen, setScreen] = useState<'loading' | 'ready' | 'unavailable' | 'error'>(token ? 'loading' : 'unavailable');
  const [refresh, setRefresh] = useState(0);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [request, setRequest] = useState<SharedPhoneRequest | null>(null);
  const [error, setError] = useState('');
  const receipt = useRef<string | null>(null);
  const mounted = useRef(true);
  const submission = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; submission.current?.abort(); }; }, []);
  useEffect(() => {
    if (!token) { setScreen('unavailable'); return; }
    const controller = new AbortController();
    setScreen('loading'); setError('');
    void client.metadata(controller.signal).then(value => { if (!controller.signal.aborted) { setAgent(value); setScreen('ready'); } })
      .catch(failure => { if (!controller.signal.aborted) { setScreen(unavailablePhoneLink(failure) ? 'unavailable' : 'error'); setError('Calling could not be loaded. Please try again.'); } });
    return () => controller.abort();
  }, [client, token, refresh]);
  useEffect(() => {
    if (!request || !['queued','dispatching'].includes(request.status) || !receipt.current || screen !== 'ready') return;
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const currentReceipt = receipt.current;
    const poll = async () => {
      let delay = 5000;
      if (document.visibilityState === 'visible') {
        controller = new AbortController();
        try {
          const value = await client.status(request.id, currentReceipt, controller.signal);
          if (!stopped) { setRequest(value); setError(''); }
        } catch (failure) {
          if (!stopped && !controller.signal.aborted) {
            if (unavailablePhoneLink(failure)) { setScreen('unavailable'); return; }
            setError('Your request is saved. Its status could not be refreshed.');
            if (failure instanceof PublicPhoneApiError) delay = Math.max(delay, failure.retryAfterSeconds * 1000);
          }
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), delay);
    };
    timer = window.setTimeout(() => void poll(), 5000);
    return () => { stopped = true; controller?.abort(); if (timer) window.clearTimeout(timer); };
  }, [client, request?.id, request?.status, screen]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current || request || !consent || !phone.trim()) return;
    busyRef.current = true; setBusy(true); setError('');
    receipt.current ??= crypto.randomUUID();
    submission.current = new AbortController();
    try {
      const value = await client.call(phone.trim(), receipt.current, consent, website, submission.current.signal);
      if (mounted.current) setRequest(value);
    } catch (failure) {
      if (mounted.current) {
        if (unavailablePhoneLink(failure)) setScreen('unavailable');
        else setError(failure instanceof PublicPhoneApiError ? failure.message : 'The request could not be confirmed. Retry with the same number; it will not create a duplicate request.');
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  return <main className="flex min-h-dvh items-center justify-center bg-slate-50 p-4 sm:p-8">
    {screen === 'ready' && agent ? <SharedPhoneCallForm agent={agent} phone={phone} consent={consent} busy={busy} request={request} error={error}
      website={website} onWebsite={setWebsite} onPhone={value => { setPhone(value); receipt.current = null; setError(''); }} onConsent={setConsent}
      onSubmit={event => void submit(event)} onNew={() => { setRequest(null); receipt.current = null; setPhone(''); setConsent(false); setError(''); }} />
      : <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-slate-800 shadow-lg">
        <h1 className="text-xl font-bold">{screen === 'loading' ? 'Loading calling page...' : screen === 'unavailable' ? 'Calling link unavailable' : 'Calling is temporarily unavailable'}</h1>
        {screen === 'unavailable' && <p className="mt-3 text-sm text-slate-500">This link is invalid, expired, revoked, or no longer enabled. Ask the person who shared it for a new link.</p>}
        {screen === 'error' && <><p role="alert" className="mt-3 text-sm text-slate-500">{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)} className="mt-4 rounded-lg bg-amber-400 px-4 py-2 font-semibold">Try again</button></>}
      </section>}
  </main>;
}
