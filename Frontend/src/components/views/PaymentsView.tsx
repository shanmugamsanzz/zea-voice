import React, { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';

type PaymentType = 'subscription' | 'credit_refill' | 'add_on';
type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

interface PaymentItem {
  id: string;
  transactionReference: string;
  externalReference: string | null;
  companyName: string;
  type: PaymentType;
  status: PaymentStatus;
  amount: number;
  currency: string;
  paymentMethod: string | null;
  invoiceNumber: string | null;
  invoiceAvailable: boolean;
  settledAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
}

interface PaymentList {
  items: PaymentItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface PaymentSummary {
  currency: string;
  succeededAmount: number;
  succeededCount: number;
  pendingCount: number;
  failedCount: number;
}

const money = (value: number, currency: string) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4,
}).format(value);

const title = (value: string) => value.split('_').map((part) =>
  `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');

const statusClass: Record<PaymentStatus, string> = {
  succeeded: 'bg-emerald-50 border-emerald-100 text-emerald-700',
  pending: 'bg-amber-50 border-amber-100 text-amber-700',
  failed: 'bg-red-50 border-red-100 text-red-700',
  refunded: 'bg-slate-100 border-slate-200 text-slate-600',
};

export function PaymentsView() {
  const [payments, setPayments] = useState<PaymentList | null>(null);
  const [summary, setSummary] = useState<PaymentSummary[]>([]);
  const [status, setStatus] = useState<PaymentStatus | ''>('');
  const [type, setType] = useState<PaymentType | ''>('');
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState('');

  const loadPayments = async (forceRefresh = false) => {
    setError(''); setListLoading(true); setSummaryLoading(true);
    const query = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (status) query.set('status', status);
    if (type) query.set('type', type);
    await Promise.allSettled([
      apiRequest<PaymentList>(`/admin/payments?${query}`, forceRefresh ? { zeaCache: 'reload' } : {})
        .then(setPayments)
        .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Payment transactions could not be loaded'))
        .finally(() => setListLoading(false)),
      apiRequest<PaymentSummary[]>('/admin/payments/summary', forceRefresh ? { zeaCache: 'reload' } : {})
        .then(setSummary)
        .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Payment summary could not be loaded'))
        .finally(() => setSummaryLoading(false)),
    ]);
  };

  useEffect(() => { void loadPayments(); }, [page, status, type]);

  const changeStatus = (value: PaymentStatus | '') => { setStatus(value); setPage(1); };
  const changeType = (value: PaymentType | '') => { setType(value); setPage(1); };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div><h2 className="text-xl font-bold text-slate-800 tracking-tight">Payments</h2><p className="text-xs text-slate-400 font-medium mt-0.5">Database payment transactions, settlements, refills and invoices.</p></div>
        <button type="button" onClick={() => void loadPayments(true)} disabled={listLoading || summaryLoading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer">{listLoading || summaryLoading ? 'Refreshing...' : 'Refresh Payments'}</button>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-semibold">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {summaryLoading && summary.length === 0 && [1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-xl border border-slate-200 bg-white p-5"><div className="h-3 w-28 rounded bg-slate-200" /><div className="mt-4 h-8 w-36 rounded bg-slate-200" /></div>)}
        {summary.map((item) => (
          <div key={item.currency} className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
            <div className="flex justify-between items-start"><div><p className="text-[9px] uppercase font-black tracking-wider text-indigo-500">Successful Payments</p><p className="text-2xl font-black font-mono text-slate-900 mt-1">{money(item.succeededAmount, item.currency)}</p></div><span className="text-[10px] font-black text-slate-400">{item.currency}</span></div>
            <div className="grid grid-cols-3 gap-2 mt-4 text-center"><div className="bg-emerald-50 rounded-lg p-2"><span className="block text-lg font-black text-emerald-700">{item.succeededCount}</span><span className="text-[8px] uppercase font-bold text-emerald-600">Succeeded</span></div><div className="bg-amber-50 rounded-lg p-2"><span className="block text-lg font-black text-amber-700">{item.pendingCount}</span><span className="text-[8px] uppercase font-bold text-amber-600">Pending</span></div><div className="bg-red-50 rounded-lg p-2"><span className="block text-lg font-black text-red-700">{item.failedCount}</span><span className="text-[8px] uppercase font-bold text-red-600">Failed</span></div></div>
          </div>
        ))}
        {!summaryLoading && summary.length === 0 && <div className="md:col-span-2 xl:col-span-3 py-8 text-center bg-white rounded-xl border border-dashed border-slate-300 text-xs text-slate-400">No payment summary is available yet.</div>}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4 mb-4">
          <div><h3 className="font-bold text-slate-800">Financial Ledger</h3><p className="text-[10px] text-slate-400">{payments?.pagination.total ?? 0} matching transactions</p></div>
          <div className="flex flex-wrap gap-2">
            <select value={type} onChange={(event) => changeType(event.target.value as PaymentType | '')} className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold outline-none cursor-pointer"><option value="">All Types</option><option value="subscription">Subscription</option><option value="credit_refill">Credit Refill</option><option value="add_on">Add-on</option></select>
            <select value={status} onChange={(event) => changeStatus(event.target.value as PaymentStatus | '')} className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold outline-none cursor-pointer"><option value="">All Statuses</option><option value="pending">Pending</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="refunded">Refunded</option></select>
          </div>
        </div>

        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left min-w-[900px]">
            <thead><tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[10px]"><th className="pb-3">Transaction</th><th className="pb-3">Company</th><th className="pb-3">Type</th><th className="pb-3">Status</th><th className="pb-3">Payment Method</th><th className="pb-3">Settlement</th><th className="pb-3">Invoice</th><th className="pb-3 text-right">Amount</th></tr></thead>
            <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
              {payments?.items.map((payment) => (
                <tr key={payment.id} className="hover:bg-slate-50/50 align-top">
                  <td className="py-3.5"><span className="font-bold font-mono text-slate-800 block">{payment.transactionReference}</span>{payment.externalReference && <span className="text-[9px] text-slate-400 font-mono block mt-0.5">External: {payment.externalReference}</span>}</td>
                  <td className="py-3.5 font-bold text-slate-800">{payment.companyName}</td>
                  <td className="py-3.5"><span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded border border-slate-200 text-[10px] font-bold">{title(payment.type)}</span></td>
                  <td className="py-3.5"><span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${statusClass[payment.status]}`}>{payment.status}</span>{payment.failureMessage && <span title={payment.failureMessage} className="block max-w-40 truncate text-[9px] text-red-500 mt-1">{payment.failureCode ? `${payment.failureCode}: ` : ''}{payment.failureMessage}</span>}</td>
                  <td className="py-3.5 text-slate-500">{payment.paymentMethod || 'Not recorded'}</td>
                  <td className="py-3.5 text-slate-400 font-mono text-[10px]"><span className="block">Created: {new Date(payment.createdAt).toLocaleString()}</span><span className="block mt-0.5">Settled: {payment.settledAt ? new Date(payment.settledAt).toLocaleString() : '—'}</span></td>
                  <td className="py-3.5"><span className="font-mono text-[10px]">{payment.invoiceNumber || '—'}</span>{payment.invoiceAvailable && <span className="block text-[9px] text-emerald-600 mt-0.5">Stored</span>}</td>
                  <td className="py-3.5 text-right font-black font-mono text-slate-800">{money(payment.amount, payment.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {listLoading && !payments && <div className="space-y-3 py-5">{[1, 2, 3, 4].map((item) => <div key={item} className="h-10 animate-pulse rounded bg-slate-100" />)}</div>}
          {!listLoading && payments?.items.length === 0 && <div className="py-10 text-center text-slate-400">No payment transactions match these filters.</div>}
        </div>

        {(payments?.pagination.totalPages ?? 0) > 1 && <div className="flex justify-between items-center pt-4 mt-4 border-t border-slate-200"><span className="text-[10px] text-slate-400">Page {payments?.pagination.page} of {payments?.pagination.totalPages}</span><div className="flex gap-2"><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || listLoading} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-bold disabled:opacity-40 cursor-pointer">Previous</button><button type="button" onClick={() => setPage((value) => value + 1)} disabled={page >= (payments?.pagination.totalPages ?? 1) || listLoading} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-bold disabled:opacity-40 cursor-pointer">Next</button></div></div>}
      </div>
    </div>
  );
}
