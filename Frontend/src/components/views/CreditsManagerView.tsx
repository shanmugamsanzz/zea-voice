import React, { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api';

interface CompanyWallet {
  id: string;
  companyId: string;
  companyName: string;
  unit: 'credit';
  balance: number;
  reservedBalance: number;
  availableBalance: number;
  perMinutePrice: number;
  inrRemainder: number;
}

interface AdminCreditSummary {
  globalLowCreditThreshold: number;
  thresholdUpdatedAt: string;
  companyWallets: CompanyWallet[];
}

interface CreditLedger {
  items: Array<{
    id: string; companyName: string | null; type: string; direction: 'credit' | 'debit';
    amount: number; creditAmount: number | null; balanceAfter: number; description: string | null;
    actorName: string | null; billedDurationSeconds: number | null; createdAt: string;
  }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface PaymentHistory {
  items: Array<{
    id: string; companyName: string; paymentAmountInr: number; perMinutePrice: number;
    remainderBeforeInr: number; creditsIssued: number; remainderAfterInr: number;
    reference: string | null; description: string | null; actorName: string | null; createdAt: string;
  }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface ProviderBalance {
  telephonyAccountId: string;
  provider: string;
  providerName: string;
  available: boolean;
  remainingCredits?: number;
  currency?: string;
  sourceRemainingCredits?: number;
  sourceCurrency?: string;
  conversionRate?: number;
  billingMode?: string | null;
  autoRecharge?: boolean;
  fetchedAt?: string;
  cacheHit?: boolean;
  error?: string;
}

interface PurchaseResponse extends CompanyWallet {
  idempotentReplay: boolean;
  allocation: {
    paymentId: string; paymentAmountInr: number; creditsIssued: number; perMinutePrice: number;
    previousRemainderInr: number; remainderInr: number; createdAt: string;
  };
}

const money = (value: number) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 4,
}).format(value);
const credits = (value: number) => `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)} credits`;
const readableType = (value: string) => value.split('_').map((part) =>
  `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
const newIdempotencyKey = () => globalThis.crypto?.randomUUID?.()
  ?? `credit-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function fixedUnits(value: number | string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10_000) : 0;
}

export function CreditsManagerView() {
  const [summary, setSummary] = useState<AdminCreditSummary | null>(null);
  const [ledger, setLedger] = useState<CreditLedger | null>(null);
  const [payments, setPayments] = useState<PaymentHistory | null>(null);
  const [providerBalances, setProviderBalances] = useState<ProviderBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [providerLoading, setProviderLoading] = useState(true);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [paymentPage, setPaymentPage] = useState(1);
  const [error, setError] = useState('');
  const [providerError, setProviderError] = useState('');
  const [success, setSuccess] = useState('');
  const [selectedWallet, setSelectedWallet] = useState<CompanyWallet | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDescription, setPaymentDescription] = useState('');
  const [purchaseKey, setPurchaseKey] = useState(newIdempotencyKey);
  const [purchasing, setPurchasing] = useState(false);
  const [threshold, setThreshold] = useState('50');
  const [savingThreshold, setSavingThreshold] = useState(false);

  const loadBilling = async (forceRefresh = false) => {
    setLoading(true); setError('');
    try {
      const options = forceRefresh ? { zeaCache: 'reload' as const } : {};
      const [nextSummary, nextLedger, nextPayments] = await Promise.all([
        apiRequest<AdminCreditSummary>('/admin/credits/summary', options),
        apiRequest<CreditLedger>(`/admin/credits/ledger?page=${ledgerPage}&pageSize=20`, options),
        apiRequest<PaymentHistory>(`/admin/credits/payments?page=${paymentPage}&pageSize=20`, options),
      ]);
      setSummary(nextSummary); setThreshold(String(nextSummary.globalLowCreditThreshold));
      setLedger(nextLedger); setPayments(nextPayments);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Credit information could not be loaded');
    } finally { setLoading(false); }
  };

  const loadProviders = async (forceRefresh = false) => {
    setProviderLoading(true); setProviderError('');
    try {
      setProviderBalances(await apiRequest<ProviderBalance[]>('/admin/credits/provider-balances', forceRefresh
        ? { zeaCache: 'reload', headers: { 'x-force-provider-refresh': 'true' } } : {}));
    } catch (requestError) {
      setProviderError(requestError instanceof Error ? requestError.message : 'Provider balances could not be loaded');
    } finally { setProviderLoading(false); }
  };

  useEffect(() => { void loadProviders(); }, []);
  useEffect(() => { void loadBilling(); }, [ledgerPage, paymentPage]);

  const purchasePreview = useMemo(() => {
    if (!selectedWallet) return null;
    const payment = fixedUnits(paymentAmount);
    const price = fixedUnits(selectedWallet.perMinutePrice);
    const priorRemainder = fixedUnits(selectedWallet.inrRemainder);
    if (payment <= 0 || price <= 0) return null;
    const total = payment + priorRemainder;
    const issued = Math.floor(total / price);
    return {
      creditsIssued: issued,
      remainderInr: (total - (issued * price)) / 10_000,
      projectedBalance: selectedWallet.balance + issued,
    };
  }, [paymentAmount, selectedWallet]);

  const openPurchase = (wallet: CompanyWallet) => {
    setSelectedWallet(wallet); setPaymentAmount(''); setPaymentReference(''); setPaymentDescription('');
    setPurchaseKey(newIdempotencyKey()); setError('');
  };

  const submitPurchase = async () => {
    if (!selectedWallet || !purchasePreview || purchasing) return;
    setPurchasing(true); setError('');
    try {
      const result = await apiRequest<PurchaseResponse>(
        `/admin/credits/companies/${selectedWallet.companyId}/allocations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': purchaseKey },
          body: JSON.stringify({
            amount: paymentAmount,
            reference: paymentReference.trim() || undefined,
            description: paymentDescription.trim() || undefined,
          }),
        },
      );
      setSuccess(`${result.allocation.creditsIssued.toLocaleString('en-IN')} credits added to ${selectedWallet.companyName}. ${money(result.allocation.remainderInr)} carried forward.`);
      setSelectedWallet(null);
      await loadBilling(true);
      window.setTimeout(() => setSuccess(''), 5000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Company payment could not be completed');
    } finally { setPurchasing(false); }
  };

  const saveThreshold = async () => {
    const value = Number(threshold);
    if (!Number.isSafeInteger(value) || value < 0 || savingThreshold) {
      setError('Low-credit threshold must be a non-negative whole number.');
      return;
    }
    setSavingThreshold(true); setError('');
    try {
      const result = await apiRequest<{ globalLowCreditThreshold: number }>('/admin/credits/threshold', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lowCreditThreshold: value }),
      });
      setThreshold(String(result.globalLowCreditThreshold));
      setSummary((current) => current ? { ...current, globalLowCreditThreshold: result.globalLowCreditThreshold } : current);
      setSuccess(`Global low-credit threshold updated to ${result.globalLowCreditThreshold} credits.`);
      window.setTimeout(() => setSuccess(''), 5000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Threshold could not be updated');
    } finally { setSavingThreshold(false); }
  };

  return (
    <div className="zea-credits-manager space-y-6">
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Credit Manager</h2>
          <p className="text-sm text-slate-400 mt-1 font-medium">Manage company payments, whole call credits and private INR remainders.</p>
        </div>
        <button type="button" onClick={() => { void loadBilling(true); void loadProviders(true); }} disabled={loading || providerLoading}
          className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold disabled:opacity-50">
          {loading || providerLoading ? 'Refreshing...' : 'Refresh Credits'}
        </button>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-semibold">{error}</div>}
      {success && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-sm font-semibold">{success}</div>}

      <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h3 className="font-bold text-amber-950">Global Company Credit Alert</h3>
            <p className="mt-1 max-w-2xl text-sm text-amber-800">At or below this balance, company users receive a warning and new outbound calls are paused. Inbound calls remain available until no credit remains.</p>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs font-bold uppercase text-amber-800">Threshold (credits)
              <input type="number" min="0" step="1" value={threshold} onChange={(event) => setThreshold(event.target.value)}
                className="mt-1 block w-40 rounded-lg border border-amber-300 bg-white px-3 py-2.5 text-base font-black text-slate-900 outline-none focus:border-amber-500" />
            </label>
            <button type="button" disabled={savingThreshold} onClick={() => void saveThreshold()}
              className="rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50">
              {savingThreshold ? 'Saving...' : 'Save threshold'}
            </button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-base font-bold text-slate-800 mb-3">Provider Balances</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {providerLoading && providerBalances.length === 0 && [1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-xl border border-slate-200 bg-white" />)}
          {providerError && <div className="md:col-span-2 xl:col-span-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{providerError}</div>}
          {providerBalances.map((balance) => (
            <div key={balance.telephonyAccountId} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex justify-between gap-3"><div><span className="text-xs uppercase font-black text-indigo-600">{balance.provider}</span><h4 className="font-bold text-slate-800">{balance.providerName}</h4></div>
                <span className={`h-fit px-2 py-1 rounded-full text-xs font-black ${balance.available ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{balance.available ? 'LIVE' : 'UNAVAILABLE'}</span></div>
              {balance.available ? <><p className="text-xs uppercase font-bold text-slate-400 mt-4">Remaining provider balance</p><p className="text-2xl font-black font-mono text-slate-900">{money(balance.remainingCredits ?? 0)}</p></>
                : <p className="text-sm text-red-600 mt-4">{balance.error || 'Balance unavailable'}</p>}
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between mb-4"><div><h3 className="text-base font-bold text-slate-800">Company Credit Wallets</h3><p className="text-xs text-slate-400 mt-1">Payments and pricing are visible only to Super Admin.</p></div><span className="text-xs font-bold text-slate-400">{summary?.companyWallets.length ?? 0} companies</span></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm text-left">
            <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400"><th className="py-2">Company</th><th className="py-2 text-right">Price / minute</th><th className="py-2 text-right">Balance</th><th className="py-2 text-right">Reserved</th><th className="py-2 text-right">Available</th><th className="py-2 text-right">INR remainder</th><th className="py-2 text-right">Action</th></tr></thead>
            <tbody>{summary?.companyWallets.map((wallet) => (
              <tr key={wallet.id} className="border-b border-slate-100 last:border-0"><td className="py-3 font-bold text-slate-800">{wallet.companyName}</td><td className="py-3 text-right font-mono">{money(wallet.perMinutePrice)}</td><td className="py-3 text-right font-mono">{credits(wallet.balance)}</td><td className="py-3 text-right font-mono text-amber-600">{credits(wallet.reservedBalance)}</td><td className="py-3 text-right font-mono font-bold text-emerald-700">{credits(wallet.availableBalance)}</td><td className="py-3 text-right font-mono">{money(wallet.inrRemainder)}</td><td className="py-3 text-right"><button type="button" onClick={() => openPurchase(wallet)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-700">Add payment</button></td></tr>
            ))}</tbody>
          </table>
          {loading && !summary && <div className="h-24 animate-pulse bg-slate-50 rounded-lg mt-3" />}
          {!loading && summary?.companyWallets.length === 0 && <p className="py-8 text-center text-slate-400">No company wallets found.</p>}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex justify-between mb-3"><h3 className="font-bold text-slate-800">Payment History</h3><span className="text-xs font-bold text-slate-400">{payments?.pagination.total ?? 0} payments</span></div>
          <div className="space-y-3">{payments?.items.map((payment) => <div key={payment.id} className="rounded-xl border border-slate-200 p-3 text-sm"><div className="flex justify-between gap-3"><div><p className="font-bold text-slate-800">{payment.companyName}</p><p className="text-xs text-slate-500">{payment.actorName || 'Super Admin'} · {new Date(payment.createdAt).toLocaleString()}</p></div><div className="text-right"><p className="font-black text-indigo-700">{money(payment.paymentAmountInr)}</p><p className="text-xs font-bold text-emerald-700">+{credits(payment.creditsIssued)}</p></div></div><p className="text-xs text-slate-500 mt-2">Rate {money(payment.perMinutePrice)} · remainder {money(payment.remainderBeforeInr)} → {money(payment.remainderAfterInr)}</p>{payment.reference && <p className="text-xs text-slate-400 mt-1">Reference: {payment.reference}</p>}</div>)}</div>
          {payments && <Pagination page={paymentPage} totalPages={payments.pagination.totalPages} loading={loading} onChange={setPaymentPage} />}
        </section>

        <section className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex justify-between mb-3"><h3 className="font-bold text-slate-800">Company Credit Ledger</h3><span className="text-xs font-bold text-slate-400">{ledger?.pagination.total ?? 0} entries</span></div>
          <div className="space-y-3">{ledger?.items.map((entry) => <div key={entry.id} className="rounded-xl border border-slate-200 p-3 text-sm flex justify-between gap-3"><div><p className="font-bold text-slate-800">{entry.companyName || 'Company'}</p><p className="text-xs text-slate-500">{readableType(entry.type)} · {entry.description || 'No description'}</p><p className="text-xs text-slate-400">{new Date(entry.createdAt).toLocaleString()}</p></div><div className="text-right"><p className={`font-black ${entry.direction === 'credit' ? 'text-emerald-700' : 'text-red-600'}`}>{entry.direction === 'credit' ? '+' : '-'}{credits(entry.creditAmount ?? entry.amount)}</p><p className="text-xs text-slate-400">Balance: {credits(entry.balanceAfter)}</p></div></div>)}</div>
          {ledger && <Pagination page={ledgerPage} totalPages={ledger.pagination.totalPages} loading={loading} onChange={setLedgerPage} />}
        </section>
      </div>

      {selectedWallet && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Add company payment">
        <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
          <div className="flex justify-between gap-4"><div><h3 className="text-xl font-black text-slate-900">Add company payment</h3><p className="text-sm text-slate-500">{selectedWallet.companyName}</p></div><button type="button" disabled={purchasing} onClick={() => setSelectedWallet(null)} className="text-2xl text-slate-400">×</button></div>
          {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div>}
          <div className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-indigo-50 p-4 text-sm"><div><p className="text-xs font-bold uppercase text-indigo-500">Price per credit</p><p className="font-black text-indigo-900">{money(selectedWallet.perMinutePrice)}</p></div><div><p className="text-xs font-bold uppercase text-indigo-500">Carried remainder</p><p className="font-black text-indigo-900">{money(selectedWallet.inrRemainder)}</p></div></div>
          <div className="mt-5 space-y-4"><label className="block text-sm font-bold text-slate-600">Payment amount (INR)<input autoFocus type="number" min="0.0001" step="0.0001" value={paymentAmount} onChange={(event) => { setPaymentAmount(event.target.value); setPurchaseKey(newIdempotencyKey()); }} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-slate-900 outline-none focus:border-indigo-500" placeholder="10000" /></label><label className="block text-sm font-bold text-slate-600">Payment reference (optional)<input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} maxLength={240} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2.5 outline-none focus:border-indigo-500" placeholder="Receipt or transaction ID" /></label><label className="block text-sm font-bold text-slate-600">Description (optional)<textarea value={paymentDescription} onChange={(event) => setPaymentDescription(event.target.value)} maxLength={500} rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2.5 outline-none focus:border-indigo-500" /></label></div>
          {purchasePreview && <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm"><p className="font-black text-emerald-900">This payment adds {credits(purchasePreview.creditsIssued)}</p><p className="mt-1 text-emerald-700">Projected balance: {credits(purchasePreview.projectedBalance)}</p><p className="text-emerald-700">New INR remainder: {money(purchasePreview.remainderInr)}</p></div>}
          <div className="mt-6 flex justify-end gap-3"><button type="button" disabled={purchasing} onClick={() => setSelectedWallet(null)} className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600">Cancel</button><button type="button" disabled={!purchasePreview || purchasing} onClick={() => void submitPurchase()} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{purchasing ? 'Adding credits...' : 'Confirm payment'}</button></div>
        </div>
      </div>}
    </div>
  );
}

function Pagination({ page, totalPages, loading, onChange }: { page: number; totalPages: number; loading: boolean; onChange: (page: number) => void }) {
  return <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-xs font-bold text-slate-500"><span>Page {page} of {Math.max(1, totalPages)}</span><div className="flex gap-2"><button type="button" disabled={loading || page <= 1} onClick={() => onChange(Math.max(1, page - 1))} className="rounded-md border border-slate-200 px-3 py-2 disabled:opacity-40">Previous</button><button type="button" disabled={loading || page >= totalPages} onClick={() => onChange(page + 1)} className="rounded-md border border-slate-200 px-3 py-2 disabled:opacity-40">Next</button></div></div>;
}
