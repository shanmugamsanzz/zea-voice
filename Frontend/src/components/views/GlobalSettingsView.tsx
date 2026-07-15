import React, { useEffect, useState } from 'react';
import { AlertTriangle, Lock, Settings } from 'lucide-react';
import { apiRequest } from '../../lib/api';

type CompliancePolicy = 'standard_hipaa_pci' | 'strict_gdpr' | 'relaxed_developer';
type SipRelayRegion = 'us_east' | 'eu_central' | 'apac_south';

interface PlatformSettings {
  adminIpAllowlist: string[];
  maxSessionTimeoutSeconds: number;
  compliancePolicy: CompliancePolicy;
  sipRelayRegion: SipRelayRegion;
  updatedBy: string | null;
  updatedAt: string;
}

export function GlobalSettingsView() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [allowlist, setAllowlist] = useState('');
  const [sessionTimeout, setSessionTimeout] = useState('');
  const [compliancePolicy, setCompliancePolicy] = useState<CompliancePolicy>('standard_hipaa_pci');
  const [sipRelayRegion, setSipRelayRegion] = useState<SipRelayRegion>('us_east');
  const [confirmAccessLoss, setConfirmAccessLoss] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const applySettings = (data: PlatformSettings) => {
    setSettings(data);
    setAllowlist(data.adminIpAllowlist.join('\n'));
    setSessionTimeout(String(data.maxSessionTimeoutSeconds));
    setCompliancePolicy(data.compliancePolicy);
    setSipRelayRegion(data.sipRelayRegion);
    setConfirmAccessLoss(false);
  };

  const loadSettings = async (forceRefresh = false) => {
    setLoading(true); setError('');
    try { applySettings(await apiRequest<PlatformSettings>('/admin/settings', forceRefresh ? { zeaCache: 'reload' } : {})); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Platform settings could not be loaded'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void loadSettings(); }, []);

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    const adminIpAllowlist = allowlist.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    const timeout = Number(sessionTimeout);
    if (adminIpAllowlist.length === 0) { setError('At least one administrative IP CIDR is required.'); return; }
    if (!Number.isInteger(timeout) || timeout < 300 || timeout > 86400) { setError('Session timeout must be an integer from 300 to 86400 seconds.'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      const updated = await apiRequest<PlatformSettings>('/admin/settings', {
        method: 'PUT', body: JSON.stringify({ adminIpAllowlist, maxSessionTimeoutSeconds: timeout,
          compliancePolicy, sipRelayRegion, confirmAccessLoss }),
      });
      applySettings(updated);
      setSuccess('Global platform settings saved and audit-logged successfully.');
      window.setTimeout(() => setSuccess(''), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Platform settings could not be saved');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div><div className="flex items-center gap-2"><Settings className="w-5 h-5 text-indigo-600" /><h2 className="text-xl font-bold text-slate-800 tracking-tight">Platform Settings</h2></div><p className="text-xs text-slate-400 font-medium mt-1">Database-backed access, compliance, session and SIP relay configuration.</p></div>
        <button type="button" onClick={() => void loadSettings(true)} disabled={loading || saving} className="px-4 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer">{loading ? 'Loading...' : 'Reload Settings'}</button>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-semibold">{error}</div>}
      {success && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs font-semibold">{success}</div>}

      <form onSubmit={saveSettings} className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-6">
        <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 p-4"><AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" /><div><p className="text-xs font-bold text-amber-900">Administrative IP allowlist safety</p><p className="text-[10px] text-amber-700 mt-0.5">Removing your current IP range can immediately block future Super Admin requests. Use CIDR notation, one network per line.</p></div></div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-2"><label className="block text-[11px] font-bold text-slate-500 uppercase">Administrative IP Allowlist</label><textarea required rows={5} value={allowlist} onChange={(event) => setAllowlist(event.target.value)} placeholder={'0.0.0.0/0\n::/0'} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono text-xs" /><p className="text-[9px] text-slate-400">Examples: 203.0.113.10/32, 10.0.0.0/8, ::1/128</p></div>
          <div className="space-y-2"><label className="block text-[11px] font-bold text-slate-500 uppercase">Maximum Session Timeout</label><div className="relative"><input required type="number" min="300" max="86400" step="1" value={sessionTimeout} onChange={(event) => setSessionTimeout(event.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 pr-20 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition" /><span className="absolute right-4 top-3 text-xs text-slate-400 font-bold">seconds</span></div><p className="text-[9px] text-slate-400">Allowed range: 300 seconds to 86400 seconds.</p></div>

          <div className="space-y-2"><label className="block text-[11px] font-bold text-slate-500 uppercase">Compliance Enforcement Policy</label><select value={compliancePolicy} onChange={(event) => setCompliancePolicy(event.target.value as CompliancePolicy)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition cursor-pointer text-xs"><option value="standard_hipaa_pci">Standard HIPAA + PCI</option><option value="strict_gdpr">Strict GDPR</option><option value="relaxed_developer">Relaxed Developer</option></select><p className="text-[9px] text-slate-400">Controls the platform-wide compliance behavior stored for runtime enforcement.</p></div>
          <div className="space-y-2"><label className="block text-[11px] font-bold text-slate-500 uppercase">SIP Relay Region</label><select value={sipRelayRegion} onChange={(event) => setSipRelayRegion(event.target.value as SipRelayRegion)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition cursor-pointer text-xs"><option value="us_east">US East</option><option value="eu_central">EU Central</option><option value="apac_south">APAC South</option></select><p className="text-[9px] text-slate-400">Selects the configured platform SIP relay region.</p></div>
        </div>

        <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 cursor-pointer"><input type="checkbox" checked={confirmAccessLoss} onChange={(event) => setConfirmAccessLoss(event.target.checked)} className="mt-0.5" /><span><span className="block text-xs font-bold text-slate-700">Confirm possible administrative access loss</span><span className="block text-[9px] text-slate-400 mt-0.5">Only enable this if the new CIDR list intentionally excludes the IP address currently making this request.</span></span></label>

        <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3"><div className="flex items-center gap-2 text-[9px] text-slate-400"><Lock className="w-3.5 h-3.5" /><span>Updates require a logged-in Super Admin session and are written to the audit log.{settings?.updatedAt ? ` Last updated ${new Date(settings.updatedAt).toLocaleString()}.` : ''}</span></div><button type="submit" disabled={loading || saving || !settings} className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition disabled:opacity-50 cursor-pointer">{saving ? 'Applying...' : 'Apply Configurations'}</button></div>
      </form>
    </div>
  );
}
