/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useAppState } from '../../store/AppState';
import { 
  MOCK_COMPANIES, 
  COMPLETED_CALL_LOGS 
} from '../../lib/mockData';
import { Company, PhoneNumber, Developer } from '../../types';
import { 
  Building2, 
  Users, 
  Cpu, 
  Phone, 
  Coins, 
  Activity, 
  Tv, 
  CreditCard, 
  Settings, 
  Search, 
  TrendingUp, 
  AlertCircle,
  Plus, 
  Check, 
  X, 
  Play, 
  Pause, 
  Eye, 
  Sliders, 
  ArrowRight,
  UserCheck,
  Zap,
  Globe,
  Lock,
  ArrowDownToLine,
  ArrowUpFromLine,
  Trash2
} from 'lucide-react';
import { CallVolumeChart, OutcomePieChart } from '../charts/DashboardCharts';
import { CreditsManagerView } from './CreditsManagerView';
import { QueueMonitorView } from './QueueMonitorView';
import { CallMonitoringView } from './CallMonitoringView';
import { PaymentsView } from './PaymentsView';
import { GlobalSettingsView } from './GlobalSettingsView';
import { apiRequest, isAbortError } from '../../lib/api';

interface PlatformDashboardData {
  overview: {
    activeCompanies: number; pendingCompanies: number; inFlightCalls: number;
    waitingCalls: number; callsToday: number; monthlyRevenue: number; currency: string;
  };
  callTraffic: Array<{ name: string; hour: string; inbound: number; outbound: number }>;
  outcomes: Array<{ name: string; value: number; color: string }>;
  topCompanies: Array<{ id: string; name: string; billingTier: string; monthlySpend: number; creditsBalance: number }>;
  liveCalls: Array<{ id: string; companyName: string; agentName: string; status: string; duration: number; phone: string; startedAt: string; latestTranscript: string | null }>;
}

interface CompanyApiData {
  tenantId: string; organizationId: string; workspaceId: string; businessName: string;
  legalName: string | null; firstName: string | null; lastName: string | null; email: string;
  businessPhone: string | null; website: string | null; billingTier: 'starter' | 'pro' | 'enterprise';
  perMinutePrice: number;
  addressLine1: string | null; addressLine2: string | null; state: string | null; country: string | null;
  postalCode: string | null; timezone: string; status: 'pending' | 'active' | 'suspended' | 'archived';
  teamSize: number; phoneNumbersCount: number; creditsBalance: number; monthlySpend: number; createdAt: string;
}

interface CompanyOption { tenantId: string; businessName: string }
interface PaginationData { page: number; pageSize: number; total: number; totalPages: number }

interface TenantUserApiData {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  companyId: string;
  companyName: string;
  workspaceId: string;
  role: 'COMPANY_DEVELOPER' | 'COMPANY_USER';
  status: 'active' | 'invited' | 'suspended';
  lastActiveAt: string | null;
  createdAt: string;
}

