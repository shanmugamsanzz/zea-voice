import React, { useState } from 'react';
import { ArrowRight, CheckCircle2, Link2, PlugZap, ShieldCheck, Webhook, X } from 'lucide-react';

type CrmKey = 'zea' | 'zoho' | 'hubspot' | 'salesforce';

interface CrmDefinition {
  key: CrmKey;
  name: string;
  description: string;
  capabilities: string[];
  accent: string;
}

const crmIntegrations: CrmDefinition[] = [
  {
    key: 'zea', name: 'Zea CRM', accent: 'from-violet-600 to-fuchsia-500',
    description: 'Connect Zea CRM contacts, leads and activities directly to Zea Voice.',
    capabilities: ['Contact access', 'Lead event webhooks', 'Call activity sync'],
  },
  {
    key: 'zoho', name: 'Zoho CRM', accent: 'from-red-500 to-blue-500',
    description: 'Receive Zoho lead and contact events and synchronize voice-call outcomes.',
    capabilities: ['OAuth connection', 'Lead and contact events', 'Call result updates'],
  },
  {
    key: 'hubspot', name: 'HubSpot', accent: 'from-orange-500 to-orange-400',
    description: 'Trigger voice workflows from HubSpot contacts, forms and lifecycle changes.',
    capabilities: ['Private app or OAuth', 'Contact webhooks', 'Timeline activities'],
  },
  {
    key: 'salesforce', name: 'Salesforce CRM', accent: 'from-sky-500 to-blue-500',
    description: 'Connect Salesforce leads and contacts with real-time Zea Voice campaigns.',
    capabilities: ['OAuth connection', 'Platform events', 'Task and call logging'],
  },
];

function CrmLogo({ type }: { type: CrmKey }) {
  if (type === 'zoho') return <svg viewBox="0 0 120 54" role="img" aria-label="Zoho CRM" className="h-14 w-28"><rect x="2" y="10" width="28" height="34" rx="6" fill="#ef4444"/><rect x="31" y="10" width="28" height="34" rx="6" fill="#3b82f6"/><rect x="60" y="10" width="28" height="34" rx="6" fill="#facc15"/><rect x="89" y="10" width="28" height="34" rx="6" fill="#22c55e"/><text x="16" y="33" textAnchor="middle" fontSize="17" fontWeight="900" fill="white">Z</text><text x="45" y="33" textAnchor="middle" fontSize="17" fontWeight="900" fill="white">O</text><text x="74" y="33" textAnchor="middle" fontSize="17" fontWeight="900" fill="white">H</text><text x="103" y="33" textAnchor="middle" fontSize="17" fontWeight="900" fill="white">O</text></svg>;
  if (type === 'hubspot') return <svg viewBox="0 0 120 54" role="img" aria-label="HubSpot" className="h-14 w-28"><g transform="translate(4 4)" fill="none" stroke="#ff7a59" strokeWidth="4"><circle cx="25" cy="23" r="7" fill="#ff7a59"/><circle cx="43" cy="8" r="4" fill="#ff7a59"/><circle cx="45" cy="38" r="4" fill="#ff7a59"/><path d="M31 19L40 11M31 27l10 8M25 16V7" strokeLinecap="round"/></g><text x="57" y="33" fontSize="16" fontWeight="800" fill="#33475b">HubSpot</text></svg>;
  if (type === 'salesforce') return <svg viewBox="0 0 120 54" role="img" aria-label="Salesforce" className="h-14 w-28"><path d="M25 42c-9 0-15-5-15-12 0-6 4-11 11-12 2-7 8-11 16-9 4-5 13-5 18 1 8-1 14 4 15 11 7 1 11 5 11 11 0 6-5 10-13 10H25Z" fill="#0ea5e9"/><text x="45" y="30" textAnchor="middle" fontSize="9" fontWeight="800" fill="white">salesforce</text></svg>;
  return <svg viewBox="0 0 120 54" role="img" aria-label="Zea CRM" className="h-14 w-28"><defs><linearGradient id="zea-crm-gradient" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#7c3aed"/><stop offset="1" stopColor="#ec4899"/></linearGradient></defs><rect x="5" y="5" width="44" height="44" rx="14" fill="url(#zea-crm-gradient)"/><path d="M16 16h22L19 38h22" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/><text x="58" y="27" fontSize="17" fontWeight="900" fill="#172033">ZEA</text><text x="58" y="40" fontSize="10" fontWeight="800" fill="#7c3aed">CRM</text></svg>;
}

export function DeveloperIntegrationsView() {
  const [notice, setNotice] = useState<string | null>(null);

  return <div className="space-y-6">
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-start gap-3"><div className="rounded-xl bg-violet-50 p-3 text-violet-600"><PlugZap className="h-5 w-5" /></div><div><h2 className="text-xl font-black text-slate-800">CRM Integrations</h2><p className="mt-1 max-w-3xl text-xs font-semibold leading-relaxed text-slate-500">Connect a CRM to receive lead and contact events, trigger approved real-time calls, and return call outcomes. These connectors are planned and are not active yet.</p></div></div></div>

    {notice && <div className="flex items-start justify-between gap-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-xs font-semibold text-blue-800"><span className="flex items-start gap-2"><Link2 className="mt-0.5 h-4 w-4 shrink-0" />{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="h-4 w-4" /></button></div>}

    <div className="grid gap-5 md:grid-cols-2">{crmIntegrations.map((crm) => <article key={crm.key} className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className={`h-1.5 bg-gradient-to-r ${crm.accent}`} /><div className="p-6"><div className="flex items-start justify-between gap-4"><div className="flex h-20 w-36 items-center justify-center rounded-2xl border border-slate-100 bg-slate-50"><CrmLogo type={crm.key} /></div><span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[9px] font-black uppercase text-amber-700">Coming later</span></div><h3 className="mt-5 text-lg font-black text-slate-800">{crm.name}</h3><p className="mt-2 min-h-10 text-xs font-semibold leading-relaxed text-slate-500">{crm.description}</p><div className="mt-5 space-y-2">{crm.capabilities.map((capability) => <div key={capability} className="flex items-center gap-2 text-[11px] font-bold text-slate-600"><CheckCircle2 className="h-4 w-4 text-emerald-500" />{capability}</div>)}</div><button onClick={() => setNotice(`${crm.name} integration is reserved for a future phase. No credentials were requested and no connection was created.`)} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-xs font-black text-white transition hover:bg-violet-700">Integrate <ArrowRight className="h-4 w-4" /></button></div></article>)}</div>

    <div className="grid gap-4 md:grid-cols-2"><div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-5"><Webhook className="mt-0.5 h-5 w-5 shrink-0 text-violet-500" /><div><h3 className="text-xs font-black text-slate-800">Planned event flow</h3><p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-500">CRM lead/contact event → verified tenant webhook → deduplication and consent checks → call task queue → selected voice agent.</p></div></div><div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-5"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" /><div><h3 className="text-xs font-black text-slate-800">Required before activation</h3><p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-500">Tenant-scoped OAuth storage, encrypted refresh tokens, signed webhooks, event replay protection, field mapping, consent rules and per-company call limits.</p></div></div></div>
  </div>;
}
