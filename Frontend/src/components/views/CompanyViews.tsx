/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useAppState } from '../../store/AppState';
import { COMPLETED_CALL_LOGS } from '../../lib/mockData';
import { VoiceAgent, Campaign, PhoneNumber } from '../../types';
import { 
  LayoutDashboard, 
  Activity, 
  Megaphone, 
  Bot, 
  FileSpreadsheet, 
  History, 
  Phone, 
  Settings,
  Search,
  Plus,
  Play,
  Pause,
  Eye,
  Lock,
  Download,
  Key,
  ShieldCheck,
  ArrowRight,
  TrendingUp,
  Clock,
  Coins,
  Copy,
  CheckCircle2,
  Trash2,
  Calendar,
  Wifi,
  Upload,
  X,
  ChevronDown,
  Check,
  Grid,
  List,
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  ChevronRight,
  User,
  Filter,
  XCircle,
  ArrowLeft,
  RefreshCw,
  LayoutGrid
} from 'lucide-react';
import { AgentTabs } from '../agent/AgentTabs';
import { DeveloperReportsView } from '../reports/DeveloperReportsView';
import { DeveloperVqaView } from '../vqa/DeveloperVqaView';
import { DeveloperAiInsightsView } from '../insights/DeveloperAiInsightsView';
import { DeveloperPhoneNumbersView } from '../phone-numbers/DeveloperPhoneNumbersView';
import { DeveloperIntegrationsView } from '../integrations/DeveloperIntegrationsView';
import { DeveloperWorkspaceSettingsView } from '../settings/DeveloperWorkspaceSettingsView';
import { DeveloperApiKeysView } from '../api-keys/DeveloperApiKeysView';
import { CallVolumeChart, DurationBarChart, OutcomePieChart } from '../charts/DashboardCharts';
import { apiRequest } from '../../lib/api';

interface CompanyDashboardData {
  company: { tenantId: string; workspaceId: string; name: string; timezone: string };
  metrics: {
    inboundCalls: number; outboundCalls: number; totalCalls: number; activeCalls: number;
    totalMinutesUsed: number; averageCallDurationSeconds: number; currentMonthCalls: number;
    totalAgents: number; activeAgents: number; activeCampaigns: number;
    changes: { totalCallsPercent: number | null; inboundCallsPercent: number | null; outboundCallsPercent: number | null };
  };
  resources: {
    credits: { balance: number; reservedBalance: number; availableBalance: number; currency: string } | null;
    assignedPhoneNumbers: number; activeTeamMembers: number;
  };
  callVolume: Array<{ date: string; inbound: number; outbound: number }>;
  agents: Array<{
    id: string; name: string; status: 'active' | 'draft' | 'archived'; prompt: string;
    voiceId: string; temperature: number; interruptionSensitivity: number; silenceTimeoutMs: number;
    llmProvider: string; llmModel: string; totalCalls: number; averageDurationSeconds: number;
    successRate: number; createdAt: string; updatedAt: string;
  }>;
  recentActivity: Array<{
    id: string; agentName: string | null; campaignName: string | null; direction: 'inbound' | 'outbound';
    status: string; phoneNumber: string; startedAt: string; durationSeconds: number;
  }>;
}

interface CompanyAnalyticsData {
  periodDays: number;
  summary: { totalCalls: number; completedCalls: number; connectedCalls: number; connectionRate: number; averageDurationSeconds: number; totalMinutes: number };
  traffic: Array<{ date: string; inbound: number; outbound: number }>;
  durationDistribution: Array<{ range: string; count: number }>;
  outcomes: Array<{ name: string; value: number }>;
  sentiments: Array<{ name: 'positive' | 'neutral' | 'negative' | 'unknown'; value: number; percentage: number }>;
}

