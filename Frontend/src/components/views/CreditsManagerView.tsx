import React, { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';

interface AdminCreditSummary {
  platformWallet: { balance: number; reservedBalance: number; availableBalance: number; currency: string };
  companyWallets: Array<{ id: string; companyName: string; balance: number; reservedBalance: number; availableBalance: number; currency: string }>;
  pricing: Record<string, { ratePerMinute: number; currency: string }>;
}

interface CreditLedger {
  items: Array<{ id: string; companyName: string | null; type: string; direction: 'credit' | 'debit'; amount: number; balanceAfter: number; currency: string; description: string | null; actorName: string | null; createdAt: string }>;
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

const money = (value: number, currency: string) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4,
}).format(value);

const readableType = (value: string) => value.split('_').map((part) =>
  `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');

const providerDisplayAmount = (balance: ProviderBalance) => balance.currency === 'USD'
  ? Number(((balance.remainingCredits ?? 0) * (balance.conversionRate ?? 80)).toFixed(2))
  : (balance.remainingCredits ?? 0);
const providerDisplayCurrency = (balance: ProviderBalance) => balance.currency === 'USD' ? 'INR' : (balance.currency ?? 'INR');
const providerRawUsd = (balance: ProviderBalance) => balance.sourceRemainingCredits
  ?? (balance.currency === 'USD' ? balance.remainingCredits : undefined);

export function CreditsManagerView() {
  const [summary, setSummary] = useState<AdminCreditSummary | null>(null);
  const [ledger, setLedger] = useState<CreditLedger | null>(null);
  const [providerBalances, setProviderBalances] = useState<ProviderBalance[]>([]);
  const [rateOutbound, setRateOutbound] = useState('');
  const [rateInbound, setRateInbound] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [providerLoading, setProviderLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [ledgerError, setLedgerError] = useState('');
  const [providerError, setProviderError] = useState('');
  const [success, setSuccess] = useState('');
  const [ledgerPage, setLedgerPage] = useState(1);

  const loadSummary = async (forceRefresh = false) => {
    setSummaryLoading(true); setSummaryError('');
    try {
      const creditSummary = await apiRequest<AdminCreditSummary>('/admin/credits/summary', forceRefresh ? { zeaCache: 'reload' } : {});
      setSummary(creditSummary);
      setRateInbound(String(creditSummary.pricing.inbound?.ratePerMinute ?? ''));
      setRateOutbound(String(creditSummary.pricing.outbound?.ratePerMinute ?? ''));
    } catch (requestError) {
      setSummaryError(requestError instanceof Error ? requestError.message : 'Wallet information could not be loaded');
    } finally { setSummaryLoading(false); }
  };

  const loadLedger = async (forceRefresh = false) => {
    setLedgerLoading(true); setLedgerError('');
    try {
      setLedger(await apiRequest<CreditLedger>(`/admin/credits/ledger?page=${ledgerPage}&pageSize=20`, forceRefresh ? { zeaCache: 'reload' } : {}));
    } catch (requestError) {
      setLedgerError(requestError instanceof Error ? requestError.message : 'Credit ledger could not be loaded');
    } finally { setLedgerLoading(false); }
  };

  const loadProviderBalances = async (forceRefresh = false) => {
    setProviderLoading(true); setProviderError('');
    try {
      setProviderBalances(await apiRequest<ProviderBalance[]>('/admin/credits/provider-balances', forceRefresh
        ? { zeaCache: 'reload', headers: { 'x-force-provider-refresh': 'true' } } : {}));
    } catch (requestError) {
      setProviderError(requestError instanceof Error ? requestError.message : 'Plivo balance could not be loaded');
    } finally { setProviderLoading(false); }
  };

  const loadCreditData = async (forceRefresh = false) => {
    setError('');
    await Promise.allSettled([loadSummary(forceRefresh), loadLedger(forceRefresh), loadProviderBalances(forceRefresh)]);
  };

  useEffect(() => { void loadCreditData(); }, []);
  useEffect(() => { if (ledgerPage !== 1) void loadLedger(); }, [ledgerPage]);

  const savePricingRules = async () => {
    if (!rateInbound || !rateOutbound) return;
    setSaving(true); setError('');
    try {
      await apiRequest('/admin/credits/pricing', {
        method: 'PUT', body: JSON.stringify({ inboundRate: rateInbound, outboundRate: rateOutbound }),
      });
      setSuccess('Global platform pricing rates saved successfully.');
      await loadSummary(true);
      window.setTimeout(() => setSuccess(''), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Pricing rates could not be saved');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">Credit Manager</h2>
          <p className="text-xs text-slate-400 mt-0.5 font-medium">Live Plivo credits, company wallets, pricing, and ledger activity.</p>
        </div>
        <button type="button" onClick={() => void loadCreditData(true)} disabled={summaryLoading || ledgerLoading || providerLoading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer">
          {summaryLoading || ledgerLoading || providerLoading ? 'Refreshing...' : 'Refresh Credits'}
        </button>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-semibold">{error}</div>}
      {success && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs font-semibold">{success}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {providerLoading && providerBalances.length === 0 && [1, 2, 3].map((item) => (
          <div key={item} className="h-44 animate-pulse rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="h-3 w-24 rounded bg-slate-200" /><div className="mt-3 h-4 w-40 rounded bg-slate-200" /><div className="mt-8 h-8 w-32 rounded bg-slate-200" />
          </div>
        ))}
        {providerError && <div className="md:col-span-2 xl:col-span-3 rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-semibold text-red-700">{providerError}</div>}
        {providerBalances.map((balance) => (
          <div key={balance.telephonyAccountId} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="text-[10px] uppercase tracking-wider font-black text-indigo-600">{balance.provider}</span>
                <h3 className="font-bold text-slate-800 mt-0.5">{balance.providerName}</h3>
              </div>
              <span className={`px-2 py-1 rounded-full text-[9px] uppercase font-black ${balance.available ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {balance.available ? 'Live' : 'Unavailable'}
              </span>
            </div>
            <p className="text-[10px] font-bold uppercase text-slate-400 mt-5">Plivo Remaining Credits</p>
            {balance.available && balance.remainingCredits !== undefined && balance.currency ? (
              <>
                <p className="text-3xl font-black text-slate-900 font-mono mt-1">
                  {money(providerDisplayAmount(balance), providerDisplayCurrency(balance))}
                </p>
                {providerRawUsd(balance) !== undefined && (
                  <p className="text-[10px] text-slate-400 font-mono mt-1">
                    Raw Plivo API balance: {providerRawUsd(balance)?.toFixed(5)} USD
                    {` · ₹${balance.conversionRate ?? 80}/USD`}
                  </p>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500 mt-3 font-semibold">
                  <span>Billing: {balance.billingMode || 'Unknown'}</span>
                  <span>Auto recharge: {balance.autoRecharge ? 'Enabled' : 'Disabled'}</span>
                </div>
                <p className="text-[9px] text-slate-400 mt-2">{balance.cacheHit ? 'Cached Plivo balance' : 'Fetched directly from Plivo'} {balance.fetchedAt ? new Date(balance.fetchedAt).toLocaleString() : ''}</p>
              </>
            ) : <p className="text-xs text-red-600 font-semibold mt-2">{balance.error || 'Balance is unavailable'}</p>}
          </div>
        ))}
        {!providerLoading && !providerError && providerBalances.length === 0 && (
          <div className="md:col-span-2 xl:col-span-3 bg-white p-8 rounded-xl border border-dashed border-slate-300 text-center text-xs text-slate-500">
            Connect a main Plivo provider in Phone Numbers to display its live remaining credits.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-fit space-y-4">
          <div>
            <h2 className="text-md font-bold text-slate-800 tracking-tight">Global Pricing Rates</h2>
            <p className="text-xs text-slate-400 mt-0.5 font-medium">Database-backed company billing rates per minute.</p>
          </div>
          <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3">
            <p className="text-[9px] uppercase text-indigo-500 font-black">Platform Available Balance</p>
            <p className="text-xl font-black text-indigo-800 font-mono mt-1">{summary ? money(summary.platformWallet.availableBalance, summary.platformWallet.currency) : '—'}</p>
          </div>
          <div className="space-y-4 text-xs font-semibold">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Inbound Calling Minute Rate (INR)</label>
              <input type="number" min="0.0001" step="0.0001" value={rateInbound} onChange={(event) => setRateInbound(event.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Outbound Campaign Minute Rate (INR)</label>
              <input type="number" min="0.0001" step="0.0001" value={rateOutbound} onChange={(event) => setRateOutbound(event.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition" />
            </div>
            <button onClick={() => void savePricingRules()} disabled={saving || !rateInbound || !rateOutbound}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition disabled:opacity-50 cursor-pointer">
              {saving ? 'Saving...' : 'Save Pricing Rules'}
            </button>
          </div>
        </div>

        <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <h2 className="text-md font-bold text-slate-800 mb-3 tracking-tight">Company Credit Wallets</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead><tr className="border-b border-slate-200 text-[10px] uppercase text-slate-400">
                <th className="py-2">Company</th><th className="py-2 text-right">Balance</th><th className="py-2 text-right">Reserved</th><th className="py-2 text-right">Available</th>
              </tr></thead>
              <tbody>
                {summaryLoading && !summary && [1, 2, 3].map((item) => <tr key={item}><td colSpan={4} className="py-3"><div className="h-4 animate-pulse rounded bg-slate-100" /></td></tr>)}
                {summary?.companyWallets.map((wallet) => (
                  <tr key={wallet.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-3 font-bold text-slate-800">{wallet.companyName}</td>
                    <td className="py-3 text-right font-mono">{money(wallet.balance, wallet.currency)}</td>
                    <td className="py-3 text-right font-mono text-amber-600">{money(wallet.reservedBalance, wallet.currency)}</td>
                    <td className="py-3 text-right font-mono font-bold text-emerald-700">{money(wallet.availableBalance, wallet.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summaryError && <p className="py-5 text-center text-xs font-semibold text-red-600">{summaryError}</p>}
            {!summaryLoading && !summaryError && summary?.companyWallets.length === 0 && <p className="py-8 text-center text-slate-400">No company wallets found.</p>}
          </div>
        </div>
      </div>

      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-md font-bold text-slate-800 tracking-tight">Credit Ledger</h2>
          <span className="text-[10px] font-bold text-slate-400">{ledger?.pagination.total ?? 0} entries</span>
        </div>
        <div className="space-y-3 text-xs">
          {ledger?.items.map((entry) => (
            <div key={entry.id} className="border border-slate-200 p-3.5 rounded-xl bg-slate-50/30 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 font-semibold">
              <div>
                <span className="font-bold text-slate-800 block">{entry.companyName || 'Platform Wallet'}</span>
                <span className="text-[10px] text-slate-500">{readableType(entry.type)} · {entry.description || 'No description'} · {entry.actorName || 'System'}</span>
                <span className="text-[9px] text-slate-400 font-mono block mt-0.5">{new Date(entry.createdAt).toLocaleString()}</span>
              </div>
              <div className="sm:text-right">
                <span className={`text-sm font-black font-mono ${entry.direction === 'credit' ? 'text-emerald-600' : 'text-red-600'}`}>
                  {entry.direction === 'credit' ? '+' : '-'}{money(entry.amount, entry.currency)}
                </span>
                <span className="block text-[9px] text-slate-400 mt-0.5">Balance: {money(entry.balanceAfter, entry.currency)}</span>
              </div>
            </div>
          ))}
          {!ledgerLoading && !ledgerError && ledger?.items.length === 0 && <div className="py-8 text-center text-slate-400">No credit ledger entries yet.</div>}
          {ledgerLoading && !ledger && [1, 2, 3].map((item) => <div key={item} className="h-16 animate-pulse rounded-xl bg-slate-100" />)}
          {ledgerError && <div className="py-8 text-center font-semibold text-red-600">{ledgerError}</div>}
        </div>
        {ledger && (
          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-[10px] font-bold text-slate-500">
            <span>Page {ledger.pagination.page} of {Math.max(1, ledger.pagination.totalPages)}</span>
            <div className="flex gap-2">
              <button type="button" disabled={ledgerLoading || ledgerPage <= 1} onClick={() => setLedgerPage((value) => Math.max(1, value - 1))} className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40">Previous</button>
              <button type="button" disabled={ledgerLoading || ledgerPage >= ledger.pagination.totalPages} onClick={() => setLedgerPage((value) => value + 1)} className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
