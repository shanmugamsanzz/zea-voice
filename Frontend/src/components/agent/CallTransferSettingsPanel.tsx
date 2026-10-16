import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest, isAbortError } from '../../lib/api';

interface Settings {
  enabled: boolean;
  credentialSource: 'saved_account' | 'manual';
  telephonyAccountId: string | null;
  authId: string;
  hasAuthToken?: boolean;
  destinationNumber: string;
  mode: 'direct_handoff' | 'wait_and_return';
  ringTimeoutSeconds: number;
  callbackToolId?: string | null;
}
interface Payload {
  settings: Settings | null;
  accounts: { id: string; name: string; authId: string }[];
  runtimeAvailable: boolean;
  callbackTools: { id: string; name: string }[];
}
const emptySettings = (): Settings => ({ enabled: false, credentialSource: 'saved_account',
  telephonyAccountId: null, authId: '', destinationNumber: '',
  mode: 'wait_and_return', ringTimeoutSeconds: 25 });
const inputClass = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900';

export function CallTransferSettingsPanel({ agentId }: { agentId: string }) {
  const formId = `agent-call-transfer-${agentId}`;
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [accounts, setAccounts] = useState<Payload['accounts']>([]);
  const [runtimeAvailable, setRuntimeAvailable] = useState(false);
  const [callbackTools, setCallbackTools] = useState<Payload['callbackTools']>([]);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setToken(''); setSaved(null); setSettings(emptySettings());
    apiRequest<Payload>(`/agents/${agentId}/call-transfer-settings`, { signal: controller.signal, zeaCache: 'reload' })
      .then((value) => {
        if (controller.signal.aborted) return;
        setAccounts(value.accounts); setSaved(value.settings);
        setRuntimeAvailable(value.runtimeAvailable);
        setCallbackTools(value.callbackTools ?? []);
        setSettings(value.settings ?? emptySettings());
      })
      .catch((reason) => { if (!isAbortError(reason)) setError(reason instanceof Error ? reason.message : 'Unable to load transfer settings'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [agentId, revision]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value })); setNotice('');
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); event.stopPropagation(); setError(''); setNotice(''); setSaving(true);
    try {
      const body = { enabled: settings.enabled, credentialSource: settings.credentialSource,
        callbackToolId: settings.callbackToolId ?? null,
        destinationNumber: settings.destinationNumber, mode: settings.mode,
        ringTimeoutSeconds: Number(settings.ringTimeoutSeconds),
        ...(settings.credentialSource === 'saved_account'
          ? { telephonyAccountId: settings.telephonyAccountId }
          : { authId: settings.authId, ...(token ? { authToken: token } : {}) }) };
      const result = await apiRequest<{ settings: Settings; runtimeAvailable: boolean }>(`/agents/${agentId}/call-transfer-settings`, {
        method: 'PUT', body: JSON.stringify(body),
      });
      setSaved(result.settings); setSettings(result.settings); setToken('');
      setRuntimeAvailable(result.runtimeAvailable);
      setNotice(result.runtimeAvailable ? 'Transfer settings saved.' : 'Settings saved. Native transfers are not enabled for this agent.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save transfer settings');
    } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!window.confirm('Remove this agent’s transfer settings and any stored transfer token? Existing webhook tools will stay unchanged.')) return;
    setSaving(true); setError('');
    try {
      await apiRequest(`/agents/${agentId}/call-transfer-settings`, { method: 'DELETE' });
      setSaved(null); setSettings(emptySettings()); setToken(''); setNotice('Transfer settings removed.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to remove settings'); }
    finally { setSaving(false); }
  };
  const retainedToken = saved?.credentialSource === 'manual' && saved.authId === settings.authId && saved.hasAuthToken;
  return <section className="rounded-2xl border border-slate-200 bg-white p-5">
    {typeof document !== 'undefined' && createPortal(<form id={formId} onSubmit={save} />, document.body)}
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-bold text-slate-900">Built-in Call Transfer</h3>
      <button type="button" disabled={loading || saving} onClick={() => { setNotice(''); setRevision((value) => value + 1); }} className="text-xs font-semibold text-slate-600 disabled:opacity-50">Reload settings</button>
    </div>
    <p className="mt-2 text-xs text-slate-600">Configure a staff destination for this agent only. {runtimeAvailable ? 'Native transfers are available for live telephone calls.' : 'Native transfers are not enabled for this agent; settings can still be saved.'} Existing webhook transfers remain unchanged.</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-emerald-700">{notice}</p>}
    {loading ? <p className="mt-4 text-sm text-slate-500">Loading transfer settings…</p> : <div className="mt-4 space-y-4">
      <fieldset disabled={saving || Boolean(error && !accounts.length)} className="space-y-4 disabled:opacity-60">
        <label className="flex items-center gap-2 text-sm font-semibold"><input form={formId} type="checkbox" className="accent-slate-900" checked={settings.enabled} onChange={(event) => set('enabled', event.target.checked)} />Enable built-in call transfer</label>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-xs font-semibold text-slate-700">Credentials
            <select form={formId} className={inputClass} value={settings.credentialSource} onChange={(event) => { set('credentialSource', event.target.value as Settings['credentialSource']); setToken(''); }}>
              <option value="saved_account">Use saved company Plivo subaccount</option><option value="manual">Enter subaccount credentials</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-700">Transfer mode
            <select form={formId} className={inputClass} value={settings.mode} onChange={(event) => set('mode', event.target.value as Settings['mode'])}>
              <option value="wait_and_return">Wait and return on failure</option><option value="direct_handoff">Direct handoff</option>
            </select>
          </label>
        </div>
        {settings.credentialSource === 'saved_account' ? <label className="block text-xs font-semibold text-slate-700">Company Plivo subaccount
          <select form={formId} required className={inputClass} value={settings.telephonyAccountId ?? ''} onChange={(event) => set('telephonyAccountId', event.target.value || null)}>
            <option value="">Select subaccount</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} — {account.authId}</option>)}
          </select>
        </label> : <div className="grid gap-4 md:grid-cols-2">
          <label className="text-xs font-semibold text-slate-700">Plivo subaccount Auth ID<input form={formId} required autoComplete="off" className={inputClass} value={settings.authId} onChange={(event) => { set('authId', event.target.value); setToken(''); }} /></label>
          <label className="text-xs font-semibold text-slate-700">Secret Auth Token<input form={formId} type="password" autoComplete="new-password" required={!retainedToken} minLength={16} maxLength={512} className={inputClass} value={token} placeholder={retainedToken ? 'Token stored — leave blank to keep it' : 'Enter Auth Token'} onChange={(event) => setToken(event.target.value)} /></label>
        </div>}
        <p className="text-xs text-slate-500">Only subaccounts registered to this company are allowed. Ask Super Admin to connect a missing account. Manually entered tokens are encrypted and never returned; credentials are not tested against Plivo here.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-xs font-semibold text-slate-700">Approved staff destination<input form={formId} required type="tel" pattern="\+[1-9][0-9]{6,14}" placeholder="+919876543210" className={inputClass} value={settings.destinationNumber} onChange={(event) => set('destinationNumber', event.target.value)} /></label>
          <label className="text-xs font-semibold text-slate-700">Staff ring timeout (seconds)<input form={formId} required type="number" min={10} max={120} step={1} className={inputClass} value={Number.isFinite(settings.ringTimeoutSeconds) ? settings.ringTimeoutSeconds : ''} onChange={(event) => set('ringTimeoutSeconds', event.target.value === '' ? Number.NaN : Number(event.target.value))} /></label>
        </div>
        <p className="text-xs text-slate-500">Ring timeout is how long staff can ring. Wait-and-return resumes the agent if staff cannot answer. Direct handoff plays a short failure message and ends the call if staff cannot answer. A failed transfer does not schedule a callback.</p>
        <label className="block text-xs font-semibold text-slate-700">Staff callback action after failed transfer (optional)
          <select form={formId} className={inputClass} value={settings.callbackToolId ?? ''} onChange={(event) => set('callbackToolId', event.target.value || null)}>
            <option value="">No callback action</option>{callbackTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
          </select>
        </label>
        <p className="text-xs text-slate-500">Choose an active webhook assigned to this agent. Caller agreement is required. The action must return success: true, saved: true and a real requestId before the agent can promise a callback. Notification requires notified: true separately. Direct handoff ends on failure and does not run this action.</p>
        <div className="flex gap-3"><button form={formId} type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">{saving ? 'Saving…' : 'Save transfer settings'}</button>{saved && <button type="button" onClick={remove} className="rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-700">Remove settings</button>}</div>
      </fieldset>
    </div>}
  </section>;
}