export function CompanyViews() {
  const { view, setView, selectedAgentId, setSelectedAgentId } = useAppState();
  const [agents, setAgents] = useState<VoiceAgent[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  // Callback to save a voice agent
  const handleSaveAgent = (savedAgent: VoiceAgent) => {
    const exists = agents.some(a => a.id === savedAgent.id);
    if (exists) {
      setAgents(agents.map(a => a.id === savedAgent.id ? savedAgent : a));
    } else {
      setAgents([...agents, savedAgent]);
    }
    setSelectedAgentId(null);
    setView('agents');
  };

  switch (view) {
    case 'dashboard':
      return <CompanyDashboard onEditAgent={(id) => { setSelectedAgentId(id); setView('agents/edit'); }} onAddAgent={() => { setSelectedAgentId(null); setView('agents/create'); }} />;
    case 'analytics':
      return <CompanyAnalytics />;
    case 'campaigns':
      return <CampaignsListView campaigns={campaigns} setCampaigns={setCampaigns} />;
    case 'agents':
      return <AgentsListView agents={agents} setAgents={setAgents} onEditAgent={(id) => { setSelectedAgentId(id); setView('agents/edit'); }} onAddAgent={() => { setSelectedAgentId(null); setView('agents/create'); }} />;
    case 'agents/create':
    case 'agents/edit':
      return <AgentTabs agentId={selectedAgentId} onSave={handleSaveAgent} onCancel={() => { setSelectedAgentId(null); setView('agents'); }} />;
    case 'reports':
      return <DeveloperReportsView />;
    case 'call-logs':
      return <DeveloperReportsView
        title="Call Logs Analytics"
        subtitle="Live tenant call records, outcomes, durations, costs and transcripts from PostgreSQL"
      />;
    case 'phone-numbers':
      return <DeveloperPhoneNumbersView />;
    case 'vqa-voice':
      return <DeveloperVqaView />;
    case 'ai-insights':
      return <DeveloperAiInsightsView />;
    case 'integrations':
      return <DeveloperIntegrationsView />;
    case 'settings':
      return <DeveloperWorkspaceSettingsView />;
    case 'api-keys':
      return <DeveloperApiKeysView />;
    default:
      return <CompanyDashboard onEditAgent={(id) => { setSelectedAgentId(id); setView('agents/edit'); }} onAddAgent={() => { setSelectedAgentId(null); setView('agents/create'); }} />;
  }
}

/* ==========================================
   1. COMPANY DASHBOARD
   ========================================== */
function CompanyDashboard({ onEditAgent, onAddAgent }: { onEditAgent: (id: string) => void, onAddAgent: () => void }) {
  const { role, setView } = useAppState();
  const isReadOnly = role === 'USER';
  const [dashboard, setDashboard] = useState<CompanyDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    apiRequest<CompanyDashboardData>('/dashboard?days=14', { signal: controller.signal })
      .then(setDashboard)
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Dashboard data could not be loaded');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  if (loading && !dashboard) return <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">{[1, 2, 3, 4, 5, 6].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl border border-slate-200 bg-white p-6"><div className="h-3 w-28 rounded bg-slate-200" /><div className="mt-8 h-8 w-16 rounded bg-slate-200" /></div>)}</div>;
  if (error || !dashboard) return <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm font-semibold text-red-700">Unable to load the company dashboard: {error || 'No data was returned'}</div>;

  const { metrics } = dashboard;
  const changeLabel = (value: number | null) => value === null ? 'New vs last month' : `${value > 0 ? '+' : ''}${value}% vs last month`;
  const chartData = dashboard.callVolume.map((item) => ({
    name: new Date(item.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
    inbound: item.inbound, outbound: item.outbound,
  }));

  return (
    <div className="space-y-6">
      {/* Competitor Dashcards - Row 1 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        {/* Card 1: Inbound Calls */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Inbound Calls</span>
            <div className="w-10 h-10 rounded-full bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center border border-[#DBEAFE] shadow-sm">
              <PhoneIncoming className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-3xl font-extrabold text-slate-800 tracking-tight">{metrics.inboundCalls.toLocaleString()}</h3>
            <div className="flex items-center space-x-1.5 mt-2.5">
              <span className="text-[10px] font-extrabold bg-[#F0FDF4] text-[#16A34A] border border-[#DCFCE7] px-2.5 py-0.5 rounded-full">{changeLabel(metrics.changes.inboundCallsPercent)}</span>
            </div>
          </div>
        </div>

        {/* Card 2: Outbound Calls */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Outbound Calls</span>
            <div className="w-10 h-10 rounded-full bg-[#FFF1F2] text-[#E11D48] flex items-center justify-center border border-[#FFE4E6] shadow-sm">
              <PhoneOutgoing className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-3xl font-extrabold text-slate-800 tracking-tight">{metrics.outboundCalls.toLocaleString()}</h3>
            <div className="flex items-center space-x-1.5 mt-2.5">
              <span className="text-[10px] font-extrabold bg-[#F0FDF4] text-[#16A34A] border border-[#DCFCE7] px-2.5 py-0.5 rounded-full">{changeLabel(metrics.changes.outboundCallsPercent)}</span>
            </div>
          </div>
        </div>

        {/* Card 3: Total Agents */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Agents</span>
            <div className="w-10 h-10 rounded-full bg-[#ECFDF5] text-[#059669] flex items-center justify-center border border-[#D1FAE5] shadow-sm">
              <Bot className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-3xl font-extrabold text-slate-800 tracking-tight">{metrics.totalAgents.toLocaleString()}</h3>
            <p className="text-[10px] font-bold text-slate-400 mt-4 uppercase tracking-wider">{metrics.activeAgents} active operators</p>
          </div>
        </div>
      </div>

      {/* Competitor Dashcards - Row 2 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        {/* Card 5: Total Calls */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Calls</span>
            <div className="w-10 h-10 rounded-full bg-[#F8FAFC] text-[#475569] flex items-center justify-center border border-[#E2E8F0] shadow-sm">
              <Phone className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-3xl font-extrabold text-slate-800 tracking-tight">{metrics.totalCalls.toLocaleString()}</h3>
            <div className="flex items-center space-x-1.5 mt-2.5">
              <span className="text-[10px] font-extrabold bg-[#F0FDF4] text-[#16A34A] border border-[#DCFCE7] px-2.5 py-0.5 rounded-full">{changeLabel(metrics.changes.totalCallsPercent)}</span>
            </div>
          </div>
        </div>

        {/* Card 6: Active Campaigns */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Active Campaigns</span>
            <div className="w-10 h-10 rounded-full bg-[#FFF1F2] text-[#BE123C] flex items-center justify-center border border-[#FFE4E6] shadow-sm">
              <Megaphone className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-3xl font-extrabold text-slate-800 tracking-tight">{metrics.activeCampaigns.toLocaleString()}</h3>
            <p className="text-[10px] font-bold text-slate-400 mt-4 uppercase tracking-wider">Running or scheduled campaigns</p>
          </div>
        </div>

        {/* Card 7: Total Minutes Used */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Minutes Used</span>
            <div className="w-10 h-10 rounded-full bg-[#F0FDF4] text-[#15803D] flex items-center justify-center border border-[#DCFCE7] shadow-sm">
              <Clock className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-3xl font-extrabold text-slate-800 tracking-tight">{metrics.totalMinutesUsed.toLocaleString()}</h3>
            <p className="text-[10px] font-bold text-slate-400 mt-4 uppercase tracking-wider">Average {metrics.averageCallDurationSeconds}s per call</p>
          </div>
        </div>
      </div>

      {/* Competitor Split Row: Call Volume Chart & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Call Volume Chart */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h4 className="font-bold text-slate-800 text-sm tracking-tight">Call Volume</h4>
              <p className="text-[10px] text-slate-400 font-semibold">Real-time daily call throughput statistics</p>
            </div>
            <div className="flex items-center space-x-2.5 text-[10px] font-bold text-slate-500">
              <div className="flex items-center space-x-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#7C3AED]" />
                <span>Inbound</span>
              </div>
              <div className="flex items-center space-x-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#EC4899]" />
                <span>Outbound</span>
              </div>
            </div>
          </div>
          <CallVolumeChart data={chartData} />
        </div>

        {/* Recent Activity */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex flex-col justify-between">
          <div>
            <h4 className="font-bold text-slate-800 text-sm tracking-tight mb-4">Recent Activity</h4>
            <div className="space-y-5 relative pl-4 border-l border-slate-100">
              {dashboard.recentActivity.map((activity) => (
                <div key={activity.id} className="relative">
                  <div className={`absolute -left-[20.5px] top-1 w-2 h-2 rounded-full border-2 border-white ring-4 ${activity.status === 'completed' ? 'bg-blue-500 ring-blue-50' : 'bg-amber-500 ring-amber-50'}`} />
                  <div className="text-xs font-bold text-slate-800">
                    {activity.campaignName || activity.agentName || 'Direct call'} — <span className="text-slate-500 font-medium">{activity.direction === 'outbound' ? 'Call to' : 'Call from'}</span>{' '}
                    <span className="font-mono">{activity.phoneNumber}</span>{' '}
                    <span className="text-slate-400 font-normal">({activity.status.replace('_', ' ')})</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1 font-semibold">{new Date(activity.startedAt).toLocaleString()}</div>
                </div>
              ))}
              {dashboard.recentActivity.length === 0 && <p className="py-8 text-center text-xs font-semibold text-slate-400">No call activity yet.</p>}
            </div>
          </div>

          <button 
            onClick={() => setView('call-logs')}
            className="w-full text-center py-2.5 bg-slate-50 hover:bg-slate-100 text-slate-500 hover:text-slate-700 rounded-xl text-xs font-bold border border-slate-200 mt-6 transition cursor-pointer"
          >
            View All Call Logs →
          </button>
        </div>
      </div>

      {/* AI Voice Operators Management Row */}
      <div className="space-y-4 pt-4 border-t border-slate-200">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="font-bold text-slate-855 text-lg tracking-tight">AI Operators Console</h3>
            <p className="text-xs text-slate-400 font-semibold mt-0.5">Select an operator engine profile to customize prompts, listening filters, and vocal outputs.</p>
          </div>

          {!isReadOnly ? (
            <button
              onClick={onAddAgent}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition shadow-md shadow-indigo-100/50 flex items-center space-x-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Provision Agent</span>
            </button>
          ) : (
            <span className="bg-slate-100 text-slate-500 text-xs px-3 py-1.5 rounded-lg font-bold flex items-center space-x-1.5 border border-slate-200">
              <Lock className="w-3.5 h-3.5" />
              <span>User Mode (Read-Only)</span>
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {dashboard.agents.map((agent) => (
            <div key={agent.id} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between hover:shadow-md transition duration-200">
              <div>
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="font-bold text-slate-800 text-sm tracking-tight">{agent.name}</h4>
                    <span className="text-[10px] font-mono text-slate-400 block mt-0.5">Brain: {agent.llmModel}</span>
                  </div>
                  <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                    agent.status === 'active' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-slate-100 border-slate-200 text-slate-500'
                  }`}>
                    {agent.status}
                  </span>
                </div>

                <p className="text-xs text-slate-500 font-semibold line-clamp-3 mt-3 italic leading-relaxed">
                  "{agent.prompt}"
                </p>

                <div className="grid grid-cols-3 gap-1.5 text-center text-xs mt-4 py-2.5 bg-slate-50/50 rounded-xl border border-slate-150">
                  <div>
                    <span className="text-[9px] text-slate-400 block font-bold uppercase tracking-wider">Success</span>
                    <span className="text-slate-700 font-bold font-mono">{agent.successRate}%</span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-400 block font-bold uppercase tracking-wider">Calls</span>
                    <span className="text-slate-700 font-bold font-mono">{agent.totalCalls.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-400 block font-bold uppercase tracking-wider">Length</span>
                    <span className="text-slate-700 font-bold font-mono">{agent.averageDurationSeconds}s</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEditAgent(agent.id)}
                className="w-full py-2.5 bg-slate-50 hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 rounded-lg text-xs font-bold mt-4 transition border border-slate-200 flex items-center justify-center space-x-1 cursor-pointer"
                id={`agent-card-edit-${agent.id}`}
              >
                <span>{isReadOnly ? 'Inspect Settings' : 'Architect Engine'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {dashboard.agents.length === 0 && (
            <div className="md:col-span-2 lg:col-span-3 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-xs font-semibold text-slate-400">
              No AI operators have been created for this company yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ==========================================
   2. COMPANY ANALYTICS
   ========================================== */
function CompanyAnalytics() {
  const [days, setDays] = useState(30);
  const [analytics, setAnalytics] = useState<CompanyAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    apiRequest<CompanyAnalyticsData>(`/dashboard/analytics?days=${days}`, { signal: controller.signal })
      .then(setAnalytics)
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Analytics could not be loaded');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days]);

  if (loading && !analytics) return <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">{[1, 2, 3, 4].map((item) => <div key={item} className="h-80 animate-pulse rounded-xl border border-slate-200 bg-white p-6"><div className="h-4 w-40 rounded bg-slate-200" /><div className="mt-8 h-56 rounded bg-slate-100" /></div>)}</div>;
  if (error || !analytics) return <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm font-semibold text-red-700">Unable to load company analytics: {error || 'No data was returned'}</div>;

  const traffic = analytics.traffic.map((item) => ({
    name: new Date(item.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
    inbound: item.inbound, outbound: item.outbound,
  }));
  const outcomeColors = ['#7C3AED', '#EC4899', '#3B82F6', '#F59E0B', '#10B981', '#EF4444', '#64748B'];
  const outcomes = analytics.outcomes.map((item, index) => ({
    name: item.name.split('_').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' '),
    value: item.value, color: outcomeColors[index % outcomeColors.length],
  }));
  const sentimentStyle = {
    positive: { label: 'Positive Sentiment', bar: 'bg-emerald-500', text: 'text-emerald-600' },
    neutral: { label: 'Neutral Sentiment', bar: 'bg-slate-400', text: 'text-slate-600' },
    negative: { label: 'Negative Sentiment', bar: 'bg-rose-500', text: 'text-rose-600' },
    unknown: { label: 'Unknown Sentiment', bar: 'bg-amber-400', text: 'text-amber-600' },
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div><h2 className="text-xl font-bold text-slate-800 tracking-tight">Enterprise Analytics Dashboard</h2><p className="text-xs text-slate-400 font-medium mt-0.5">Tenant call dispositions, durations, traffic and sentiment stored in PostgreSQL.</p></div>
        <select value={days} onChange={(event) => setDays(Number(event.target.value))} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
          <option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {[
          ['Total Calls', analytics.summary.totalCalls], ['Completed', analytics.summary.completedCalls],
          ['Connection Rate', `${analytics.summary.connectionRate}%`], ['Average Duration', `${analytics.summary.averageDurationSeconds}s`],
          ['Total Minutes', analytics.summary.totalMinutes],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span><p className="mt-2 text-xl font-black text-slate-800">{value}</p></div>)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-4 tracking-tight">Daily Traffic Volumes</h3>
          <CallVolumeChart data={traffic} />
        </div>

        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-4 tracking-tight">Call Length Frequency Distribution</h3>
          <DurationBarChart data={analytics.durationDistribution} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-4 tracking-tight">Call Conversion Dispositions</h3>
          <OutcomePieChart data={outcomes} />
        </div>

        <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-3">NLP Customer Sentiment Breakdown</h3>
          <div className="space-y-4 text-xs font-semibold mt-4">
            {analytics.sentiments.map((sentiment) => {
              const style = sentimentStyle[sentiment.name];
              return <div key={sentiment.name}><div className="flex justify-between text-slate-600 mb-1"><span>{style.label} ({sentiment.value} calls)</span><span className={`${style.text} font-bold`}>{sentiment.percentage}%</span></div><div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${style.bar}`} style={{ width: `${sentiment.percentage}%` }} /></div></div>;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==========================================
   3. OUTBOUND CAMPAIGNS
   ========================================== */
interface CampaignsListProps {
  campaigns: Campaign[];
  setCampaigns: React.Dispatch<React.SetStateAction<Campaign[]>>;
}

interface CampaignApiData {
  id: string; name: string; type: 'batch' | 'realtime';
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'archived';
  agentId: string; agentName: string; phoneNumberId: string; phoneNumber: string;
  timezone: string; concurrencyLimit: number; priority: 'low' | 'medium' | 'high'; retries: number;
  retryIntervalsMs: number[]; retryOutcomes: string[]; callingStartTime: string; callingEndTime: string;
  startAfter: string | null; endAfter: string | null;
  metrics: { totalTasks: number; attemptedTasks: number; connectedTasks: number; completedTasks: number };
  createdAt: string; updatedAt: string;
}

interface CampaignAgentOption { id: string; name: string; status: string }
interface CampaignPhoneOption { id: string; number: string; provider: string; status: string }

function campaignFromApi(value: CampaignApiData): Campaign {
  return {
    id: value.id, name: value.name, status: value.status,
    agentId: value.agentId, agentName: value.agentName,
    phoneNumberId: value.phoneNumberId, phoneNumber: value.phoneNumber,
    totalLeads: value.metrics.totalTasks, calledLeads: value.metrics.attemptedTasks,
    connectedCalls: value.metrics.connectedTasks, convertedCount: value.metrics.completedTasks,
    scheduleStart: `${value.callingStartTime.slice(0, 5)} - ${value.callingEndTime.slice(0, 5)} (${value.timezone})`,
    scheduleEnd: value.endAfter ? new Date(value.endAfter).toLocaleString() : 'No end date',
  };
}

function CampaignsListView({ campaigns, setCampaigns }: CampaignsListProps) {
  const { role } = useAppState();
  const isReadOnly = role === 'USER';

  // Sub tab: 'batch' | 'real-time'
  const [activeTab, setActiveTab] = useState<'batch' | 'real-time'>('batch');

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // Creation forms toggles
  const [showBatchCreator, setShowBatchCreator] = useState(false);
  const [showRealtimeModal, setShowRealtimeModal] = useState(false);

  // Clipboard Copy State
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [realtimeCampaigns, setRealtimeCampaigns] = useState<CampaignApiData[]>([]);
  const [campaignAgents, setCampaignAgents] = useState<CampaignAgentOption[]>([]);
  const [campaignPhones, setCampaignPhones] = useState<CampaignPhoneOption[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignsError, setCampaignsError] = useState('');
  const [submittingCampaign, setSubmittingCampaign] = useState(false);

  // Batch Form State
  const [phoneInputMethod, setPhoneInputMethod] = useState('Upload CSV File');
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
  const [simulatedLeadsCount, setSimulatedLeadsCount] = useState(0);
  const [csvText, setCsvText] = useState('');
  
  const [batchCampName, setBatchCampName] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedNumId, setSelectedNumId] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  
  const [retries, setRetries] = useState(1);
  const [priority, setPriority] = useState('Medium');
  const [slots, setSlots] = useState(2);
  const [retryInterval, setRetryInterval] = useState(60);
  const [retryIntervalUnit, setRetryIntervalUnit] = useState('Mins');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [scheduleTrigger, setScheduleTrigger] = useState('Now');
  const [endAfterDate, setEndAfterDate] = useState('');

  // Real-Time Form State
  const [rtCampName, setRtCampName] = useState('');
  const [rtAgentId, setRtAgentId] = useState('');
  const [rtNumberId, setRtNumberId] = useState('');
  const [rtStartTime, setRtStartTime] = useState('09:00');
  const [rtEndTime, setRtEndTime] = useState('17:00');
  const [rtEndDate, setRtEndDate] = useState('');
  const [rtSlots, setRtSlots] = useState(1);

  // Toast / Status Message
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const loadCampaignData = async (forceRefresh = false) => {
    setCampaignsLoading(true); setCampaignsError('');
    try {
      const options = forceRefresh ? { zeaCache: 'reload' as const } : {};
      const [batch, realtime, agentsResponse, phonesResponse] = await Promise.all([
        apiRequest<{ items: CampaignApiData[] }>('/campaigns?type=batch&page=1&pageSize=50', options),
        apiRequest<{ items: CampaignApiData[] }>('/campaigns?type=realtime&page=1&pageSize=50', options),
        apiRequest<{ items: CampaignAgentOption[] }>('/agents?status=active&page=1&pageSize=50', options),
        apiRequest<CampaignPhoneOption[]>('/phone-numbers', options),
      ]);
      setCampaigns(batch.items.map(campaignFromApi));
      setRealtimeCampaigns(realtime.items);
      setCampaignAgents(agentsResponse.items);
      setCampaignPhones(phonesResponse.filter((phone) => phone.status === 'active'));
      setSelectedAgentId((current) => current || agentsResponse.items[0]?.id || '');
      setRtAgentId((current) => current || agentsResponse.items[0]?.id || '');
      setSelectedNumId((current) => current || phonesResponse.find((phone) => phone.status === 'active')?.id || '');
      setRtNumberId((current) => current || phonesResponse.find((phone) => phone.status === 'active')?.id || '');
    } catch (requestError) {
      setCampaignsError(requestError instanceof Error ? requestError.message : 'Campaign data could not be loaded');
    } finally { setCampaignsLoading(false); }
  };

  useEffect(() => { void loadCampaignData(); }, []);

  const showToast = (msg: string) => {
    setActionMessage(msg);
    setTimeout(() => setActionMessage(null), 3500);
  };

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    showToast('Campaign ID copied to clipboard!');
    setTimeout(() => setCopiedId(null), 1500);
  };

  const to24Hour = (value: string) => {
    const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!match) return value;
    let hour = Number(match[1]);
    const suffix = match[3]?.toUpperCase();
    if (suffix === 'PM' && hour < 12) hour += 12;
    if (suffix === 'AM' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${match[2]}`;
  };

  const retryIntervalMilliseconds = () => retryInterval * (retryIntervalUnit === 'Days' ? 86_400_000 : retryIntervalUnit === 'Hours' ? 3_600_000 : 60_000);
  const optionalIsoDate = (value: string) => value ? new Date(value).toISOString() : undefined;

  const handleCsvFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const contents = await file.text();
      const rows = contents.split(/\r?\n/).filter((line) => line.trim()).length;
      setUploadedFile(file.name); setCsvText(contents); setSimulatedLeadsCount(Math.max(0, rows - 1));
      if (!batchCampName) setBatchCampName(`${file.name.replace(/\.csv$/i, '').replace(/_/g, ' ')} Campaign`);
      showToast(`Loaded ${file.name}. The backend will validate every phone number and duplicate.`);
    } catch { showToast('The selected CSV file could not be read.'); }
  };

  const handleDownloadTemplate = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['name,phone,remarks\nJohn (USA),16501234567,Example USA number\n'], { type: 'text/csv' }));
    link.download = 'zea-voice-batch-template.csv'; link.click(); URL.revokeObjectURL(link.href);
    showToast('Downloaded sample CSV template: name, phone, remarks.');
  };

  const toggleCampaignStatus = async (id: string) => {
    const campaign = campaigns.find((item) => item.id === id);
    if (!campaign || !['running', 'scheduled', 'paused'].includes(campaign.status)) return showToast(`Campaign cannot be changed from ${campaign?.status ?? 'unknown'}.`);
    try {
      const action = campaign.status === 'paused' ? 'resume' : 'pause';
      const updated = await apiRequest<CampaignApiData>(`/campaigns/${id}/${action}`, { method: 'POST', body: '{}' });
      setCampaigns((current) => current.map((item) => item.id === id ? campaignFromApi(updated) : item));
      showToast(`Campaign "${campaign.name}" is now ${updated.status}.`);
    } catch (requestError) { showToast(requestError instanceof Error ? requestError.message : 'Campaign status could not be changed'); }
  };

  const deleteCampaign = async (id: string) => {
    const c = campaigns.find(item => item.id === id);
    if (c && window.confirm(`Delete batch campaign "${c.name}"?`)) {
      try {
        await apiRequest(`/campaigns/${id}`, { method: 'DELETE' });
        setCampaigns((current) => current.filter(item => item.id !== id));
      } catch (requestError) { return showToast(requestError instanceof Error ? requestError.message : 'Campaign could not be deleted'); }
      showToast(`Deleted batch campaign "${c.name}".`);
    }
  };

  const toggleRealtimeStatus = async (id: string) => {
    const campaign = realtimeCampaigns.find((item) => item.id === id);
    if (!campaign || !['running', 'scheduled', 'paused'].includes(campaign.status)) return showToast(`Campaign cannot be changed from ${campaign?.status ?? 'unknown'}.`);
    try {
      const action = campaign.status === 'paused' ? 'resume' : 'pause';
      const updated = await apiRequest<CampaignApiData>(`/campaigns/${id}/${action}`, { method: 'POST', body: '{}' });
      setRealtimeCampaigns((current) => current.map((item) => item.id === id ? updated : item));
      showToast(`Real-time campaign "${campaign.name}" is now ${updated.status}.`);
    } catch (requestError) { showToast(requestError instanceof Error ? requestError.message : 'Campaign status could not be changed'); }
  };

  const deleteRealtimeCampaign = async (id: string) => {
    const c = realtimeCampaigns.find(item => item.id === id);
    if (c && window.confirm(`Delete real-time campaign "${c.name}"?`)) {
      try {
        await apiRequest(`/campaigns/${id}`, { method: 'DELETE' });
        setRealtimeCampaigns((current) => current.filter(item => item.id !== id));
      } catch (requestError) { return showToast(requestError instanceof Error ? requestError.message : 'Campaign could not be deleted'); }
      showToast(`Deleted real-time service "${c.name}".`);
    }
  };

  const handleCreateBatchCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchCampName.trim() || !selectedAgentId || !selectedNumId || !csvText) return showToast('Campaign name, active agent, assigned number and CSV file are required.');
    setSubmittingCampaign(true);
    try {
      const created = await apiRequest<CampaignApiData>('/campaigns', { method: 'POST', body: JSON.stringify({
        name: batchCampName.trim(), type: 'batch', status: scheduleTrigger === 'Now' ? 'running' : 'scheduled',
        agentId: selectedAgentId, phoneNumberId: selectedNumId, timezone, concurrencyLimit: slots,
        priority: priority.toLowerCase(), retries,
        retryIntervalsMs: Array.from({ length: retries }, retryIntervalMilliseconds),
        retryOutcomes: ['busy', 'failed', 'no_answer'], callingStartTime: to24Hour(startTime), callingEndTime: to24Hour(endTime),
        endAfter: optionalIsoDate(endAfterDate), contextSchema: {},
      }) });
      const imported = await apiRequest<{ import: { acceptedRows: number; invalidRows: number; duplicateRows: number } }>(`/campaigns/${created.id}/batch/import`, {
        method: 'POST', body: JSON.stringify({ fileName: uploadedFile, csvText }),
      });
      await loadCampaignData(true); setShowBatchCreator(false); setBatchCampName(''); setUploadedFile(null); setCsvText(''); setSimulatedLeadsCount(0);
      showToast(`Campaign created: ${imported.import.acceptedRows} accepted, ${imported.import.invalidRows} invalid, ${imported.import.duplicateRows} duplicate.`);
    } catch (requestError) { showToast(requestError instanceof Error ? requestError.message : 'Batch campaign could not be created'); }
    finally { setSubmittingCampaign(false); }
  };

  const handleCreateRealtimeCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rtCampName.trim() || !rtAgentId || !rtNumberId) return showToast('Campaign name, active agent and assigned from-number are required.');
    setSubmittingCampaign(true);
    try {
      await apiRequest<CampaignApiData>('/campaigns', { method: 'POST', body: JSON.stringify({
        name: rtCampName.trim(), type: 'realtime', status: 'running', agentId: rtAgentId,
        phoneNumberId: rtNumberId, timezone, concurrencyLimit: rtSlots, priority: 'high', retries: 3,
        retryIntervalsMs: [300000, 600000, 900000], retryOutcomes: ['busy', 'failed', 'no_answer'],
        callingStartTime: to24Hour(rtStartTime), callingEndTime: to24Hour(rtEndTime),
        endAfter: optionalIsoDate(rtEndDate), contextSchema: { lead_name: 'string', company: 'string' },
      }) });
      await loadCampaignData(true); setShowRealtimeModal(false); setRtCampName('');
      showToast(`Real-time campaign "${rtCampName}" activated successfully.`);
    } catch (requestError) { showToast(requestError instanceof Error ? requestError.message : 'Real-time campaign could not be created'); }
    finally { setSubmittingCampaign(false); }
  };

  const handleResumeAll = async () => {
    const paused = campaigns.filter((campaign) => campaign.status === 'paused');
    if (paused.length === 0) return showToast('There are no paused batch campaigns.');
    const results = await Promise.allSettled(paused.map((campaign) => apiRequest(`/campaigns/${campaign.id}/resume`, { method: 'POST', body: '{}' })));
    await loadCampaignData(true);
    showToast(`Resumed ${results.filter((result) => result.status === 'fulfilled').length} of ${paused.length} paused campaigns.`);
  };

  // Filter campaigns
  const filteredCampaigns = campaigns.filter(c => {
    const matchesSearch = c.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          c.agentName.toLowerCase().includes(searchQuery.toLowerCase());
    if (statusFilter === 'all') return matchesSearch;
    return matchesSearch && c.status === statusFilter;
  });

  return (
    <div className="space-y-6">
      {/* Toast Alert */}
      {actionMessage && (
        <div className="fixed top-4 right-4 bg-slate-900 text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-2xl border border-slate-700 z-50 animate-in slide-in-from-top-4 duration-200 flex items-center space-x-2">
          <div className="w-2 h-2 rounded-full bg-pink-500 animate-ping" />
          <span>{actionMessage}</span>
        </div>
      )}
      {campaignsError && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">{campaignsError}</div>}

      {/* Main Title Banner matching Attachment 1 */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-1 gap-4">
        <div>
          <h1 className="text-2xl font-black text-slate-800 tracking-tight">Campaign Hub</h1>
          <p className="text-xs text-slate-400 font-semibold mt-0.5">Design, pilot, and oversee outbound telephonic operations</p>
        </div>

        {/* Create Campaign Launcher */}
        {activeTab === 'batch' && !showBatchCreator && (
          <button
            onClick={() => setShowBatchCreator(true)}
            className="px-5 py-2.5 bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-600 hover:to-rose-700 text-white rounded-xl text-xs font-black transition shadow-lg shadow-pink-100/50 flex items-center space-x-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Create Campaign</span>
          </button>
        )}
      </div>

      {/* Sub Tabs Pill Selectors matching Attachment 1 */}
      <div className="flex items-center space-x-2">
        <button
          onClick={() => {
            setActiveTab('batch');
            setShowBatchCreator(false);
          }}
          className={`px-5 py-2 rounded-full text-xs font-extrabold tracking-tight transition cursor-pointer ${
            activeTab === 'batch'
              ? 'bg-[#ec4899] text-white shadow-md shadow-pink-100'
              : 'bg-slate-100 text-slate-500 hover:text-slate-800'
          }`}
        >
          Batch Campaign
        </button>
        <button
          onClick={() => setActiveTab('real-time')}
          className={`px-5 py-2 rounded-full text-xs font-extrabold tracking-tight transition cursor-pointer ${
            activeTab === 'real-time'
              ? 'bg-[#ec4899] text-white shadow-md shadow-pink-100'
              : 'bg-slate-100 text-slate-500 hover:text-slate-800'
          }`}
        >
          Real-Time Campaign
        </button>
      </div>

      {activeTab === 'batch' ? (
        <>
          {showBatchCreator ? (
            /* ==========================================
               BATCH CAMPAIGN CREATION FORM (Attachment 2)
               ========================================== */
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <h2 className="font-extrabold text-slate-800 text-sm tracking-tight">Campaign Details</h2>
                <button
                  type="button"
                  onClick={() => setShowBatchCreator(false)}
                  className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateBatchCampaign} className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* 1. Contacts List Column */}
                <div className="space-y-4">
                  <div className="border-b border-slate-100 pb-2">
                    <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider">1. Contacts List</h3>
                    <p className="text-[10px] text-slate-400 mt-0.5">Select input method and load phone numbers.</p>
                  </div>

                  <div className="space-y-3 font-semibold text-xs">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Phone Input Method</label>
                      <select
                        value={phoneInputMethod}
                        onChange={(e) => setPhoneInputMethod(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none cursor-pointer"
                      >
                        <option value="Upload CSV File">Upload CSV File</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">
                        Upload CSV File (Name | Phone | Remarks)
                      </label>
                      
                      <div className="border-2 border-dashed border-pink-200 hover:border-pink-400 bg-pink-50/20 hover:bg-pink-50/50 rounded-xl p-5 text-center transition flex flex-col items-center justify-center space-y-2 group">
                        <div className="w-9 h-9 rounded-full bg-pink-50 text-[#ec4899] flex items-center justify-center border border-pink-100 group-hover:scale-105 transition">
                          <Upload className="w-4 h-4" />
                        </div>
                        
                        <div>
                          <p className="text-[11px] font-bold text-slate-700">Click to upload or drag and drop</p>
                          <p className="text-[9px] text-slate-400 mt-0.5">CSV with columns: name, phone, remarks</p>
                        </div>

                        {uploadedFile && (
                          <div className="px-2.5 py-1 bg-emerald-50 text-emerald-800 border border-emerald-100 text-[10px] font-bold rounded-lg mt-1 flex items-center space-x-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            <span>{uploadedFile} ({simulatedLeadsCount} leads)</span>
                          </div>
                        )}

                        <div className="flex items-center space-x-2 pt-2">
                          <label className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[10px] font-extrabold text-slate-600 hover:bg-slate-50 shadow-xs cursor-pointer">
                            Choose File<input type="file" accept=".csv,text/csv" onChange={(event) => void handleCsvFile(event)} className="hidden" />
                          </label>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleDownloadTemplate(); }}
                            className="px-2.5 py-1.5 bg-white border border-pink-200 rounded-lg text-[10px] font-extrabold text-[#ec4899] hover:bg-pink-50 flex items-center space-x-1"
                          >
                            <Download className="w-3 h-3" />
                            <span>Download Template</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. Configuration Column */}
                <div className="space-y-4">
                  <div className="border-b border-slate-100 pb-2">
                    <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider">2. Configuration</h3>
                    <p className="text-[10px] text-slate-400 mt-0.5">Set campaign identity, agent and dialing route.</p>
                  </div>

                  <div className="space-y-3 font-semibold text-xs">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Campaign Name *</label>
                      <input
                        type="text"
                        required
                        value={batchCampName}
                        onChange={(e) => setBatchCampName(e.target.value)}
                        placeholder="Enter campaign name"
                        className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-pink-500 rounded-lg px-3 py-2 text-slate-800 outline-none transition"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Agent *</label>
                      <select
                        value={selectedAgentId}
                        onChange={(e) => setSelectedAgentId(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none cursor-pointer font-bold"
                      >
                        <option value="">Select an active agent</option>
                        {campaignAgents.map(agent => (
                          <option key={agent.id} value={agent.id}>{agent.name}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">From Number *</label>
                      <select
                        value={selectedNumId}
                        onChange={(e) => setSelectedNumId(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none cursor-pointer font-bold"
                      >
                        <option value="">Select an assigned number</option>
                        {campaignPhones.map(num => (
                          <option key={num.id} value={num.id}>{num.number} ({num.provider})</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Timezone</label>
                      <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none cursor-pointer"
                      >
                          <option value="Asia/Kolkata">Asia/Kolkata</option>
                        <option value="UTC">UTC (Greenwich Mean Time)</option>
                        <option value="America/New_York">America/New_York (EST)</option>
                        <option value="Europe/London">Europe/London (BST)</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* 3. Dialing & Schedule Column */}
                <div className="space-y-4">
                  <div className="border-b border-slate-100 pb-2">
                    <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider">3. Dialing & Schedule</h3>
                    <p className="text-[10px] text-slate-400 mt-0.5">Configure calling retry behavior, time window, and trigger.</p>
                  </div>

                  <div className="space-y-3 font-semibold text-xs">
                    {/* Retries, Priority, Slots Grid */}
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Retries</label>
                        <input
                          type="number"
                          min={0}
                          max={5}
                          value={retries}
                          onChange={(e) => setRetries(parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Priority</label>
                        <select
                          value={priority}
                          onChange={(e) => setPriority(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-slate-800 outline-none cursor-pointer font-bold"
                        >
                          <option value="High">High</option>
                          <option value="Medium">Medium</option>
                          <option value="Low">Low</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Slots</label>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={slots}
                          onChange={(e) => setSlots(parseInt(e.target.value) || 1)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 outline-none"
                        />
                      </div>
                    </div>

                    {/* Retry Intervals subcard */}
                    <div className="bg-slate-50/50 p-3 rounded-lg border border-slate-100">
                      <span className="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">Retry Intervals</span>
                      <div className="flex items-center space-x-2">
                        <span className="text-[10px] text-slate-400">Retry 1</span>
                        <input
                          type="number"
                          min={1}
                          value={retryInterval}
                          onChange={(e) => setRetryInterval(parseInt(e.target.value) || 5)}
                          className="w-20 bg-white border border-slate-200 rounded-lg px-2 py-1 outline-none text-center font-bold"
                        />
                        <select
                          value={retryIntervalUnit}
                          onChange={(e) => setRetryIntervalUnit(e.target.value)}
                          className="bg-white border border-slate-200 rounded-lg px-2 py-1 outline-none cursor-pointer font-bold"
                        >
                          <option value="Mins">Mins</option>
                          <option value="Hours">Hours</option>
                          <option value="Days">Days</option>
                        </select>
                      </div>
                    </div>

                    {/* Start Time & End Time */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Start Time</label>
                        <div className="relative">
                          <input
                            type="time"
                            value={startTime}
                            onChange={(e) => setStartTime(e.target.value)}
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 text-slate-800 outline-none font-bold"
                          />
                          <Clock className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">End Time</label>
                        <div className="relative">
                          <input
                            type="time"
                            value={endTime}
                            onChange={(e) => setEndTime(e.target.value)}
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 text-slate-800 outline-none font-bold"
                          />
                          <Clock className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5" />
                        </div>
                      </div>
                    </div>

                    {/* Schedule & End After */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Schedule</label>
                        <select
                          value={scheduleTrigger}
                          onChange={(e) => setScheduleTrigger(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-slate-800 outline-none cursor-pointer font-bold"
                        >
                          <option value="Now">Now</option>
                          <option value="Later">Schedule Later</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">End After</label>
                        <div className="relative">
                          <input
                            type="datetime-local"
                            value={endAfterDate}
                            onChange={(e) => setEndAfterDate(e.target.value)}
                            placeholder="mm/dd/yyyy --:--"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 text-slate-800 outline-none font-mono text-[10px]"
                          />
                          <Calendar className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Form Action Controls Footer */}
                <div className="col-span-1 lg:col-span-3 pt-6 border-t border-slate-100 flex justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowBatchCreator(false)}
                    className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submittingCampaign || campaignsLoading || campaignAgents.length === 0 || campaignPhones.length === 0}
                    className="px-6 py-2.5 bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-600 hover:to-rose-700 text-white rounded-xl text-xs font-black transition shadow-md cursor-pointer"
                  >
                    {submittingCampaign ? 'Creating Campaign...' : 'Create & Launch Campaign'}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            /* ==========================================
               BATCH CAMPAIGNS DIRECTORY LISTING
               ========================================== */
            <>
              {/* Search Bar / Filters panel matching Attachment 1 */}
              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col md:flex-row items-center justify-between gap-4">
                <div className="relative w-full md:max-w-md">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search campaigns by name..."
                    className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-pink-500 rounded-xl pl-9 pr-4 py-2.5 text-xs font-semibold text-slate-800 outline-none transition"
                  />
                </div>

                <div className="flex items-center space-x-3 w-full md:w-auto justify-between md:justify-end">
                  {/* Status Dropdown Filter */}
                  <div className="relative">
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="bg-slate-50 border border-slate-200 text-slate-700 font-bold text-xs rounded-xl pl-3 pr-8 py-2.5 outline-none cursor-pointer appearance-none min-w-[130px]"
                    >
                      <option value="all">All Statuses</option>
                      <option value="running">Running Only</option>
                      <option value="paused">Paused Only</option>
                      <option value="completed">Completed Only</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
                  </div>

                  {/* List / Grid toggle buttons */}
                  <div className="bg-slate-100 rounded-xl p-1 flex items-center space-x-0.5">
                    <button
                      onClick={() => setViewMode('list')}
                      className={`p-1.5 rounded-lg transition cursor-pointer ${
                        viewMode === 'list' ? 'bg-white text-pink-600 shadow-xs' : 'text-slate-400 hover:text-slate-700'
                      }`}
                    >
                      <List className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setViewMode('grid')}
                      className={`p-1.5 rounded-lg transition cursor-pointer ${
                        viewMode === 'grid' ? 'bg-white text-pink-600 shadow-xs' : 'text-slate-400 hover:text-slate-700'
                      }`}
                    >
                      <Grid className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Resume All button */}
                  <button
                    onClick={handleResumeAll}
                    className="bg-white border border-slate-200 hover:border-slate-300 px-4 py-2.5 rounded-xl text-xs font-black text-slate-700 hover:bg-slate-50 transition flex items-center space-x-1.5 cursor-pointer shadow-xs"
                  >
                    <Play className="w-3.5 h-3.5 text-slate-500 fill-slate-500" />
                    <span>Resume All</span>
                  </button>
                </div>
              </div>

              {campaignsLoading ? (
                <div className="h-56 animate-pulse rounded-2xl border border-slate-200 bg-white p-6"><div className="h-4 w-48 rounded bg-slate-200" /><div className="mt-8 space-y-4"><div className="h-8 rounded bg-slate-100" /><div className="h-8 rounded bg-slate-100" /><div className="h-8 rounded bg-slate-100" /></div></div>
              ) : filteredCampaigns.length === 0 ? (
                /* ==========================================
                   EMPTY STATE (Attachment 1)
                   ========================================== */
                <div className="bg-white rounded-2xl border border-slate-200 py-16 px-6 text-center shadow-xs flex flex-col items-center justify-center space-y-4">
                  <div className="w-12 h-12 rounded-full bg-pink-50 text-pink-500 flex items-center justify-center border border-pink-100">
                    <span className="text-xl font-bold font-sans">!</span>
                  </div>
                  <div>
                    <h3 className="text-md font-black text-slate-800 tracking-tight">No Campaigns Found</h3>
                    <p className="text-xs text-slate-400 font-medium mt-1">
                      Launch your first calling campaign to start reaching customers!
                    </p>
                  </div>
                  <button
                    onClick={() => setShowBatchCreator(true)}
                    className="px-5 py-2.5 bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-600 hover:to-rose-700 text-white rounded-xl text-xs font-black transition shadow-md shadow-pink-100/50 flex items-center space-x-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create Campaign</span>
                  </button>
                </div>
              ) : viewMode === 'grid' ? (
                /* ==========================================
                   GRID VIEW
                   ========================================== */
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 font-sans">
                  {filteredCampaigns.map(c => {
                    const progressPct = c.totalLeads > 0 ? Math.round((c.calledLeads / c.totalLeads) * 100) : 0;
                    return (
                      <div key={c.id} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:shadow-md transition flex flex-col justify-between space-y-4">
                        <div className="space-y-2">
                          <div className="flex justify-between items-start">
                            <div>
                              <h4 className="font-bold text-slate-800 text-sm tracking-tight">{c.name}</h4>
                              <p className="text-[10px] text-slate-400 font-mono mt-0.5">Trunk: {c.phoneNumber}</p>
                            </div>
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${
                              c.status === 'running' ? 'bg-emerald-50 text-emerald-600 animate-pulse' :
                              c.status === 'paused' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'
                            }`}>
                              {c.status}
                            </span>
                          </div>

                          <div className="text-xs space-y-1 pt-2 font-semibold text-slate-600">
                            <div className="flex justify-between">
                              <span className="text-slate-400">Agent:</span>
                              <span>{c.agentName}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Progress:</span>
                              <span className="font-mono">{c.calledLeads} / {c.totalLeads}</span>
                            </div>
                            <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden mt-1">
                              <div className="h-full bg-pink-500 rounded-full" style={{ width: `${progressPct}%` }} />
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                          <span className="text-[10px] text-slate-400 font-mono">{c.scheduleStart}</span>
                          <div className="flex space-x-1.5">
                            <button
                              onClick={() => toggleCampaignStatus(c.id)}
                              className="p-1.5 bg-slate-50 hover:bg-pink-50 text-slate-600 hover:text-pink-600 border border-slate-200 rounded-lg transition cursor-pointer"
                            >
                              {c.status === 'running' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                            </button>
                            {!isReadOnly && <button onClick={() => void deleteCampaign(c.id)} className="p-1.5 bg-slate-50 hover:bg-rose-50 text-slate-400 hover:text-rose-600 border border-slate-200 rounded-lg transition cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* ==========================================
                   LIST / TABLE VIEW (Default)
                   ========================================== */
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden p-6">
                  <div className="overflow-x-auto text-xs">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[9px] pb-3">
                          <th className="pb-3">Campaign Name</th>
                          <th className="pb-3">Operator</th>
                          <th className="pb-3">Caller DID</th>
                          <th className="pb-3 text-right">Dial Progress</th>
                          <th className="pb-3 text-right">Success Convert</th>
                          <th className="pb-3 pl-4">Status</th>
                          <th className="pb-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-semibold">
                        {filteredCampaigns.map((c) => {
                          const progressPct = c.totalLeads > 0 ? Math.round((c.calledLeads / c.totalLeads) * 100) : 0;
                          const convertPct = c.connectedCalls > 0 ? Math.round((c.convertedCount / c.connectedCalls) * 100) : 0;
                          return (
                            <tr key={c.id} className="hover:bg-slate-50/50">
                              <td className="py-3.5 font-bold text-slate-800">
                                <span className="block text-slate-800 hover:text-pink-600 transition">{c.name}</span>
                                <span className="text-[9px] text-slate-400 font-mono block mt-0.5 font-medium">Window: {c.scheduleStart}</span>
                              </td>
                              <td className="py-3.5 text-slate-600">{c.agentName}</td>
                              <td className="py-3.5 font-mono text-slate-500">{c.phoneNumber}</td>
                              <td className="py-3.5 text-right">
                                <span>{c.calledLeads.toLocaleString()} / {c.totalLeads.toLocaleString()} ({progressPct}%)</span>
                                <div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden ml-auto mt-1.5">
                                  <div className="h-full bg-pink-500 rounded-full" style={{ width: `${progressPct}%` }} />
                                </div>
                              </td>
                              <td className="py-3.5 text-right">
                                <span className="text-emerald-600 font-bold">{c.convertedCount} leads ({convertPct}%)</span>
                              </td>
                              <td className="py-3.5 pl-4">
                                <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wide inline-block ${
                                  c.status === 'running' ? 'bg-emerald-50 text-emerald-600 animate-pulse border border-emerald-100' :
                                  c.status === 'paused' ? 'bg-amber-50 text-amber-600 border border-amber-100' : 'bg-slate-100 text-slate-500 border border-slate-200'
                                }`}>
                                  {c.status}
                                </span>
                              </td>
                              <td className="py-3.5 text-right">
                                <div className="flex justify-end items-center space-x-1.5">
                                  <button
                                    onClick={() => toggleCampaignStatus(c.id)}
                                    className={`p-1.5 rounded-lg border transition cursor-pointer ${
                                      c.status === 'running' 
                                        ? 'bg-amber-50 border-amber-100 text-amber-600 hover:bg-amber-100' 
                                        : 'bg-emerald-50 border-emerald-100 text-emerald-600 hover:bg-emerald-100'
                                    }`}
                                  >
                                    {c.status === 'running' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                                  </button>
                                  {!isReadOnly && <button onClick={() => void deleteCampaign(c.id)} className="p-1.5 bg-slate-50 hover:bg-rose-50 border border-slate-200 rounded-lg text-slate-400 hover:text-rose-600 transition cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        /* ==========================================
           REAL-TIME CAMPAIGN VIEW (Attachment 3)
           ========================================== */
        <div className="space-y-6 font-sans">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center pb-5 mb-5 border-b border-slate-100 gap-4">
              <div className="flex items-center space-x-2.5">
                <h2 className="text-md font-extrabold text-slate-800 tracking-tight">Real-Time Campaigns</h2>
                <button
                    onClick={() => showToast('Create instant lead tasks with POST /campaigns/{campaignId}/realtime/tasks using a unique eventId.')}
                  className="px-2 py-1 bg-slate-50 hover:bg-slate-100 text-slate-500 rounded border border-slate-200 text-[10px] font-bold tracking-tight transition flex items-center space-x-1"
                >
                  <FileSpreadsheet className="w-3 h-3" />
                  <span>API Docs</span>
                </button>
              </div>

              <button
                onClick={() => setShowRealtimeModal(true)}
                className="px-5 py-2.5 bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-600 hover:to-rose-700 text-white rounded-xl text-xs font-black transition shadow-lg shadow-pink-100/50 flex items-center space-x-1.5 cursor-pointer self-start sm:self-auto"
              >
                <Plus className="w-4 h-4" />
                <span>Create Realtime</span>
              </button>
            </div>

            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-400 font-black uppercase tracking-wider text-[9px] pb-3">
                    <th className="pb-3">Campaign Name</th>
                    <th className="pb-3">Campaign ID</th>
                    <th className="pb-3">Slot</th>
                    <th className="pb-3">End Date</th>
                    <th className="pb-3">Status</th>
                    <th className="pb-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {realtimeCampaigns.map((rt) => (
                    <tr key={rt.id} className="hover:bg-slate-50/50 transition">
                      {/* Name */}
                      <td className="py-3.5 font-bold text-slate-800 text-sm">
                        {rt.name}
                      </td>
                      
                      {/* Campaign ID with Copy button */}
                      <td className="py-3.5 font-mono">
                        <div className="flex items-center space-x-2 bg-amber-50/30 px-2 py-1 rounded border border-amber-100/50 w-fit">
                          <span className="text-[10px] text-slate-600 font-bold truncate max-w-[200px]">{rt.id}</span>
                          <button
                            onClick={() => handleCopyId(rt.id)}
                            className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition cursor-pointer"
                            title="Copy Campaign ID"
                          >
                            {copiedId === rt.id ? (
                              <Check className="w-3 h-3 text-emerald-600" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* Slot */}
                      <td className="py-3.5 font-mono text-slate-500">
                        {rt.callingStartTime.slice(0, 5)} - {rt.callingEndTime.slice(0, 5)}
                      </td>

                      {/* End Date */}
                      <td className="py-3.5 text-slate-500 font-medium">
                        {rt.endAfter ? new Date(rt.endAfter).toLocaleDateString() : 'No end date'}
                      </td>

                      {/* Status badge */}
                      <td className="py-3.5">
                        <span className={`px-2.5 py-0.5 rounded-md text-[9px] font-black uppercase inline-block ${
                          rt.status === 'running'
                            ? 'bg-emerald-500 text-white'
                            : 'bg-amber-500 text-white'
                        }`}>
                          {rt.status}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 text-right">
                        <div className="flex justify-end items-center space-x-2">
                          {/* Play/Pause */}
                          <button
                            onClick={() => toggleRealtimeStatus(rt.id)}
                            className="p-1 rounded text-amber-500 hover:bg-amber-50 transition cursor-pointer"
                            title={rt.status === 'running' ? 'Pause listener' : 'Resume listener'}
                          >
                            {rt.status === 'running' ? (
                              <Pause className="w-4 h-4 text-amber-600" />
                            ) : (
                              <Play className="w-4 h-4 text-emerald-600" />
                            )}
                          </button>

                          {/* Delete */}
                          {!isReadOnly && <button
                            onClick={() => void deleteRealtimeCampaign(rt.id)}
                            className="p-1 rounded text-rose-500 hover:bg-rose-50 transition cursor-pointer"
                            title="Deactivate & Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!campaignsLoading && realtimeCampaigns.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-slate-400">No real-time campaigns found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
         CREATE REAL-TIME CAMPAIGN DIALOG MODAL (Attachment 4)
         ========================================== */}
      {showRealtimeModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full border border-slate-100 overflow-hidden animate-in zoom-in-95 duration-150 relative">
            
            {/* Header with 'x' close button */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">Create Real-Time Campaign</h3>
              <button
                onClick={() => setShowRealtimeModal(false)}
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateRealtimeCampaign} className="p-6 space-y-4 text-xs font-semibold">
              
              {/* Campaign Name */}
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Campaign Name</label>
                <input
                  type="text"
                  required
                  value={rtCampName}
                  onChange={(e) => setRtCampName(e.target.value)}
                  placeholder="e.g. Inbound Lead Responder"
                  className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-pink-500 rounded-lg px-3 py-2 text-slate-800 outline-none transition font-sans"
                />
              </div>

              {/* Agent selector (Optional) */}
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Agent</label>
                <select
                  value={rtAgentId}
                  onChange={(e) => setRtAgentId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none cursor-pointer"
                >
                  <option value="">Select an active agent</option>
                  {campaignAgents.map(agent => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">From Number</label>
                <select required value={rtNumberId} onChange={(event) => setRtNumberId(event.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none cursor-pointer">
                  <option value="">Select an assigned number</option>
                  {campaignPhones.map((phone) => <option key={phone.id} value={phone.id}>{phone.number} ({phone.provider})</option>)}
                </select>
              </div>

              {/* Start Time & End Time */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Start Time</label>
                  <div className="relative">
                    <input
                      type="time"
                      value={rtStartTime}
                      onChange={(e) => setRtStartTime(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none font-bold"
                    />
                    <Clock className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5" />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">End Time</label>
                  <div className="relative">
                    <input
                      type="time"
                      value={rtEndTime}
                      onChange={(e) => setRtEndTime(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none font-bold"
                    />
                    <Clock className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5" />
                  </div>
                </div>
              </div>

              {/* End Date with Calendar Icon */}
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">End Date</label>
                <div className="relative">
                  <input
                    type="datetime-local"
                    value={rtEndDate}
                    onChange={(e) => setRtEndDate(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none font-bold font-mono text-[10px]"
                  />
                  <Calendar className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5 font-sans" />
                </div>
              </div>

              {/* Slots (Concurrency) */}
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Slots (Concurrency)</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={rtSlots}
                  onChange={(e) => setRtSlots(parseInt(e.target.value) || 1)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 outline-none text-left"
                />
                <span className="block text-[10px] text-slate-400 mt-1 font-medium font-sans">
                  Maximum allowed by your plan: 20
                </span>
              </div>

              {/* Submit Button (magenta pink) */}
              <div className="pt-4 flex flex-col space-y-2">
                <button
                  type="submit"
                  disabled={submittingCampaign || campaignsLoading || !rtAgentId || !rtNumberId}
                  className="w-full py-2.5 bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-600 hover:to-rose-700 text-white rounded-lg font-black transition shadow-md text-xs cursor-pointer text-center"
                >
                  {submittingCampaign ? 'Creating...' : 'Create'}
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
   4. VOICE AGENTS LIST
   ========================================== */
interface AgentApiData {
  id: string; name: string; description: string | null; goal: string | null; language: string;
  usageDirection: 'inbound' | 'outbound' | 'both';
  status: 'active' | 'draft' | 'archived'; phoneNumberId: string | null; phoneNumber: string | null;
  stt: { modelId: string; providerName: string; modelName: string };
  llm: { modelId: string; providerName: string; modelName: string };
  tts: { modelId: string; providerName: string; modelName: string };
  voiceId: string; prompt: string; welcomeMessage: string | null; temperature: number;
  interruptionSensitivity: number; silenceTimeoutMs: number; inactivityTimeoutSeconds: number;
  settings: Record<string, unknown>; createdAt: string; updatedAt: string;
  metrics: { totalCalls: number; averageDurationSeconds: number; successRate: number };
}

function agentFromApi(value: AgentApiData): VoiceAgent {
  return {
    ...(value.settings as Partial<VoiceAgent>),
    id: value.id, name: value.name, status: value.status, voiceId: value.voiceId,
    temperature: value.temperature, prompt: value.prompt,
    interruptionSensitivity: value.interruptionSensitivity, silenceTimeout: value.silenceTimeoutMs,
    sttProvider: value.stt.providerName, sttModel: value.stt.modelName,
    ttsProvider: value.tts.providerName, ttsModel: value.tts.modelName,
    llmProvider: value.llm.providerName, llmModel: value.llm.modelName,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    totalCalls: value.metrics.totalCalls, avgDuration: value.metrics.averageDurationSeconds, successRate: value.metrics.successRate,
    description: value.description ?? '', goal: value.goal ?? '', language: value.language, agentUsage: value.usageDirection,
    welcomeMessage: value.welcomeMessage ?? '', inactivityTimeout: value.inactivityTimeoutSeconds,
  };
}

function AgentsListView({ agents, setAgents, onEditAgent, onAddAgent }: { agents: VoiceAgent[]; setAgents: React.Dispatch<React.SetStateAction<VoiceAgent[]>>; onEditAgent: (id: string) => void; onAddAgent: () => void }) {
  const { role } = useAppState();
  const isReadOnly = role === 'USER';

  // State for user role simple view
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [agentError, setAgentError] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  const userAgents = agents.map((agent) => ({ ...agent, statusLabel: agent.status === 'active' ? 'Live' : agent.status }));

  const handleRefresh = async (forceRefresh = false) => {
    setIsRefreshing(true);
    setAgentError('');
    try {
      const data = await apiRequest<{ items: AgentApiData[] }>('/agents?page=1&pageSize=50', forceRefresh ? { zeaCache: 'reload' } : {});
      setAgents(data.items.map(agentFromApi));
    } catch (requestError) { setAgentError(requestError instanceof Error ? requestError.message : 'Agents could not be loaded'); }
    finally { setIsRefreshing(false); }
  };

  useEffect(() => { void handleRefresh(); }, []);

  const handleCopy = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleAgentStatus = async (agent: VoiceAgent) => {
    try {
      const updated = await apiRequest<AgentApiData>(`/agents/${agent.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status: agent.status === 'active' ? 'draft' : 'active' }),
      });
      setAgents((current) => current.map((item) => item.id === agent.id ? agentFromApi(updated) : item));
    } catch (requestError) { setAgentError(requestError instanceof Error ? requestError.message : 'Agent status could not be changed'); }
  };

  const deleteAgent = async (agent: VoiceAgent) => {
    if (!window.confirm(`Archive voice agent "${agent.name}"?`)) return;
    try {
      await apiRequest(`/agents/${agent.id}`, { method: 'DELETE' });
      setAgents((current) => current.filter((item) => item.id !== agent.id));
    } catch (requestError) { setAgentError(requestError instanceof Error ? requestError.message : 'Agent could not be archived'); }
  };

  const filteredUserAgents = userAgents.filter(agent =>
    agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    agent.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (isReadOnly) {
    return (
      <div className="space-y-6">
        {agentError && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">{agentError}</div>}
        {/* Header Row */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-slate-200">
          <div>
            <h2 className="text-2xl font-black text-slate-800 tracking-tight">Voice Agents</h2>
            <p className="text-xs text-slate-400 font-semibold mt-1">Build and manage your AI calling agents</p>
          </div>
          <div className="flex items-center space-x-2 mt-4 sm:mt-0">
            <button
              onClick={() => void handleRefresh(true)}
              className="bg-white border border-slate-200 hover:bg-slate-50 rounded-xl px-4 py-2.5 text-xs font-bold text-slate-700 shadow-xs flex items-center space-x-2 transition cursor-pointer select-none"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-slate-500 ${isRefreshing ? 'animate-spin text-purple-600' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Search and view toggle row */}
        <div className="flex items-center justify-between">
          <div className="relative w-full max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
            <input
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 outline-none placeholder-slate-400 focus:border-slate-300 focus:ring-1 focus:ring-slate-300 transition"
            />
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-2.5 rounded-xl border transition cursor-pointer ${
                viewMode === 'grid'
                  ? 'bg-purple-50 border-purple-200 text-[#7C3AED]'
                  : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-2.5 rounded-xl border transition cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-purple-50 border-purple-200 text-[#7C3AED]'
                  : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50'
              }`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main List Box */}
        {viewMode === 'list' ? (
          <div className="bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-xs">
            <div className="px-6 py-4 bg-slate-50/50 border-b border-slate-100 flex items-center justify-between">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Agent</span>
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Status</span>
            </div>
            {filteredUserAgents.length > 0 ? (
              <div className="divide-y divide-slate-100">
                {filteredUserAgents.map((agent) => (
                  <div key={agent.id} className="px-6 py-5 flex items-center justify-between hover:bg-slate-50/30 transition">
                    <div className="flex items-center space-x-4">
                      <div className="w-11 h-11 rounded-full bg-gradient-to-tr from-[#8B5CF6] to-[#7C3AED] text-white flex items-center justify-center font-black text-sm shrink-0 shadow-sm shadow-purple-100">
                        {agent.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-sm font-black text-slate-800 tracking-tight leading-none">{agent.name}</span>
                        <div className="flex items-center space-x-1.5 mt-2">
                          <span className="text-[10px] font-mono text-slate-400 select-all">{agent.id}</span>
                          <button
                            onClick={() => handleCopy(agent.id)}
                            className="p-1 rounded-md hover:bg-slate-100 transition text-slate-400 hover:text-slate-600 cursor-pointer animate-none"
                            title="Copy UUID"
                          >
                            {copiedId === agent.id ? (
                              <Check className="w-3 h-3 text-emerald-500 stroke-[3]" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div>
                      {/* Live status badge with pulsating green dot */}
                      <span className="bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-full px-3.5 py-1.5 text-xs font-black tracking-wide flex items-center space-x-2 select-none">
                        <span className="relative flex h-1.5 w-1.5 shrink-0">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                        </span>
                        <span>{agent.statusLabel}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-12 text-center text-slate-400 font-semibold text-xs">No voice agents found matching "{searchQuery}"</div>
            )}
          </div>
        ) : (
          /* Grid Mode matching the simple cards layout */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredUserAgents.map((agent) => (
              <div key={agent.id} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between hover:shadow-md transition">
                <div>
                  <div className="flex justify-between items-start">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#8B5CF6] to-[#7C3AED] text-white flex items-center justify-center font-black text-xs shrink-0 shadow-xs">
                        {agent.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex flex-col">
                        <h4 className="font-black text-slate-800 text-sm tracking-tight leading-none">{agent.name}</h4>
                        <div className="flex items-center space-x-1.5 mt-1.5">
                          <span className="text-[9px] font-mono text-slate-400">{agent.id.slice(0, 15)}...</span>
                          <button onClick={() => handleCopy(agent.id)} className="text-slate-400 hover:text-slate-600 transition cursor-pointer">
                            {copiedId === agent.id ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                      </div>
                    </div>
                    <span className="bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-full px-2.5 py-1 text-[10px] font-black tracking-wide flex items-center space-x-1.5">
                      <span className="relative flex h-1 w-1">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-1 w-1 bg-emerald-500"></span>
                      </span>
                      <span>{agent.statusLabel}</span>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
      {agentError && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">{agentError}</div>}
      <div className="flex justify-between items-center border-b border-slate-200 pb-5 mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">Conversational Operators</h2>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Control LLM prompts, active voice outputs, and registered tools.</p>
        </div>

        {!isReadOnly ? (
          <button
            onClick={onAddAgent}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition shadow-md shadow-indigo-100/50 flex items-center space-x-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Provision Operator</span>
          </button>
        ) : (
          <span className="bg-slate-100 text-slate-500 text-xs px-3 py-1.5 rounded-lg font-bold flex items-center space-x-1.5 border border-slate-200">
            <Lock className="w-3.5 h-3.5" />
            <span>Locked View</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {agents.map((agent) => (
          <div key={agent.id} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex flex-col justify-between hover:shadow-md transition duration-200">
            <div>
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="font-bold text-slate-800 text-sm tracking-tight">{agent.name}</h4>
                  <span className="text-[10px] text-slate-400 mt-1 block">TTS ID: {agent.voiceId}</span>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                  agent.status === 'active' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-slate-100 border-slate-200 text-slate-500'
                }`}>
                  {agent.status}
                </span>
              </div>

              <div className="mt-4 space-y-2">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-slate-400">LLM Engine:</span>
                  <span className="text-slate-700 font-medium">{agent.llmModel}</span>
                </div>
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-slate-400">Speech Provider:</span>
                  <span className="text-slate-700 font-medium">{agent.sttProvider}</span>
                </div>
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-slate-400">Inbound Calls:</span>
                  <span className="text-slate-700 font-mono font-bold">{agent.totalCalls.toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-[1fr_auto_auto] gap-2">
              <button onClick={() => onEditAgent(agent.id)} className="py-2.5 bg-slate-50 hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 rounded-lg text-xs font-bold transition border border-slate-200 flex items-center justify-center space-x-1 cursor-pointer"><span>Architect Engine</span><ArrowRight className="w-3.5 h-3.5" /></button>
              <button onClick={() => void toggleAgentStatus(agent)} title={agent.status === 'active' ? 'Set draft' : 'Activate'} className="rounded-lg border border-amber-100 bg-amber-50 px-3 text-xs font-bold text-amber-700">{agent.status === 'active' ? 'Draft' : 'Activate'}</button>
              <button onClick={() => void deleteAgent(agent)} title="Archive agent" className="rounded-lg border border-red-100 bg-red-50 px-3 text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
        {!isRefreshing && agents.length === 0 && <div className="md:col-span-2 lg:col-span-3 rounded-xl border border-dashed border-slate-300 p-10 text-center text-xs font-semibold text-slate-400">No voice agents have been created for this company.</div>}
      </div>
    </div>
  );
}

/* ==========================================
   5. CUSTOM REPORTS / CALL LOGS
   ================================5. CUSTOM REPORTS / CALL LOGS ========== */

function CallAudioPlayer({ durationSec }: { durationSec: number }) {
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);

  React.useEffect(() => {
    let interval: any;
    if (isPlaying) {
      interval = setInterval(() => {
        setCurrentTime(prev => {
          if (prev >= durationSec) {
            setIsPlaying(false);
            return 0;
          }
          return prev + 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isPlaying, durationSec]);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remaining = secs % 60;
    return `${mins}:${remaining < 10 ? '0' : ''}${remaining}`;
  };

  const handlePlayToggle = () => {
    setIsPlaying(!isPlaying);
  };

  const percentage = durationSec > 0 ? (currentTime / durationSec) * 100 : 0;

  return (
    <div className="bg-[#f1f3f4] rounded-2xl px-5 py-4 flex items-center justify-between w-full shadow-inner select-none">
      {/* Play/Pause Button */}
      <button 
        onClick={handlePlayToggle}
        className="w-10 h-10 rounded-full hover:bg-slate-200/60 flex items-center justify-center transition cursor-pointer text-slate-800 focus:outline-none"
      >
        {isPlaying ? (
          // Pause Icon
          <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
          </svg>
        ) : (
          // Play Icon
          <svg className="w-4 h-4 fill-current ml-0.5" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z"/>
          </svg>
        )}
      </button>

      {/* Time Tracker */}
      <div className="text-xs font-mono font-bold text-slate-600 px-2 shrink-0">
        {formatTime(currentTime)} / {formatTime(durationSec)}
      </div>

      {/* Seek Track */}
      <div 
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          const pct = Math.max(0, Math.min(1, clickX / rect.width));
          setCurrentTime(Math.floor(pct * durationSec));
        }}
        className="flex-1 mx-3 h-1 bg-slate-300/80 rounded-full relative cursor-pointer group"
      >
        <div 
          className="h-full bg-slate-800 rounded-full transition-all duration-150"
          style={{ width: `${percentage}%` }}
        />
        <div 
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-slate-800 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ left: `calc(${percentage}% - 5px)` }}
        />
      </div>

      {/* Volume and Actions */}
      <div className="flex items-center space-x-3 text-slate-600">
        <button className="p-1 hover:bg-slate-200/50 rounded-full transition cursor-pointer">
          <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
          </svg>
        </button>
        <button className="p-1 hover:bg-slate-200/50 rounded-full transition cursor-pointer">
          <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

interface CallLogItem {
  id: string;
  sNo: number;
  timestamp: string;
  contactName: string;
  callType: 'Inbound' | 'Outbound';
  outcome: 'N/A' | 'Busy' | 'Completed' | 'Answering Machine' | 'User Hung Up';
  duration: string;
  durationSec: number;
  prospectNumber: string;
  agentName: string;
  campaignName: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'Neutral';
  cost: number;
  transcript: Array<{ speaker: 'agent' | 'user' | 'Customer' | 'Agent'; text: string; time?: string }>;
  aiSummary?: string;
  fullTranscriptText?: string;
}

const truncateToTwoWords = (str: string) => {
  if (!str) return '—';
  const cleanStr = str.trim();
  const words = cleanStr.split(/\s+/);
  if (words.length <= 2) return cleanStr;
  return words.slice(0, 2).join(' ') + '...';
};

function CustomReportsView({ agents }: { agents: VoiceAgent[] }) {
  // Generate 195 mock call logs to match the requested design exactly
  const [allLogs] = useState<CallLogItem[]>(() => {
    const list: CallLogItem[] = [];

    // 1. The 4 logs from the image
    list.push({
      id: 'log-img-1',
      sNo: 1,
      timestamp: 'Jul 10, 02:03 PM',
      contactName: 'Caller',
      callType: 'Inbound',
      outcome: 'N/A',
      duration: '53s',
      durationSec: 53,
      prospectNumber: '919500600811',
      agentName: 'Shanmuga_test packages-Inbound',
      campaignName: 'Inbound Healthcare Support',
      sentiment: 'neutral',
      cost: 0.13,
      transcript: [
        { speaker: 'agent', text: 'Good afternoon — Perumal நா ஷண்முகா Hospitalல இருந்து AI Agent கார்த்திகா பேசுறங்க — How can I help you?', time: '0:02' },
        { speaker: 'user', text: 'ஓகே', time: '0:08' },
        { speaker: 'agent', text: 'நீங்க Facebookல full body checkupக்காக உங்க details fill பண்ணிருந்தீங்க. எங்க packages பத்தி தெரிஞ்சுக்கிறீங்களா?', time: '0:15' },
        { speaker: 'user', text: 'எஸ்', time: '0:22' },
        { speaker: 'agent', text: 'Alright, எங்ககிட்ட மூணு packages இருக்கு. Silver, Gold, and Platinum. And மூணும் இப்போ currentஅ up to fifty percent discountல இருக்கு. Also, organwise health checkupsஉம் இருக்கு. நீங்க என்ன மாதிரி health check upக்கு plan பண்றீங்க?', time: '0:35' }
      ]
    });

    list.push({
      id: 'log-img-2',
      sNo: 2,
      timestamp: 'Jul 10, 02:03 PM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'N/A',
      duration: '14s',
      durationSec: 14,
      prospectNumber: '919500600811',
      agentName: 'Sarah - Sales Qualifier',
      campaignName: 'Q3 Cold Outreach Campaign',
      sentiment: 'neutral',
      cost: 0.04,
      transcript: [
        { speaker: 'agent', text: 'Hello, this is Sarah from Zea Voice. Am I speaking with the business owner?', time: '0:02' },
        { speaker: 'user', text: 'No, sorry, wrong number.', time: '0:07' },
        { speaker: 'agent', text: 'Ah, my apologies. Have a wonderful day!', time: '0:11' }
      ]
    });

    list.push({
      id: 'log-img-3',
      sNo: 3,
      timestamp: 'Jul 10, 12:28 PM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'Busy',
      duration: '0s',
      durationSec: 0,
      prospectNumber: '+917200627475',
      agentName: 'Sarah - Sales Qualifier',
      campaignName: 'Q3 Cold Outreach Campaign',
      sentiment: 'neutral',
      cost: 0.00,
      transcript: []
    });

    list.push({
      id: 'log-img-4',
      sNo: 4,
      timestamp: 'Jul 10, 12:26 PM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'N/A',
      duration: '16s',
      durationSec: 16,
      prospectNumber: '919442801758',
      agentName: 'Sarah - Sales Qualifier',
      campaignName: 'Inactive Customer Re-activation',
      sentiment: 'negative',
      cost: 0.04,
      transcript: [
        { speaker: 'agent', text: 'Hello, this is Sarah from Zea Voice. Just calling to verify your active subscription status.', time: '0:02' },
        { speaker: 'user', text: 'Stop calling me. I told you guys to take me off your list.', time: '0:08' },
        { speaker: 'agent', text: 'I am extremely sorry for the inconvenience. I will mark this number as do-not-call immediately.', time: '0:14' }
      ]
    });

    // Generate remaining 191 records (to make exactly 195 records)
    const phoneSuffixes = ['58', '12', '99', '04', '77', '61', '83', '40', '26', '35'];
    const agentNames = ['Sarah - Sales Qualifier', 'Michael - Support Desk Bot'];
    const campaignsList = ['Q3 Cold Outreach Campaign', 'Post-Support Feedback Survey', 'Inactive Customer Re-activation'];
    const sentiments: ('positive' | 'neutral' | 'negative')[] = ['positive', 'neutral', 'negative'];

    // Add 100 Inbound
    for (let i = 0; i < 100; i++) {
      const min = Math.floor(Math.random() * 60);
      const hour = Math.floor(Math.random() * 12) + 1;
      const isAm = Math.random() > 0.5;
      const day = Math.floor(Math.random() * 10) + 1; // Jul 1 to Jul 10
      const durationSec = Math.floor(Math.random() * 120) + 5;
      const durationStr = `${durationSec}s`;
      
      list.push({
        id: `log-inbound-${i}`,
        sNo: 0,
        timestamp: `Jul ${day < 10 ? '0' + day : day}, ${hour < 10 ? '0' + hour : hour}:${min < 10 ? '0' + min : min} ${isAm ? 'AM' : 'PM'}`,
        contactName: Math.random() > 0.3 ? 'Caller' : 'N/A',
        callType: 'Inbound',
        outcome: durationSec > 35 ? 'Completed' : 'N/A',
        duration: durationStr,
        durationSec,
        prospectNumber: `919500600${phoneSuffixes[i % phoneSuffixes.length]}${String(i).padStart(2, '0')}`,
        agentName: agentNames[1],
        campaignName: 'N/A',
        sentiment: sentiments[i % sentiments.length],
        cost: Number((durationSec * 0.003).toFixed(2)),
        transcript: [
          { speaker: 'user', text: 'Hello, is this tech support for Zea Voice?', time: '0:01' },
          { speaker: 'agent', text: 'Yes, it is! Michael here. How can I help you today?', time: '0:06' },
          { speaker: 'user', text: 'I am trying to confirm if my active campaign calls are routed correctly.', time: '0:14' },
          { speaker: 'agent', text: 'Let me inspect your operational trunks. Yes, everything appears active and routing correctly!', time: '0:22' }
        ]
      });
    }

    // Add 91 Outbound
    for (let i = 0; i < 91; i++) {
      const min = Math.floor(Math.random() * 60);
      const hour = Math.floor(Math.random() * 12) + 1;
      const isAm = Math.random() > 0.5;
      const day = Math.floor(Math.random() * 10) + 1;
      const durationSec = Math.floor(Math.random() * 110);
      const durationStr = durationSec === 0 ? '0s' : `${durationSec}s`;
      const outcome = durationSec === 0 ? 'Busy' : (durationSec < 20 ? 'Answering Machine' : 'Completed');

      list.push({
        id: `log-outbound-${i}`,
        sNo: 0,
        timestamp: `Jul ${day < 10 ? '0' + day : day}, ${hour < 10 ? '0' + hour : hour}:${min < 10 ? '0' + min : min} ${isAm ? 'AM' : 'PM'}`,
        contactName: 'N/A',
        callType: 'Outbound',
        outcome,
        duration: durationStr,
        durationSec,
        prospectNumber: `+91720062${phoneSuffixes[i % phoneSuffixes.length]}${String(i).padStart(2, '0')}`,
        agentName: agentNames[0],
        campaignName: campaignsList[i % campaignsList.length],
        sentiment: sentiments[i % sentiments.length],
        cost: Number((durationSec * 0.0025).toFixed(2)),
        transcript: durationSec > 0 ? [
          { speaker: 'agent', text: 'Hello, this is Sarah with Zea Voice. I noticed your interest in automating incoming sales routes?', time: '0:02' },
          { speaker: 'user', text: 'Yes, we have high call volumes during product launches. Can you scale?', time: '0:10' },
          { speaker: 'agent', text: 'Absolutely, our neural nodes can manage up to 10,000 parallel streams with less than 400ms delay. Shall we set up an integration trial?', time: '0:19' }
        ] : []
      });
    }

    // Sort to keep img logs at the top (newest Jul 10 logs)
    list.sort((a, b) => {
      if (a.id.startsWith('log-img') && b.id.startsWith('log-img')) {
        return a.sNo - b.sNo;
      }
      if (a.id.startsWith('log-img')) return -1;
      if (b.id.startsWith('log-img')) return 1;

      return b.timestamp.localeCompare(a.timestamp);
    });

    // Assign S.No
    list.forEach((item, index) => {
      item.sNo = index + 1;
    });

    return list;
  });

  // Filters State
  const [dateRange, setDateRange] = useState('All Time');
  const [callType, setCallType] = useState('All Types');
  const [outcome, setOutcome] = useState('All Outcomes');
  const [selectedAgent, setSelectedAgent] = useState('All Agents');
  const [callDuration, setCallDuration] = useState('All Durations');
  const [selectedCampaign, setSelectedCampaign] = useState('All Campaigns');
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  
  // Tabs state ("All Calls", "Inbound", "Outbound")
  const [activeTab, setActiveTab] = useState<'All' | 'Inbound' | 'Outbound'>('All');

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Selected single log review
  const [activeReviewLog, setActiveReviewLog] = useState<CallLogItem | null>(null);
  const [drawerMode, setDrawerMode] = useState<'details' | 'transcript'>('details');

  // Success message for Export
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  // Clear all filters handler
  const handleClearFilters = () => {
    setDateRange('All Time');
    setCallType('All Types');
    setOutcome('All Outcomes');
    setSelectedAgent('All Agents');
    setCallDuration('All Durations');
    setSelectedCampaign('All Campaigns');
    setSearchQuery('');
    setActiveTab('All');
    setCurrentPage(1);
  };

  // Filter Logic
  const filteredLogs = allLogs.filter(log => {
    // 1. Tab filter
    if (activeTab === 'Inbound' && log.callType !== 'Inbound') return false;
    if (activeTab === 'Outbound' && log.callType !== 'Outbound') return false;

    // 2. Call Type dropdown filter
    if (callType !== 'All Types' && log.callType !== callType) return false;

    // 3. Date Range filter
    if (dateRange === 'Today') {
      if (!log.timestamp.startsWith('Jul 10')) return false;
    } else if (dateRange === 'Yesterday') {
      if (!log.timestamp.startsWith('Jul 09')) return false;
    } else if (dateRange === 'Last 7 Days') {
      const match = log.timestamp.match(/Jul (\d+)/);
      if (match) {
        const day = parseInt(match[1]);
        if (day < 4 || day > 10) return false;
      } else return false;
    }

    // 4. Outcome filter
    if (outcome !== 'All Outcomes' && log.outcome !== outcome) return false;

    // 5. Voice Agent filter
    if (selectedAgent !== 'All Agents') {
      const match = log.agentName.toLowerCase().includes(selectedAgent.toLowerCase().split(' - ')[0]);
      if (!match) return false;
    }

    // 6. Call Duration filter
    if (callDuration !== 'All Durations') {
      const sec = log.durationSec;
      if (callDuration === '0-30s' && sec > 30) return false;
      if (callDuration === '31-60s' && (sec <= 30 || sec > 60)) return false;
      if (callDuration === '1-2m' && (sec <= 60 || sec > 120)) return false;
      if (callDuration === '2-5m' && (sec <= 120 || sec > 300)) return false;
      if (callDuration === '5m+' && sec <= 300) return false;
    }

    // 7. Outbound Campaign filter
    if (selectedCampaign !== 'All Campaigns' && log.campaignName !== selectedCampaign) return false;

    // 8. Search query filter
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      const numMatch = log.prospectNumber.toLowerCase().includes(q);
      const agentMatch = log.agentName.toLowerCase().includes(q);
      const contactMatch = log.contactName.toLowerCase().includes(q);
      if (!numMatch && !agentMatch && !contactMatch) return false;
    }

    return true;
  });

  const paginatedLogs = filteredLogs.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const totalPages = Math.ceil(filteredLogs.length / itemsPerPage);

  const totalCallsCount = allLogs.length; // 195
  const inboundCount = allLogs.filter(l => l.callType === 'Inbound').length; // 101
  const outboundCount = allLogs.filter(l => l.callType === 'Outbound').length; // 94

  const handleExportExcel = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "S.No,Time Stamp,Contact Name,Call Type,Outcome,Duration,Prospect Number,Agent Name,Campaign Name,Cost,Sentiment\n";
    
    filteredLogs.forEach(l => {
      const row = [
        l.sNo,
        `"${l.timestamp}"`,
        `"${l.contactName}"`,
        `"${l.callType}"`,
        `"${l.outcome}"`,
        `"${l.duration}"`,
        `"${l.prospectNumber}"`,
        `"${l.agentName}"`,
        `"${l.campaignName}"`,
        `₹${l.cost}`,
        `"${l.sentiment}"`
      ].join(",");
      csvContent += row + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `ZeaVoice_CallLogs_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setExportMessage(`Successfully exported ${filteredLogs.length} filtered call records to Excel/CSV format.`);
    setTimeout(() => setExportMessage(null), 4000);
  };

  return (
    <div className="space-y-6">
      {/* Upper header action section matching Attachment image */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">Call Logs</h2>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Review all inbound and outbound calls</p>
        </div>
        <button
          onClick={handleExportExcel}
          className="bg-white hover:bg-slate-50 text-slate-600 font-bold text-xs px-4 py-2.5 rounded-xl border border-slate-200 transition flex items-center justify-center space-x-2 shadow-xs cursor-pointer animate-none"
        >
          <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
          <span>Export Excel</span>
        </button>
      </div>

      {exportMessage && (
        <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs font-semibold flex items-center space-x-2 animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <span>{exportMessage}</span>
        </div>
      )}

      {/* Summary Cards Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Total Calls */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Calls</p>
            <p className="text-3xl font-black text-slate-800 tracking-tight">{totalCallsCount}</p>
          </div>
          <div className="w-12 h-12 bg-pink-50 border border-pink-100 rounded-2xl flex items-center justify-center">
            <PhoneCall className="w-5 h-5 text-pink-500" />
          </div>
        </div>

        {/* Inbound */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Inbound</p>
            <p className="text-3xl font-black text-slate-800 tracking-tight">{inboundCount}</p>
          </div>
          <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center">
            <PhoneIncoming className="w-5 h-5 text-blue-500" />
          </div>
        </div>

        {/* Outbound */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Outbound</p>
            <p className="text-3xl font-black text-slate-800 tracking-tight">{outboundCount}</p>
          </div>
          <div className="w-12 h-12 bg-rose-50 border border-rose-100 rounded-2xl flex items-center justify-center">
            <PhoneOutgoing className="w-5 h-5 text-rose-500" />
          </div>
        </div>
      </div>

      {/* Search Filters Card */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-5">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center space-x-1.5">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Search Filters</span>
          </h3>
          <button
            onClick={handleClearFilters}
            className="text-xs font-bold text-pink-500 hover:text-pink-600 transition flex items-center space-x-1 cursor-pointer"
          >
            <XCircle className="w-3.5 h-3.5" />
            <span>Clear Filters</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-semibold">
          {/* Date Range */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date Range</label>
            <div className="relative">
              <select
                value={dateRange}
                onChange={(e) => { setDateRange(e.target.value); setCurrentPage(1); }}
                className="w-full bg-slate-50 hover:bg-slate-100/50 border border-slate-200 rounded-xl pl-8 pr-4 py-2.5 text-slate-800 font-bold outline-none cursor-pointer appearance-none transition"
              >
                <option value="All Time">All Time</option>
                <option value="Today">Today</option>
                <option value="Yesterday">Yesterday</option>
                <option value="Last 7 Days">Last 7 Days</option>
                <option value="Last 30 Days">Last 30 Days</option>
              </select>
              <Calendar className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
            </div>
          </div>

          {/* Call Type */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Call Type</label>
            <div className="relative">
              <select
                value={callType}
                onChange={(e) => { setCallType(e.target.value); setCurrentPage(1); }}
                className="w-full bg-slate-50 hover:bg-slate-100/50 border border-slate-200 rounded-xl pl-8 pr-4 py-2.5 text-slate-800 font-bold outline-none cursor-pointer appearance-none transition"
              >
                <option value="All Types">All Types</option>
                <option value="Inbound">Inbound</option>
                <option value="Outbound">Outbound</option>
              </select>
              <Phone className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
            </div>
          </div>

          {/* Outcome */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Outcome</label>
            <div className="relative">
              <select
                value={outcome}
                onChange={(e) => { setOutcome(e.target.value); setCurrentPage(1); }}
                className="w-full bg-slate-50 hover:bg-slate-100/50 border border-slate-200 rounded-xl pl-8 pr-4 py-2.5 text-slate-800 font-bold outline-none cursor-pointer appearance-none transition"
              >
                <option value="All Outcomes">All Outcomes</option>
                <option value="N/A">N/A</option>
                <option value="Busy">Busy</option>
                <option value="Completed">Completed</option>
                <option value="Answering Machine">Answering Machine</option>
                <option value="User Hung Up">User Hung Up</option>
              </select>
              <Activity className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
            </div>
          </div>

          {/* Voice Agent */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Voice Agent</label>
            <div className="relative">
              <select
                value={selectedAgent}
                onChange={(e) => { setSelectedAgent(e.target.value); setCurrentPage(1); }}
                className="w-full bg-slate-50 hover:bg-slate-100/50 border border-slate-200 rounded-xl pl-8 pr-4 py-2.5 text-slate-800 font-bold outline-none cursor-pointer appearance-none transition"
              >
                <option value="All Agents">All Agents</option>
                {agents.map(a => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
              <User className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-semibold">
          {/* Call Duration */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Call Duration</label>
            <div className="relative">
              <select
                value={callDuration}
                onChange={(e) => { setCallDuration(e.target.value); setCurrentPage(1); }}
                className="w-full bg-slate-50 hover:bg-slate-100/50 border border-slate-200 rounded-xl pl-8 pr-4 py-2.5 text-slate-800 font-bold outline-none cursor-pointer appearance-none transition"
              >
                <option value="All Durations">All Durations</option>
                <option value="0-30s">0-30s</option>
                <option value="31-60s">31-60s</option>
                <option value="1-2m">1-2m</option>
                <option value="2-5m">2-5m</option>
                <option value="5m+">5m+</option>
              </select>
              <Clock className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
            </div>
          </div>

          {/* Outbound Campaign */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Outbound Campaign</label>
            <div className="relative">
              <select
                value={selectedCampaign}
                onChange={(e) => { setSelectedCampaign(e.target.value); setCurrentPage(1); }}
                className="w-full bg-slate-50 hover:bg-slate-100/50 border border-slate-200 rounded-xl pl-8 pr-4 py-2.5 text-slate-800 font-bold outline-none cursor-pointer appearance-none transition"
              >
                <option value="All Campaigns">All Campaigns</option>
                <option value="Q3 Cold Outreach Campaign">Q3 Cold Outreach Campaign</option>
                <option value="Post-Support Feedback Survey">Post-Support Feedback Survey</option>
                <option value="Inactive Customer Re-activation">Inactive Customer Re-activation</option>
              </select>
              <Megaphone className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
            </div>
          </div>
        </div>
      </div>

      {/* Pill tabs + Search Row */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
        {/* All / Inbound / Outbound Tabs */}
        <div className="flex flex-wrap items-center gap-2">
          {/* All Calls */}
          <button
            onClick={() => { setActiveTab('All'); setCurrentPage(1); }}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center space-x-2 transition cursor-pointer border ${
              activeTab === 'All'
                ? 'bg-pink-500 text-white border-pink-500 shadow-md shadow-pink-100/50'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Phone className="w-3.5 h-3.5" />
            <span>All Calls</span>
            <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-black ${activeTab === 'All' ? 'bg-white/25 text-white' : 'bg-slate-200 text-slate-700'}`}>
              {totalCallsCount}
            </span>
          </button>

          {/* Inbound */}
          <button
            onClick={() => { setActiveTab('Inbound'); setCurrentPage(1); }}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center space-x-2 transition cursor-pointer border ${
              activeTab === 'Inbound'
                ? 'bg-pink-500 text-white border-pink-500 shadow-md shadow-pink-100/50'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <PhoneIncoming className="w-3.5 h-3.5" />
            <span>Inbound</span>
            <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-black ${activeTab === 'Inbound' ? 'bg-white/25 text-white' : 'bg-slate-200 text-slate-700'}`}>
              {inboundCount}
            </span>
          </button>

          {/* Outbound */}
          <button
            onClick={() => { setActiveTab('Outbound'); setCurrentPage(1); }}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center space-x-2 transition cursor-pointer border ${
              activeTab === 'Outbound'
                ? 'bg-pink-500 text-white border-pink-500 shadow-md shadow-pink-100/50'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <PhoneOutgoing className="w-3.5 h-3.5" />
            <span>Outbound</span>
            <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-black ${activeTab === 'Outbound' ? 'bg-white/25 text-white' : 'bg-slate-200 text-slate-700'}`}>
              {outboundCount}
            </span>
          </button>
        </div>

        {/* Search input + records counter */}
        <div className="flex items-center gap-3 flex-1 lg:max-w-md">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              placeholder="Search number, agent..."
              className="w-full bg-slate-50 hover:bg-slate-100/40 focus:bg-white border border-slate-200 focus:border-pink-500 rounded-xl pl-10 pr-4 py-2.5 text-xs font-semibold text-slate-800 outline-none transition"
            />
          </div>
          <span className="text-xs font-bold text-slate-400 tracking-tight shrink-0 whitespace-nowrap">
            {filteredLogs.length} records
          </span>
        </div>
      </div>

      {/* Main Table Panel */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/50 border-b border-slate-200 text-slate-400 font-extrabold uppercase tracking-widest text-[9px]">
                <th className="px-6 py-4">S.No</th>
                <th className="px-6 py-4">Time Stamp</th>
                <th className="px-6 py-4">Contact Name</th>
                <th className="px-6 py-4">Call Type</th>
                <th className="px-6 py-4">Outcome</th>
                <th className="px-6 py-4">Duration</th>
                <th className="px-6 py-4">Prospect Number</th>
                <th className="px-6 py-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs font-semibold">
              {paginatedLogs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-400">
                    <div className="flex flex-col items-center justify-center space-y-2">
                      <Phone className="w-8 h-8 text-slate-300" />
                      <p className="font-bold">No call records match your active query.</p>
                      <button onClick={handleClearFilters} className="text-xs text-pink-500 font-bold hover:underline cursor-pointer">Reset Filters</button>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/40 transition">
                    <td className="px-6 py-4 font-mono text-slate-400">{log.sNo}</td>
                    <td className="px-6 py-4 text-slate-500 font-semibold">{log.timestamp}</td>
                    <td className="px-6 py-4 text-slate-700 font-black">{log.contactName}</td>
                    <td className="px-6 py-4">
                      {log.callType === 'Inbound' ? (
                        <span className="bg-blue-50 text-blue-600 border border-blue-100 font-black rounded-lg px-2.5 py-1 text-[10px] inline-flex items-center space-x-1">
                          <PhoneIncoming className="w-3 h-3" />
                          <span>Inbound</span>
                        </span>
                      ) : (
                        <span className="bg-pink-50 text-pink-600 border border-pink-100 font-black rounded-lg px-2.5 py-1 text-[10px] inline-flex items-center space-x-1">
                          <PhoneOutgoing className="w-3 h-3" />
                          <span>Outbound</span>
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {log.outcome === 'N/A' && (
                        <span className="bg-slate-100 text-slate-500 border border-slate-200 font-extrabold rounded-md px-2 py-0.5 text-[10px] uppercase">
                          N/A
                        </span>
                      )}
                      {log.outcome === 'Busy' && (
                        <span className="bg-blue-100 text-blue-600 border border-blue-200 font-extrabold rounded-md px-2 py-0.5 text-[10px] uppercase">
                          Busy
                        </span>
                      )}
                      {log.outcome === 'Completed' && (
                        <span className="bg-emerald-50 text-emerald-600 border border-emerald-200 font-extrabold rounded-md px-2 py-0.5 text-[10px] uppercase">
                          Completed
                        </span>
                      )}
                      {log.outcome === 'Answering Machine' && (
                        <span className="bg-amber-50 text-amber-600 border border-amber-200 font-extrabold rounded-md px-2 py-0.5 text-[10px] uppercase">
                          Ans Machine
                        </span>
                      )}
                      {log.outcome === 'User Hung Up' && (
                        <span className="bg-rose-50 text-rose-600 border border-rose-200 font-extrabold rounded-md px-2 py-0.5 text-[10px] uppercase">
                          Hung Up
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-slate-600 font-bold font-mono">
                      <div className="flex items-center space-x-1">
                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                        <span>{log.duration}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-800 font-bold font-mono">{log.prospectNumber}</td>
                    <td className="px-6 py-4 text-center">
                      <button
                        onClick={() => { setActiveReviewLog(log); setDrawerMode('details'); }}
                        className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-pink-500 transition cursor-pointer inline-flex items-center"
                        title="Review verbatim transcript"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controller */}
        {totalPages > 1 && (
          <div className="bg-slate-50/50 border-t border-slate-200 px-6 py-4 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400">
              Showing page {currentPage} of {totalPages} ({filteredLogs.length} records total)
            </span>
            <div className="flex items-center space-x-2">
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-700 hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                Previous
              </button>
              <button
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-700 hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Review Transcript Drawer overlay Modal */}
      {activeReviewLog && (() => {
        // Prepare precise values to match screenshot or generate highly realistic ones
        const details = {
          agentName: activeReviewLog.id === 'log-img-1' ? 'Shanmuga_test packages-Inbound' : activeReviewLog.agentName,
          timestamp: activeReviewLog.id === 'log-img-1' ? 'Jul 10, 2026, 02:03 PM' : activeReviewLog.timestamp.includes(', 2026') ? activeReviewLog.timestamp : `${activeReviewLog.timestamp.split(',')[0]}, 2026, ${activeReviewLog.timestamp.split(',')[1]?.trim() || '02:03 PM'}`,
          direction: activeReviewLog.callType === 'Inbound' ? 'INBOUND' : 'OUTBOUND',
          outcome: activeReviewLog.outcome,
          endReason: activeReviewLog.outcome === 'Completed' || activeReviewLog.durationSec > 15 ? 'Completed' : (activeReviewLog.outcome === 'Busy' ? 'Busy' : 'User Hung Up'),
          from: activeReviewLog.callType === 'Inbound' ? activeReviewLog.prospectNumber : '918035383450',
          to: activeReviewLog.callType === 'Inbound' ? '918035383450' : activeReviewLog.prospectNumber,
          agentId: 'd1a6c13b-b20c-453d-b000-4bd6f3d1184a',
          taskId: 'N/A',
          callSid: activeReviewLog.id === 'log-img-1' ? '695ad8af-b238-4489-a2eb-71f8c39c5224' : '3d4fa78c-097a-4ab0-b11c-' + activeReviewLog.id.substring(activeReviewLog.id.length - 8),
          callbackDate: 'N/A',
          callbackTime: 'N/A',
          sessionSummary: activeReviewLog.callType === 'Inbound' 
            ? "The AI agent, Karthika, greeted the user and confirmed their interest in health checkup packages. The agent provided information about three packages: Silver, Gold, and Platinum, all currently at a discount, and inquired about the user's specific health checkup plans."
            : "The AI agent, Sarah, conducted outbound solicitation with the contact. The agent qualified the contact's initial interest in automating incoming routes and scheduled a trial session.",
          resolvedWelcomeMessage: activeReviewLog.id === 'log-img-1'
            ? "Good afternoon — Perumal நா ஷண்முகா Hospitalல இருந்து AI Agent கார்த்திகா பேசுறங்க — How can I help you?"
            : (activeReviewLog.transcript?.[0]?.speaker === 'agent' ? activeReviewLog.transcript[0].text : "Good afternoon, thank you for connecting with our automated helpline. How can I assist you today?")
        };

        return (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-end z-50 animate-in fade-in duration-200">
            <div className="bg-[#fafafb] h-full w-full max-w-xl border-l border-slate-200 shadow-2xl flex flex-col justify-between animate-in slide-in-from-right duration-250 relative overflow-hidden">
              
              {/* Header - Sticky */}
              <div className="p-6 border-b border-slate-200 bg-[#fbfbfc] flex items-center justify-between shrink-0">
                <div>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Transcript & Analytics</span>
                  <h3 className="font-extrabold text-slate-800 text-xl tracking-tight mt-0.5">Call Details</h3>
                </div>
                <div className="flex items-center space-x-2 shrink-0">
                  {drawerMode === 'details' && (
                    <button 
                      onClick={() => setDrawerMode('transcript')}
                      className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-bold text-xs px-3.5 py-2 rounded-xl transition flex items-center space-x-1.5 shadow-xs cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      <span>View Transcript</span>
                    </button>
                  )}
                  <button
                    onClick={() => setActiveReviewLog(null)}
                    className="p-2 bg-white hover:bg-slate-50 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-700 transition cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                
                {/* Simulated Audio Player bar matching screenshot precisely */}
                <CallAudioPlayer durationSec={activeReviewLog.durationSec || 53} />

                {drawerMode === 'details' ? (
                  <>
                    {/* 2-Column Info Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      
                      {/* AGENT Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          <span>Agent</span>
                        </span>
                        <span className="text-sm font-black text-slate-800 block mt-2 leading-tight">
                          {details.agentName}
                        </span>
                      </div>

                      {/* TIMESTAMP Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <Calendar className="w-3.5 h-3.5 text-slate-400" />
                          <span>Timestamp</span>
                        </span>
                        <span className="text-sm font-black text-slate-800 block mt-2 leading-tight">
                          {details.timestamp}
                        </span>
                      </div>

                      {/* DIRECTION Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L17.5 12M21 7.5H7.5" />
                          </svg>
                          <span>Direction</span>
                        </span>
                        <div className="mt-2.5">
                          {details.direction === 'INBOUND' ? (
                            <span className="bg-blue-50 text-blue-600 border border-blue-100 font-extrabold rounded-md px-2.5 py-1 text-[10px] uppercase inline-block">
                              INBOUND
                            </span>
                          ) : (
                            <span className="bg-pink-50 text-pink-600 border border-pink-100 font-extrabold rounded-md px-2.5 py-1 text-[10px] uppercase inline-block">
                              OUTBOUND
                            </span>
                          )}
                        </div>
                      </div>

                      {/* OUTCOME Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <Activity className="w-3.5 h-3.5 text-slate-400" />
                          <span>Outcome</span>
                        </span>
                        <div className="mt-2.5">
                          <span className="bg-slate-100 text-slate-600 border border-slate-200/80 font-extrabold rounded-md px-2.5 py-1 text-[10px] uppercase inline-block">
                            {details.outcome}
                          </span>
                        </div>
                      </div>

                      {/* END REASON Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                          </svg>
                          <span>End Reason</span>
                        </span>
                        <span className="text-sm font-black text-slate-800 block mt-2 leading-tight">
                          {details.endReason}
                        </span>
                      </div>

                      {/* FROM Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <Phone className="w-3.5 h-3.5 text-slate-400" />
                          <span>From</span>
                        </span>
                        <div className="mt-2">
                          <span className="bg-slate-50 border border-slate-100 text-slate-800 font-bold px-3 py-1 rounded-lg text-xs inline-block font-mono">
                            {details.from}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* TO Card (Full width row) */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                        <PhoneCall className="w-3.5 h-3.5 text-slate-400" />
                        <span>To</span>
                      </span>
                      <div className="mt-2">
                        <span className="bg-slate-50 border border-slate-100 text-slate-800 font-bold px-3 py-1 rounded-lg text-xs inline-block font-mono">
                          {details.to}
                        </span>
                      </div>
                    </div>

                    {/* System Properties Card */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs divide-y divide-slate-100 text-[11px] font-semibold">
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Agent ID</span>
                        <span className="text-slate-800 font-mono font-bold break-all ml-4 text-right">
                          {details.agentId}
                        </span>
                      </div>
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Task ID</span>
                        <span className="text-slate-800 font-bold">{details.taskId}</span>
                      </div>
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Call Sid</span>
                        <span className="text-slate-800 font-mono font-bold break-all ml-4 text-right">
                          {details.callSid}
                        </span>
                      </div>
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Callback Date</span>
                        <span className="text-slate-800 font-bold">{details.callbackDate}</span>
                      </div>
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Callback Time</span>
                        <span className="text-slate-800 font-bold">{details.callbackTime}</span>
                      </div>
                    </div>

                    {/* Session Summary Card */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-2">
                      <h4 className="font-extrabold text-slate-800 text-sm">Session Summary</h4>
                      <p className="text-xs text-slate-500 font-medium leading-relaxed">
                        {details.sessionSummary}
                      </p>
                    </div>

                    {/* AI Conversation Parameters Card */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
                      {/* Title banner */}
                      <div className="flex items-center space-x-2 text-[#ec4899] font-extrabold text-xs tracking-wider uppercase">
                        <svg className="w-4 h-4 fill-current animate-pulse text-[#ec4899]" viewBox="0 0 24 24">
                          <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
                        </svg>
                        <span>AI Conversation Parameters</span>
                      </div>

                      {/* Config keys list */}
                      <div className="divide-y divide-slate-100 text-xs">
                        
                        <div className="grid grid-cols-3 py-3 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px]">To</span>
                          <span className="col-span-2 text-slate-800 font-mono text-right sm:text-left">{details.to}</span>
                        </div>

                        <div className="grid grid-cols-3 py-3 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px]">Name</span>
                          <span className="col-span-2 text-slate-800 text-right sm:text-left">{activeReviewLog.contactName || 'Caller'}</span>
                        </div>

                        <div className="grid grid-cols-3 py-3 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px]">From</span>
                          <span className="col-span-2 text-slate-800 font-mono text-right sm:text-left">{details.from}</span>
                        </div>

                        <div className="grid grid-cols-3 py-4 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px] self-start">Transcript</span>
                          <div className="col-span-2 text-slate-800 font-medium leading-relaxed text-left whitespace-pre-line bg-slate-50 p-4 rounded-2xl border border-slate-200/60 max-h-[300px] overflow-y-auto font-sans">
                            {activeReviewLog.transcript && activeReviewLog.transcript.length > 0 ? (
                              <div className="space-y-3">
                                {activeReviewLog.transcript.map((t, i) => (
                                  <p key={i}>
                                    <span className={`font-extrabold uppercase text-[10px] tracking-wider block mb-0.5 ${t.speaker === 'agent' ? 'text-[#ec4899]' : 'text-[#4f46e5]'}`}>
                                      {t.speaker === 'agent' ? 'Zea Voice AI' : 'Customer'}
                                    </span>
                                    {t.text}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <span className="text-slate-400 italic">No conversational exchange recorded for this brief connection.</span>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-3 py-3 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px]">From Number</span>
                          <span className="col-span-2 text-slate-800 font-mono text-right sm:text-left">{details.from}</span>
                        </div>

                        <div className="grid grid-cols-3 py-3 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px] self-start">Resolved Welcome Message</span>
                          <span className="col-span-2 text-slate-600 leading-relaxed text-right sm:text-left bg-slate-50/50 px-3 py-2 rounded-lg border border-slate-200/60 font-medium">
                            {details.resolvedWelcomeMessage}
                          </span>
                        </div>

                      </div>
                    </div>
                  </>
                ) : (
                  <div className="space-y-6">
                    {/* Back to Details Row */}
                    <div className="flex items-center justify-between">
                      <button 
                        onClick={() => setDrawerMode('details')}
                        className="text-slate-500 hover:text-slate-800 font-extrabold text-xs flex items-center space-x-1.5 py-1 px-2.5 hover:bg-slate-100 rounded-xl transition cursor-pointer select-none"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        <span>Back to Details</span>
                      </button>
                      <span className="bg-[#fdf2f8] text-[#db2777] border border-pink-100 font-black rounded-full px-3 py-1 text-[10px] tracking-widest uppercase">
                        CALL TRANSCRIPT
                      </span>
                    </div>

                    {/* Conversations List with customized bubbles matching the design */}
                    <div className="space-y-6 pt-2">
                      {activeReviewLog.transcript && activeReviewLog.transcript.length > 0 ? (
                        activeReviewLog.transcript.map((t, i) => {
                          const isAgent = t.speaker === 'agent';
                          return (
                            <div 
                              key={i} 
                              className={`flex flex-col ${isAgent ? 'items-end' : 'items-start'} w-full animate-in fade-in duration-150`}
                            >
                              <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-1 block">
                                {isAgent ? details.agentName : 'CUSTOMER'}
                              </span>
                              <div className={`p-4 rounded-2xl text-xs font-semibold leading-relaxed shadow-xs max-w-[85%] ${
                                isAgent 
                                  ? 'bg-gradient-to-r from-purple-600 to-fuchsia-500 text-white rounded-tr-none text-left' 
                                  : 'bg-white border border-slate-200 text-slate-800 rounded-tl-none text-left'
                              }`}>
                                {t.text}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-center py-12 text-slate-400">
                          <p className="font-bold">No conversation occurred.</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              </div>

              {/* Footer - Sticky */}
              <div className="p-6 border-t border-slate-200 shrink-0 bg-white flex items-center justify-between">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest font-mono">ID: {activeReviewLog.id}</span>
                <button
                  onClick={() => setActiveReviewLog(null)}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition shadow-md cursor-pointer"
                >
                  Close Review
                </button>
              </div>

            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ==========================================
   6. CALL LOGS LIST (REPLICATING THE SHARYX SCREENSHOT PRECISELY)
   ========================================== */
function CallLogsListView() {
  const [allLogs] = useState<CallLogItem[]>(() => {
    const list: CallLogItem[] = [];

    // Row 1
    list.push({
      id: 'call-log-1',
      sNo: 1,
      timestamp: 'Jul 10, 2026, 2:03 PM',
      contactName: 'Caller',
      callType: 'Inbound',
      outcome: 'N/A',
      duration: '53s',
      durationSec: 53,
      prospectNumber: '919500600811',
      agentName: 'Shanmuga_test packages-Inbound',
      campaignName: '—',
      sentiment: 'Neutral',
      cost: 0.13,
      aiSummary: 'The AI agent, Karthika, greeted the user and confirmed their interest in health checkup packages. The agent provided information about three packages: Silver, Gold, and Platinum, all currently at a discount, and inquired about the user\'s specific health checkup plans.',
      fullTranscriptText: 'Agent: Good afternoon — Perumal நா ஷண்முகா Hospitalல இருந்து AI Agent கார்த்திகா பேசுறங்க — How can I help you? Customer: ஓகே Agent: நீங்க Facebookல full body checkupக்காக உங்க details fill பண்ணிருந்தீங்க. எங்க packages பத்தி தெரிஞ்சிக்கிறீங்களா? Customer: எஸ் Agent: Alright, எங்ககிட்ட மூணு packages இருக்கு. Silver, Gold, and Platinum. And மூணும் இப்போ currentஅ up to fifty percent discountல இருக்கு. Also, organwise health checkupsஉம் இருக்கு. நீங்க என்ன மாதிரி health check upக்கு plan பண்றீங்க?',
      transcript: [
        { speaker: 'agent', text: 'Good afternoon — Perumal நா ஷண்முகா Hospitalல இருந்து AI Agent கார்த்திகா பேசுறங்க — How can I help you?', time: '0:02' },
        { speaker: 'user', text: 'ஓகே', time: '0:08' },
        { speaker: 'agent', text: 'நீங்க Facebookல full body checkupக்காக உங்க details fill பண்ணிருந்தீங்க. எங்க packages பத்தி தெரிஞ்சுக்கிறீங்களா?', time: '0:15' },
        { speaker: 'user', text: 'எஸ்', time: '0:22' },
        { speaker: 'agent', text: 'Alright, எங்ககிட்ட மூணு packages இருக்கு. Silver, Gold, and Platinum. And மூணும் இப்போ currentஅ up to fifty percent discountல இருக்கு. Also, organwise health checkupsஉம் இருக்கு. நீங்க என்ன மாதிரி health check upக்கு plan பண்றீங்க?', time: '0:35' }
      ]
    });

    // Row 2
    list.push({
      id: 'call-log-2',
      sNo: 2,
      timestamp: 'Jul 10, 2026, 2:03 PM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'N/A',
      duration: '14s',
      durationSec: 14,
      prospectNumber: '919500600811',
      agentName: 'Shanmuga_test packages',
      campaignName: 'MHC',
      sentiment: 'neutral',
      cost: 0.04,
      aiSummary: 'No conversation took place during the call.',
      fullTranscriptText: 'Agent: Good afternoon — நா ஷ',
      transcript: [
        { speaker: 'agent', text: 'Hello, this is Shanmuga_test packages AI assistant calling to follow up on your healthcare inquiry.', time: '0:02' },
        { speaker: 'user', text: 'Yes, tell me about the healthcare options.', time: '0:07' },
        { speaker: 'agent', text: 'Perfect. We offer the MHC full body checkup package which includes comprehensive diagnostics. Would you like me to book a slot?', time: '0:12' }
      ]
    });

    // Row 3
    list.push({
      id: 'call-log-3',
      sNo: 3,
      timestamp: 'Jul 10, 2026, 12:28 PM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'Busy',
      duration: '0s',
      durationSec: 0,
      prospectNumber: '+917200627475',
      agentName: 'Shanmuga_test packages',
      campaignName: 'MHC',
      sentiment: 'neutral',
      cost: 0.00,
      aiSummary: 'No conversation took place during the call.',
      fullTranscriptText: 'No transcript available - call busy.',
      transcript: []
    });

    // Row 4
    list.push({
      id: 'call-log-4',
      sNo: 4,
      timestamp: 'Jul 10, 2026, 12:26 PM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'N/A',
      duration: '16s',
      durationSec: 16,
      prospectNumber: '919442801758',
      agentName: 'Shanmuga_test packages',
      campaignName: 'MHC',
      sentiment: 'neutral',
      cost: 0.05,
      aiSummary: 'The AI agent greeted the customer and they agreed to schedule a call for later.',
      fullTranscriptText: 'Agent: Good morning, calling from Shanmuga_test packages regarding the health camps. Customer: Ah yes, please schedule a call for later. Agent: Sure thing! Will mark this down. Have a good day!',
      transcript: [
        { speaker: 'agent', text: 'Good morning, calling from Shanmuga_test packages regarding the health camps.', time: '0:02' },
        { speaker: 'user', text: 'Ah yes, please schedule a call for later.', time: '0:07' },
        { speaker: 'agent', text: 'Sure thing! Will mark this down. Have a good day!', time: '0:12' }
      ]
    });

    // Row 5
    list.push({
      id: 'call-log-5',
      sNo: 5,
      timestamp: 'Jul 10, 2026, 10:44 AM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'Answering Machine',
      duration: '0s',
      durationSec: 0,
      prospectNumber: '+919894664741',
      agentName: 'Shanmuga_test packages',
      campaignName: 'MHC',
      sentiment: 'neutral',
      cost: 0.00,
      aiSummary: 'No conversation took place during the call.',
      fullTranscriptText: 'No transcript available - answering machine.',
      transcript: []
    });

    // Row 6
    list.push({
      id: 'call-log-6',
      sNo: 6,
      timestamp: 'Jul 10, 2026, 10:44 AM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'Answering Machine',
      duration: '0s',
      durationSec: 0,
      prospectNumber: '+919751415146',
      agentName: 'Shanmuga_test packages',
      campaignName: 'MHC',
      sentiment: 'neutral',
      cost: 0.00,
      aiSummary: 'No conversation took place during the call.',
      fullTranscriptText: 'No transcript available - answering machine.',
      transcript: []
    });

    // Row 7
    list.push({
      id: 'call-log-7',
      sNo: 7,
      timestamp: 'Jul 10, 2026, 10:44 AM',
      contactName: 'N/A',
      callType: 'Outbound',
      outcome: 'Busy',
      duration: '0s',
      durationSec: 0,
      prospectNumber: '+919655544850',
      agentName: 'Shanmuga_test packages',
      campaignName: 'MHC',
      sentiment: 'neutral',
      cost: 0.00,
      aiSummary: 'No conversation took place during the call.',
      fullTranscriptText: 'No transcript available - call busy.',
      transcript: []
    });

    // Generate remaining 165 records (to make exactly 172 records)
    const phoneSuffixes = ['12', '99', '04', '77', '61', '83', '40', '26', '35'];

    for (let i = 8; i <= 172; i++) {
      const min = Math.floor(Math.random() * 60);
      const hour = Math.floor(Math.random() * 12) + 1;
      const isAm = Math.random() > 0.5;
      const day = Math.floor(Math.random() * 7) + 3; // Jul 3 to Jul 10
      const durationSec = Math.random() > 0.3 ? Math.floor(Math.random() * 100) + 10 : 0;
      const duration = `${durationSec}s`;
      const outcome: 'N/A' | 'Busy' | 'Completed' | 'Answering Machine' | 'User Hung Up' = durationSec === 0 
        ? (Math.random() > 0.5 ? 'Busy' : 'Answering Machine') 
        : 'Completed';
      const isOutbound = Math.random() > 0.3;

      let summaryText = 'No conversation took place during the call.';
      let transcriptText = 'No transcript available.';

      if (durationSec > 0) {
        if (isOutbound) {
          summaryText = 'The AI agent, Sarah, called the customer to follow up on health diagnostics packages and offered slots.';
          transcriptText = 'Agent: Hello, thank you for connecting with Shanmuga diagnostics packages. Customer: Hello, I want to confirm my health check appointment. Agent: Let me look that up. Yes, your booking is confirmed for tomorrow morning at 9:00 AM.';
        } else {
          summaryText = 'The user called the automated system to verify package details and active booking slots.';
          transcriptText = 'Customer: Hello, I want to inquire about your body health packages. Agent: Welcome! We have Silver, Gold, and Platinum packages. Would you like details on Silver? Customer: Yes, please send me the discount details.';
        }
      }

      list.push({
        id: `call-log-${i}`,
        sNo: i,
        timestamp: `Jul 0${day}, 2026, ${hour < 10 ? '0' + hour : hour}:${min < 10 ? '0' + min : min} ${isAm ? 'AM' : 'PM'}`,
        contactName: isOutbound ? 'N/A' : 'Caller',
        callType: isOutbound ? 'Outbound' : 'Inbound',
        outcome,
        duration,
        durationSec,
        prospectNumber: isOutbound ? `+919500600${phoneSuffixes[i % phoneSuffixes.length]}${String(i).padStart(2, '0')}` : `919500600${phoneSuffixes[i % phoneSuffixes.length]}${String(i).padStart(2, '0')}`,
        agentName: isOutbound ? 'Shanmuga_test packages' : 'Shanmuga_test packages-Inbound',
        campaignName: isOutbound ? 'MHC' : '—',
        sentiment: 'neutral',
        cost: durationSec > 0 ? 0.05 : 0.00,
        aiSummary: summaryText,
        fullTranscriptText: transcriptText,
        transcript: durationSec > 0 ? [
          { speaker: 'agent', text: 'Hello, thank you for connecting with Shanmuga diagnostics packages.', time: '0:02' },
          { speaker: 'user', text: 'Hello, I want to confirm my health check appointment.', time: '0:07' },
          { speaker: 'agent', text: 'Let me look that up. Yes, your booking is confirmed for tomorrow morning at 9:00 AM.', time: '0:14' }
        ] : []
      });
    }

    return list;
  });

  const [dateRange, setDateRange] = useState('7 Days');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Selected single log review drawer state
  const [activeReviewLog, setActiveReviewLog] = useState<CallLogItem | null>(null);
  const [drawerMode, setDrawerMode] = useState<'details' | 'transcript'>('details');

  const filteredLogs = allLogs.filter(log => {
    // Standard filters for presentation
    return true;
  });

  const paginatedLogs = filteredLogs.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const totalPages = Math.ceil(filteredLogs.length / itemsPerPage);

  const handleExportxlsx = () => {
    let csv = "S.No,Date & Time,Agent Name,Campaign Name,Direction,From Number,To Number,Duration,Outcome,Sentiment,AI Summary,Full Transcript\n";
    filteredLogs.forEach(l => {
      const dir = l.callType.toLowerCase();
      const fromNum = l.callType === 'Inbound' ? l.prospectNumber : '+918035383450';
      const toNum = l.callType === 'Inbound' ? '—' : l.prospectNumber;
      const safeSummary = (l.aiSummary || '').replace(/"/g, '""');
      const safeTranscript = (l.fullTranscriptText || '').replace(/"/g, '""');
      csv += `${l.sNo},"${l.timestamp}","${l.agentName}","${l.campaignName}",${dir},"${fromNum}","${toNum}",${l.duration},${l.outcome},${l.sentiment},"${safeSummary}","${safeTranscript}"\n`;
    });
    const encodedUri = encodeURI("data:text/csv;charset=utf-8," + csv);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `ZeaVoice_Call_Logs_Report.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      
      {/* 1. Report Builder Card */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center space-x-4">
          <div className="p-3 bg-pink-50 rounded-2xl shrink-0">
            <FileSpreadsheet className="w-6 h-6 text-[#db2777]" />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-slate-800 tracking-tight leading-tight">Report Builder</h2>
            <p className="text-xs text-slate-400 font-semibold mt-0.5">Generate, customize, and export powerful insights</p>
          </div>
        </div>
        
        {/* Dropdowns + Export Button */}
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          <div className="relative">
            <select className="bg-slate-50 border border-slate-200 text-slate-700 font-bold text-xs rounded-xl pl-4 pr-8 py-2.5 outline-none appearance-none cursor-pointer">
              <option>Call Logs Report</option>
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
          </div>

          <div className="relative">
            <select 
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value)}
              className="bg-slate-50 border border-slate-200 text-slate-700 font-bold text-xs rounded-xl pl-4 pr-8 py-2.5 outline-none appearance-none cursor-pointer"
            >
              <option value="7 Days">7 Days</option>
              <option value="All Time">All Time</option>
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-3.5 pointer-events-none" />
          </div>

          <button 
            onClick={handleExportxlsx}
            className="bg-gradient-to-r from-purple-600 to-fuchsia-500 hover:from-purple-700 hover:to-fuchsia-600 text-white font-extrabold text-xs px-5 py-2.5 rounded-xl shadow-xs transition flex items-center space-x-1.5 cursor-pointer select-none"
          >
            <svg className="w-4 h-4 text-white shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            <span>Export .xlsx</span>
          </button>
        </div>
      </div>

      {/* 2. Three Metric Cards Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Card 1: TOTAL RECORDS */}
        <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-xs flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">TOTAL RECORDS</span>
            <span className="text-4xl font-black text-slate-800 tracking-tight block">{filteredLogs.length}</span>
          </div>
          <div className="w-12 h-12 bg-[#eff6ff] text-[#3b82f6] rounded-2xl flex items-center justify-center border border-blue-50">
            <Filter className="w-5 h-5 text-blue-500" />
          </div>
        </div>

        {/* Card 2: SELECTED COLUMNS */}
        <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-xs flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">SELECTED COLUMNS</span>
            <span className="text-4xl font-black text-slate-800 tracking-tight block">13</span>
          </div>
          <div className="w-12 h-12 bg-[#fdf2f8] text-[#db2777] rounded-2xl flex items-center justify-center border border-pink-50">
            <Grid className="w-5 h-5 text-pink-500" />
          </div>
        </div>

        {/* Card 3: ACTIVE FILTERS */}
        <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-xs relative flex flex-col justify-between min-h-[106px]">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">ACTIVE FILTERS</span>
            <span className="bg-[#f1f5f9] text-slate-500 border border-slate-200/55 rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider">
              1 Applied
            </span>
          </div>
          <div className="mt-3 flex items-center">
            <span className="bg-[#f8fafc] hover:bg-slate-100 text-slate-600 font-extrabold text-xs px-3.5 py-2 rounded-xl border border-slate-200/60 inline-flex items-center space-x-1.5 select-none transition cursor-default">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span>{dateRange}</span>
            </span>
          </div>
        </div>

      </div>

      {/* 3. Table Card */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-xs space-y-4">
        <div>
          <h3 className="text-base font-extrabold text-slate-800 tracking-tight">Report Data</h3>
          <p className="text-[11px] text-slate-400 font-semibold mt-0.5">Viewing all generated data</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#f8fafc] border-b border-slate-200 text-slate-400 font-black uppercase tracking-widest text-[9px]">
                <th className="px-5 py-4">S.No</th>
                <th className="px-5 py-4">Date & Time</th>
                <th className="px-5 py-4">Agent Name</th>
                <th className="px-5 py-4">Campaign Name</th>
                <th className="px-5 py-4">Direction</th>
                <th className="px-5 py-4">From Number</th>
                <th className="px-5 py-4">To Number</th>
                <th className="px-5 py-4">Duration</th>
                <th className="px-5 py-4">Outcome</th>
                <th className="px-5 py-4">Sentiment</th>
                <th className="px-5 py-4">Recording Link</th>
                <th className="px-5 py-4">AI Summary</th>
                <th className="px-5 py-4">Full Transcript</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs font-semibold text-slate-700">
              {paginatedLogs.map((log) => (
                <tr 
                  key={log.id} 
                  className="hover:bg-slate-50/40 transition border-b border-slate-100"
                >
                  <td className="px-5 py-4 font-mono text-slate-400">{log.sNo}</td>
                  <td className="px-5 py-4 text-slate-500 font-bold">{log.timestamp}</td>
                  <td className="px-5 py-4 font-black text-slate-800">{log.agentName}</td>
                  <td className="px-5 py-4 text-slate-500">{log.campaignName}</td>
                  <td className="px-5 py-4">
                    {log.callType === 'Inbound' ? (
                      <span className="text-blue-500 font-black tracking-tight block">inbound</span>
                    ) : (
                      <span className="text-pink-500 font-black tracking-tight block">outbound</span>
                    )}
                  </td>
                  <td className="px-5 py-4 font-mono font-bold text-slate-600">
                    {log.callType === 'Inbound' ? log.prospectNumber : '+918035383450'}
                  </td>
                  <td className="px-5 py-4 font-mono font-bold text-slate-600">
                    {log.callType === 'Inbound' ? '—' : log.prospectNumber}
                  </td>
                  <td className="px-5 py-4 font-mono text-slate-500">{log.duration}</td>
                  <td className="px-5 py-4">
                    {log.outcome === 'N/A' ? (
                      <span className="bg-slate-100 text-slate-500 border border-slate-200/80 font-black rounded-md px-2 py-0.5 text-[9px] uppercase tracking-wide">
                        N/A
                      </span>
                    ) : log.outcome === 'Busy' ? (
                      <span className="bg-[#f1f5f9] text-[#475569] border border-slate-200/80 font-black rounded-md px-2 py-0.5 text-[9px] uppercase tracking-wide">
                        BUSY
                      </span>
                    ) : log.outcome === 'Answering Machine' ? (
                      <span className="bg-[#f1f5f9] text-[#475569] border border-slate-200/80 font-black rounded-md px-2 py-0.5 text-[9px] uppercase tracking-wide">
                        NO ANSWER
                      </span>
                    ) : (
                      <span className="bg-emerald-50 text-emerald-600 border border-emerald-200/80 font-black rounded-md px-2 py-0.5 text-[9px] uppercase tracking-wide">
                        COMPLETED
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-slate-500 font-bold">{log.sentiment}</td>
                  <td className="px-5 py-4">
                    {log.duration !== '0s' ? (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveReviewLog(log);
                          setDrawerMode('transcript');
                        }}
                        className="text-[#4f46e5] hover:text-indigo-700 font-black inline-flex items-center space-x-1 hover:underline select-none cursor-pointer"
                      >
                        <Play className="w-3 h-3 text-[#4f46e5] fill-current" />
                        <span>Play</span>
                      </button>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td 
                    title={log.aiSummary || ''} 
                    className="px-5 py-4 text-slate-600 font-medium whitespace-nowrap text-left"
                  >
                    {log.aiSummary ? truncateToTwoWords(log.aiSummary) : '—'}
                  </td>
                  <td 
                    title={log.fullTranscriptText || ''} 
                    className="px-5 py-4 text-slate-500 font-normal whitespace-nowrap text-left"
                  >
                    {log.fullTranscriptText ? truncateToTwoWords(log.fullTranscriptText) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination controller */}
        {totalPages > 1 && (
          <div className="bg-[#fafafa] border border-slate-100 rounded-2xl px-6 py-4 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400">
              Showing page {currentPage} of {totalPages} ({filteredLogs.length} records total)
            </span>
            <div className="flex items-center space-x-2">
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer select-none"
              >
                Previous
              </button>
              <button
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer select-none"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Verbatim Transcript Drawer overlay */}
      {activeReviewLog && (() => {
        const isInc = activeReviewLog.callType === 'Inbound';
        const details = {
          agentName: activeReviewLog.agentName,
          timestamp: activeReviewLog.timestamp,
          direction: isInc ? 'INBOUND' : 'OUTBOUND',
          outcome: activeReviewLog.outcome,
          endReason: activeReviewLog.outcome === 'Completed' || activeReviewLog.durationSec > 15 ? 'Completed' : (activeReviewLog.outcome === 'Busy' ? 'Busy' : 'User Hung Up'),
          from: isInc ? activeReviewLog.prospectNumber : '918035383450',
          to: isInc ? '918035383450' : activeReviewLog.prospectNumber,
          agentId: 'd1a6c13b-b20c-453d-b000-4bd6f3d1184a',
          taskId: 'N/A',
          callSid: '3d4fa78c-097a-4ab0-b11c-' + activeReviewLog.id.substring(activeReviewLog.id.length - 8),
          callbackDate: 'N/A',
          callbackTime: 'N/A',
          sessionSummary: isInc 
            ? "The AI agent, Karthika, greeted the user and confirmed their interest in health checkup packages. The agent provided information about three packages: Silver, Gold, and Platinum, all currently at a discount, and inquired about the user's specific health checkup plans."
            : "The AI agent, Sarah, conducted outbound solicitation with the contact. The agent qualified the contact's initial interest in automating incoming routes and scheduled a trial session.",
          resolvedWelcomeMessage: isInc
            ? "Good afternoon — Perumal நா ஷண்முகா Hospitalல இருந்து AI Agent கார்த்திகா பேசுறங்க — How can I help you?"
            : (activeReviewLog.transcript?.[0]?.speaker === 'agent' ? activeReviewLog.transcript[0].text : "Good afternoon, thank you for connecting with our automated helpline. How can I assist you today?")
        };

        return (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-end z-50 animate-in fade-in duration-200">
            <div className="bg-[#fafafb] h-full w-full max-w-xl border-l border-slate-200 shadow-2xl flex flex-col justify-between animate-in slide-in-from-right duration-250 relative overflow-hidden">
              
              {/* Header - Sticky */}
              <div className="p-6 border-b border-slate-200 bg-[#fbfbfc] flex items-center justify-between shrink-0">
                <div>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Transcript & Analytics</span>
                  <h3 className="font-extrabold text-slate-800 text-xl tracking-tight mt-0.5">Call Details</h3>
                </div>
                <div className="flex items-center space-x-2 shrink-0">
                  {drawerMode === 'details' && (
                    <button 
                      onClick={() => setDrawerMode('transcript')}
                      className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-bold text-xs px-3.5 py-2 rounded-xl transition flex items-center space-x-1.5 shadow-xs cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      <span>View Transcript</span>
                    </button>
                  )}
                  <button
                    onClick={() => setActiveReviewLog(null)}
                    className="p-2 bg-white hover:bg-slate-50 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-700 transition cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                
                {/* Simulated Audio Player */}
                <CallAudioPlayer durationSec={activeReviewLog.durationSec || 53} />

                {drawerMode === 'details' ? (
                  <>
                    {/* 2-Column Info Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      
                      {/* AGENT Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          <span>Agent</span>
                        </span>
                        <span className="text-sm font-black text-slate-800 block mt-2 leading-tight">
                          {details.agentName}
                        </span>
                      </div>

                      {/* TIMESTAMP Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <Calendar className="w-3.5 h-3.5 text-slate-400" />
                          <span>Timestamp</span>
                        </span>
                        <span className="text-sm font-black text-slate-800 block mt-2 leading-tight">
                          {details.timestamp}
                        </span>
                      </div>

                      {/* DIRECTION Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L17.5 12M21 7.5H7.5" />
                          </svg>
                          <span>Direction</span>
                        </span>
                        <div className="mt-2.5">
                          {details.direction === 'INBOUND' ? (
                            <span className="bg-blue-50 text-blue-600 border border-blue-100 font-extrabold rounded-md px-2.5 py-1 text-[10px] uppercase inline-block">
                              INBOUND
                            </span>
                          ) : (
                            <span className="bg-pink-50 text-pink-600 border border-pink-100 font-extrabold rounded-md px-2.5 py-1 text-[10px] uppercase inline-block">
                              OUTBOUND
                            </span>
                          )}
                        </div>
                      </div>

                      {/* OUTCOME Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <Activity className="w-3.5 h-3.5 text-slate-400" />
                          <span>Outcome</span>
                        </span>
                        <div className="mt-2.5">
                          <span className="bg-slate-100 text-slate-600 border border-slate-200/80 font-extrabold rounded-md px-2.5 py-1 text-[10px] uppercase inline-block">
                            {details.outcome}
                          </span>
                        </div>
                      </div>

                      {/* END REASON Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                          </svg>
                          <span>End Reason</span>
                        </span>
                        <span className="text-sm font-black text-slate-800 block mt-2 leading-tight">
                          {details.endReason}
                        </span>
                      </div>

                      {/* FROM Card */}
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                          <Phone className="w-3.5 h-3.5 text-slate-400" />
                          <span>From</span>
                        </span>
                        <div className="mt-2">
                          <span className="bg-slate-50 border border-slate-100 text-slate-800 font-bold px-3 py-1 rounded-lg text-xs inline-block font-mono">
                            {details.from}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* TO Card (Full width row) */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                        <PhoneCall className="w-3.5 h-3.5 text-slate-400" />
                        <span>To</span>
                      </span>
                      <div className="mt-2">
                        <span className="bg-slate-50 border border-slate-100 text-slate-800 font-bold px-3 py-1 rounded-lg text-xs inline-block font-mono">
                          {details.to}
                        </span>
                      </div>
                    </div>

                    {/* System Properties Card */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs divide-y divide-slate-100 text-[11px] font-semibold">
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Agent ID</span>
                        <span className="text-slate-800 font-mono font-bold break-all ml-4 text-right">
                          {details.agentId}
                        </span>
                      </div>
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Task ID</span>
                        <span className="text-slate-800 font-bold">{details.taskId}</span>
                      </div>
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Call Sid</span>
                        <span className="text-slate-800 font-mono font-bold break-all ml-4 text-right">
                          {details.callSid}
                        </span>
                      </div>
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Callback Date</span>
                        <span className="text-slate-800 font-bold">{details.callbackDate}</span>
                      </div>
                      <div className="flex justify-between py-2.5">
                        <span className="text-slate-400 font-bold uppercase tracking-wider">Callback Time</span>
                        <span className="text-slate-800 font-bold">{details.callbackTime}</span>
                      </div>
                    </div>

                    {/* Session Summary Card */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-2">
                      <h4 className="font-extrabold text-slate-800 text-sm">Session Summary</h4>
                      <p className="text-xs text-slate-500 font-medium leading-relaxed">
                        {details.sessionSummary}
                      </p>
                    </div>

                    {/* AI Conversation Parameters Card */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
                      {/* Title banner */}
                      <div className="flex items-center space-x-2 text-[#ec4899] font-extrabold text-xs tracking-wider uppercase">
                        <svg className="w-4 h-4 fill-current animate-pulse text-[#ec4899]" viewBox="0 0 24 24">
                          <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
                        </svg>
                        <span>AI Conversation Parameters</span>
                      </div>

                      {/* Config keys list */}
                      <div className="divide-y divide-slate-100 text-xs">
                        <div className="grid grid-cols-3 py-3 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px]">To</span>
                          <span className="col-span-2 text-slate-800 font-mono text-right sm:text-left">{details.to}</span>
                        </div>

                        <div className="grid grid-cols-3 py-3 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px]">From</span>
                          <span className="col-span-2 text-slate-800 font-mono text-right sm:text-left">{details.from}</span>
                        </div>

                        <div className="grid grid-cols-3 py-4 font-semibold">
                          <span className="text-slate-400 font-bold uppercase tracking-widest text-[9px] self-start">Transcript</span>
                          <div className="col-span-2 text-slate-800 font-medium leading-relaxed text-left whitespace-pre-line bg-slate-50 p-4 rounded-2xl border border-slate-200/60 max-h-[300px] overflow-y-auto font-sans">
                            {activeReviewLog.transcript && activeReviewLog.transcript.length > 0 ? (
                              <div className="space-y-3">
                                {activeReviewLog.transcript.map((t, i) => (
                                  <p key={i}>
                                    <span className={`font-extrabold uppercase text-[10px] tracking-wider block mb-0.5 ${t.speaker === 'agent' ? 'text-[#ec4899]' : 'text-[#4f46e5]'}`}>
                                      {t.speaker === 'agent' ? 'Zea Voice AI' : 'Customer'}
                                    </span>
                                    {t.text}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <span className="text-slate-400 italic">No conversational exchange recorded for this brief connection.</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="space-y-6">
                    {/* Back to Details Row */}
                    <div className="flex items-center justify-between">
                      <button 
                        onClick={() => setDrawerMode('details')}
                        className="text-slate-500 hover:text-slate-800 font-extrabold text-xs flex items-center space-x-1.5 py-1 px-2.5 hover:bg-slate-100 rounded-xl transition cursor-pointer select-none"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        <span>Back to Details</span>
                      </button>
                      <span className="bg-[#fdf2f8] text-[#db2777] border border-pink-100 font-black rounded-full px-3 py-1 text-[10px] tracking-widest uppercase">
                        CALL TRANSCRIPT
                      </span>
                    </div>

                    {/* Conversations List with customized bubbles matching the design */}
                    <div className="space-y-6 pt-2">
                      {activeReviewLog.transcript && activeReviewLog.transcript.length > 0 ? (
                        activeReviewLog.transcript.map((t, i) => {
                          const isAgent = t.speaker === 'agent';
                          return (
                            <div 
                              key={i} 
                              className={`flex flex-col ${isAgent ? 'items-end' : 'items-start'} w-full animate-in fade-in duration-150`}
                            >
                              <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-1 block">
                                {isAgent ? details.agentName : 'CUSTOMER'}
                              </span>
                              <div className={`p-4 rounded-2xl text-xs font-semibold leading-relaxed shadow-xs max-w-[85%] ${
                                isAgent 
                                  ? 'bg-gradient-to-r from-purple-600 to-fuchsia-500 text-white rounded-tr-none text-left' 
                                  : 'bg-white border border-slate-200 text-slate-800 rounded-tl-none text-left'
                              }`}>
                                {t.text}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-center py-12 text-slate-400">
                          <p className="font-bold">No conversation occurred.</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              </div>

              {/* Footer - Sticky */}
              <div className="p-6 border-t border-slate-200 shrink-0 bg-white flex items-center justify-between">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest font-mono">ID: {activeReviewLog.id}</span>
                <button
                  onClick={() => setActiveReviewLog(null)}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition shadow-md cursor-pointer"
                >
                  Close Review
                </button>
              </div>

            </div>
          </div>
        );
      })()}

    </div>
  );
}

/* ==========================================
   7. COMPANY PHONE NUMBERS
   ========================================== */
interface PhoneNumbersProps {
  phoneNumbers: PhoneNumber[];
  setPhoneNumbers: React.Dispatch<React.SetStateAction<PhoneNumber[]>>;
  agents: VoiceAgent[];
}

function CompanyPhoneNumbersView({ phoneNumbers, setPhoneNumbers, agents }: PhoneNumbersProps) {
  const { role } = useAppState();
  const isReadOnly = role === 'USER';
  const [success, setSuccess] = useState<string | null>(null);

  const assignAgentToNum = (numId: string, agentName: string) => {
    setPhoneNumbers(phoneNumbers.map(n => {
      if (n.id === numId) {
        return { ...n, assignedTo: agentName };
      }
      return n;
    }));
    setSuccess(`Line reassigned successfully! Incoming calls will now trigger operator [${agentName}].`);
    setTimeout(() => setSuccess(null), 3000);
  };

  return (
    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
      <div className="border-b border-slate-200 pb-5 mb-5">
        <h2 className="text-xl font-bold text-slate-800 tracking-tight">Trunk Assignations</h2>
        <p className="text-xs text-slate-400 font-medium mt-0.5">Route leased DID telephone lines directly into voice AI operator prompt loops.</p>
      </div>

      {success && (
        <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs font-semibold mb-4 animate-in fade-in">
          {success}
        </div>
      )}

      <div className="overflow-x-auto text-xs">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[9px]">
              <th className="pb-3">Phone Line</th>
              <th className="pb-3">Type</th>
              <th className="pb-3">Active Routing Mapping</th>
              <th className="pb-3">Monthly Lease Cost</th>
              <th className="pb-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-semibold">
            {phoneNumbers.map((num) => (
              <tr key={num.id} className="hover:bg-slate-50/50">
                <td className="py-3.5 font-bold font-mono text-slate-800">{num.number}</td>
                <td className="py-3.5 text-slate-500">{num.type} Trunk</td>
                <td className="py-3.5">
                  {num.assignedTo ? (
                    <span className="bg-indigo-50 text-indigo-700 px-2 py-1 rounded-lg font-bold border border-indigo-100">
                      {num.assignedTo}
                    </span>
                  ) : (
                    <span className="text-slate-400 italic">No assigned routing</span>
                  )}
                </td>
                <td className="py-3.5 font-mono text-slate-600">₹{num.monthlyCost.toFixed(2)}/mo</td>
                <td className="py-3.5 text-right">
                  {!isReadOnly ? (
                    <select
                      value={num.assignedTo || ''}
                      onChange={(e) => assignAgentToNum(num.id, e.target.value)}
                      className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 font-semibold text-slate-700 outline-none focus:bg-white text-xs cursor-pointer"
                    >
                      <option value="">-- Reassign Route --</option>
                      {agents.map(a => (
                        <option key={a.id} value={agentLabelShort(a.name)}>{a.name}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-slate-400 italic text-[11px]">Read Only</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function agentLabelShort(fullName: string) {
  return fullName.split(' - ')[0];
}

/* ==========================================
   8. COMPANY SETTINGS
   ========================================== */
function CompanySettingsView() {
  const { role } = useAppState();
  const isReadOnly = role === 'USER';
  const [success, setSuccess] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const saveSettings = () => {
    setSuccess('Webhook callbacks and API credentials saved successfully.');
    setTimeout(() => setSuccess(null), 3000);
  };

  const triggerCopy = () => {
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  return (
    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800 tracking-tight">Account Integrations</h2>
        <p className="text-xs text-slate-400 font-medium mt-0.5">Configure company credentials, secure webhooks, and programmatic API access keys.</p>
      </div>

      {success && (
        <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs font-semibold animate-in fade-in">
          {success}
        </div>
      )}

      <div className="space-y-4 text-xs font-semibold">
        {/* Webhook endpoint URL */}
        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">Callback Callback Webhook URL</label>
          <input
            type="text"
            disabled={isReadOnly}
            defaultValue="https://hooks.mycompany.com/v1/voice-analytics"
            className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg px-4 py-2.5 text-slate-800 outline-none transition font-mono"
          />
          <span className="text-[10px] text-slate-400 mt-1 block font-medium">Platform triggers call transcript uploads and recording files here.</span>
        </div>

        {/* API access tokens */}
        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">Programmatic API Key Key</label>
          <div className="flex items-center space-x-2">
            <div className="relative flex-1">
              <input
                type="text"
                readOnly
                value={isReadOnly ? '********************************' : 'zea_live_ak_902jfd823jhf88df88g8s7df'}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-4 pr-10 py-2.5 text-slate-600 outline-none font-mono"
              />
              <Key className="w-4 h-4 text-slate-400 absolute right-3.5 top-3" />
            </div>

            {!isReadOnly && (
              <button
                type="button"
                onClick={triggerCopy}
                className="px-4 py-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 rounded-lg font-bold transition flex items-center space-x-1.5 cursor-pointer"
              >
                <span>{copiedKey ? 'Copied' : 'Copy'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Action button */}
        <div className="pt-4 border-t border-slate-200 flex justify-end">
          {!isReadOnly ? (
            <button
              onClick={saveSettings}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition shadow-md shadow-indigo-100/50 cursor-pointer"
            >
              Apply Integrations
            </button>
          ) : (
            <span className="bg-slate-100 text-slate-500 text-xs px-3 py-1.5 rounded-lg font-bold border border-slate-200">
              Settings Locked (User View)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
