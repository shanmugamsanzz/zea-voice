import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, Check, Copy, Key, LoaderCircle, LockKeyhole, Plus, RefreshCw,
  RotateCw, ShieldCheck, Trash2, X,
} from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

interface ApiKeyRecord {
  id: string; name: string; keyPrefix: string; scopeType: 'company'; tenantId: string;
  workspaceId: string; scopes: string[]; expiresAt: string | null; lastUsedAt: string | null;
  lastUsedIp: string | null; revokedAt: string | null; revokeReason: string | null; createdAt: string;
  key?: string;
}
interface WorkspaceIdentity {
  tenant: { id: string; name: string };
  organization: { id: string; name: string };
  workspace: { id: string; name: string };
}

const availableScopes = [
  ['calls:create', 'Create outbound call tasks'], ['calls:read', 'Read company call records'],
  ['agents:read', 'Read company agents'], ['campaigns:read', 'Read company campaigns'],
  ['phone_numbers:read', 'Read assigned company numbers'], ['reports:read', 'Read company reports'],
] as const;

function formatDate(value: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString('en-IN');
}

export function DeveloperApiKeysView() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [identity, setIdentity] = useState<WorkspaceIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('n8n outbound calls');
  const [expiresAt, setExpiresAt] = useState('');
  const [scopes, setScopes] = useState<string[]>(['calls:create']);
  const [revealed, setRevealed] = useState<ApiKeyRecord | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    Promise.all([
      apiRequest<ApiKeyRecord[]>('/api-keys', { signal: controller.signal, zeaCache: 'reload' }),
      apiRequest<WorkspaceIdentity>('/settings', { signal: controller.signal, zeaCache: 'reload' }),
    ]).then(([records, workspace]) => { setKeys(records); setIdentity(workspace); })
      .catch((requestError) => {
        if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'API keys could not be loaded');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshKey]);

  const toggleScope = (scope: string) => setScopes((current) => current.includes(scope)
    ? current.filter((item) => item !== scope) : [...current, scope]);

  const createKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !scopes.length) return;
    setSubmitting(true); setError('');
    try {
      const created = await apiRequest<ApiKeyRecord>('/api-keys', {
        method: 'POST', body: JSON.stringify({
          name: name.trim(), scopes,
          ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        }),
      });
      const { key: _plaintextKey, ...safeRecord } = created;
      setKeys((current) => [safeRecord, ...current]);
      setCreateOpen(false); setRevealed(created); setName('n8n outbound calls');
      setScopes(['calls:create']); setExpiresAt('');
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'API key could not be created'); }
    finally { setSubmitting(false); }
  };

  const revoke = async (record: ApiKeyRecord) => {
    if (!window.confirm(`Revoke “${record.name}”? Any integration using it will immediately stop working.`)) return;
    setError('');
    try {
      const updated = await apiRequest<ApiKeyRecord>(`/api-keys/${record.id}/revoke`, {
        method: 'POST', body: JSON.stringify({ reason: 'Revoked by company developer' }),
      });
      setKeys((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'API key could not be revoked'); }
  };

  const rotate = async (record: ApiKeyRecord) => {
    if (!window.confirm(`Rotate “${record.name}”? The existing key will stop working immediately.`)) return;
    setError('');
    try {
      const replacement = await apiRequest<ApiKeyRecord>(`/api-keys/${record.id}/rotate`, { method: 'POST', body: '{}' });
      const { key: _plaintextKey, ...safeReplacement } = replacement;
      setKeys((current) => [safeReplacement, ...current.map((item) => item.id === record.id
        ? { ...item, revokedAt: new Date().toISOString(), revokeReason: 'Rotated to replacement key' } : item)]);
      setRevealed(replacement);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'API key could not be rotated'); }
  };

  const copySecret = async () => {
    if (!revealed?.key) return;
    await navigator.clipboard.writeText(revealed.key); setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  if (loading && !identity) return <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-slate-200 bg-white"><div className="text-center"><LoaderCircle className="mx-auto h-8 w-8 animate-spin text-violet-500" /><p className="mt-3 text-xs font-bold text-slate-400">Loading tenant API keys…</p></div></div>;

  return <div className="space-y-6">
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><div className="rounded-xl bg-violet-50 p-3 text-violet-600"><Key className="h-5 w-5" /></div><div><h2 className="text-xl font-black text-slate-800">API Keys</h2><p className="mt-1 text-xs font-semibold text-slate-500">Create tenant-bound credentials for n8n and approved integrations.</p></div></div><div className="flex gap-2"><button onClick={() => setRefreshKey((value) => value + 1)} disabled={loading} className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-500 disabled:opacity-50" title="Refresh"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button><button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-black text-white"><Plus className="h-4 w-4" />Create API Key</button></div></div>

    {error && <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-700"><span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{error}</span><button onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}

    {identity && <div className="grid gap-3 rounded-2xl border border-violet-200 bg-violet-50 p-5 text-xs sm:grid-cols-3"><div><p className="text-[9px] font-black uppercase text-violet-500">Organization</p><p className="mt-1 font-black text-violet-900">{identity.organization.name}</p><p className="mt-1 break-all font-mono text-[9px] text-violet-600">{identity.organization.id}</p></div><div><p className="text-[9px] font-black uppercase text-violet-500">Bound Tenant</p><p className="mt-1 font-black text-violet-900">{identity.tenant.name}</p><p className="mt-1 break-all font-mono text-[9px] text-violet-600">{identity.tenant.id}</p></div><div><p className="text-[9px] font-black uppercase text-violet-500">Bound Workspace</p><p className="mt-1 font-black text-violet-900">{identity.workspace.name}</p><p className="mt-1 break-all font-mono text-[9px] text-violet-600">{identity.workspace.id}</p></div></div>}

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left"><thead className="border-b border-slate-200 bg-slate-50 text-[9px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-4">Name</th><th className="px-5 py-4">Key Prefix</th><th className="px-5 py-4">Scopes</th><th className="px-5 py-4">Created</th><th className="px-5 py-4">Last Used</th><th className="px-5 py-4">Status</th><th className="px-5 py-4 text-right">Actions</th></tr></thead><tbody className="divide-y divide-slate-100 text-xs">{keys.length ? keys.map((record) => { const active = !record.revokedAt && (!record.expiresAt || new Date(record.expiresAt) > new Date()); return <tr key={record.id} className="hover:bg-slate-50"><td className="px-5 py-4"><p className="font-black text-slate-700">{record.name}</p><p className="mt-1 font-mono text-[9px] text-slate-400">{record.id}</p></td><td className="px-5 py-4 font-mono font-bold text-violet-600">{record.keyPrefix}••••••••</td><td className="px-5 py-4"><div className="flex max-w-xs flex-wrap gap-1">{record.scopes.map((scope) => <span key={scope} className="rounded-md bg-slate-100 px-2 py-1 text-[9px] font-black text-slate-600">{scope}</span>)}</div></td><td className="px-5 py-4 font-semibold text-slate-500">{formatDate(record.createdAt)}</td><td className="px-5 py-4 font-semibold text-slate-500">{formatDate(record.lastUsedAt)}</td><td className="px-5 py-4"><span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${active ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{active ? 'Active' : 'Revoked / Expired'}</span></td><td className="px-5 py-4"><div className="flex justify-end gap-2">{active && <><button onClick={() => void rotate(record)} title="Rotate key" className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:text-violet-600"><RotateCw className="h-4 w-4" /></button><button onClick={() => void revoke(record)} title="Revoke key" className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:border-rose-200 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button></>}</div></td></tr>; }) : <tr><td colSpan={7} className="py-14 text-center"><Key className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 text-xs font-bold text-slate-500">No company API keys have been created.</p></td></tr>}</tbody></table></div></div>

    <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold leading-relaxed text-emerald-800"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /><span>Every key created here is permanently bound to the company tenant and active workspace shown above. Supplying another company’s tenant or workspace headers is rejected. Resource endpoints also query agents, campaigns, numbers and calls under this tenant context.</span></div>

    {createOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"><form onSubmit={createKey} className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><h3 className="text-lg font-black text-slate-800">Create Company API Key</h3><p className="mt-1 text-xs font-semibold text-slate-400">Use the smallest set of permissions required.</p></div><button type="button" onClick={() => setCreateOpen(false)}><X className="h-5 w-5 text-slate-400" /></button></div><div className="mt-6 space-y-5"><label className="block text-xs font-black text-slate-600">Key Name<input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold outline-none focus:border-violet-400" /></label><div><p className="text-xs font-black text-slate-600">Permissions</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{availableScopes.map(([scope, description]) => <label key={scope} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 ${scopes.includes(scope) ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white'}`}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} className="mt-0.5" /><span><b className="block font-mono text-[10px] text-slate-700">{scope}</b><span className="mt-1 block text-[9px] font-semibold text-slate-400">{description}</span></span></label>)}</div>{!scopes.length && <p className="mt-2 text-[10px] font-bold text-rose-600">Select at least one permission.</p>}</div><label className="block text-xs font-black text-slate-600">Expiry (optional)<input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold outline-none focus:border-violet-400" /></label></div><div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-5"><button type="button" onClick={() => setCreateOpen(false)} className="rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-600">Cancel</button><button type="submit" disabled={submitting || !name.trim() || !scopes.length} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-black text-white disabled:opacity-50"><LockKeyhole className="h-4 w-4" />{submitting ? 'Creating…' : 'Create Key'}</button></div></form></div>}

    {revealed?.key && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"><div className="w-full max-w-2xl rounded-2xl border border-amber-200 bg-white p-6 shadow-2xl"><div className="flex items-start gap-3"><div className="rounded-xl bg-amber-100 p-3 text-amber-700"><AlertTriangle className="h-5 w-5" /></div><div><h3 className="text-lg font-black text-slate-800">Copy your API key now</h3><p className="mt-1 text-xs font-semibold text-amber-700">This plaintext key is shown only once. Zea Voice stores only its cryptographic hash.</p></div></div><div className="mt-5 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-950 p-3"><code className="min-w-0 flex-1 break-all text-xs font-bold text-emerald-300">{revealed.key}</code><button onClick={() => void copySecret()} className="shrink-0 rounded-lg bg-white p-2.5 text-slate-700">{copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}</button></div><div className="mt-5 flex justify-end"><button onClick={() => { setRevealed(null); setCopied(false); }} className="rounded-xl bg-slate-900 px-5 py-2.5 text-xs font-black text-white">I saved this key</button></div></div></div>}
  </div>;
}
