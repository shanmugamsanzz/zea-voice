import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Clock3,
  Globe2,
  Info,
  Lock,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';

type CompliancePolicy = 'standard_hipaa_pci' | 'strict_gdpr' | 'relaxed_developer';
type SipRelayRegion = 'us_east' | 'eu_central' | 'apac_south';
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

interface PlatformSettings {
  adminIpAllowlist: string[];
  maxSessionTimeoutSeconds: number;
  compliancePolicy: CompliancePolicy;
  sipRelayRegion: SipRelayRegion;
  updatedBy: string | null;
  updatedAt: string;
}

function SettingsInfoTooltip({ text, label }: { text: string; label: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`About ${label}`}
        className="zea-settings-info-trigger inline-flex h-6 w-6 items-center justify-center rounded-full"
      >
        <Info className="h-4.5 w-4.5" strokeWidth={2.4} aria-hidden="true" />
      </button>
      <span
        role="tooltip"
        className="zea-settings-info-tooltip pointer-events-none absolute left-0 top-full z-[9999] mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border p-3 text-left text-sm font-medium leading-relaxed opacity-0 shadow-2xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
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
    if (!Number.isInteger(timeout) || timeout < 300 || timeout > THIRTY_DAYS_SECONDS) {
      setError(`Session timeout must be an integer from 300 to ${THIRTY_DAYS_SECONDS} seconds.`);
      return;
    }
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
    <div className="zea-settings-page">
      <form onSubmit={saveSettings} className="zea-settings-shell rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-7">
        <header className="zea-settings-header flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-2xl font-black tracking-tight text-slate-900">Platform Settings</h2>
              <span className="group relative inline-flex">
                <button
                  type="button"
                  aria-label="Safety warning"
                  className="zea-settings-alert-trigger inline-flex h-8 w-8 items-center justify-center rounded-lg"
                >
                  <AlertTriangle className="h-5 w-5" strokeWidth={2.3} aria-hidden="true" />
                </button>
                <span
                  role="tooltip"
                  className="zea-settings-alert-tooltip pointer-events-none absolute left-0 top-full z-[9999] mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border p-4 text-left opacity-0 shadow-2xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <strong className="block text-base font-black">Safety Warning</strong>
                  <span className="mt-2 block text-sm font-medium leading-relaxed">
                    Removing your current IP range can immediately block future Super Admin requests.
                  </span>
                  <span className="mt-2 block text-sm font-medium leading-relaxed">
                    Use CIDR notation, one network per line.
                  </span>
                </span>
              </span>
            </div>
            <p className="mt-2 text-sm font-medium text-slate-500">Database-backed access, compliance, session and SIP relay configuration.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void loadSettings(true)}
              disabled={loading || saving}
              className="zea-settings-reload inline-flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
              aria-label="Reload settings"
              title="Reload Settings"
            >
              <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="submit"
              disabled={loading || saving || !settings}
              className="zea-settings-apply inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#dfa822] px-6 py-3 text-sm font-black text-black shadow-md transition hover:bg-[#e8b83f] disabled:opacity-50"
            >
              <ShieldCheck className="h-5 w-5" />
              <span>{saving ? 'Applying...' : 'Apply Configurations'}</span>
            </button>
          </div>
        </header>

        {error && <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div>}
        {success && <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{success}</div>}

        <div className="mt-7 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="zea-settings-card rounded-xl border border-slate-200 p-5">
            <div className="flex items-center gap-4">
              <span className="zea-settings-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
                <Globe2 className="h-6 w-6" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-black text-slate-900">Administrative IP Allowlist</h3>
                  <SettingsInfoTooltip label="Administrative IP Allowlist" text="Enter allowed IP ranges in CIDR notation." />
                </div>
              </div>
            </div>
            <textarea
              required
              rows={1}
              value={allowlist}
              onChange={(event) => setAllowlist(event.target.value)}
              placeholder={'0.0.0.0/0\n::/0'}
              className="mt-5 w-full resize-y rounded-xl border border-slate-200 bg-transparent px-4 py-3 font-mono text-sm text-slate-900 outline-none transition"
            />
          </section>

          <section className="zea-settings-card rounded-xl border border-slate-200 p-5">
            <div className="flex items-center gap-4">
              <span className="zea-settings-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
                <Clock3 className="h-6 w-6" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-black text-slate-900">Maximum Session Timeout</h3>
                  <SettingsInfoTooltip label="Maximum Session Timeout" text="Set the fixed maximum lifetime of a login session from its original sign-in time. Access tokens still renew silently every 15 minutes." />
                </div>
              </div>
            </div>
            <div className="relative mt-5">
              <input
                required
                type="number"
                min="300"
                max={THIRTY_DAYS_SECONDS}
                step="1"
                value={sessionTimeout}
                onChange={(event) => setSessionTimeout(event.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-transparent px-4 py-3 pr-24 text-sm text-slate-900 outline-none transition"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500">seconds</span>
            </div>
            <p className="mt-3 text-xs text-slate-500">Allowed range: 300 seconds to 2,592,000 seconds (30 days).</p>
          </section>

          <section className="zea-settings-card rounded-xl border border-slate-200 p-5">
            <div className="flex items-center gap-4">
              <span className="zea-settings-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
                <Shield className="h-6 w-6" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-black text-slate-900">Compliance Enforcement Policy</h3>
                  <SettingsInfoTooltip label="Compliance Enforcement Policy" text="Controls the platform-wide compliance behavior." />
                </div>
              </div>
            </div>
            <select
              value={compliancePolicy}
              onChange={(event) => setCompliancePolicy(event.target.value as CompliancePolicy)}
              className="mt-5 w-full cursor-pointer rounded-xl border border-slate-200 bg-transparent px-4 py-3 text-sm text-slate-900 outline-none transition"
            >
              <option value="standard_hipaa_pci">Standard HIPAA + PCI</option>
              <option value="strict_gdpr">Strict GDPR</option>
              <option value="relaxed_developer">Relaxed Developer</option>
            </select>
          </section>

          <section className="zea-settings-card rounded-xl border border-slate-200 p-5">
            <div className="flex items-center gap-4">
              <span className="zea-settings-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
                <Server className="h-6 w-6" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-black text-slate-900">SIP Relay Region</h3>
                  <SettingsInfoTooltip label="SIP Relay Region" text="Select the configured platform SIP relay region." />
                </div>
              </div>
            </div>
            <select
              value={sipRelayRegion}
              onChange={(event) => setSipRelayRegion(event.target.value as SipRelayRegion)}
              className="mt-5 w-full cursor-pointer rounded-xl border border-slate-200 bg-transparent px-4 py-3 text-sm text-slate-900 outline-none transition"
            >
              <option value="us_east">US East</option>
              <option value="eu_central">EU Central</option>
              <option value="apac_south">APAC South</option>
            </select>
          </section>
        </div>

        <div className="zea-settings-confirm mt-5 flex items-start gap-4 rounded-xl border border-amber-200 bg-amber-50/50 px-5 py-4">
          <input
            id="confirm-administrative-access-loss"
            type="checkbox"
            checked={confirmAccessLoss}
            onChange={(event) => setConfirmAccessLoss(event.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded"
          />
          <div className="flex items-center gap-2">
            <label htmlFor="confirm-administrative-access-loss" className="cursor-pointer text-sm font-black text-slate-900">
              Confirm possible administrative access loss
            </label>
            <SettingsInfoTooltip
              label="Confirm possible administrative access loss"
              text="Only enable this if the new CIDR list intentionally excludes the IP address currently making this request."
            />
          </div>
        </div>

        <footer className="zea-settings-footer mt-5 flex items-center gap-4 border-t border-slate-200 pt-5">
          <span className="zea-settings-lock flex h-11 w-11 shrink-0 items-center justify-center rounded-full">
            <Lock className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm text-slate-600">Updates require a logged-in Super Admin session and are written to the audit log.</p>
            {settings?.updatedAt && <p className="mt-1 text-sm text-slate-500">Last updated: {new Date(settings.updatedAt).toLocaleString()}.</p>}
          </div>
        </footer>
      </form>
    </div>
  );
}