interface ProviderApiData {
  id: string;
  name: string;
  slug: string;
  type: 'llm' | 'tts' | 'stt';
  status: 'connected' | 'disconnected' | 'error';
  baseUrl: string | null;
  latencyMs: number | null;
  usageCount: number;
  parameterKeys: Array<{ key: string; value: string; isSecret: boolean }>;
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ProviderModelApiData {
  id: string; providerId: string; providerName: string; providerType: 'llm' | 'tts' | 'stt';
  modelKey: string; displayName: string; status: 'active' | 'inactive';
  capabilities: Record<string, unknown>; settings: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}

interface TelephonyAccountApiData {
  id: string; provider: 'plivo'; name: string; authId: string; authToken: string;
  baseUrl: string; applicationId: string; answerUrl: string; hangupUrl: string;
  recordingCallbackUrl: string; status: 'connected' | 'disconnected' | 'error';
  accountType: 'main' | 'subaccount'; parentAccountId: string | null;
  companyId: string | null; providerSubaccountId: string | null;
  lastSyncedAt: string | null; syncError: string | null; createdAt: string;
}

interface CompanySubaccountApiData extends TelephonyAccountApiData {
  companyName: string; parentAccountName: string; phoneNumbersCount: number;
}

interface PhoneNumberApiData {
  id: string; number: string; provider: string; telephonyAccountId: string;
  telephonyAccountName: string; accountType: 'main' | 'subaccount'; subaccountAuthId: string | null;
  countryIso: string | null; numberType: string | null; capabilities: { voice?: boolean; sms?: boolean };
  monthlyCost: number | null; currency: string; status: 'active' | 'unavailable' | 'released';
  companyId: string | null; companyName: string | null; assignedAt: string | null;
}

function providerValuePreview(value: string) {
  return value.length > 10 ? `${value.slice(0, 10)}..........` : value;
}

const COMPANY_COUNTRIES = [
  'India', 'Sri Lanka', 'Bangladesh', 'Nepal', 'Bhutan',
  'Pakistan', 'United Arab Emirates', 'Singapore', 'Malaysia', 'Indonesia',
];

const COMPANY_TIMEZONES = [
  { value: 'Asia/Dubai', label: 'GMT+04:00 Asia/Dubai (+04)' },
  { value: 'Asia/Karachi', label: 'GMT+05:00 Asia/Karachi (PKT)' },
  { value: 'Asia/Kolkata', label: 'GMT+05:30 Asia/Kolkata (IST)' },
  { value: 'Asia/Colombo', label: 'GMT+05:30 Asia/Colombo (+0530)' },
  { value: 'Asia/Kathmandu', label: 'GMT+05:45 Asia/Kathmandu (+0545)' },
  { value: 'Asia/Dhaka', label: 'GMT+06:00 Asia/Dhaka (+06)' },
  { value: 'Asia/Thimphu', label: 'GMT+06:00 Asia/Thimphu (+06)' },
  { value: 'Asia/Yangon', label: 'GMT+06:30 Asia/Yangon (+0630)' },
  { value: 'Asia/Bangkok', label: 'GMT+07:00 Asia/Bangkok (+07)' },
  { value: 'Asia/Singapore', label: 'GMT+08:00 Asia/Singapore (+08)' },
];

function companyFromApi(value: CompanyApiData): Company {
  const billingTier = `${value.billingTier[0].toUpperCase()}${value.billingTier.slice(1)}` as Company['billingTier'];
  return {
    id: value.tenantId, name: value.businessName, status: value.status, billingTier,
    createdAt: new Date(value.createdAt).toLocaleDateString(), developersCount: value.teamSize,
    creditsBalance: value.creditsBalance, phoneNumbersCount: value.phoneNumbersCount,
    perMinutePrice: value.perMinutePrice,
    monthlySpend: value.monthlySpend,
    primaryContact: [value.firstName, value.lastName].filter(Boolean).join(' ') + ` (${value.email})`,
    firstName: value.firstName ?? undefined, lastName: value.lastName ?? undefined, email: value.email,
    businessPhone: value.businessPhone ?? undefined,
    address: value.addressLine1 ?? undefined, state: value.state ?? undefined, country: value.country ?? undefined,
    zip: value.postalCode ?? undefined, website: value.website ?? undefined, timezone: value.timezone,
  };
}

export function SuperAdminViews() {
  const { view, setView, selectedCompanyId, setSelectedCompanyId } = useAppState();

  // Route to sub-screens based on selected menu
  switch (view) {
    case 'dashboard':
      return <SuperAdminDashboard />;
    case 'companies':
      if (selectedCompanyId) {
        return <CompanyDetailView companyId={selectedCompanyId} onBack={() => setSelectedCompanyId(null)} />;
      }
      return <CompaniesListView />;
    case 'developers':
      return <UsersListView />;
    case 'providers':
      return <VoiceProvidersView />;
    case 'phone-numbers':
      return <PhoneNumbersView />;
    case 'credits':
      return <CreditsManagerView />;
    case 'queue-monitor':
      return <QueueMonitorView />;
    case 'call-monitoring':
      return <CallMonitoringView />;
    case 'payments':
      return <PaymentsView />;
    case 'settings':
      return <GlobalSettingsView />;
    default:
      return <SuperAdminDashboard />;
  }
}

/* ==========================================
   1. SUPER ADMIN DASHBOARD
   ========================================== */
function SuperAdminDashboard() {
  const { setView, setSelectedCompanyId } = useAppState();
  const [dashboard, setDashboard] = useState<PlatformDashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    apiRequest<PlatformDashboardData>('/admin/dashboard')
      .then((data) => { if (active) setDashboard(data); })
      .catch((requestError) => { if (active) setError(requestError instanceof Error ? requestError.message : 'Dashboard could not be loaded'); });
    return () => { active = false; };
  }, []);

  if (error) return <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm font-semibold text-red-700">Unable to load the Super Admin dashboard: {error}</div>;
  if (!dashboard) return (
    <div className="space-y-6" aria-label="Loading live platform data">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {[1, 2, 3, 4].map((item) => <div key={item} className="h-32 animate-pulse rounded-xl border border-slate-200 bg-white p-6"><div className="h-3 w-28 rounded bg-slate-200" /><div className="mt-5 h-7 w-36 rounded bg-slate-200" /></div>)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 h-80 animate-pulse rounded-xl border border-slate-200 bg-white p-6"><div className="h-4 w-44 rounded bg-slate-200" /><div className="mt-8 h-56 rounded bg-slate-100" /></div>
        <div className="h-80 animate-pulse rounded-xl border border-slate-200 bg-white p-6"><div className="h-4 w-36 rounded bg-slate-200" /><div className="mx-auto mt-10 h-44 w-44 rounded-full bg-slate-100" /></div>
      </div>
    </div>
  );
  const { overview, callTraffic, outcomes, topCompanies, liveCalls } = dashboard;
  
  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Active Organizations</span>
          <div className="flex items-center justify-between mt-2">
            <h4 className="text-2xl font-extrabold text-slate-800">{overview.activeCompanies} Companies</h4>
            <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
              <Building2 className="w-4.5 h-4.5" />
            </div>
          </div>
          <span className="text-xs text-slate-500 mt-2 block font-medium">{overview.pendingCompanies} pending registrations</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">In-Flight Calls</span>
          <div className="flex items-center justify-between mt-2">
            <h4 className="text-2xl font-extrabold text-slate-800">{overview.inFlightCalls} Concurrent</h4>
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100 animate-pulse">
              <Activity className="w-4.5 h-4.5" />
            </div>
          </div>
          <span className="text-xs text-slate-500 mt-2 block font-medium">{overview.waitingCalls} waiting in queues</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Calls Today</span>
          <div className="flex items-center justify-between mt-2">
            <h4 className="text-2xl font-extrabold text-slate-800">{overview.callsToday.toLocaleString()}</h4>
            <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
              <Zap className="w-4.5 h-4.5" />
            </div>
          </div>
          <span className="text-xs text-slate-500 mt-2 block font-medium">Across all organizations</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Platform Revenue (MRR)</span>
          <div className="flex items-center justify-between mt-2">
            <h4 className="text-2xl font-extrabold text-slate-800">₹{overview.monthlyRevenue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</h4>
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100">
              <Coins className="w-4.5 h-4.5" />
            </div>
          </div>
          <span className="text-xs text-slate-500 font-bold mt-2 block">Successful subscriptions this month</span>
        </div>
      </div>

      {/* Main Stats Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-800 tracking-tight">Global Call Traffic Volumes</h3>
            <span className="text-xs font-semibold text-slate-400">Past 12 Hours</span>
          </div>
          <CallVolumeChart data={callTraffic} />
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-800 tracking-tight">Voice Output Disposition</h3>
            <span className="text-xs font-semibold text-slate-400">All Tenants</span>
          </div>
          <OutcomePieChart data={outcomes} />
        </div>
      </div>

      {/* Dual Table Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Active Companies List */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-800 tracking-tight">Top Tenants (By Spend)</h3>
            <button onClick={() => setView('companies')} className="text-xs font-bold text-indigo-600 hover:text-indigo-700 flex items-center space-x-1 cursor-pointer">
              <span>View All</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400 font-bold">
                  <th className="pb-2">Company</th>
                  <th className="pb-2">Tier</th>
                  <th className="pb-2 text-right">Spend</th>
                  <th className="pb-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-semibold">
                {topCompanies.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/50 cursor-pointer" onClick={() => { setSelectedCompanyId(c.id); setView('companies'); }}>
                    <td className="py-2.5 font-bold text-slate-800">{c.name}</td>
                    <td className="py-2.5">
                      <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-bold border border-slate-200">{c.billingTier}</span>
                    </td>
                    <td className="py-2.5 text-right font-semibold">₹{c.monthlySpend.toLocaleString()}</td>
                    <td className="py-2.5 text-right font-mono text-indigo-600 font-bold">₹{c.creditsBalance.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live Active Intercepts */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
              </span>
              <h3 className="font-bold text-slate-800 tracking-tight">Live Active Transcripts</h3>
            </div>
            <button onClick={() => setView('call-monitoring')} className="text-xs font-bold text-indigo-600 hover:text-indigo-700 flex items-center space-x-1 cursor-pointer">
              <span>Intercept Panel</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="space-y-3">
            {liveCalls.map((call) => (
              <div key={call.id} className="border border-slate-200 rounded-xl p-4 bg-slate-50/30 hover:bg-slate-50 transition duration-200 cursor-pointer" onClick={() => setView('call-monitoring')}>
                <div className="flex justify-between items-start text-[11px]">
                  <div>
                    <span className="font-bold text-slate-800 block">{call.companyName}</span>
                    <span className="text-slate-400 font-semibold">Agent: {call.agentName}</span>
                  </div>
                  <span className="bg-emerald-50 text-emerald-700 border border-emerald-100 text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase">
                    {call.status} · {call.duration}s
                  </span>
                </div>
                {call.latestTranscript && (
                  <div className="mt-2 text-[11px] bg-white border border-slate-250 rounded-lg p-2.5 text-slate-500 italic font-medium truncate">
                    "{call.latestTranscript}"
                  </div>
                )}
              </div>
            ))}
            {liveCalls.length === 0 && <p className="py-8 text-center text-xs font-semibold text-slate-400">No active calls right now.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==========================================
   2. COMPANIES LIST VIEW
   ========================================== */
function CompaniesListView() {
  const { setSelectedCompanyId } = useAppState();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [search, setSearch] = useState('');
  const [filterTier, setFilterTier] = useState('All');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationData>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [editingCompany, setEditingCompany] = useState<CompanyApiData | null>(null);

  // Modal & Form States (pre-filled with the user's requested data for instant confirmation/creation)
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [businessPhone, setBusinessPhone] = useState('');
  const [address, setAddress] = useState('');
  const [state, setState] = useState('');
  const [country, setCountry] = useState('India');
  const [zip, setZip] = useState('');
  const [website, setWebsite] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [billingTier, setBillingTier] = useState<'starter' | 'pro' | 'enterprise'>('starter');
  const [perMinutePrice, setPerMinutePrice] = useState('');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search.trim()) params.set('search', search.trim());
      if (filterTier !== 'All') params.set('billingTier', filterTier.toLowerCase());
      setLoading(true); setError('');
      apiRequest<{ items: CompanyApiData[]; pagination: PaginationData }>(`/admin/companies?${params}`, { signal: controller.signal })
        .then((result) => { setCompanies(result.items.map(companyFromApi)); setPagination(result.pagination); })
        .catch((requestError) => { if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Companies could not be loaded'); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [search, filterTier, refreshKey, page]);

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName || !email) return;
    setSubmitting(true); setError('');
    try {
      await apiRequest<CompanyApiData>('/admin/companies', { method: 'POST', body: JSON.stringify({
        businessName, legalName: businessName, firstName, lastName, email, businessPhone,
        website, billingTier, perMinutePrice: Number(perMinutePrice), addressLine1: address, state, country, postalCode: zip,
        timezone, workspaceName: `${businessName} Workspace`, status: 'active', locale: 'en-US', currency: 'INR',
      }) });
      setSuccessMessage(`Organization "${businessName}" successfully created.`);
      setRefreshKey((value) => value + 1);
      window.setTimeout(() => { setSuccessMessage(null); setIsModalOpen(false); }, 1200);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Company could not be created');
    } finally { setSubmitting(false); }
  };

  const handleDeleteCompany = async (company: Company) => {
    if (!window.confirm(`Delete "${company.name}"? All company logins will be revoked and active campaigns will stop.`)) return;
    setError('');
    try {
      await apiRequest(`/admin/companies/${company.id}`, { method: 'DELETE' });
      setCompanies((current) => current.filter((item) => item.id !== company.id));
      setRefreshKey((value) => value + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Company could not be deleted');
    }
  };

  const openCompanyEditor = async (companyId: string) => {
    setError('');
    try {
      setEditingCompany(await apiRequest<CompanyApiData>(`/admin/companies/${companyId}`));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Company could not be loaded for editing');
    }
  };

  const handleUpdateCompany = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingCompany) return;
    setSubmitting(true); setError('');
    try {
      await apiRequest(`/admin/companies/${editingCompany.tenantId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          businessName: editingCompany.businessName, legalName: editingCompany.legalName,
          firstName: editingCompany.firstName, lastName: editingCompany.lastName,
          email: editingCompany.email, businessPhone: editingCompany.businessPhone,
          website: editingCompany.website, billingTier: editingCompany.billingTier,
          perMinutePrice: Number(editingCompany.perMinutePrice),
          addressLine1: editingCompany.addressLine1, addressLine2: editingCompany.addressLine2,
          state: editingCompany.state, country: editingCompany.country,
          postalCode: editingCompany.postalCode, timezone: editingCompany.timezone,
        }),
      });
      setEditingCompany(null);
      setRefreshKey((value) => value + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Company could not be updated');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm relative">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-200 pb-5 mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">Organization Accounts</h2>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Manage clients, billing subscriptions, and manual credit ceilings.</p>
        </div>
        <div className="flex flex-wrap gap-2 w-full md:w-auto items-center">
          <button
            onClick={() => setIsModalOpen(true)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-3.5 py-2 text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer shadow-sm shadow-indigo-100"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create Company</span>
          </button>
          <div className="relative flex-1 md:flex-none">
            <input
              type="text"
              placeholder="Search companies..."
              value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 outline-none w-full md:w-56 focus:bg-white focus:border-indigo-500 transition"
            />
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
          </div>
          <select
            value={filterTier}
            onChange={(e) => { setFilterTier(e.target.value); setPage(1); }}
            className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold text-slate-700 outline-none cursor-pointer"
          >
            <option value="All">All Tiers</option>
            <option value="Enterprise">Enterprise</option>
            <option value="Pro">Pro</option>
            <option value="Starter">Starter</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">{error}</div>}
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[10px] pb-3">
              <th className="pb-3">Company Name</th>
              <th className="pb-3">Status</th>
              <th className="pb-3">Billing Sub</th>
              <th className="pb-3 text-right">Team size</th>
              <th className="pb-3 text-right">DID Lines</th>
              <th className="pb-3 text-right">Balance</th>
              <th className="pb-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-semibold">
            {loading && (
              <tr><td colSpan={7} className="py-10 text-center text-xs font-semibold text-slate-400">Loading companies...</td></tr>
            )}
            {companies.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50/50 group">
                <td className="py-3.5 font-bold text-slate-800">
                  <button onClick={() => setSelectedCompanyId(c.id)} className="text-left hover:text-indigo-600 transition cursor-pointer">
                    {c.name}
                  </button>
                  <span className="block text-[10px] text-slate-400 font-mono mt-0.5">Created: {c.createdAt}</span>
                </td>
                <td className="py-3.5">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                    c.status === 'active' ? 'bg-emerald-50 text-emerald-700' :
                    c.status === 'suspended' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
                  }`}>
                    {c.status}
                  </span>
                </td>
                <td className="py-3.5">
                  <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-md font-bold text-[10px] uppercase border border-indigo-100">
                    {c.billingTier}
                  </span>
                </td>
                <td className="py-3.5 text-right font-semibold">{c.developersCount} users</td>
                <td className="py-3.5 text-right font-semibold">{c.phoneNumbersCount} numbers</td>
                <td className="py-3.5 text-right font-mono font-bold text-indigo-600">₹{c.creditsBalance.toLocaleString()}</td>
                <td className="py-3.5 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => setSelectedCompanyId(c.id)}
                      className="px-3 py-1.5 bg-slate-50 group-hover:bg-indigo-50 text-slate-600 group-hover:text-indigo-600 rounded-lg font-bold transition flex items-center space-x-1 cursor-pointer"
                    >
                      <span>Inspect</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                    <button onClick={() => openCompanyEditor(c.id)}
                      className="px-2.5 py-1.5 rounded-lg border border-indigo-100 bg-indigo-50 text-[10px] font-bold text-indigo-700 hover:bg-indigo-100 cursor-pointer">
                      Edit
                    </button>
                    <button onClick={() => handleDeleteCompany(c)} title="Delete company"
                      className="p-1.5 rounded-lg border border-red-100 bg-red-50 text-red-600 hover:bg-red-100 transition cursor-pointer">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && companies.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-xs font-semibold text-slate-400">No companies found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-[10px] font-bold text-slate-500">
        <span>{pagination.total.toLocaleString()} companies</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40">Previous</button>
          <span>Page {pagination.page} of {Math.max(1, pagination.totalPages)}</span>
          <button type="button" disabled={loading || page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)} className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40">Next</button>
        </div>
      </div>

      {editingCompany && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <form onSubmit={handleUpdateCompany} className="w-full max-w-2xl max-h-[90vh] overflow-y-auto space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-100 pb-3">
              <div><h3 className="text-sm font-black text-slate-800">Edit Company</h3><p className="text-[10px] text-slate-400">Update tenant business and billing information.</p></div>
              <button type="button" onClick={() => setEditingCompany(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 text-xs">
              <label className="font-bold text-slate-500">Business Name<input required value={editingCompany.businessName} onChange={(e) => setEditingCompany({ ...editingCompany, businessName: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Legal Name<input value={editingCompany.legalName ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, legalName: e.target.value || null })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">First Name<input required value={editingCompany.firstName ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, firstName: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Last Name<input required value={editingCompany.lastName ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, lastName: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Primary Email<input type="email" required value={editingCompany.email} onChange={(e) => setEditingCompany({ ...editingCompany, email: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Business Phone<input required value={editingCompany.businessPhone ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, businessPhone: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Website<input value={editingCompany.website ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, website: e.target.value || null })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Billing Tier<select value={editingCompany.billingTier} onChange={(e) => setEditingCompany({ ...editingCompany, billingTier: e.target.value as CompanyApiData['billingTier'] })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800"><option value="starter">Starter</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></label>
              <label className="font-bold text-slate-500">Per-Minute Price (₹)<input type="number" min="0" step="0.01" required value={editingCompany.perMinutePrice} onChange={(e) => setEditingCompany({ ...editingCompany, perMinutePrice: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Time Zone<input list="company-timezone-options" required value={editingCompany.timezone} onChange={(e) => setEditingCompany({ ...editingCompany, timezone: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500 md:col-span-2">Street Address<input value={editingCompany.addressLine1 ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, addressLine1: e.target.value || null })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">State<input value={editingCompany.state ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, state: e.target.value || null })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Country<input list="company-country-options" value={editingCompany.country ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, country: e.target.value || null })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
              <label className="font-bold text-slate-500">Postal Code<input value={editingCompany.postalCode ?? ''} onChange={(e) => setEditingCompany({ ...editingCompany, postalCode: e.target.value || null })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" /></label>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button type="button" onClick={() => setEditingCompany(null)} className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-600">Cancel</button>
              <button type="submit" disabled={submitting} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{submitting ? 'Saving...' : 'Save Changes'}</button>
            </div>
          </form>
        </div>
      )}

      {/* CREATE COMPANY MODAL DIALOG */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">Provision New Client Company</h3>
                <p className="text-[10px] text-slate-400 font-medium">Configure operational billing tenant profiles and contacts.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Form body */}
            <form onSubmit={handleCreateCompany} className="flex-1 overflow-y-auto p-6 space-y-4">
              {successMessage && (
                <div className="p-3 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-xl text-xs font-bold animate-pulse">
                  {successMessage}
                </div>
              )}
              {error && (
                <div className="p-3 bg-red-50 text-red-700 border border-red-100 rounded-xl text-xs font-bold">
                  {error}
                </div>
              )}

              {/* Form grids */}
              <div className="space-y-4 text-xs font-semibold">
                {/* 1. Contact Info */}
                <div>
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2.5">Primary Contact</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">First Name</label>
                      <input
                        type="text"
                        required
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="e.g. Julia"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">Last Name</label>
                      <input
                        type="text"
                        required
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="e.g. Gold"
                      />
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="block text-[10px] text-slate-500 mb-1 font-bold">Primary Email</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                      placeholder="email@example.com"
                    />
                  </div>
                </div>

                <hr className="border-slate-100" />

                {/* 2. Business Details */}
                <div>
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2.5">Business Profile</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">Business Name</label>
                      <input
                        type="text"
                        required
                        value={businessName}
                        onChange={(e) => setBusinessName(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="Company Corp"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">Business Phone</label>
                      <input
                        type="text"
                        required
                        value={businessPhone}
                        onChange={(e) => setBusinessPhone(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="(555) 000-0000"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">Website</label>
                      <input
                        type="text"
                        required
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="www.company.com"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">Billing Subscription Tier</label>
                      <select
                        value={billingTier}
                        onChange={(e) => setBillingTier(e.target.value as any)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 outline-none cursor-pointer font-semibold text-slate-800"
                      >
                        <option value="starter">Starter</option>
                        <option value="pro">Pro</option>
                        <option value="enterprise">Enterprise</option>
                      </select>
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="block text-[10px] text-slate-500 mb-1 font-bold">Per-Minute Price (₹)</label>
                    <input
                      type="number"
                      required
                      min="0"
                      step="0.01"
                      value={perMinutePrice}
                      onChange={(e) => setPerMinutePrice(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                      placeholder="e.g. 5.50"
                    />
                  </div>
                </div>

                <hr className="border-slate-100" />

                {/* 3. Location / Address details */}
                <div>
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2.5">Location & Settings</h4>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-1 font-bold">Street Address</label>
                    <input
                      type="text"
                      required
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                      placeholder="123 Main St"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3 mt-3">
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">State / Province</label>
                      <input
                        type="text"
                        required
                        value={state}
                        onChange={(e) => setState(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="State"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">Country</label>
                      <input
                        type="text"
                        list="company-country-options"
                        required
                        value={country}
                        onChange={(e) => setCountry(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="Search country"
                      />
                      <datalist id="company-country-options">
                        {COMPANY_COUNTRIES.map((item) => <option key={item} value={item} />)}
                      </datalist>
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1 font-bold">Zip Code</label>
                      <input
                        type="text"
                        required
                        value={zip}
                        onChange={(e) => setZip(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="Zip"
                      />
                    </div>
                  </div>

                  <div className="mt-3">
                    <label className="block text-[10px] text-slate-500 mb-1 font-bold">Time Zone</label>
                    <input
                      type="text"
                      list="company-timezone-options"
                      required
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                      placeholder="Search timezone"
                    />
                    <datalist id="company-timezone-options">
                      {COMPANY_TIMEZONES.map((item) => (
                        <option key={item.value} value={item.value}>{item.label}</option>
                      ))}
                    </datalist>
                  </div>
                </div>
              </div>

              {/* Modal Actions */}
              <div className="pt-4 border-t border-slate-100 flex items-center justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 bg-slate-50 hover:bg-slate-100 text-slate-500 rounded-lg font-bold transition cursor-pointer text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition cursor-pointer text-xs shadow-md shadow-indigo-100"
                >
                  {submitting ? 'Creating…' : 'Confirm Provisioning'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}

/* ==========================================
   2b. COMPANY DETAIL VIEW (DRILLDOWN)
   ========================================== */
function CompanyDetailView({ companyId, onBack }: { companyId: string, onBack: () => void }) {
  const [company, setCompany] = useState<Company | null>(null);
  const [developers, setDevelopers] = useState<Developer[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [balance, setBalance] = useState(0);
  const [adjustAmount, setAdjustAmount] = useState('100');
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true); setError('');
    Promise.all([
      apiRequest<CompanyApiData>(`/admin/companies/${companyId}`),
      apiRequest<{ items: Array<{ id: string; fullName: string; email: string; companyId: string; companyName: string; status: 'active' | 'invited' | 'suspended'; lastActiveAt: string | null }> }>(`/admin/developers?companyId=${companyId}&role=COMPANY_DEVELOPER&pageSize=50`),
      apiRequest<{ items: Array<{ id: string; number: string; provider: string; numberType: string | null; capabilities: { voice?: boolean }; status: 'active' | 'released' | 'unavailable'; monthlyCost: number | null }> }>(`/admin/telephony/phone-numbers?companyId=${companyId}&assignment=assigned&pageSize=50`),
    ]).then(([companyData, developerData, phoneData]) => {
      const mappedCompany = companyFromApi(companyData);
      setCompany(mappedCompany); setBalance(mappedCompany.creditsBalance);
      setDevelopers(developerData.items.map((developer) => ({
        id: developer.id, name: developer.fullName, email: developer.email,
        companyId: developer.companyId, companyName: developer.companyName,
        status: developer.status === 'suspended' ? 'inactive' : developer.status,
        lastActive: developer.lastActiveAt ?? 'Never', role: 'admin',
      })));
      setNumbers(phoneData.items.map((number) => ({
        id: number.id, number: number.number, provider: number.provider,
        type: 'Bidirectional', status: number.status === 'unavailable' ? 'pending' : number.status,
        monthlyCost: number.monthlyCost ?? 0,
      })));
    }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Company could not be loaded'))
      .finally(() => setLoading(false));
  }, [companyId]);

  const adjustCredits = async (direction: 'add' | 'subtract') => {
    const amt = parseFloat(adjustAmount);
    if (isNaN(amt) || amt <= 0) return;
    setError('');
    try {
      const wallet = await apiRequest<{ balance: number }>(`/admin/credits/companies/${companyId}/adjustments`, {
        method: 'POST', body: JSON.stringify({ direction: direction === 'add' ? 'credit' : 'debit',
          amount: amt, type: 'manual_adjustment', description: `Super Admin ${direction} adjustment` }),
      });
      setBalance(wallet.balance);
      setSuccessMsg(`Balance adjusted successfully to ₹${wallet.balance.toLocaleString()}`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Credits could not be adjusted'); }
  };

  if (loading) return <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm font-semibold text-slate-500">Loading company…</div>;
  if (error && !company) return <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm font-semibold text-red-700">{error}</div>;
  if (!company) return <div>Company not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <button onClick={onBack} className="text-xs font-bold text-indigo-600 hover:text-indigo-700 mb-1 flex items-center space-x-1 cursor-pointer">
            <span>← Return to Companies</span>
          </button>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">{company.name}</h2>
          <p className="text-xs text-slate-400 font-medium">{company.primaryContact}</p>
        </div>
        <span className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-lg font-bold text-xs uppercase border border-indigo-100">
          {company.billingTier} Tier
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Account Details & Status */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
          <h3 className="font-bold text-slate-800 border-b border-slate-200 pb-2 tracking-tight">Tenant Operational Parameters</h3>
          
          <div className="grid grid-cols-2 gap-4 text-xs font-semibold">
            <div>
              <span className="text-slate-400 block">Acct Registration</span>
              <span className="text-slate-700">{company.createdAt}</span>
            </div>
            <div>
              <span className="text-slate-400 block">Current Status</span>
              <span className="text-emerald-600 capitalize">{company.status}</span>
            </div>
            <div>
              <span className="text-slate-400 block">Monthly Spend</span>
              <span className="text-slate-700">₹{company.monthlySpend.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-slate-400 block">Per-Minute Price</span>
              <span className="text-slate-700">₹{company.perMinutePrice.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-slate-400 block">DID Lines</span>
              <span className="text-slate-700">{company.phoneNumbersCount} active</span>
            </div>
            {company.businessPhone && (
              <div>
                <span className="text-slate-400 block">Phone</span>
                <span className="text-slate-700">{company.businessPhone}</span>
              </div>
            )}
            {company.website && (
              <div>
                <span className="text-slate-400 block">Website</span>
                <span className="text-slate-700 font-medium text-indigo-600 hover:underline">
                  <a href={company.website.startsWith('http') ? company.website : `https://${company.website}`} target="_blank" rel="noopener noreferrer">{company.website}</a>
                </span>
              </div>
            )}
            {company.timezone && (
              <div className="col-span-2">
                <span className="text-slate-400 block">Time Zone</span>
                <span className="text-slate-700">{company.timezone}</span>
              </div>
            )}
            {company.address && (
              <div className="col-span-2">
                <span className="text-slate-400 block">Billing Address</span>
                <span className="text-slate-700">{company.address}, {company.state} {company.zip}, {company.country}</span>
              </div>
            )}
          </div>
        </div>

        {/* Dynamic Credits Adjuster */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4 lg:col-span-2">
          <h3 className="font-bold text-slate-800 border-b border-slate-200 pb-2 tracking-tight">Manual Credits Adjustment Ledger</h3>
          {successMsg && (
            <div className="p-2.5 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-lg text-xs font-semibold">
              {successMsg}
            </div>
          )}
          {error && <div className="p-2.5 bg-red-50 text-red-700 border border-red-100 rounded-lg text-xs font-semibold">{error}</div>}

          <div className="flex flex-wrap items-center gap-6">
            <div>
              <span className="text-xs text-slate-400 font-bold block mb-1">Ledger Balance</span>
              <span className="text-2xl font-black text-indigo-600 font-mono">₹{balance.toLocaleString()}</span>
            </div>

            <div className="flex items-center space-x-2">
              <div className="relative">
                <span className="absolute left-3 top-2 text-xs font-bold text-slate-400">₹</span>
                <input
                  type="number"
                  value={adjustAmount}
                  onChange={(e) => setAdjustAmount(e.target.value)}
                  className="pl-6 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 w-24 outline-none focus:bg-white"
                />
              </div>
              <button
                onClick={() => adjustCredits('add')}
                className="px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold transition flex items-center space-x-1 cursor-pointer border border-emerald-100"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Inject Fund</span>
              </button>
              <button
                onClick={() => adjustCredits('subtract')}
                className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg text-xs font-bold transition flex items-center space-x-1 cursor-pointer border border-red-100"
              >
                <X className="w-3.5 h-3.5" />
                <span>Void Credits</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Sub Lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Developers inside client company */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-3 flex items-center space-x-2 tracking-tight">
            <Users className="w-4 h-4 text-slate-400" />
            <span>Assigned Developer Team ({developers.length})</span>
          </h3>
          <div className="space-y-3 text-xs">
            {developers.map(dev => (
              <div key={dev.id} className="flex justify-between items-center border border-slate-200 p-2.5 rounded-lg font-semibold">
                <div>
                  <span className="font-bold text-slate-800 block">{dev.name}</span>
                  <span className="text-[10px] text-slate-400 font-mono font-medium">{dev.email}</span>
                </div>
                <span className="bg-slate-100 text-slate-600 text-[10px] font-bold px-1.5 py-0.5 rounded border border-slate-200 uppercase">
                  {dev.role}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Leased phone numbers */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-3 flex items-center space-x-2 tracking-tight">
            <Phone className="w-4 h-4 text-slate-400" />
            <span>Leased Inbound/Outbound Trunks ({numbers.length})</span>
          </h3>
          <div className="space-y-3 text-xs">
            {numbers.map(num => (
              <div key={num.id} className="flex justify-between items-center border border-slate-200 p-2.5 rounded-lg font-semibold">
                <div>
                  <span className="font-bold text-slate-800 font-mono block">{num.number}</span>
                  <span className="text-[10px] text-slate-400 font-medium">Carrier: {num.provider} · {num.type}</span>
                </div>
                <span className="bg-emerald-50 text-emerald-700 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase border border-emerald-100">
                  {num.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==========================================
   3. TENANT USERS LIST VIEW
   ========================================== */
function UsersListView() {
  const [users, setUsers] = useState<TenantUserApiData[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationData>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [userRole, setUserRole] = useState<'COMPANY_DEVELOPER' | 'COMPANY_USER'>('COMPANY_DEVELOPER');
  const [loading, setLoading] = useState(true);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editingUser, setEditingUser] = useState<TenantUserApiData | null>(null);

  const loadUsers = async () => {
    setLoading(true); setCompaniesLoading(true); setError('');
    await Promise.allSettled([
      apiRequest<{ items: TenantUserApiData[]; pagination: PaginationData }>(`/admin/developers?page=${page}&pageSize=20`)
        .then((data) => { setUsers(data.items); setPagination(data.pagination); })
        .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Users could not be loaded'))
        .finally(() => setLoading(false)),
      apiRequest<CompanyOption[]>('/admin/companies/options')
        .then((data) => {
          setCompanies(data);
          setCompanyId((current) => current || data[0]?.tenantId || '');
        })
        .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Companies could not be loaded'))
        .finally(() => setCompaniesLoading(false)),
    ]);
  };

  useEffect(() => { void loadUsers(); }, [page]);

  const handleCreateUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!companyId) return;
    setSubmitting(true); setError(''); setSuccess('');
    try {
      await apiRequest<TenantUserApiData>('/admin/developers', {
        method: 'POST',
        body: JSON.stringify({ companyId, fullName, email, password, role: userRole }),
      });
      setSuccess(`${userRole === 'COMPANY_DEVELOPER' ? 'Developer' : 'User'} account created successfully.`);
      setFullName(''); setEmail(''); setPassword('');
      await loadUsers();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User could not be created');
    } finally { setSubmitting(false); }
  };

  const toggleUserStatus = async (user: TenantUserApiData) => {
    setError('');
    try {
      await apiRequest(`/admin/developers/${user.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status: user.status === 'active' ? 'suspended' : 'active' }),
      });
      await loadUsers();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User status could not be updated');
    }
  };

  const deleteUser = async (user: TenantUserApiData) => {
    if (!window.confirm(`Delete ${user.fullName} from ${user.companyName}? This immediately revokes login access.`)) return;
    setError('');
    try {
      await apiRequest(`/admin/developers/${user.id}`, { method: 'DELETE' });
      setUsers((current) => current.filter((item) => item.id !== user.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User could not be deleted');
    }
  };

  const handleUpdateUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingUser) return;
    setSubmitting(true); setError('');
    try {
      const updated = await apiRequest<TenantUserApiData>(`/admin/developers/${editingUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: editingUser.fullName, email: editingUser.email,
          companyId: editingUser.companyId, role: editingUser.role,
        }),
      });
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingUser(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User could not be updated');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-fit space-y-4">
        <div>
          <h2 className="text-md font-bold text-slate-800 tracking-tight">Create Company User</h2>
          <p className="text-xs text-slate-400 mt-0.5 font-medium">Create a developer or standard user and assign the account to a company.</p>
        </div>
        {success && <div className="p-2.5 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs font-semibold">{success}</div>}
        {error && <div className="p-2.5 bg-red-50 border border-red-100 text-red-700 rounded-lg text-xs font-semibold">{error}</div>}
        <form onSubmit={handleCreateUser} className="space-y-4 text-xs font-semibold">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Full Name</label>
            <input type="text" required value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. John Doe"
              className="w-full bg-slate-50 border border-slate-200 focus:bg-white rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:border-indigo-500 transition" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Email (Login ID)</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@company.com"
              className="w-full bg-slate-50 border border-slate-200 focus:bg-white rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:border-indigo-500 transition" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Login Password</label>
            <input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Minimum 10 characters"
              className="w-full bg-slate-50 border border-slate-200 focus:bg-white rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:border-indigo-500 transition" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Account Role</label>
            <select value={userRole} onChange={(e) => setUserRole(e.target.value as typeof userRole)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none cursor-pointer font-bold">
              <option value="COMPANY_DEVELOPER">Company Developer</option>
              <option value="COMPANY_USER">Company User</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Assign Company</label>
            <select required disabled={companiesLoading} value={companyId} onChange={(e) => setCompanyId(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none cursor-pointer font-bold">
              <option value="" disabled>{companiesLoading ? 'Loading companies...' : 'Select a company'}</option>
              {companies.map((company) => <option key={company.tenantId} value={company.tenantId}>{company.businessName}</option>)}
            </select>
          </div>
          <button type="submit" disabled={submitting || companies.length === 0}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg font-bold transition shadow-md shadow-indigo-100/50 flex items-center justify-center space-x-1.5 cursor-pointer">
            <UserCheck className="w-4 h-4" />
            <span>{submitting ? 'Creating...' : 'Create User Account'}</span>
          </button>
        </form>
      </div>

      <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h2 className="text-md font-bold text-slate-800 mb-3 tracking-tight">Company User Directory</h2>
        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left">
            <thead><tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[9px]">
              <th className="pb-2">User</th><th className="pb-2">Company</th><th className="pb-2">Role</th>
              <th className="pb-2">Status</th><th className="pb-2">Last Active</th><th className="pb-2 text-right">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100 font-semibold">
              {loading && <tr><td colSpan={6} className="py-10 text-center text-slate-400">Loading users...</td></tr>}
              {!loading && users.map((user) => (
                <tr key={user.id} className="hover:bg-slate-50/50">
                  <td className="py-2.5"><span className="font-bold text-slate-800 block">{user.fullName}</span><span className="text-[10px] text-slate-400 font-mono">{user.email}</span></td>
                  <td className="py-2.5 text-slate-700">{user.companyName}</td>
                  <td className="py-2.5"><span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-100">{user.role === 'COMPANY_DEVELOPER' ? 'Developer' : 'User'}</span></td>
                  <td className="py-2.5"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${user.status === 'active' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : 'bg-slate-100 border-slate-200 text-slate-500'}`}>{user.status}</span></td>
                  <td className="py-2.5 text-slate-500 font-mono text-[10px]">{user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleString() : 'Never'}</td>
                  <td className="py-2.5 text-right"><div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => { setEditingUser(user); setError(''); }}
                      className="px-2.5 py-1 rounded-md text-[10px] font-bold border border-indigo-100 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 cursor-pointer">
                      Edit
                    </button>
                    <button onClick={() => toggleUserStatus(user)}
                      className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition border cursor-pointer ${user.status === 'active' ? 'bg-red-50 border-red-100 text-red-600' : 'bg-emerald-50 border-emerald-100 text-emerald-600'}`}>
                      {user.status === 'active' ? 'Suspend' : 'Activate'}
                    </button>
                    <button onClick={() => deleteUser(user)} title="Delete user"
                      className="p-1 rounded-md border border-red-100 bg-red-50 text-red-600 hover:bg-red-100 transition cursor-pointer">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div></td>
                </tr>
              ))}
              {!loading && users.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-slate-400">No company users found.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-[10px] font-bold text-slate-500">
          <span>{pagination.total.toLocaleString()} users</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40">Previous</button>
            <span>Page {pagination.page} of {Math.max(1, pagination.totalPages)}</span>
            <button type="button" disabled={loading || page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)} className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40">Next</button>
          </div>
        </div>
      </div>

      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <form onSubmit={handleUpdateUser} className="w-full max-w-lg space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-100 pb-3">
              <div><h3 className="text-sm font-black text-slate-800">Edit Company User</h3><p className="text-[10px] text-slate-400">Role or company changes require the user to log in again.</p></div>
              <button type="button" onClick={() => setEditingUser(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
            </div>
            {error && <div className="rounded-lg border border-red-100 bg-red-50 p-2.5 text-xs font-semibold text-red-700">{error}</div>}
            <label className="block text-[10px] font-bold text-slate-500">Full Name<input required value={editingUser.fullName} onChange={(e) => setEditingUser({ ...editingUser, fullName: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-indigo-500" /></label>
            <label className="block text-[10px] font-bold text-slate-500">Email<input type="email" required value={editingUser.email} onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-indigo-500" /></label>
            <label className="block text-[10px] font-bold text-slate-500">Role<select value={editingUser.role} onChange={(e) => setEditingUser({ ...editingUser, role: e.target.value as TenantUserApiData['role'] })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-800"><option value="COMPANY_DEVELOPER">Company Developer</option><option value="COMPANY_USER">Company User</option></select></label>
            <label className="block text-[10px] font-bold text-slate-500">Assigned Company<select value={editingUser.companyId} onChange={(e) => setEditingUser({ ...editingUser, companyId: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-800">{companies.map((company) => <option key={company.tenantId} value={company.tenantId}>{company.businessName}</option>)}</select></label>
            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button type="button" onClick={() => setEditingUser(null)} className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-600">Cancel</button>
              <button type="submit" disabled={submitting} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{submitting ? 'Saving...' : 'Save Changes'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/* ==========================================
   4. VOICE PROVIDERS VIEW
   ========================================== */
function VoiceProvidersView() {
  const [providers, setProviders] = useState<ProviderApiData[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<'llm' | 'tts' | 'stt'>('tts');
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'error'>('connected');
  const [parameters, setParameters] = useState<Array<{ key: string; value: string }>>([]);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [editingProvider, setEditingProvider] = useState<ProviderApiData | null>(null);
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<'connected' | 'disconnected' | 'error'>('disconnected');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editLatencyMs, setEditLatencyMs] = useState('');
  const [editParameters, setEditParameters] = useState<Array<{
    originalKey?: string; key: string; value: string; isSecret: boolean;
  }>>([]);
  const [modelProvider, setModelProvider] = useState<ProviderApiData | null>(null);
  const [providerModels, setProviderModels] = useState<ProviderModelApiData[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelKey, setModelKey] = useState('');
  const [modelDisplayName, setModelDisplayName] = useState('');
  const [modelParameters, setModelParameters] = useState<Array<{ key: string; value: string }>>([]);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);

  const loadProviders = async () => {
    setLoading(true); setError('');
    try {
      setProviders(await apiRequest<ProviderApiData[]>('/admin/providers'));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Providers could not be loaded');
    } finally { setLoading(false); }
  };

  useEffect(() => { void loadProviders(); }, []);

  const toggleProviderStatus = async (provider: ProviderApiData) => {
    const nextStatus = provider.status === 'connected' ? 'disconnected' : 'connected';
    setError('');
    try {
      const updated = await apiRequest<ProviderApiData>(`/admin/providers/${provider.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status: nextStatus }),
      });
      setProviders((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Provider status could not be updated');
    }
  };

  const addParameterField = () => {
    setParameters([...parameters, { key: '', value: '' }]);
  };

  const removeParameterField = (index: number) => {
    setParameters(parameters.filter((_, i) => i !== index));
  };

  const updateParameterField = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...parameters];
    updated[index][field] = val;
    setParameters(updated);
  };

  const handleCreateProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const finalParameters = parameters.filter(p => p.key.trim() !== '');
    setSubmitting(true); setError('');
    try {
      const created = await apiRequest<ProviderApiData>('/admin/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(), type, status,
          parameters: finalParameters.map((parameter) => ({ ...parameter, isSecret: false })),
        }),
      });
      setProviders((current) => [created, ...current]);
      setSuccessMsg(`Provider "${name}" successfully configured.`);
      setName(''); setType('tts'); setStatus('connected'); setParameters([]);
      window.setTimeout(() => { setSuccessMsg(null); setShowAddForm(false); }, 1500);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Provider could not be created');
    } finally { setSubmitting(false); }
  };

  const openProviderEditor = (provider: ProviderApiData) => {
    setEditingProvider(provider);
    setEditName(provider.name);
    setEditStatus(provider.status);
    setEditBaseUrl(provider.baseUrl ?? '');
    setEditLatencyMs(provider.latencyMs?.toString() ?? '');
    setEditParameters(provider.parameterKeys.map((parameter) => ({
      originalKey: parameter.key, key: parameter.key, value: parameter.value, isSecret: false,
    })));
    setError('');
  };

  const handleUpdateProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingProvider) return;
    setSubmitting(true); setError('');
    try {
      const updated = await apiRequest<ProviderApiData>(`/admin/providers/${editingProvider.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(), status: editStatus,
          baseUrl: editBaseUrl.trim() || null,
          latencyMs: editLatencyMs === '' ? null : Number(editLatencyMs),
          parameters: editParameters.map((parameter) => ({
            originalKey: parameter.originalKey,
            key: parameter.key.trim(),
            ...(parameter.value ? { value: parameter.value } : {}),
            isSecret: parameter.isSecret,
          })),
        }),
      });
      setProviders((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingProvider(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Provider could not be updated');
    } finally { setSubmitting(false); }
  };

  const handleDeleteProvider = async (provider: ProviderApiData) => {
    if (!window.confirm(`Delete provider "${provider.name}"? Its models will no longer be available for new agents.`)) return;
    setError('');
    try {
      await apiRequest(`/admin/providers/${provider.id}`, { method: 'DELETE' });
      setProviders((current) => current.filter((item) => item.id !== provider.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Provider could not be deleted');
    }
  };

  const openModelManager = async (provider: ProviderApiData) => {
    setModelProvider(provider); setProviderModels([]); setModelsLoading(true); setError('');
    setEditingModelId(null); setModelKey(''); setModelDisplayName(''); setModelParameters([]);
    try {
      setProviderModels(await apiRequest<ProviderModelApiData[]>(`/admin/providers/${provider.id}/models`));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Provider models could not be loaded');
    } finally { setModelsLoading(false); }
  };

  const modelParameterValue = (value: string): unknown => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try { return JSON.parse(trimmed); } catch { return value; }
  };

  const handleCreateModel = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!modelProvider) return;
    setSubmitting(true); setError('');
    try {
      const settings = Object.fromEntries(modelParameters.filter((parameter) => parameter.key.trim()).map((parameter) => [parameter.key.trim(), modelParameterValue(parameter.value)]));
      const existingModel = editingModelId ? providerModels.find((model) => model.id === editingModelId) : null;
      const saved = await apiRequest<ProviderModelApiData>(editingModelId
        ? `/admin/providers/models/${editingModelId}`
        : `/admin/providers/${modelProvider.id}/models`, {
        method: editingModelId ? 'PATCH' : 'POST',
        body: JSON.stringify({ modelKey: modelKey.trim(), displayName: modelDisplayName.trim(), status: 'active', capabilities: existingModel?.capabilities ?? {}, settings }),
      });
      if (editingModelId) {
        setProviderModels((current) => current.map((model) => model.id === saved.id ? saved : model));
      } else {
        setProviderModels((current) => [saved, ...current]);
        setProviders((current) => current.map((provider) => provider.id === modelProvider.id ? { ...provider, modelCount: provider.modelCount + 1 } : provider));
        setModelProvider((current) => current ? { ...current, modelCount: current.modelCount + 1 } : current);
      }
      setEditingModelId(null); setModelKey(''); setModelDisplayName(''); setModelParameters([]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Provider model could not be created');
    } finally { setSubmitting(false); }
  };

  const openModelEditor = (model: ProviderModelApiData) => {
    setEditingModelId(model.id);
    setModelKey(model.modelKey);
    setModelDisplayName(model.displayName);
    setModelParameters(Object.entries(model.settings).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })));
    setError('');
  };

  const cancelModelEditor = () => {
    setEditingModelId(null); setModelKey(''); setModelDisplayName(''); setModelParameters([]);
  };

  const toggleModelStatus = async (model: ProviderModelApiData) => {
    setError('');
    try {
      const updated = await apiRequest<ProviderModelApiData>(`/admin/providers/models/${model.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status: model.status === 'active' ? 'inactive' : 'active' }),
      });
      setProviderModels((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Model status could not be updated');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">AI Providers</h2>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Configure LLM, text-to-speech, and speech-to-text providers.</p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2.5 text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer shadow-sm shadow-indigo-100"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Provider</span>
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-100 text-red-700 text-xs font-bold rounded-xl">
          {error}
        </div>
      )}

      {/* NEW PROVIDER PROVISIONING CARD */}
      {showAddForm && (
        <div className="bg-white border-2 border-indigo-100 rounded-2xl p-6 shadow-xl animate-in fade-in duration-200 space-y-5">
          <div className="flex justify-between items-start border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">Configure New AI Provider</h3>
              <p className="text-[10px] text-slate-400 font-medium mt-0.5">All parameter values are stored as entered and visible to Super Admin.</p>
            </div>
            <button 
              onClick={() => setShowAddForm(false)}
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {successMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 text-xs font-bold rounded-xl animate-pulse">
              {successMsg}
            </div>
          )}

          <form onSubmit={handleCreateProvider} className="space-y-5 text-xs font-semibold">
            {/* Step 1: Basic Details */}
            <div>
              <h4 className="text-[10px] font-black text-indigo-600 uppercase tracking-wider mb-2.5">1. Provider Profile Details</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[10px] text-slate-500 mb-1 font-bold">Provider Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Vapi AI, Twilio, Neets TTS"
                    className="w-full bg-slate-50 border border-slate-200 focus:bg-white rounded-lg px-3 py-2 text-slate-800 outline-none focus:border-indigo-500 transition"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-1 font-bold">Provider Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as any)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none cursor-pointer font-bold"
                  >
                    <option value="tts">Text-to-Speech (TTS)</option>
                    <option value="stt">Speech-to-Text (STT)</option>
                    <option value="llm">AI Large Language Model (LLM)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-1 font-bold">Initial Connection State</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as any)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none cursor-pointer font-bold"
                  >
                    <option value="connected">Connected & Online</option>
                    <option value="disconnected">Inactive / Offline</option>
                    <option value="error">Maintenance Error State</option>
                  </select>
                </div>
              </div>
            </div>

            <hr className="border-slate-100" />

            {/* Step 2: Dynamic Parameters Fields */}
            <div>
              <div className="flex justify-between items-center mb-2.5">
                <div>
                  <h4 className="text-[10px] font-black text-indigo-600 uppercase tracking-wider">2. API Configuration Parameters</h4>
                  <p className="text-[10px] text-slate-400 mt-0.5">Add environment keys, webhooks, or unique identifier fields required by this client integration.</p>
                </div>
                <button
                  type="button"
                  onClick={addParameterField}
                  className="bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg px-3 py-1.5 text-[10px] font-bold transition flex items-center space-x-1 cursor-pointer border border-indigo-100"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Parameter Field</span>
                </button>
              </div>

              {parameters.length === 0 ? (
                <div className="bg-slate-50/50 rounded-xl p-4 border border-dashed border-slate-200 text-center py-6 text-slate-400">
                  <span className="block font-medium">No configuration parameters declared yet.</span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">Click the "Add Parameter Field" button above to inject custom properties.</span>
                </div>
              ) : (
                <div className="space-y-2.5 bg-slate-50 p-4 rounded-xl border border-slate-200 max-h-[250px] overflow-y-auto">
                  {parameters.map((param, index) => (
                    <div key={index} className="flex items-center space-x-2.5 animate-in fade-in duration-150">
                      <div className="flex-1 grid grid-cols-2 gap-2.5">
                        <input
                          type="text"
                          required
                          value={param.key}
                          onChange={(e) => updateParameterField(index, 'key', e.target.value)}
                          placeholder="Property Key (e.g. api_key, model_version)"
                          className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg px-3 py-1.5 text-slate-800 outline-none transition font-mono text-[11px]"
                        />
                        <input
                          type="text"
                          required
                          value={param.value}
                          onChange={(e) => updateParameterField(index, 'value', e.target.value)}
                          placeholder="Property Value"
                          className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg px-3 py-1.5 text-slate-800 outline-none transition font-mono text-[11px]"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeParameterField(index)}
                        className="p-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition border border-red-100 cursor-pointer"
                        title="Remove parameter"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-end space-x-2">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg font-bold transition cursor-pointer text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition cursor-pointer text-xs shadow-md shadow-indigo-100"
              >
                {submitting ? 'Creating Provider...' : 'Confirm & Create Provider'}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <form onSubmit={handleUpdateProvider} className="w-full max-w-lg space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div><h3 className="text-sm font-black text-slate-800">Edit Provider</h3><p className="text-[10px] text-slate-400">Super Admin can view and edit all parameter values.</p></div>
              <button type="button" onClick={() => setEditingProvider(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-bold text-slate-500">Provider Name</label>
              <input required value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-bold text-slate-500">Connection Status</label>
              <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as typeof editStatus)} className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold outline-none">
                <option value="connected">Connected</option><option value="disconnected">Disconnected</option><option value="error">Error</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-bold text-slate-500">Base URL</label>
              <input type="url" value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} placeholder="https://api.provider.com" className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-bold text-slate-500">Latency (milliseconds)</label>
              <input type="number" min="0" step="1" value={editLatencyMs} onChange={(e) => setEditLatencyMs(e.target.value)} placeholder="Optional" className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-indigo-500" />
            </div>
            <div className="space-y-2 border-t border-slate-100 pt-4">
              <div className="flex items-center justify-between">
                <div><h4 className="text-[10px] font-black uppercase tracking-wider text-indigo-600">Provider Keys &amp; Credentials</h4><p className="text-[10px] text-slate-400">Shared provider configuration only. These values do not create or configure selectable models.</p></div>
                <button type="button" onClick={() => setEditParameters((current) => [...current, { key: '', value: '', isSecret: false }])}
                  className="flex items-center gap-1 rounded-lg border border-indigo-100 bg-indigo-50 px-2.5 py-1.5 text-[10px] font-bold text-indigo-700 hover:bg-indigo-100">
                  <Plus className="h-3 w-3" /> Add Parameter
                </button>
              </div>
              <div className="max-h-56 space-y-2 overflow-y-auto">
                {editParameters.map((parameter, index) => (
                  <div key={`${parameter.originalKey ?? 'new'}-${index}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <input required value={parameter.key} onChange={(e) => setEditParameters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, key: e.target.value } : item))}
                      placeholder="Parameter key" className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-mono outline-none focus:border-indigo-500" />
                    <input type="text" required value={parameter.value} onChange={(e) => setEditParameters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: e.target.value } : item))}
                      placeholder="Parameter value" className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-mono outline-none focus:border-indigo-500" />
                    <button type="button" onClick={() => setEditParameters((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      className="rounded-md border border-red-100 bg-red-50 p-1.5 text-red-600 hover:bg-red-100"><Trash2 className="h-3 w-3" /></button>
                  </div>
                ))}
                {editParameters.length === 0 && <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-[10px] text-slate-400">No parameters configured.</div>}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button type="button" onClick={() => setEditingProvider(null)} className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-600">Cancel</button>
              <button type="submit" disabled={submitting} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{submitting ? 'Saving...' : 'Save Changes'}</button>
            </div>
          </form>
        </div>
      )}

      {modelProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="mb-5 flex items-start justify-between border-b border-slate-100 pb-4">
              <div><h3 className="text-sm font-black text-slate-800">Manage {modelProvider.type.toUpperCase()} Models</h3><p className="mt-1 text-[10px] font-semibold text-slate-400">{modelProvider.name} — developers can only select active models and view these parameters.</p></div>
              <button type="button" onClick={() => setModelProvider(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
            </div>
            {error && <div className="mb-4 rounded-lg border border-red-100 bg-red-50 p-2.5 text-xs font-semibold text-red-700">{error}</div>}
            <form onSubmit={handleCreateModel} className="space-y-4 rounded-xl border border-indigo-100 bg-indigo-50/30 p-4">
              <div><h4 className="text-[10px] font-black uppercase tracking-wider text-indigo-700">{editingModelId ? 'Edit Super Admin Model' : 'Create Super Admin Model'}</h4><p className="text-[10px] text-slate-400">Models are explicit and dynamic. Provider credentials remain private; developers can select active models and view only these model settings.</p></div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-[10px] font-bold text-slate-500">Model Key<input required value={modelKey} onChange={(e) => setModelKey(e.target.value)} placeholder="e.g. gpt-4.1" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500" /></label>
                <label className="text-[10px] font-bold text-slate-500">Display Name<input required value={modelDisplayName} onChange={(e) => setModelDisplayName(e.target.value)} placeholder="e.g. GPT 4.1" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-indigo-500" /></label>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between"><span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Model Parameters</span><button type="button" onClick={() => setModelParameters((current) => [...current, { key: '', value: '' }])} className="rounded-lg border border-indigo-100 bg-white px-2.5 py-1.5 text-[10px] font-bold text-indigo-700"><Plus className="mr-1 inline h-3 w-3" />Add Parameter</button></div>
                {modelParameters.map((parameter, index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input required value={parameter.key} onChange={(e) => setModelParameters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, key: e.target.value } : item))} placeholder="Key, e.g. language" className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-[10px] outline-none" />
                  <input required value={parameter.value} onChange={(e) => setModelParameters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: e.target.value } : item))} placeholder="Value; JSON supported" className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-[10px] outline-none" />
                  <button type="button" onClick={() => setModelParameters((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded-lg border border-red-100 bg-red-50 p-2 text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>)}
                {modelParameters.length === 0 && <div className="rounded-lg border border-dashed border-slate-200 bg-white p-3 text-center text-[10px] text-slate-400">No optional model parameters.</div>}
              </div>
              <div className="flex justify-end gap-2">
                {editingModelId && <button type="button" onClick={cancelModelEditor} className="rounded-lg bg-white px-4 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200">Cancel Edit</button>}
                <button disabled={submitting} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{submitting ? 'Saving...' : editingModelId ? 'Save Model' : 'Add Active Model'}</button>
              </div>
            </form>
            <div className="mt-5 space-y-2">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Created Models ({providerModels.length})</span>
              {modelsLoading && <div className="rounded-xl border border-slate-200 p-6 text-center text-xs text-slate-400">Loading models...</div>}
              {!modelsLoading && providerModels.map((model) => <div key={model.id} className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 p-4">
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-black text-slate-800">{model.displayName}</span><span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">{model.modelKey}</span></div><div className="mt-2 flex flex-wrap gap-1.5">{Object.entries(model.settings).map(([key, value]) => <span key={key} className="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[9px] text-slate-600">{key}: {typeof value === 'string' ? value : JSON.stringify(value)}</span>)}{Object.keys(model.settings).length === 0 && <span className="text-[9px] text-slate-400">No model parameters</span>}</div></div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => openModelEditor(model)} className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-1.5 text-[10px] font-bold text-indigo-700">Edit</button>
                  <button type="button" onClick={() => toggleModelStatus(model)} className={`rounded-lg border px-3 py-1.5 text-[10px] font-bold ${model.status === 'active' ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-100 text-slate-500'}`}>{model.status === 'active' ? 'Active' : 'Inactive'}</button>
                </div>
              </div>)}
              {!modelsLoading && providerModels.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">No models created for this provider.</div>}
            </div>
          </div>
        </div>
      )}

      {/* PROVIDERS GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading && <div className="md:col-span-2 lg:col-span-3 bg-white border border-slate-200 rounded-xl p-10 text-center text-sm font-semibold text-slate-400">Loading providers...</div>}
        {providers.map((p) => (
          <div key={p.id} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex flex-col justify-between hover:shadow-md transition duration-200">
            <div>
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="font-bold text-slate-800 text-sm tracking-tight">{p.name}</h4>
                  <span className="bg-slate-100 text-slate-600 text-[9px] font-bold px-1.5 py-0.5 rounded border border-slate-200 uppercase mt-1.5 inline-block">
                    {p.type}
                  </span>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                  p.status === 'connected' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' :
                  p.status === 'error' ? 'bg-red-50 border-red-100 text-red-700' : 'bg-slate-100 border-slate-200 text-slate-500'
                }`}>
                  {p.status}
                </span>
              </div>

              {/* Display config parameters if they exist */}
              {p.parameterKeys.length > 0 && (
                <div className="mt-3.5 bg-slate-50 p-3 rounded-lg border border-slate-200/60 font-sans">
                  <span className="text-[9px] text-slate-400 font-extrabold uppercase tracking-widest block mb-2">Provider Keys &amp; Vars (not model settings)</span>
                  <div className="space-y-1.5 text-[10px] font-mono">
                    {p.parameterKeys.map((param) => (
                      <div key={param.key} className="flex min-w-0 items-center justify-between gap-2 text-slate-600 border-b border-slate-100 pb-1 last:border-0 last:pb-0">
                        <span className="min-w-0 truncate font-bold text-slate-500" title={param.key}>{param.key}</span>
                        <span className="shrink-0 max-w-[145px] overflow-hidden whitespace-nowrap text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200" title={param.value}>
                          {providerValuePreview(param.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs font-semibold mt-4 bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase font-bold">Latency</span>
                  <span className="text-slate-700 font-mono text-[11px] font-bold">{p.latencyMs === null ? 'Not measured' : `${p.latencyMs} ms`}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase font-bold">Models</span>
                  <span className="text-slate-700 font-mono text-[11px] font-bold">{p.modelCount.toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 mt-4 flex justify-between items-center gap-2">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{p.usageCount.toLocaleString()} invocations</span>
              <div className="flex items-center gap-1">
                <button onClick={() => void openModelManager(p)} className="rounded-lg border border-violet-100 bg-violet-50 px-2 py-1.5 text-[10px] font-bold text-violet-700 hover:bg-violet-100">Models</button>
                <button onClick={() => openProviderEditor(p)} className="rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-1.5 text-[10px] font-bold text-indigo-700 hover:bg-indigo-100">Edit</button>
                <button onClick={() => toggleProviderStatus(p)} className={`rounded-lg border px-2 py-1.5 text-[10px] font-bold ${p.status === 'connected' ? 'border-red-100 bg-red-50 text-red-600' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}`}>
                  {p.status === 'connected' ? 'Disconnect' : 'Connect'}
                </button>
                <button onClick={() => handleDeleteProvider(p)} title="Delete provider" className="rounded-lg border border-red-100 bg-red-50 p-1.5 text-red-600 hover:bg-red-100"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          </div>
        ))}
        {!loading && providers.length === 0 && (
          <div className="md:col-span-2 lg:col-span-3 bg-white border border-slate-200 rounded-xl p-10 text-center text-sm font-semibold text-slate-400">No providers configured.</div>
        )}
      </div>
    </div>
  );
}

/* ==========================================
   5. PHONE NUMBERS VIEW
   ========================================== */
function PhoneNumbersView() {
  const [activeSubTab, setActiveSubTab] = useState<'telephony' | 'assign'>('telephony');
  const [numbers, setNumbers] = useState<PhoneNumberApiData[]>([]);
  const [assignableNumbers, setAssignableNumbers] = useState<Array<{ id: string; number: string }>>([]);
  const [phonePage, setPhonePage] = useState(1);
  const [phonePagination, setPhonePagination] = useState<PaginationData>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [telephonyProviders, setTelephonyProviders] = useState<TelephonyAccountApiData[]>([]);
  const [companySubaccounts, setCompanySubaccounts] = useState<CompanySubaccountApiData[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [showTokens, setShowTokens] = useState<{ [key: string]: boolean }>({});
  const [newProvName, setNewProvName] = useState('');
  const [newAuthId, setNewAuthId] = useState('');
  const [newAuthToken, setNewAuthToken] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('https://api.plivo.com/v1');
  const [newApplicationId, setNewApplicationId] = useState('');
  const [newAnswerUrl, setNewAnswerUrl] = useState('https://api.voice.zeacrm.com/webhooks/plivo/answer');
  const [newHangupUrl, setNewHangupUrl] = useState('https://api.voice.zeacrm.com/webhooks/plivo/hangup');
  const [newRecordingCallbackUrl, setNewRecordingCallbackUrl] = useState('https://api.voice.zeacrm.com/webhooks/plivo/recording');
  const [provSuccess, setProvSuccess] = useState<string | null>(null);
  const [assignNumId, setAssignNumId] = useState('');
  const [assignCompanyId, setAssignCompanyId] = useState('');
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState<TelephonyAccountApiData | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [numbersLoading, setNumbersLoading] = useState(true);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [syncingNumbers, setSyncingNumbers] = useState(false);
  const [error, setError] = useState('');

  const loadTelephonyData = async () => {
    setAccountsLoading(true); setNumbersLoading(true); setCompaniesLoading(true); setError('');
    await Promise.allSettled([
      Promise.all([
        apiRequest<TelephonyAccountApiData[]>('/admin/telephony/accounts'),
        apiRequest<CompanySubaccountApiData[]>('/admin/telephony/subaccounts'),
      ]).then(([accounts, subaccounts]) => {
        setTelephonyProviders(accounts); setCompanySubaccounts(subaccounts);
      }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Telephony providers could not be loaded'))
        .finally(() => setAccountsLoading(false)),
      apiRequest<{ items: PhoneNumberApiData[]; pagination: PaginationData }>(`/admin/telephony/phone-numbers?page=${phonePage}&pageSize=20`)
        .then((data) => {
          setNumbers(data.items);
          setPhonePagination(data.pagination);
        }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Phone numbers could not be loaded'))
        .finally(() => setNumbersLoading(false)),
      apiRequest<CompanyOption[]>('/admin/companies/options')
        .then((data) => {
          setCompanies(data);
          setAssignCompanyId((current) => current || data[0]?.tenantId || '');
        }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Companies could not be loaded'))
        .finally(() => setCompaniesLoading(false)),
      apiRequest<Array<{ id: string; number: string }>>('/admin/telephony/phone-number-options')
        .then((data) => {
          setAssignableNumbers(data);
          setAssignNumId((current) => data.some((number) => number.id === current) ? current : (data[0]?.id || ''));
        }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Assignable phone numbers could not be loaded')),
    ]);
  };

  useEffect(() => { void loadTelephonyData(); }, [phonePage]);

  const handleAddTelephonyProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setError('');
    try {
      const created = await apiRequest<TelephonyAccountApiData>('/admin/telephony/accounts', {
        method: 'POST', body: JSON.stringify({
          provider: 'plivo', name: newProvName.trim(), authId: newAuthId.trim(),
          authToken: newAuthToken, baseUrl: newBaseUrl.trim(), applicationId: newApplicationId.trim(),
          answerUrl: newAnswerUrl.trim(), hangupUrl: newHangupUrl.trim(),
          recordingCallbackUrl: newRecordingCallbackUrl.trim(), status: 'connected',
        }),
      });
      setTelephonyProviders((current) => [created, ...current]);
      setNewProvName(''); setNewAuthId(''); setNewAuthToken(''); setNewApplicationId('');
      setNewBaseUrl('https://api.plivo.com/v1');
      setNewAnswerUrl('https://api.voice.zeacrm.com/webhooks/plivo/answer');
      setNewHangupUrl('https://api.voice.zeacrm.com/webhooks/plivo/hangup');
      setNewRecordingCallbackUrl('https://api.voice.zeacrm.com/webhooks/plivo/recording');
      setProvSuccess(`Telephony provider "${created.name}" added successfully.`);
      window.setTimeout(() => setProvSuccess(null), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Telephony provider could not be created');
    } finally { setSubmitting(false); }
  };

  const releaseNumber = async (id: string) => {
    setError('');
    try {
      await apiRequest(`/admin/telephony/phone-numbers/${id}/release`, {
        method: 'POST', body: JSON.stringify({ reason: 'Released by Super Admin' }),
      });
      await loadTelephonyData();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Number could not be released'); }
  };

  const handleAssignNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignNumId || !assignCompanyId) return;
    setSubmitting(true); setError('');
    try {
      const assigned = await apiRequest<PhoneNumberApiData>(`/admin/telephony/phone-numbers/${assignNumId}/assign`, {
        method: 'POST', body: JSON.stringify({ companyId: assignCompanyId }),
      });
      setAssignSuccess(`Assigned ${assigned.number} to ${assigned.companyName} using subaccount ${assigned.subaccountAuthId}.`);
      setAssignNumId(''); await loadTelephonyData();
      window.setTimeout(() => setAssignSuccess(null), 3000);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Number could not be assigned'); }
    finally { setSubmitting(false); }
  };

  const toggleTokenVisibility = (id: string) => {
    setShowTokens(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const syncAccount = async (id: string) => {
    setError('');
    try {
      await apiRequest(`/admin/telephony/accounts/${id}/sync`, { method: 'POST', body: '{}' });
      await loadTelephonyData();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Provider sync failed'); }
  };

  const syncPurchasedNumbers = async () => {
    const accounts = telephonyProviders.filter((account) => account.status === 'connected');
    if (accounts.length === 0) {
      setError('Add or connect a telephony provider before synchronizing phone numbers.');
      return;
    }
    setSyncingNumbers(true); setError(''); setAssignSuccess(null);
    try {
      const results = await Promise.allSettled(accounts.map((account) =>
        apiRequest(`/admin/telephony/accounts/${account.id}/sync`, { method: 'POST', body: '{}' })));
      await loadTelephonyData();
      const synchronized = results.filter((result) => result.status === 'fulfilled').length;
      const failed = results.length - synchronized;
      if (failed > 0) setError(`${synchronized} provider(s) synchronized; ${failed} provider(s) failed.`);
      else setAssignSuccess('Purchased phone numbers synchronized successfully.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Phone numbers could not be synchronized');
    } finally {
      setSyncingNumbers(false);
    }
  };

  const updateAccount = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editingAccount) return;
    setSubmitting(true); setError('');
    try {
      const updated = await apiRequest<TelephonyAccountApiData>(`/admin/telephony/accounts/${editingAccount.id}`, {
        method: 'PATCH', body: JSON.stringify({
          name: editingAccount.name, authId: editingAccount.authId,
          authToken: editingAccount.authToken, baseUrl: editingAccount.baseUrl,
          applicationId: editingAccount.applicationId, answerUrl: editingAccount.answerUrl,
          hangupUrl: editingAccount.hangupUrl, recordingCallbackUrl: editingAccount.recordingCallbackUrl,
          status: editingAccount.status,
        }),
      });
      setTelephonyProviders((current) => current.map((account) => account.id === updated.id ? updated : account));
      setEditingAccount(null);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Provider could not be updated'); }
    finally { setSubmitting(false); }
  };

  const deleteAccount = async (account: TelephonyAccountApiData) => {
    if (!window.confirm(`Delete telephony provider "${account.name}"?`)) return;
    setError('');
    try {
      await apiRequest(`/admin/telephony/accounts/${account.id}`, { method: 'DELETE' });
      await loadTelephonyData();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Provider could not be deleted'); }
  };

  return (
    <div className="space-y-6">
      {/* Sub tabs header */}
      <div className="flex border-b border-slate-200">
        <button
          onClick={() => setActiveSubTab('telephony')}
          className={`px-4 py-2.5 font-bold text-xs tracking-tight transition border-b-2 cursor-pointer flex items-center space-x-1.5 ${
            activeSubTab === 'telephony'
              ? 'border-indigo-600 text-indigo-600 bg-indigo-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Cpu className="w-4 h-4" />
          <span>Telephony Providers & Phone Numbers</span>
        </button>
        <button
          onClick={() => setActiveSubTab('assign')}
          className={`px-4 py-2.5 font-bold text-xs tracking-tight transition border-b-2 cursor-pointer flex items-center space-x-1.5 ${
            activeSubTab === 'assign'
              ? 'border-indigo-600 text-indigo-600 bg-indigo-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Building2 className="w-4 h-4" />
          <span>Assign Numbers to Companies</span>
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded-lg text-xs font-semibold">
          {error}
        </div>
      )}

      {activeSubTab === 'telephony' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Purchase & Provider inputs */}
          <div className="space-y-6">
            {/* Add Telephony Provider form */}
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <div>
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider">Add Telephony Provider</h3>
                <p className="text-[10px] text-slate-400 mt-0.5 font-medium font-sans">Register third-party voice carrier API credentials.</p>
              </div>

              {provSuccess && (
                <div className="p-2.5 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-lg text-xs font-semibold">
                  {provSuccess}
                </div>
              )}

              <form onSubmit={handleAddTelephonyProvider} className="space-y-3 text-xs font-semibold">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Provider Name</label>
                  <input
                    type="text"
                    required
                    value={newProvName}
                    onChange={(e) => setNewProvName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition"
                    placeholder="e.g. Twilio Production, SignalWire Central"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Plivo Account Auth ID</label>
                  <input
                    type="text"
                    required
                    value={newAuthId}
                    onChange={(e) => setNewAuthId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                    placeholder="e.g. MAXXXXXXXXXXXXXXXXXX"
                  />
                  <p className="mt-1 text-[9px] text-slate-400">Use the Auth ID from Plivo Console beginning with MA. Do not enter a sip: address.</p>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Auth Token</label>
                  <input
                    type="text"
                    required
                    value={newAuthToken}
                    onChange={(e) => setNewAuthToken(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                    placeholder="e.g. tm_secret_..."
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Base URL</label>
                  <input
                    type="url"
                    required
                    value={newBaseUrl}
                    onChange={(e) => setNewBaseUrl(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                    placeholder="https://api.plivo.com/v1"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Main Application ID (Optional)</label>
                  <input
                    type="text"
                    value={newApplicationId}
                    onChange={(e) => setNewApplicationId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                    placeholder="Company applications are created automatically"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Answer URL</label>
                  <input
                    type="url"
                    required
                    value={newAnswerUrl}
                    onChange={(e) => setNewAnswerUrl(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Hangup URL</label>
                  <input
                    type="url"
                    required
                    value={newHangupUrl}
                    onChange={(e) => setNewHangupUrl(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Recording Callback URL</label>
                  <input
                    type="url"
                    required
                    value={newRecordingCallbackUrl}
                    onChange={(e) => setNewRecordingCallbackUrl(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-lg font-bold transition shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer text-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{submitting ? 'Saving...' : 'Save Telephony Provider'}</span>
                </button>
              </form>
            </div>

          </div>

          {/* Right section: Registered Providers + Global DID Inventory */}
          <div className="lg:col-span-2 space-y-6">
            {/* Providers credentials list */}
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-3">Carrier Integrations</h3>
              <div className="space-y-3">
                {accountsLoading && <div className="py-8 text-center text-slate-400 text-xs">Loading providers...</div>}
                {telephonyProviders.map(tp => (
                  <div key={tp.id} className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-800 text-xs">{tp.name}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${tp.status === 'connected' ? 'bg-emerald-100 text-emerald-700' : tp.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'}`}>{tp.status}</span>
                      </div>
                      <div className="flex flex-col space-y-0.5 text-[10px] font-mono text-slate-500">
                        <span>Auth ID: <strong className="text-slate-700">{tp.authId}</strong></span>
                        <span className="break-all">Base URL: <strong className="text-slate-700">{tp.baseUrl}</strong></span>
                        <span>Application ID: <strong className="text-slate-700">{tp.applicationId || 'Not configured'}</strong></span>
                        <span title={tp.answerUrl}>Answer URL: <strong className="text-slate-700">{tp.answerUrl ? providerValuePreview(tp.answerUrl) : 'Not configured'}</strong></span>
                        <span title={tp.hangupUrl}>Hangup URL: <strong className="text-slate-700">{tp.hangupUrl ? providerValuePreview(tp.hangupUrl) : 'Not configured'}</strong></span>
                        <span title={tp.recordingCallbackUrl}>Recording URL: <strong className="text-slate-700">{tp.recordingCallbackUrl ? providerValuePreview(tp.recordingCallbackUrl) : 'Not configured'}</strong></span>
                        <span className="flex items-center space-x-1.5">
                          <span>Token: </span>
                          <strong className="text-slate-700">
                            {showTokens[tp.id] ? tp.authToken : '•'.repeat(20)}
                          </strong>
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => toggleTokenVisibility(tp.id)} className="text-[10px] bg-white border border-slate-200 text-slate-600 rounded-lg px-2 py-1 font-bold cursor-pointer flex items-center gap-1"><Eye className="w-3 h-3" />{showTokens[tp.id] ? 'Hide' : 'Show'}</button>
                      <button onClick={() => void syncAccount(tp.id)} className="text-[10px] bg-white border border-slate-200 text-indigo-600 rounded-lg px-2 py-1 font-bold cursor-pointer">Sync</button>
                      <button onClick={() => setEditingAccount({ ...tp })} className="text-[10px] bg-white border border-slate-200 text-slate-700 rounded-lg px-2 py-1 font-bold cursor-pointer">Edit</button>
                      <button onClick={() => void deleteAccount(tp)} className="text-[10px] bg-red-50 border border-red-100 text-red-600 rounded-lg px-2 py-1 font-bold cursor-pointer">Delete</button>
                    </div>
                  </div>
                ))}
                {!accountsLoading && telephonyProviders.length === 0 && <div className="py-8 text-center text-slate-400 text-xs">No telephony providers configured.</div>}
              </div>
            </div>

            {/* Global Directory table */}
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-3">Global DID Directory</h3>
              <div className="overflow-x-auto text-xs">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[9px]">
                      <th className="pb-2">Phone Number</th>
                      <th className="pb-2">Carrier Platform</th>
                      <th className="pb-2">Assignment</th>
                      <th className="pb-2">Status</th>
                      <th className="pb-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-semibold">
                    {numbersLoading && numbers.length === 0 && <tr><td colSpan={5} className="py-8"><div className="h-8 animate-pulse rounded bg-slate-100" /></td></tr>}
                    {numbers.map(num => (
                      <tr key={num.id} className="hover:bg-slate-50/50">
                        <td className="py-2.5 font-bold font-mono text-slate-800">{num.number}</td>
                        <td className="py-2.5 text-slate-500 font-semibold">{num.provider}</td>
                        <td className="py-2.5">
                          {num.companyName ? (
                            <span className="text-indigo-600 font-bold border border-indigo-100 bg-indigo-50 px-2 py-0.5 rounded text-[10px]">
                              {num.companyName}
                            </span>
                          ) : (
                            <span className="text-slate-400 italic">Unassigned Reserve</span>
                          )}
                        </td>
                        <td className="py-2.5">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${
                            num.status === 'active' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : 'bg-slate-100 border-slate-200 text-slate-500'
                          }`}>
                            {num.status}
                          </span>
                        </td>
                        <td className="py-2.5 text-right">
                          {num.companyId && (
                            <button
                              onClick={() => releaseNumber(num.id)}
                              className="text-red-600 hover:text-red-700 font-bold cursor-pointer"
                            >
                              Release Trunk
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!numbersLoading && numbers.length === 0 && (
                      <tr><td colSpan={5} className="py-8 text-center text-slate-400 italic">No phone numbers found. Add a provider and sync its purchased numbers.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-[10px] font-bold text-slate-500">
                <span>{phonePagination.total.toLocaleString()} phone numbers</span>
                <div className="flex items-center gap-2">
                  <button type="button" disabled={numbersLoading || phonePage <= 1} onClick={() => setPhonePage((value) => Math.max(1, value - 1))} className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40">Previous</button>
                  <span>Page {phonePagination.page} of {Math.max(1, phonePagination.totalPages)}</span>
                  <button type="button" disabled={numbersLoading || phonePage >= phonePagination.totalPages} onClick={() => setPhonePage((value) => value + 1)} className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40">Next</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Assignment form */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-fit space-y-4">
            <div>
              <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider">Map DID trunk routing</h3>
              <p className="text-[10px] text-slate-400 mt-0.5 font-medium font-sans">Assign leased carrier lines to active client tenants.</p>
            </div>

            {assignSuccess && (
              <div className="p-2.5 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-lg text-xs font-semibold">
                {assignSuccess}
              </div>
            )}

            <form onSubmit={handleAssignNumber} className="space-y-4 text-xs font-semibold">
              <button
                type="button"
                onClick={() => void syncPurchasedNumbers()}
                disabled={syncingNumbers || telephonyProviders.length === 0}
                className="w-full py-2.5 bg-white hover:bg-indigo-50 border border-indigo-200 text-indigo-700 disabled:opacity-50 rounded-lg font-bold transition flex items-center justify-center space-x-1.5 cursor-pointer text-xs"
              >
                <ArrowDownToLine className={`w-3.5 h-3.5 ${syncingNumbers ? 'animate-bounce' : ''}`} />
                <span>{syncingNumbers ? 'Syncing Purchased Numbers...' : 'Sync Purchased Numbers'}</span>
              </button>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Select Phone Number</label>
                <select
                  disabled={numbersLoading}
                  value={assignNumId}
                  onChange={(e) => setAssignNumId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none cursor-pointer font-bold"
                >
                  <option value="">-- Choose Virtual Trunk Line --</option>
                  {assignableNumbers.map(n => (
                    <option key={n.id} value={n.id}>
                      {n.number} (Unassigned Pool)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Select Tenant Organization</label>
                <select
                  disabled={companiesLoading}
                  value={assignCompanyId}
                  onChange={(e) => setAssignCompanyId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none cursor-pointer font-bold"
                >
                  <option value="">-- Choose Tenant Company --</option>
                  {companies.map(c => (
                    <option key={c.tenantId} value={c.tenantId}>{c.businessName}</option>
                  ))}
                </select>
              </div>

              {assignCompanyId && (() => {
                const subaccount = companySubaccounts.find((item) => item.companyId === assignCompanyId);
                return (
                  <div className={`rounded-lg border p-2.5 text-[10px] ${subaccount ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-indigo-100 bg-indigo-50 text-indigo-700'}`}>
                    {subaccount
                      ? `Plivo subaccount ready: ${subaccount.providerSubaccountId} (${subaccount.phoneNumbersCount} number${subaccount.phoneNumbersCount === 1 ? '' : 's'})`
                      : 'A secure Plivo subaccount and application will be created automatically during the first assignment.'}
                  </div>
                );
              })()}

              <button
                type="submit"
                disabled={submitting || !assignNumId || !assignCompanyId}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-lg font-bold transition shadow-md shadow-indigo-100/50 flex items-center justify-center space-x-1.5 cursor-pointer text-xs"
              >
                <UserCheck className="w-3.5 h-3.5" />
                <span>Assign DID to Company</span>
              </button>
            </form>
          </div>

          {/* Map details table */}
          <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-3">Active Enterprise Mappings</h3>
            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[9px]">
                    <th className="pb-2">Phone line</th>
                    <th className="pb-2">Associated Tenant Org</th>
                    <th className="pb-2">Plivo Subaccount</th>
                    <th className="pb-2">Carrier Provider</th>
                    <th className="pb-2 text-right">Mapping Control</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold">
                  {numbers.filter(num => num.companyId).map(num => (
                    <tr key={num.id} className="hover:bg-slate-50/50">
                      <td className="py-2.5 font-bold font-mono text-slate-800">{num.number}</td>
                      <td className="py-2.5">
                        <span className="text-indigo-600 font-bold bg-indigo-50 border border-indigo-100 px-2.5 py-0.5 rounded text-[10px]">
                          {num.companyName}
                        </span>
                      </td>
                      <td className="py-2.5 font-mono text-[10px] text-slate-500">{num.subaccountAuthId || 'Main account'}</td>
                      <td className="py-2.5 text-slate-500">{num.provider}</td>
                      <td className="py-2.5 text-right">
                        <button
                          onClick={() => releaseNumber(num.id)}
                          className="text-red-500 hover:text-red-700 hover:underline cursor-pointer font-bold text-[11px]"
                        >
                          Unassign / Revoke DID
                        </button>
                      </td>
                    </tr>
                  ))}
                  {numbers.filter(num => num.companyId).length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-400 italic">
                        No active enterprise trunk mappings found. Assign a number above to start routing.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {editingAccount && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form onSubmit={updateAccount} className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div><h3 className="font-black text-slate-900">Edit Telephony Provider</h3><p className="text-xs text-slate-400">Update all provider connection parameters.</p></div>
              <button type="button" onClick={() => setEditingAccount(null)} className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            {(['name', 'authId', 'authToken', 'baseUrl', 'applicationId', 'answerUrl', 'hangupUrl', 'recordingCallbackUrl'] as const).map((field) => (
              <div key={field}>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">{
                  field === 'authId' ? 'Auth ID' : field === 'authToken' ? 'Auth Token'
                    : field === 'baseUrl' ? 'Base URL' : field === 'applicationId' ? 'Main Application ID (Optional)'
                      : field === 'answerUrl' ? 'Answer URL' : field === 'hangupUrl' ? 'Hangup URL'
                        : field === 'recordingCallbackUrl' ? 'Recording Callback URL' : 'Provider Name'
                }</label>
                <input type={field.toLowerCase().includes('url') ? 'url' : 'text'} required={field !== 'applicationId'} value={editingAccount[field]} onChange={(e) => setEditingAccount({ ...editingAccount, [field]: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:border-indigo-500 font-mono" />
              </div>
            ))}
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Status</label>
              <select value={editingAccount.status} onChange={(e) => setEditingAccount({ ...editingAccount, status: e.target.value as TelephonyAccountApiData['status'] })} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none">
                <option value="connected">Connected</option><option value="disconnected">Disconnected</option><option value="error">Error</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditingAccount(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-xs font-bold cursor-pointer">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold disabled:opacity-60 cursor-pointer">{submitting ? 'Saving...' : 'Save Changes'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
