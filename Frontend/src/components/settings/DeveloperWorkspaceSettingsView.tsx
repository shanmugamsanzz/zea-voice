import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Building2, BriefcaseBusiness, Check, Clipboard, Code2, Copy,
  LoaderCircle, Mail, RefreshCw, Settings, ShieldCheck, UserRound,
} from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

interface WorkspaceSettings {
  user: { id: string; firstName: string; lastName: string; email: string };
  tenant: { id: string; name: string; timezone: string };
  organization: { id: string; name: string };
  workspace: { id: string; name: string };
}

function ProfileRow({ label, value, Icon }: { label: string; value: string; Icon: typeof UserRound }) {
  return <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-5 last:border-0"><div className="flex items-center gap-3"><div className="rounded-xl border border-violet-100 bg-violet-50 p-2.5 text-violet-600"><Icon className="h-4 w-4" /></div><span className="text-xs font-bold text-slate-500">{label}</span></div><span className="max-w-[60%] break-words text-right text-xs font-black text-slate-800">{value || 'Not recorded'}</span></div>;
}

function Identifier({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return <div><label className="mb-2 block text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</label><div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2 pl-4"><span className="min-w-0 flex-1 break-all font-mono text-xs font-bold text-slate-700">{value}</span><button type="button" onClick={onCopy} title={`Copy ${label}`} className="shrink-0 rounded-lg border border-slate-200 bg-white p-2.5 text-slate-500 transition hover:border-violet-200 hover:text-violet-600">{copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}</button></div></div>;
}

export function DeveloperWorkspaceSettingsView() {
  const [data, setData] = useState<WorkspaceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    apiRequest<WorkspaceSettings>('/settings', { signal: controller.signal, zeaCache: 'reload' })
      .then(setData)
      .catch((requestError) => {
        if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Workspace settings could not be loaded');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshKey]);

  const copy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(''), 1600);
  };

  const taskTemplate = useMemo(() => data ? JSON.stringify({
    agent: '<agent_id>', campaign: '<campaign_id>', phone: '+91XXXXXXXXXX', from: '+91XXXXXXXXXX',
    workspace_id: data.workspace.id, retries: 3, intervals: [300000, 600000, 900000],
    context: { lead_name: '<lead_name>', company: data.organization.name },
  }, null, 2) : '', [data]);

  if (loading && !data) return <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-slate-200 bg-white"><div className="text-center"><LoaderCircle className="mx-auto h-8 w-8 animate-spin text-violet-500" /><p className="mt-3 text-xs font-bold text-slate-400">Loading workspace identity…</p></div></div>;

  return <div className="space-y-6">
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><div className="rounded-xl bg-gradient-to-br from-violet-600 to-pink-500 p-3 text-white"><Settings className="h-5 w-5" /></div><div><h2 className="text-xl font-black text-slate-800">Workspace Settings</h2><p className="mt-1 text-xs font-semibold text-slate-500">Workspace identity and read-only API identifiers</p></div></div><button onClick={() => setRefreshKey((value) => value + 1)} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div>

    {error && <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-700"><span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{error}</span><button onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div>}

    {data && <>
      <div className="grid gap-6 xl:grid-cols-2"><section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="h-1 bg-gradient-to-r from-pink-500 to-violet-500" /><div className="p-7"><div className="flex items-center gap-3"><UserRound className="h-5 w-5 text-violet-600" /><div><h3 className="text-lg font-black text-slate-800">Client Profile</h3><p className="mt-1 text-xs font-semibold text-slate-400">Personal and organizational details</p></div></div><div className="mt-6"><ProfileRow label="Full Name" value={`${data.user.firstName} ${data.user.lastName}`.trim()} Icon={UserRound} /><ProfileRow label="Email Address" value={data.user.email} Icon={Mail} /><ProfileRow label="Workspace" value={data.workspace.name} Icon={BriefcaseBusiness} /><ProfileRow label="Organization" value={data.organization.name} Icon={Building2} /></div></div></section>

        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="h-1 bg-gradient-to-r from-pink-500 to-violet-500" /><div className="p-7"><div className="flex items-center gap-3"><ShieldCheck className="h-5 w-5 text-blue-600" /><div><h3 className="text-lg font-black text-slate-800">System Identifiers</h3><p className="mt-1 text-xs font-semibold text-slate-400">Unique IDs for API and webhook integrations</p></div></div><div className="mt-7 space-y-5"><Identifier label="Organization ID" value={data.organization.id} copied={copied === 'organization'} onCopy={() => void copy('organization', data.organization.id)} /><Identifier label="Tenant ID" value={data.tenant.id} copied={copied === 'tenant'} onCopy={() => void copy('tenant', data.tenant.id)} /><Identifier label="Workspace ID" value={data.workspace.id} copied={copied === 'workspace'} onCopy={() => void copy('workspace', data.workspace.id)} /></div><div className="mt-7 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-xs font-semibold leading-relaxed text-slate-500">These identifiers are read-only and uniquely map to your active workspace. They are safe to copy into authenticated integration configuration, but they are not authentication secrets.</div></div></section></div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-2"><Code2 className="h-5 w-5 text-violet-600" /><div><h3 className="text-sm font-black text-slate-800">Planned n8n Call Task Body</h3><p className="mt-0.5 text-[10px] font-semibold text-slate-400">Payload reference only—the public task endpoint is not enabled yet</p></div></div><button onClick={() => void copy('template', taskTemplate)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">{copied === 'template' ? <Check className="h-4 w-4 text-emerald-600" /> : <Clipboard className="h-4 w-4" />}Copy JSON</button></div><pre className="overflow-x-auto bg-slate-950 p-6 font-mono text-xs leading-relaxed text-slate-200">{taskTemplate}</pre></section>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs font-semibold leading-relaxed text-amber-800"><b>Important:</b> Agent ID is available after saving an agent, Campaign ID is available from Campaigns, and the assigned outbound number is available from Phone Numbers. The future public task endpoint must require API authentication, tenant validation, consent controls and idempotency—it must not use unauthenticated production requests.</div>
    </>}
  </div>;
}
