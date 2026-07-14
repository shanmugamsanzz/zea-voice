/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useAppState } from '../../store/AppState';
import { 
  MOCK_COMPANIES, 
  MOCK_DEVELOPERS, 
  MOCK_PROVIDERS, 
  MOCK_PHONE_NUMBERS, 
  MOCK_QUEUES, 
  MOCK_PAYMENTS, 
  ACTIVE_MONITORING_CALLS, 
  COMPLETED_CALL_LOGS 
} from '../../lib/mockData';
import { Company, PhoneNumber, PaymentRecord, Developer, ProviderConfig } from '../../types';
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
import { CallVolumeChart, OutcomePieChart, LatencyBreakdownChart } from '../charts/DashboardCharts';

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
      return <DevelopersListView />;
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
  
  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Active Organizations</span>
          <div className="flex items-center justify-between mt-2">
            <h4 className="text-2xl font-extrabold text-slate-800">{MOCK_COMPANIES.length} Companies</h4>
            <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
              <Building2 className="w-4.5 h-4.5" />
            </div>
          </div>
          <span className="text-xs text-slate-500 mt-2 block font-medium">2 pending registrations</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">In-Flight Calls</span>
          <div className="flex items-center justify-between mt-2">
            <h4 className="text-2xl font-extrabold text-slate-800">{ACTIVE_MONITORING_CALLS.length} Concurrent</h4>
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100 animate-pulse">
              <Activity className="w-4.5 h-4.5" />
            </div>
          </div>
          <span className="text-xs text-slate-500 mt-2 block font-medium">13 waiting in queue trunks</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Avg Gateway Latency</span>
          <div className="flex items-center justify-between mt-2">
            <h4 className="text-2xl font-extrabold text-slate-800">495 ms</h4>
            <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
              <Zap className="w-4.5 h-4.5" />
            </div>
          </div>
          <span className="text-xs text-slate-500 mt-2 block font-medium">LLM Bottleneck: ~310ms</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Platform Revenue (MRR)</span>
          <div className="flex items-center justify-between mt-2">
            <h4 className="text-2xl font-extrabold text-slate-800">₹2,051,760.00</h4>
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100">
              <Coins className="w-4.5 h-4.5" />
            </div>
          </div>
          <span className="text-xs text-emerald-600 font-bold mt-2 block">↑ 18.2% this quarter</span>
        </div>
      </div>

      {/* Main Stats Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-800 tracking-tight">Global Call Traffic Volumes</h3>
            <span className="text-xs font-semibold text-slate-400">Past 12 Hours</span>
          </div>
          <CallVolumeChart />
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-800 tracking-tight">Voice Output Disposition</h3>
            <span className="text-xs font-semibold text-slate-400">All Tenants</span>
          </div>
          <OutcomePieChart />
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
                {MOCK_COMPANIES.slice(0, 4).map((c) => (
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
            {ACTIVE_MONITORING_CALLS.slice(0, 2).map((call) => (
              <div key={call.id} className="border border-slate-200 rounded-xl p-4 bg-slate-50/30 hover:bg-slate-50 transition duration-200 cursor-pointer" onClick={() => setView('call-monitoring')}>
                <div className="flex justify-between items-start text-[11px]">
                  <div>
                    <span className="font-bold text-slate-800 block">{call.companyName}</span>
                    <span className="text-slate-400 font-semibold">Agent: {call.agentName}</span>
                  </div>
                  <span className="bg-emerald-50 text-emerald-700 border border-emerald-100 text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase">
                    Connected · {call.duration}s
                  </span>
                </div>
                {call.transcript && call.transcript.length > 0 && (
                  <div className="mt-2 text-[11px] bg-white border border-slate-250 rounded-lg p-2.5 text-slate-500 italic font-medium truncate">
                    "{call.transcript[call.transcript.length - 1].text}"
                  </div>
                )}
              </div>
            ))}
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
  const [companies, setCompanies] = useState<Company[]>(MOCK_COMPANIES);
  const [search, setSearch] = useState('');
  const [filterTier, setFilterTier] = useState('All');

  // Modal & Form States (pre-filled with the user's requested data for instant confirmation/creation)
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [firstName, setFirstName] = useState('Julia');
  const [lastName, setLastName] = useState('Gold');
  const [email, setEmail] = useState('youandmematchmaker@gmail.com');
  const [businessName, setBusinessName] = useState('You and Me Matchmaking');
  const [businessPhone, setBusinessPhone] = useState('(215) 595-6697');
  const [address, setAddress] = useState('679 Baldwin Ln, Langhorne PA 19047');
  const [state, setState] = useState('Pennsylvania');
  const [country, setCountry] = useState('United States');
  const [zip, setZip] = useState('19047');
  const [website, setWebsite] = useState('www.youandmematchmaker.com');
  const [timezone, setTimezone] = useState('America/New York(UTC-04:00)');
  const [billingTier, setBillingTier] = useState<'Starter' | 'Pro' | 'Enterprise'>('Enterprise');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleCreateCompany = (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName || !email) return;

    const newCompany: Company = {
      id: `comp-${Date.now()}`,
      name: businessName,
      status: 'active',
      billingTier,
      createdAt: new Date().toISOString().split('T')[0],
      developersCount: 1,
      creditsBalance: 5000, // Pre-seeded testing credits
      phoneNumbersCount: 0,
      monthlySpend: 0,
      primaryContact: `${firstName} ${lastName} (${email})`,
      firstName,
      lastName,
      email,
      businessPhone,
      address,
      state,
      country,
      zip,
      website,
      timezone
    };

    // Store in global mock list
    MOCK_COMPANIES.push(newCompany);
    // Refresh local component list state
    setCompanies([...MOCK_COMPANIES]);

    setSuccessMessage(`Organization "${businessName}" successfully created!`);
    setTimeout(() => {
      setSuccessMessage(null);
      setIsModalOpen(false);
    }, 2000);
  };

  const filtered = companies.filter(c => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase());
    const matchesTier = filterTier === 'All' || c.billingTier === filterTier;
    return matchesSearch && matchesTier;
  });

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
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 outline-none w-full md:w-56 focus:bg-white focus:border-indigo-500 transition"
            />
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
          </div>
          <select
            value={filterTier}
            onChange={(e) => setFilterTier(e.target.value)}
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
            {filtered.map((c) => (
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
                  <button
                    onClick={() => setSelectedCompanyId(c.id)}
                    className="px-3 py-1.5 bg-slate-50 group-hover:bg-indigo-50 text-slate-600 group-hover:text-indigo-600 rounded-lg font-bold transition flex items-center space-x-1 ml-auto cursor-pointer"
                  >
                    <span>Inspect</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
                        <option value="Starter">Starter</option>
                        <option value="Pro">Pro</option>
                        <option value="Enterprise">Enterprise</option>
                      </select>
                    </div>
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
                        required
                        value={country}
                        onChange={(e) => setCountry(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                        placeholder="Country"
                      />
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
                      required
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-3 py-2 outline-none font-semibold text-slate-800"
                      placeholder="e.g. America/New York"
                    />
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
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition cursor-pointer text-xs shadow-md shadow-indigo-100"
                >
                  Confirm Provisioning
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
  const company = MOCK_COMPANIES.find(c => c.id === companyId);
  if (!company) return <div>Company not found.</div>;

  const [balance, setBalance] = useState(company.creditsBalance);
  const [adjustAmount, setAdjustAmount] = useState('100');
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const developers = MOCK_DEVELOPERS.filter(d => d.companyId === companyId);
  const numbers = MOCK_PHONE_NUMBERS.filter(num => num.assignedTo?.includes(company.name) || num.id === 'num-1');

  const adjustCredits = (direction: 'add' | 'subtract') => {
    const amt = parseFloat(adjustAmount);
    if (isNaN(amt) || amt <= 0) return;
    const finalBalance = direction === 'add' ? balance + amt : Math.max(0, balance - amt);
    setBalance(finalBalance);
    setSuccessMsg(`Balance adjusted successfully to ₹${finalBalance.toLocaleString()}`);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

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
                  <a href={`https://${company.website}`} target="_blank" rel="noopener noreferrer">{company.website}</a>
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
   3. DEVELOPERS LIST VIEW
   ========================================== */
function DevelopersListView() {
  const [developers, setDevelopers] = useState<Developer[]>(MOCK_DEVELOPERS);
  const [devName, setDevName] = useState('');
  const [devEmail, setDevEmail] = useState('');
  const [devPassword, setDevPassword] = useState('');
  const [inviteCompany, setInviteCompany] = useState(MOCK_COMPANIES[0]?.id || '');
  const [success, setSuccess] = useState<string | null>(null);

  const handleCreateDeveloper = (e: React.FormEvent) => {
    e.preventDefault();
    if (!devName.trim() || !devEmail.trim() || !devPassword.trim()) return;

    const compName = MOCK_COMPANIES.find(c => c.id === inviteCompany)?.name || 'Unknown Corp';

    const newDev: Developer = {
      id: `dev-${Date.now()}`,
      name: devName,
      email: devEmail,
      companyId: inviteCompany,
      companyName: compName,
      status: 'active',
      lastActive: 'Never',
      role: 'member',
      password: devPassword
    };

    MOCK_DEVELOPERS.unshift(newDev);
    setDevelopers([...MOCK_DEVELOPERS]);
    setSuccess(`Developer user "${devName}" created successfully!`);
    
    // Clear inputs
    setDevName('');
    setDevEmail('');
    setDevPassword('');
    
    setTimeout(() => setSuccess(null), 3000);
  };

  const toggleDevStatus = (id: string) => {
    // Find inside MOCK_DEVELOPERS too so that status updates persist correctly
    const foundDev = MOCK_DEVELOPERS.find(d => d.id === id);
    if (foundDev) {
      foundDev.status = foundDev.status === 'active' ? 'inactive' : 'active';
    }
    setDevelopers([...MOCK_DEVELOPERS]);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Create Developer form */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-fit space-y-4">
        <div>
          <h2 className="text-md font-bold text-slate-800 tracking-tight">Create Tenant Developer</h2>
          <p className="text-xs text-slate-400 mt-0.5 font-medium">Create direct user login credentials for a specific company tenant account.</p>
        </div>

        {success && (
          <div className="p-2.5 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs font-semibold">
            {success}
          </div>
        )}

        <form onSubmit={handleCreateDeveloper} className="space-y-4 text-xs font-semibold">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Developer Full Name</label>
            <input
              type="text"
              required
              value={devName}
              onChange={(e) => setDevName(e.target.value)}
              placeholder="e.g. John Doe"
              className="w-full bg-slate-50 border border-slate-200 focus:bg-white rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:border-indigo-500 transition"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Developer E-mail (Login ID)</label>
            <input
              type="email"
              required
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              placeholder="developer@acme.com"
              className="w-full bg-slate-50 border border-slate-200 focus:bg-white rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:border-indigo-500 transition"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Login Password</label>
            <input
              type="text"
              required
              value={devPassword}
              onChange={(e) => setDevPassword(e.target.value)}
              placeholder="e.g. devSecure123"
              className="w-full bg-slate-50 border border-slate-200 focus:bg-white rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:border-indigo-500 transition"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Assign Tenant Organization</label>
            <select
              value={inviteCompany}
              onChange={(e) => setInviteCompany(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none cursor-pointer font-bold"
            >
              {MOCK_COMPANIES.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-md shadow-indigo-100/50 flex items-center justify-center space-x-1.5 cursor-pointer"
          >
            <UserCheck className="w-4 h-4" />
            <span>Create Developer Account</span>
          </button>
        </form>
      </div>

      {/* Developer directory */}
      <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h2 className="text-md font-bold text-slate-800 mb-3 tracking-tight">Global Developer Index</h2>
        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[9px]">
                <th className="pb-2">Developer</th>
                <th className="pb-2">Tenant Association</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Last Sync</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-semibold">
              {developers.map(dev => (
                <tr key={dev.id} className="hover:bg-slate-50/50">
                  <td className="py-2.5">
                    <span className="font-bold text-slate-800 block">{dev.name}</span>
                    <span className="text-[10px] text-slate-400 font-mono font-medium block">{dev.email}</span>
                    {dev.password && (
                      <span className="text-[10px] text-indigo-600 font-mono font-bold block mt-0.5 bg-indigo-50/50 border border-indigo-100/50 px-1 py-0.5 rounded w-fit">Key: {dev.password}</span>
                    )}
                  </td>
                  <td className="py-2.5 text-slate-700">{dev.companyName}</td>
                  <td className="py-2.5">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${
                      dev.status === 'active' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' :
                      dev.status === 'invited' ? 'bg-indigo-50 border-indigo-100 text-indigo-600' : 'bg-slate-100 border-slate-200 text-slate-500'
                    }`}>
                      {dev.status}
                    </span>
                  </td>
                  <td className="py-2.5 text-slate-500 font-mono text-[10px]">{dev.lastActive}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => toggleDevStatus(dev.id)}
                      className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition border cursor-pointer ${
                        dev.status === 'active' ? 'bg-red-50 border-red-100 text-red-600 hover:bg-red-100' : 'bg-emerald-50 border-emerald-100 text-emerald-600 hover:bg-emerald-100'
                      }`}
                    >
                      {dev.status === 'active' ? 'Revoke' : 'Re-approve'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ==========================================
   4. VOICE PROVIDERS VIEW
   ========================================== */
function VoiceProvidersView() {
  const [providers, setProviders] = useState(MOCK_PROVIDERS);
  
  // Add Provider State
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<'telephony' | 'llm' | 'tts' | 'stt'>('tts');
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'error'>('connected');
  
  // Dynamic Parameters state list
  const [parameters, setParameters] = useState<Array<{ key: string; value: string }>>([]);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const toggleProviderStatus = (id: string) => {
    setProviders(providers.map(p => {
      if (p.id === id) {
        const nextStatus = p.status === 'connected' ? 'disconnected' : 'connected';
        return { ...p, status: nextStatus, latency: nextStatus === 'connected' ? '120ms' : 'N/A' };
      }
      return p;
    }));
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

  const handleCreateProvider = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    // Filter out blank parameters
    const finalParameters = parameters.filter(p => p.key.trim() !== '');

    const newProvider: ProviderConfig = {
      id: `p-${Date.now()}`,
      name,
      type,
      status,
      latency: status === 'connected' ? '110ms' : 'N/A',
      usageCount: 0,
      parameters: finalParameters
    };

    // Append to global mock storage & local list state
    MOCK_PROVIDERS.unshift(newProvider);
    setProviders([...MOCK_PROVIDERS]);

    // Success feedback
    setSuccessMsg(`Voice provider "${name}" has been successfully configured!`);
    
    // Clear inputs
    setName('');
    setType('tts');
    setStatus('connected');
    setParameters([]);

    setTimeout(() => {
      setSuccessMsg(null);
      setShowAddForm(false);
    }, 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">AI & SIP Providers Engine</h2>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Control global integration pathways, monitor latency profiles, and toggle gateway servers.</p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2.5 text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer shadow-sm shadow-indigo-100"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Provider</span>
        </button>
      </div>

      {/* NEW PROVIDER PROVISIONING CARD */}
      {showAddForm && (
        <div className="bg-white border-2 border-indigo-100 rounded-2xl p-6 shadow-xl animate-in fade-in duration-200 space-y-5">
          <div className="flex justify-between items-start border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">Configure New Voice / AI Provider</h3>
              <p className="text-[10px] text-slate-400 font-medium mt-0.5">Provision gateway endpoints, latency tunnels, and operational keys.</p>
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
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition cursor-pointer text-xs shadow-md shadow-indigo-100"
              >
                Confirm & Create Provider
              </button>
            </div>
          </form>
        </div>
      )}

      {/* PROVIDERS GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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
              {p.parameters && p.parameters.length > 0 && (
                <div className="mt-3.5 bg-slate-50 p-3 rounded-lg border border-slate-200/60 font-sans">
                  <span className="text-[9px] text-slate-400 font-extrabold uppercase tracking-widest block mb-2">Configured Keys & Vars</span>
                  <div className="space-y-1.5 text-[10px] font-mono">
                    {p.parameters.map((param, index) => (
                      <div key={index} className="flex justify-between items-center text-slate-600 border-b border-slate-100 pb-1 last:border-0 last:pb-0">
                        <span className="font-bold text-slate-500">{param.key}</span>
                        <span className="text-slate-800 bg-white px-1.5 py-0.5 rounded border border-slate-200 select-all truncate max-w-[130px]" title={param.value}>
                          {param.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs font-semibold mt-4 bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase font-bold">Latency</span>
                  <span className="text-slate-700 font-mono text-[11px] font-bold">{p.latency}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase font-bold">Invocations</span>
                  <span className="text-slate-700 font-mono text-[11px] font-bold">{p.usageCount.toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 mt-4 flex justify-between items-center">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">Trunk Relay v2</span>
              <button
                onClick={() => toggleProviderStatus(p.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition border cursor-pointer ${
                  p.status === 'connected' ? 'bg-red-50 border-red-100 text-red-600 hover:bg-red-100' : 'bg-emerald-50 border-emerald-100 text-emerald-700 hover:bg-emerald-100'
                }`}
              >
                {p.status === 'connected' ? 'Shut Down' : 'Boot Trunk'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <h3 className="font-bold text-slate-800 mb-4">Gateway Latency Profiler</h3>
        <LatencyBreakdownChart />
      </div>
    </div>
  );
}

/* ==========================================
   5. PHONE NUMBERS VIEW
   ========================================== */
function PhoneNumbersView() {
  const [activeSubTab, setActiveSubTab] = useState<'telephony' | 'assign'>('telephony');
  const [numbers, setNumbers] = useState<PhoneNumber[]>(MOCK_PHONE_NUMBERS);
  const [buyAreaCode, setBuyAreaCode] = useState('312');
  const [purchasedMsg, setPurchasedMsg] = useState<string | null>(null);

  // Telephony credentials state
  const [telephonyProviders, setTelephonyProviders] = useState<Array<{ id: string; name: string; authId: string; authToken: string; createdAt: string }>>([
    { id: 'tp-1', name: 'Twilio USA SIP', authId: 'AC7d9a1f2e3b4c5d6e', authToken: '8a9b0c1d2e3f4a5b6c7d8e9f', createdAt: '2026-05-12' },
    { id: 'tp-2', name: 'Plivo Global Gateway', authId: 'PL8a9b0c1d2e3f4a', authToken: '2e3f4a5b6c7d8e9f0a1b2c3d', createdAt: '2026-06-20' }
  ]);
  const [showTokens, setShowTokens] = useState<{ [key: string]: boolean }>({});

  // Add Telephony Provider state
  const [newProvName, setNewProvName] = useState('');
  const [newAuthId, setNewAuthId] = useState('');
  const [newAuthToken, setNewAuthToken] = useState('');
  const [provSuccess, setProvSuccess] = useState<string | null>(null);

  // Selected lease platform
  const [selectedLeaseProvider, setSelectedLeaseProvider] = useState('Twilio USA SIP');

  // Assign form state
  const [assignNumId, setAssignNumId] = useState(MOCK_PHONE_NUMBERS[0]?.id || '');
  const [assignCompanyId, setAssignCompanyId] = useState(MOCK_COMPANIES[0]?.id || '');
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);

  const handleAddTelephonyProvider = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProvName.trim() || !newAuthId.trim() || !newAuthToken.trim()) return;

    const newTp = {
      id: `tp-${Date.now()}`,
      name: newProvName.trim(),
      authId: newAuthId.trim(),
      authToken: newAuthToken.trim(),
      createdAt: new Date().toISOString().split('T')[0]
    };

    setTelephonyProviders([...telephonyProviders, newTp]);
    setProvSuccess(`Telephony integration provider "${newProvName}" added successfully!`);
    
    setNewProvName('');
    setNewAuthId('');
    setNewAuthToken('');

    setTimeout(() => setProvSuccess(null), 3000);
  };

  const simulatePurchase = () => {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const mockNum = `+1 (${buyAreaCode}) 555-${randomSuffix}`;
    const newNum: PhoneNumber = {
      id: `num-${Date.now()}`,
      number: mockNum,
      provider: selectedLeaseProvider,
      type: 'Bidirectional',
      status: 'active',
      monthlyCost: 2.50
    };
    
    MOCK_PHONE_NUMBERS.unshift(newNum);
    setNumbers([...MOCK_PHONE_NUMBERS]);
    setPurchasedMsg(`Succeeded! Number ${mockNum} bought via ${selectedLeaseProvider} and placed in unassigned reserve pools.`);
    setTimeout(() => setPurchasedMsg(null), 3500);
  };

  const releaseNumber = (id: string) => {
    const numberObj = MOCK_PHONE_NUMBERS.find(n => n.id === id);
    if (numberObj) {
      const oldAssigneeName = numberObj.assignedTo;
      if (oldAssigneeName) {
        const oldCompany = MOCK_COMPANIES.find(c => c.name === oldAssigneeName);
        if (oldCompany && oldCompany.phoneNumbersCount > 0) {
          oldCompany.phoneNumbersCount--;
        }
      }
      numberObj.assignedTo = undefined;
      numberObj.status = 'released';
      setNumbers([...MOCK_PHONE_NUMBERS]);
    }
  };

  const handleAssignNumber = (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignNumId || !assignCompanyId) return;

    const targetCompany = MOCK_COMPANIES.find(c => c.id === assignCompanyId);
    const targetNum = MOCK_PHONE_NUMBERS.find(n => n.id === assignNumId);

    if (targetCompany && targetNum) {
      const oldAssigneeName = targetNum.assignedTo;
      
      // Update company stats: decrement the old company's count if there was one
      if (oldAssigneeName) {
        const oldCompany = MOCK_COMPANIES.find(c => c.name === oldAssigneeName);
        if (oldCompany && oldCompany.phoneNumbersCount > 0) {
          oldCompany.phoneNumbersCount--;
        }
      }

      // Assign to the new company
      targetNum.assignedTo = targetCompany.name;
      targetNum.status = 'active';

      // Increment new company's phone count
      targetCompany.phoneNumbersCount++;

      // Refresh list
      setNumbers([...MOCK_PHONE_NUMBERS]);
      setAssignSuccess(`Routed virtual line ${targetNum.number} to ${targetCompany.name}!`);
      setTimeout(() => setAssignSuccess(null), 3000);
    }
  };

  const toggleTokenVisibility = (id: string) => {
    setShowTokens(prev => ({ ...prev, [id]: !prev[id] }));
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
          <span>Telephony Providers & DID Leases</span>
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
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Auth ID (Account SID)</label>
                  <input
                    type="text"
                    required
                    value={newAuthId}
                    onChange={(e) => setNewAuthId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                    placeholder="e.g. AC8a9f..."
                  />
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

                <button
                  type="submit"
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer text-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Save Telephony Provider</span>
                </button>
              </form>
            </div>

            {/* Lease DID form */}
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <div>
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider">Lease Telephony SIP DID</h3>
                <p className="text-[10px] text-slate-400 mt-0.5 font-medium">Instantly lease inbound virtual phone lines from active carriers.</p>
              </div>

              {purchasedMsg && (
                <div className="p-2.5 bg-indigo-50 text-indigo-800 border border-indigo-100 rounded-lg text-xs font-semibold">
                  {purchasedMsg}
                </div>
              )}

              <div className="space-y-3 text-xs font-semibold">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Active Gateway Carrier</label>
                  <select
                    value={selectedLeaseProvider}
                    onChange={(e) => setSelectedLeaseProvider(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none cursor-pointer font-bold"
                  >
                    {telephonyProviders.map(tp => (
                      <option key={tp.id} value={tp.name}>{tp.name}</option>
                    ))}
                    <option value="Twilio">Twilio General</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Target Area Code</label>
                  <input
                    type="text"
                    maxLength={3}
                    value={buyAreaCode}
                    onChange={(e) => setBuyAreaCode(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition font-mono"
                    placeholder="e.g. 415"
                  />
                </div>

                <button
                  onClick={simulatePurchase}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-md shadow-indigo-100/50 flex items-center justify-center space-x-1.5 cursor-pointer"
                >
                  <Phone className="w-3.5 h-3.5" />
                  <span>Search & Buy Number (₹200/mo)</span>
                </button>
              </div>
            </div>
          </div>

          {/* Right section: Registered Providers + Global DID Inventory */}
          <div className="lg:col-span-2 space-y-6">
            {/* Providers credentials list */}
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-3">Carrier Integrations</h3>
              <div className="space-y-3">
                {telephonyProviders.map(tp => (
                  <div key={tp.id} className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                    <div className="space-y-1">
                      <span className="font-bold text-slate-800 block text-xs">{tp.name}</span>
                      <div className="flex flex-col space-y-0.5 text-[10px] font-mono text-slate-500">
                        <span>Auth ID: <strong className="text-slate-700">{tp.authId}</strong></span>
                        <span className="flex items-center space-x-1.5">
                          <span>Token: </span>
                          <strong className="text-slate-700">
                            {showTokens[tp.id] ? tp.authToken : '••••••••••••••••••••'}
                          </strong>
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => toggleTokenVisibility(tp.id)}
                      className="text-[10px] bg-white border border-slate-200 hover:border-slate-300 text-slate-600 hover:text-slate-900 rounded-lg px-2 py-1 font-bold transition cursor-pointer flex items-center space-x-1"
                    >
                      <Eye className="w-3 h-3" />
                      <span>{showTokens[tp.id] ? 'Hide Token' : 'Show Token'}</span>
                    </button>
                  </div>
                ))}
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
                    {numbers.map(num => (
                      <tr key={num.id} className="hover:bg-slate-50/50">
                        <td className="py-2.5 font-bold font-mono text-slate-800">{num.number}</td>
                        <td className="py-2.5 text-slate-500 font-semibold">{num.provider}</td>
                        <td className="py-2.5">
                          {num.assignedTo ? (
                            <span className="text-indigo-600 font-bold border border-indigo-100 bg-indigo-50 px-2 py-0.5 rounded text-[10px]">
                              {num.assignedTo}
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
                          {num.status === 'active' && (
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
                  </tbody>
                </table>
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
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Select Phone Number</label>
                <select
                  value={assignNumId}
                  onChange={(e) => setAssignNumId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none cursor-pointer font-bold"
                >
                  <option value="">-- Choose Virtual Trunk Line --</option>
                  {numbers.map(n => (
                    <option key={n.id} value={n.id}>
                      {n.number} ({n.assignedTo ? `Assigned: ${n.assignedTo}` : 'Unassigned Pool'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Select Tenant Organization</label>
                <select
                  value={assignCompanyId}
                  onChange={(e) => setAssignCompanyId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none cursor-pointer font-bold"
                >
                  <option value="">-- Choose Tenant Company --</option>
                  {MOCK_COMPANIES.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-md shadow-indigo-100/50 flex items-center justify-center space-x-1.5 cursor-pointer text-xs"
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
                    <th className="pb-2">Carrier Provider</th>
                    <th className="pb-2 text-right">Mapping Control</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold">
                  {numbers.filter(num => num.assignedTo).map(num => (
                    <tr key={num.id} className="hover:bg-slate-50/50">
                      <td className="py-2.5 font-bold font-mono text-slate-800">{num.number}</td>
                      <td className="py-2.5">
                        <span className="text-indigo-600 font-bold bg-indigo-50 border border-indigo-100 px-2.5 py-0.5 rounded text-[10px]">
                          {num.assignedTo}
                        </span>
                      </td>
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
                  {numbers.filter(num => num.assignedTo).length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-400 italic">
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
    </div>
  );
}

/* ==========================================
   6. CREDITS MANAGER VIEW
   ========================================== */
function CreditsManagerView() {
  const [rateOutbound, setRateOutbound] = useState('12.00');
  const [rateInbound, setRateInbound] = useState('6.40');
  const [ledgerLog, setLedgerLog] = useState([
    { company: 'Acme Voice Systems', action: 'Injected Manual Balance', amount: 500, user: 'Admin Alice', date: '2026-07-09 11:22' },
    { company: 'Globex Logistics LLC', action: 'Credit Refill Purchase', amount: 5000, user: 'API Stripe Gateway', date: '2026-07-05 13:40' },
    { company: 'Initech Retail Corp', action: 'Injected Promotional Credit', amount: 50, user: 'Supervisor Bob', date: '2026-07-02 09:15' }
  ]);
  const [success, setSuccess] = useState<string | null>(null);

  const savePricingRules = () => {
    setSuccess('Global platform pricing limits saved successfully!');
    setTimeout(() => setSuccess(null), 3000);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Rate configurator */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-fit space-y-4">
        <div>
          <h2 className="text-md font-bold text-slate-800 tracking-tight">Global Pricing Rates</h2>
          <p className="text-xs text-slate-400 mt-0.5 font-medium">Adjust default pricing thresholds per minute for voice gateways.</p>
        </div>

        {success && (
          <div className="p-2.5 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs font-semibold animate-in fade-in">
            {success}
          </div>
        )}

        <div className="space-y-4 text-xs font-semibold">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Inbound Calling Minute Rate (₹)</label>
            <input
              type="text"
              value={rateInbound}
              onChange={(e) => setRateInbound(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Outbound Campaign Minute Rate (₹)</label>
            <input
              type="text"
              value={rateOutbound}
              onChange={(e) => setRateOutbound(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition"
            />
          </div>

          <button
            onClick={savePricingRules}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-md shadow-indigo-100/50 cursor-pointer"
          >
            Save Pricing Rules
          </button>
        </div>
      </div>

      {/* Audit ledger logs */}
      <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h2 className="text-md font-bold text-slate-800 mb-3 tracking-tight">Balance Injection Audit Ledger</h2>
        <div className="space-y-3 text-xs">
          {ledgerLog.map((log, idx) => (
            <div key={idx} className="border border-slate-200 p-3.5 rounded-xl bg-slate-50/30 flex justify-between items-center font-semibold">
              <div>
                <span className="font-bold text-slate-800 block">{log.company}</span>
                <span className="text-[10px] text-slate-500 font-semibold">{log.action} · Triggered by: {log.user}</span>
                <span className="text-[9px] text-slate-400 font-mono block mt-0.5">{log.date}</span>
              </div>
              <span className="text-sm font-black text-emerald-600 font-mono">
                +₹{log.amount.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ==========================================
   7. QUEUE MONITOR VIEW
   ========================================== */
function QueueMonitorView() {
  const [queues, setQueues] = useState(MOCK_QUEUES);

  const triggerEmergencyFlush = (id: string) => {
    setQueues(queues.map(q => {
      if (q.id === id) {
        return { ...q, waitingCalls: 0, maxWaitTime: 0, status: 'normal' as any };
      }
      return q;
    }));
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h2 className="text-xl font-bold text-slate-800 tracking-tight">Active Queue Trunks Monitor</h2>
        <p className="text-xs text-slate-400 font-medium mt-0.5">Observe current line traffic, concurrent SIP registration queues, and channel answer lags.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {queues.map((q) => (
          <div key={q.id} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex flex-col justify-between hover:shadow-md transition duration-200">
            <div>
              <div className="flex justify-between items-start">
                <h4 className="font-bold text-slate-800 text-sm tracking-tight">{q.name}</h4>
                <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                  q.status === 'normal' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' :
                  q.status === 'congested' ? 'bg-amber-50 border-amber-100 text-amber-700' : 'bg-red-50 border-red-100 text-red-700 animate-pulse'
                }`}>
                  {q.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-semibold mt-4">
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Talking channels</span>
                  <span className="text-slate-800 font-bold text-lg">{q.activeCalls} Active</span>
                </div>
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Trunk Holding</span>
                  <span className="text-slate-800 font-bold text-lg text-rose-500">{q.waitingCalls} Queued</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-semibold mt-2.5">
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Avg Queue Wait</span>
                  <span className="text-slate-800 font-mono text-[11px] font-bold">{q.avgWaitTime} seconds</span>
                </div>
                <div className="bg-slate-50/50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Max Holding Hold</span>
                  <span className="text-slate-800 font-mono text-[11px] text-amber-500 font-bold">{q.maxWaitTime} seconds</span>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 mt-4 flex justify-between items-center">
              <span className="text-[10px] text-slate-400 font-bold uppercase">Trunk SLA Monitor</span>
              {q.waitingCalls > 0 && (
                <button
                  onClick={() => triggerEmergencyFlush(q.id)}
                  className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 border border-rose-100 text-rose-600 rounded-lg text-xs font-bold transition flex items-center space-x-1 cursor-pointer"
                >
                  <span>Emergency Flush</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ==========================================
   8. CALL MONITORING VIEW (LIVE INTERCEPT)
   ========================================== */
function CallMonitoringView() {
  const [activeCalls, setActiveCalls] = useState(ACTIVE_MONITORING_CALLS);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(ACTIVE_MONITORING_CALLS[0]?.id || null);

  const selectedCall = activeCalls.find(c => c.id === selectedCallId);

  const simulateLiveDialogue = () => {
    if (!selectedCall || !selectedCall.transcript) return;
    const phrases = [
      { speaker: 'user' as const, text: 'Okay, that scheduling actually looks great! Put me down for 10 AM tomorrow morning.', time: '0:54' },
      { speaker: 'agent' as const, text: 'Awesome! I have secured your reservation for 10:00 AM on July 10th. A confirmation e-mail is on its way. Have an incredible rest of your day!', time: '1:02' }
    ];

    // Append to transcript
    setActiveCalls(activeCalls.map(c => {
      if (c.id === selectedCallId) {
        const existing = c.transcript || [];
        const nextIdx = existing.length - 6; // start append
        if (nextIdx < phrases.length && nextIdx >= 0) {
          return {
            ...c,
            duration: c.duration + 12,
            transcript: [...existing, phrases[nextIdx]]
          };
        }
      }
      return c;
    }));
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Active sessions list */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4 h-[calc(100vh-120px)] overflow-y-auto">
        <div>
          <h2 className="text-md font-bold text-slate-800 tracking-tight">In-Flight Call Channels</h2>
          <p className="text-xs text-slate-400 mt-0.5 font-medium">Select an ongoing call stream to intercept live and monitor transcripts.</p>
        </div>

        <div className="space-y-3">
          {activeCalls.map((call) => (
            <div
              key={call.id}
              onClick={() => setSelectedCallId(call.id)}
              className={`border rounded-xl p-3.5 cursor-pointer transition text-xs font-semibold ${
                selectedCallId === call.id
                  ? 'border-indigo-300 bg-indigo-50/30 shadow-sm'
                  : 'border-slate-200 bg-slate-50/50 hover:bg-slate-50'
              }`}
            >
              <div className="flex justify-between items-start">
                <span className="font-bold text-slate-800 block">{call.companyName}</span>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide border ${
                  call.status === 'connected' ? 'bg-emerald-50 border-emerald-100 text-emerald-600 animate-pulse' : 'bg-amber-50 border-amber-100 text-amber-600'
                }`}>
                  {call.status}
                </span>
              </div>
              <div className="mt-2 flex justify-between text-[10px] text-slate-400 font-medium">
                <span>Agent: {call.agentName}</span>
                <span className="font-mono">{call.duration}s</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Interceptor Canvas */}
      <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col h-[calc(100vh-120px)] justify-between">
        {selectedCall ? (
          <>
            {/* Header details */}
            <div className="border-b border-slate-200 pb-4 flex justify-between items-center flex-shrink-0">
              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Active Intercept Node</span>
                <h3 className="font-bold text-slate-800 text-md mt-0.5 tracking-tight">{selectedCall.companyName}</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">DID: {selectedCall.phoneNumber} · Direction: {selectedCall.direction}</p>
              </div>

              {selectedCall.status === 'connected' && (
                <button
                  onClick={simulateLiveDialogue}
                  className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition shadow-md shadow-indigo-100/50 flex items-center space-x-1.5 cursor-pointer"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>Simulate Next Turn</span>
                </button>
              )}
            </div>

            {/* Scrolling Dialogue Script */}
            <div className="flex-1 overflow-y-auto my-4 space-y-4 pr-2 font-sans text-xs scrollbar-thin">
              {selectedCall.transcript && selectedCall.transcript.length > 0 ? (
                selectedCall.transcript.map((line, idx) => (
                  <div key={idx} className={`flex flex-col ${line.speaker === 'agent' ? 'items-start' : 'items-end'}`}>
                    <span className="text-[9px] text-slate-400 font-bold mb-1 uppercase font-mono tracking-wider">
                      {line.speaker === 'agent' ? `Zea Agent (${line.time})` : `Caller (${line.time})`}
                    </span>
                    <div className={`p-3 rounded-xl max-w-md font-semibold ${
                      line.speaker === 'agent'
                        ? 'bg-slate-50 text-slate-800 rounded-tl-none'
                        : 'bg-indigo-600 text-white rounded-tr-none shadow-sm'
                    }`}>
                      {line.text}
                    </div>
                  </div>
                ))
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center text-slate-400">
                  <Activity className="w-8 h-8 text-slate-300 animate-pulse mb-2" />
                  <span className="text-xs font-bold uppercase tracking-wider block">Establishing Connection...</span>
                  <span className="text-[10px] text-slate-300 block mt-0.5">Trunk ringing caller ID: {selectedCall.phoneNumber}</span>
                </div>
              )}
            </div>

            {/* Footer monitoring dials */}
            <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex justify-between items-center flex-shrink-0 text-xs font-semibold">
              <div className="flex items-center space-x-4">
                <div>
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Call Cost</span>
                  <span className="text-slate-700 font-mono font-bold text-sm">₹{selectedCall.cost.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-[9px] text-slate-400 block uppercase font-bold">Sentiment Score</span>
                  <span className="text-emerald-600 font-bold block capitalize text-sm">{selectedCall.sentiment}</span>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <span className="text-[10px] text-slate-400 font-bold uppercase">Supervisor Override:</span>
                <button className="px-2.5 py-1.5 bg-red-50 hover:bg-red-100 border border-red-100 text-red-600 rounded-lg text-xs font-bold transition cursor-pointer">
                  Force Hang Up
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center text-slate-400">
            <Tv className="w-10 h-10 text-slate-300 mb-2" />
            <p className="text-xs font-bold">Select a live call trunk to intercept.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ==========================================
   9. PAYMENTS VIEW
   ========================================== */
function PaymentsView() {
  const [payments] = useState<PaymentRecord[]>(MOCK_PAYMENTS);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
      <div className="border-b border-slate-200 pb-5 mb-5">
        <h2 className="text-xl font-bold text-slate-800 tracking-tight">Financial Ledgers</h2>
        <p className="text-xs text-slate-400 font-medium mt-0.5">View subscription charges, transactional credit refills, and invoice summaries.</p>
      </div>

      <div className="overflow-x-auto text-xs">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
              <th className="pb-3">Transaction Ref</th>
              <th className="pb-3">Company Name</th>
              <th className="pb-3">Billing Type</th>
              <th className="pb-3">Status</th>
              <th className="pb-3">Settlement Date</th>
              <th className="pb-3 text-right">Invoice Sum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
            {payments.map(pay => (
              <tr key={pay.id} className="hover:bg-slate-50/50">
                <td className="py-3.5 font-bold font-mono text-slate-800">{pay.id}</td>
                <td className="py-3.5 font-bold text-slate-800">{pay.companyName}</td>
                <td className="py-3.5 font-semibold text-slate-500">
                  <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded border border-slate-200 text-[10px] font-bold">
                    {pay.type}
                  </span>
                </td>
                <td className="py-3.5">
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${
                    pay.status === 'succeeded' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' :
                    pay.status === 'failed' ? 'bg-red-50 border-red-100 text-red-600' : 'bg-slate-100 border-slate-200 text-slate-500'
                  }`}>
                    {pay.status}
                  </span>
                </td>
                <td className="py-3.5 text-slate-400 font-mono font-medium">{pay.date}</td>
                <td className="py-3.5 text-right font-black font-mono text-slate-800">
                  ₹{pay.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ==========================================
   10. GLOBAL SETTINGS VIEW
   ========================================== */
function GlobalSettingsView() {
  const [sessionTimeout, setSessionTimeout] = useState('3600');
  const [success, setSuccess] = useState<string | null>(null);

  const saveSettings = () => {
    setSuccess('Global security & cluster config parameters updated successfully.');
    setTimeout(() => setSuccess(null), 3000);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800 tracking-tight">Platform Configurations</h2>
        <p className="text-xs text-slate-400 font-medium mt-0.5">Control administrative access ceilings, compliance security flags, and cluster parameters.</p>
      </div>

      {success && (
        <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs font-semibold animate-in fade-in">
          {success}
        </div>
      )}

      <div className="space-y-4 text-xs font-semibold">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Administrative IP Access Restrictions</label>
            <input
              type="text"
              defaultValue="0.0.0.0/0 (All allowed)"
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Max Session Timeout (Seconds)</label>
            <input
              type="number"
              value={sessionTimeout}
              onChange={(e) => setSessionTimeout(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Compliance Enforcement Policy</label>
            <select className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition cursor-pointer">
              <option>Standard HIPAA + PCI Compliant Recording</option>
              <option>Strict GDPR - Delete Transcripts on hangup</option>
              <option>Relaxed Developer - Store All Metadata</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">SIP Gatekeeping Relay</label>
            <select className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-slate-800 outline-none focus:bg-white focus:border-indigo-500 transition cursor-pointer">
              <option>US-East Gateway Trunk (Standard)</option>
              <option>EU-Central Trunk Core</option>
              <option>APAC-South Sydney Core</option>
            </select>
          </div>
        </div>

        <div className="pt-4 border-t border-slate-200 flex justify-end">
          <button
            onClick={saveSettings}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition shadow-md shadow-indigo-100/50 cursor-pointer"
          >
            Apply Configurations
          </button>
        </div>
      </div>
    </div>
  );
}
