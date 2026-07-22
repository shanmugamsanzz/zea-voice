import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Building2, CheckCircle2, Globe2, LoaderCircle, Phone,
  RadioTower, RefreshCw, ShieldCheck, Smartphone as SimCard,
} from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

interface TenantPhoneNumber {
  id: string;
  number: string;
  provider: string;
  countryIso: string | null;
  numberType: string | null;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean } | null;
  monthlyCost: number | null;
  currency: string | null;
  status: 'active' | 'released' | 'unavailable' | 'pending';
  companyId: string;
  companyName: string;
  assignedAt: string | null;
  lastSyncedAt: string | null;
}

function displayDate(value: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString('en-IN');
}

function statusStyle(status: TenantPhoneNumber['status']) {
  if (status === 'active') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'pending') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-100 text-slate-600';
}

export function DeveloperPhoneNumbersView() {
  const [numbers, setNumbers] = useState<TenantPhoneNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    if (numbers.length) setRefreshing(true); else setLoading(true);
    setError('');
    apiRequest<TenantPhoneNumber[]>('/phone-numbers', { signal: controller.signal, zeaCache: 'reload' })
      .then(setNumbers)
      .catch((requestError) => {
        if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Assigned phone numbers could not be loaded');
      })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); } });
    return () => controller.abort();
  }, [refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (loading && !numbers.length) return <div className="flex min-h-[400px] items-center justify-center rounded-2xl border border-slate-200 bg-white"><div className="text-center"><LoaderCircle className="mx-auto h-8 w-8 animate-spin text-violet-500" /><p className="mt-3 text-xs font-bold text-slate-400">Loading company phone numbers…</p></div></div>;

  return <div className="space-y-6">
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><Phone className="h-5 w-5 text-violet-600" /><h2 className="text-xl font-black text-slate-800">Phone Numbers</h2></div><p className="mt-1 text-xs font-semibold text-slate-500">Only telephone numbers currently assigned to your company are shown here.</p></div><button onClick={refresh} disabled={refreshing} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</button></div>

    {error && <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-700"><span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{error}</span><button onClick={refresh}>Retry</button></div>}

    <div className="grid gap-4 sm:grid-cols-3">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Assigned Numbers</p><p className="mt-2 text-3xl font-black text-slate-800">{numbers.length}</p></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Active Numbers</p><p className="mt-2 text-3xl font-black text-emerald-600">{numbers.filter((item) => item.status === 'active').length}</p></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Voice Enabled</p><p className="mt-2 text-3xl font-black text-violet-600">{numbers.filter((item) => item.capabilities?.voice).length}</p></div>
    </div>

    {numbers.length ? <div className="grid gap-5 xl:grid-cols-2">{numbers.map((item) => <div key={item.id} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex min-w-0 items-start gap-3"><div className="rounded-2xl bg-violet-50 p-3 text-violet-600"><SimCard className="h-5 w-5" /></div><div className="min-w-0"><p className="break-all font-mono text-lg font-black text-slate-800">{item.number}</p><p className="mt-1 flex items-center gap-1.5 text-[10px] font-bold uppercase text-slate-400"><RadioTower className="h-3.5 w-3.5" />{item.provider || 'Telephony provider'}</p></div></div><span className={`w-fit rounded-full border px-3 py-1 text-[9px] font-black uppercase ${statusStyle(item.status)}`}>{item.status}</span></div>
        <div className="mt-5 grid grid-cols-2 gap-3 text-xs"><div className="rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="flex items-center gap-1.5 text-[9px] font-black uppercase text-slate-400"><Globe2 className="h-3.5 w-3.5" />Country</p><p className="mt-1.5 font-black text-slate-700">{item.countryIso || 'Not available'}</p></div><div className="rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="flex items-center gap-1.5 text-[9px] font-black uppercase text-slate-400"><Phone className="h-3.5 w-3.5" />Number type</p><p className="mt-1.5 font-black capitalize text-slate-700">{item.numberType || 'Not available'}</p></div><div className="rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="flex items-center gap-1.5 text-[9px] font-black uppercase text-slate-400"><Building2 className="h-3.5 w-3.5" />Assigned company</p><p className="mt-1.5 truncate font-black text-slate-700">{item.companyName}</p></div><div className="rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="flex items-center gap-1.5 text-[9px] font-black uppercase text-slate-400"><ShieldCheck className="h-3.5 w-3.5" />Capabilities</p><div className="mt-1.5 flex flex-wrap gap-1">{Object.entries(item.capabilities || {}).filter(([, enabled]) => enabled).map(([capability]) => <span key={capability} className="rounded bg-white px-1.5 py-0.5 text-[9px] font-black uppercase text-violet-600">{capability}</span>)}{!Object.values(item.capabilities || {}).some(Boolean) && <span className="font-semibold text-slate-400">Not recorded</span>}</div></div></div>
        <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 text-[10px] font-semibold text-slate-400 sm:flex-row sm:items-center sm:justify-between"><span>Assigned: <b className="text-slate-600">{displayDate(item.assignedAt)}</b></span>{item.monthlyCost !== null && <span>Monthly cost: <b className="text-slate-600">{item.currency || 'INR'} {item.monthlyCost.toFixed(2)}</b></span>}</div></div>)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-14 text-center"><Phone className="mx-auto h-9 w-9 text-slate-300" /><h3 className="mt-4 text-sm font-black text-slate-700">No phone numbers assigned</h3><p className="mx-auto mt-2 max-w-md text-xs font-semibold leading-relaxed text-slate-400">A Super Admin must assign a provider phone number to this company. It will appear here automatically after assignment.</p></div>}

    <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold leading-relaxed text-emerald-800"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>This page is tenant-isolated. Provider inventory and numbers assigned to other companies are never returned by this endpoint.</span></div>
  </div>;
}
