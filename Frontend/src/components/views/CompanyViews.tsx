/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useAppState } from '../../store/AppState';
import { VoiceAgent, Campaign } from '../../types';
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
import { CallVolumeChart, DurationBarChart, OutcomePieChart, LatencyBreakdownChart } from '../charts/DashboardCharts';
import { apiRequest } from '../../lib/api';
import { CallLogsAnalyticsView } from './CallLogsAnalyticsView';
import { AiInsightsView } from './AiInsightsView';

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

interface VqaVoiceData {
  periodDays: number;
  health: {
    score: number | null;
    label: 'excellent' | 'good' | 'fair' | 'needs_attention' | 'no_data';
    auditedCalls: number;
    healthyCalls: number;
  };
  latencyTrend: Array<{
    date: string;
    sampleCount: number;
    sttMs: number | null;
    llmMs: number | null;
    ttsMs: number | null;
  }>;
  audits: Array<{
    callId: string;
    auditedAt: string;
    responseDelayMs: number;
    sttConfidence: number | null;
    status: 'optimal' | 'normal' | 'degraded';
    latency: { sttMs: number | null; llmMs: number | null; ttsMs: number | null };
  }>;
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
      return <RealReportsView agents={agents} />;
    case 'call-logs':
      return <CallLogsAnalyticsView />;
    case 'phone-numbers':
      return <CompanyPhoneNumbersView />;
    case 'vqa-voice':
      return <VqaVoiceView />;
    case 'ai-insights':
      return <AiInsightsView />;
    case 'integrations':
      return <CompanyIntegrationsView />;
    case 'settings':
      return <CompanySettingsView />;
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
                    <span className="mt-1 block max-w-[220px] break-all font-mono text-[9px] font-bold text-slate-500">
                      Agent ID: {agent.id}
                    </span>
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
   1.1 INTERACTIVE MOCK SUB-VIEWS (SHARYX SUPPORT)
   ========================================== */
function VqaVoiceView() {
  const [assessment, setAssessment] = useState<VqaVoiceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAssessment = async () => {
    setLoading(true);
    setError(null);
    try {
      setAssessment(await apiRequest<VqaVoiceData>('/vqa?days=7&auditLimit=5', { zeaCache: 'bypass' }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load voice quality data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadAssessment(); }, []);

  const health = assessment?.health;
  const healthTone = health?.label === 'excellent' || health?.label === 'good'
    ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
    : health?.label === 'fair'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : health?.label === 'needs_attention'
        ? 'bg-rose-50 text-rose-600 border-rose-200'
        : 'bg-slate-50 text-slate-500 border-slate-200';
  const healthText = health?.score === null || health?.score === undefined
    ? 'HEALTH SCORE: NO DATA'
    : `HEALTH SCORE: ${health.score.toFixed(1)}% (${health.label.replace('_', ' ').toUpperCase()})`;
  const chartData = (assessment?.latencyTrend ?? []).map((point) => ({
    day: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(point.date)),
    stt: point.sttMs,
    llm: point.llmMs,
    tts: point.ttsMs,
  }));

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row md:items-center md:justify-between justify-between">
        <div>
          <h2 className="text-xl font-black text-slate-800 tracking-tight">Voice Quality Assessment (VQA)</h2>
          <p className="text-xs text-slate-500 font-semibold mt-0.5">Persisted provider latency and speech-recognition quality for completed voice calls.</p>
        </div>
        <div className={`border px-4 py-2 rounded-xl text-xs font-black shadow-xs mt-3 md:mt-0 ${healthTone}`}>
          {loading && !assessment ? 'LOADING LIVE VQA DATA...' : healthText}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700">
          Unable to load VQA database records: {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-xs">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="font-bold text-slate-800 text-sm tracking-tight">Response Latency Breakdown Trends</h3>
            <span className="text-[10px] font-bold text-slate-400">{health?.auditedCalls ?? 0} audited calls</span>
          </div>
          <LatencyBreakdownChart data={chartData} />
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between">
          <div>
            <h3 className="font-bold text-slate-800 text-sm tracking-tight mb-4">Audit Records</h3>
            <div className="space-y-3.5 text-xs font-semibold">
              {(assessment?.audits ?? []).map(log => (
                <div key={log.callId} className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex justify-between items-center">
                  <div>
                    <div className="text-slate-800 font-bold">
                      {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(log.auditedAt))}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5 font-semibold">
                      STT Confidence: {log.sttConfidence === null ? 'Not reported' : `${log.sttConfidence.toFixed(1)}%`}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
                      log.status === 'optimal' ? 'bg-emerald-50 text-emerald-600' :
                      log.status === 'normal' ? 'bg-indigo-50 text-indigo-600' : 'bg-rose-50 text-rose-600'
                    }`}>
                      {log.status}
                    </span>
                    <div className="text-[10px] font-mono text-slate-500 font-bold mt-1">Delay: {log.responseDelayMs}ms</div>
                  </div>
                </div>
              ))}
              {!loading && !error && (assessment?.audits.length ?? 0) === 0 && (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-[11px] text-slate-400">
                  No persisted voice provider usage is available for this period.
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => { void loadAssessment(); }}
            className="w-full py-2.5 bg-slate-50 hover:bg-slate-100 disabled:opacity-60 border border-slate-200 rounded-xl text-xs font-bold mt-4 transition cursor-pointer flex items-center justify-center gap-2"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Refreshing VQA Data...' : 'Refresh Live Diagnostics'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
interface CampaignPhoneOption { id: string; number: string; status: string }

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
                          <option key={num.id} value={num.id}>{num.number}</option>
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
                  {campaignPhones.map((phone) => <option key={phone.id} value={phone.id}>{phone.number}</option>)}
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
                  <div className="mt-2 flex items-start gap-1.5">
                    <span className="shrink-0 text-[9px] font-black uppercase tracking-wider text-slate-400">Agent ID</span>
                    <code className="min-w-0 flex-1 break-all text-[9px] font-bold text-slate-600">{agent.id}</code>
                    <button
                      type="button"
                      onClick={() => handleCopy(agent.id)}
                      className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
                      aria-label={'Copy Agent ID for ' + agent.name}
                    >
                      {copiedId === agent.id ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    </button>
                  </div>
                  <span className="mt-1 block text-[9px] text-slate-400">Voice ID: {agent.voiceId}</span>
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

type ReportCallStatus = 'queued' | 'ringing' | 'connected' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled';

interface ReportCallApiData {
  id: string;
  providerCallId: string | null;
  agentId: string | null;
  agentName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  phoneNumberId: string | null;
  fromNumber: string;
  toNumber: string;
  direction: 'inbound' | 'outbound';
  status: ReportCallStatus;
  sentiment: 'unknown' | 'positive' | 'neutral' | 'negative';
  startedAt: string;
  ringingAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  cost: number;
  currency: string;
  recordingAvailable: boolean;
  transcript?: Array<{
    id: string;
    sequenceNumber: number;
    speaker: 'agent' | 'user' | 'system';
    text: string;
    offsetMs: number;
    isFinal: boolean;
    createdAt: string;
  }>;
}

interface ReportCallListResponse {
  items: ReportCallApiData[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  summary: { total: number; inbound: number; outbound: number };
}

const reportStatusLabels: Record<ReportCallStatus, string> = {
  queued: 'Queued', ringing: 'Ringing', connected: 'Connected', completed: 'Completed',
  failed: 'Failed', busy: 'Busy', no_answer: 'No Answer', canceled: 'Canceled',
};

const reportStatusStyles: Record<ReportCallStatus, string> = {
  queued: 'bg-slate-100 text-slate-600 border-slate-200',
  ringing: 'bg-blue-50 text-blue-600 border-blue-200',
  connected: 'bg-violet-50 text-violet-600 border-violet-200',
  completed: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  failed: 'bg-red-50 text-red-600 border-red-200',
  busy: 'bg-amber-50 text-amber-700 border-amber-200',
  no_answer: 'bg-orange-50 text-orange-600 border-orange-200',
  canceled: 'bg-slate-100 text-slate-500 border-slate-200',
};

function reportDateRange(value: string) {
  if (value === 'All Time') return {};
  const now = new Date();
  const end = new Date(now);
  let start = new Date(now);
  if (value === 'Today') start.setHours(0, 0, 0, 0);
  if (value === 'Yesterday') {
    start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() - 1); end.setHours(23, 59, 59, 999);
  }
  if (value === 'Last 7 Days') { start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0); }
  if (value === 'Last 30 Days') { start.setDate(start.getDate() - 29); start.setHours(0, 0, 0, 0); }
  return { startedFrom: start.toISOString(), startedTo: end.toISOString() };
}

function reportDurationRange(value: string) {
  if (value === '0-30s') return { minDurationSeconds: '0', maxDurationSeconds: '30' };
  if (value === '31-60s') return { minDurationSeconds: '31', maxDurationSeconds: '60' };
  if (value === '1-2m') return { minDurationSeconds: '61', maxDurationSeconds: '120' };
  if (value === '2-5m') return { minDurationSeconds: '121', maxDurationSeconds: '300' };
  if (value === '5m+') return { minDurationSeconds: '301' };
  return {};
}

function formatReportTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString([], {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function formatReportDuration(seconds: number) {
  const safe = Math.max(0, Number(seconds) || 0);
  if (safe < 60) return `${safe}s`;
  return `${Math.floor(safe / 60)}m ${safe % 60}s`;
}

function csvCell(value: unknown) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function RealReportsView({ agents }: { agents: VoiceAgent[] }) {
  const pageSize = 10;
  const [dateRange, setDateRange] = useState('All Time');
  const [callType, setCallType] = useState('All Types');
  const [status, setStatus] = useState('All Outcomes');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [callDuration, setCallDuration] = useState('All Durations');
  const [activeTab, setActiveTab] = useState<'All' | 'Inbound' | 'Outbound'>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [report, setReport] = useState<ReportCallListResponse | null>(null);
  const [campaignOptions, setCampaignOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [activeCall, setActiveCall] = useState<ReportCallApiData | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [drawerMode, setDrawerMode] = useState<'details' | 'transcript'>('details');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    apiRequest<{ items: Array<{ id: string; name: string }> }>('/campaigns?page=1&pageSize=100')
      .then((data) => setCampaignOptions(data.items))
      .catch(() => setCampaignOptions([]));
  }, []);

  const buildQuery = (page: number, size = pageSize) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(size) });
    const tabDirection = activeTab === 'Inbound' ? 'inbound' : activeTab === 'Outbound' ? 'outbound' : '';
    const selectedDirection = tabDirection || (callType === 'Inbound' ? 'inbound' : callType === 'Outbound' ? 'outbound' : '');
    if (selectedDirection) params.set('direction', selectedDirection);
    if (status !== 'All Outcomes') params.set('status', status);
    if (selectedAgentId) params.set('agentId', selectedAgentId);
    if (selectedCampaignId) params.set('campaignId', selectedCampaignId);
    if (debouncedSearch) params.set('search', debouncedSearch);
    Object.entries(reportDateRange(dateRange)).forEach(([key, value]) => params.set(key, value));
    Object.entries(reportDurationRange(callDuration)).forEach(([key, value]) => params.set(key, value));
    return params.toString();
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    apiRequest<ReportCallListResponse>(`/calls?${buildQuery(currentPage)}`, {
      signal: controller.signal, zeaCache: 'bypass',
    }).then((data) => {
      setReport(data);
      if (data.pagination.totalPages > 0 && currentPage > data.pagination.totalPages) {
        setCurrentPage(data.pagination.totalPages);
      }
    }).catch((requestError) => {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Call report could not be loaded');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [currentPage, dateRange, callType, status, selectedAgentId, selectedCampaignId, callDuration, activeTab, debouncedSearch]);

  const resetFilters = () => {
    setDateRange('All Time'); setCallType('All Types'); setStatus('All Outcomes');
    setSelectedAgentId(''); setSelectedCampaignId(''); setCallDuration('All Durations');
    setActiveTab('All'); setSearchQuery(''); setDebouncedSearch(''); setCurrentPage(1);
  };

  const openCall = async (call: ReportCallApiData) => {
    setActiveCall(call); setDrawerMode('details'); setDetailsLoading(true); setDetailsError('');
    try {
      setActiveCall(await apiRequest<ReportCallApiData>(`/calls/${call.id}`, { zeaCache: 'bypass' }));
    } catch (requestError) {
      setDetailsError(requestError instanceof Error ? requestError.message : 'Call details could not be loaded');
    } finally { setDetailsLoading(false); }
  };

  const exportReport = async () => {
    if (exporting) return;
    setExporting(true); setExportMessage('');
    try {
      const first = await apiRequest<ReportCallListResponse>(`/calls?${buildQuery(1, 100)}`, { zeaCache: 'bypass' });
      const remaining = first.pagination.totalPages > 1
        ? await Promise.all(Array.from({ length: first.pagination.totalPages - 1 }, (_, index) =>
          apiRequest<ReportCallListResponse>(`/calls?${buildQuery(index + 2, 100)}`, { zeaCache: 'bypass' })))
        : [];
      const rows = [first, ...remaining].flatMap((page) => page.items);
      const header = ['S.No', 'Timestamp', 'Direction', 'Status', 'From Number', 'To Number', 'Duration Seconds', 'Agent', 'Campaign', 'Cost', 'Currency', 'Sentiment'];
      const csv = [header.map(csvCell).join(','), ...rows.map((call, index) => [
        index + 1, call.startedAt, call.direction, call.status, call.fromNumber, call.toNumber,
        call.durationSeconds, call.agentName ?? '', call.campaignName ?? '', call.cost, call.currency, call.sentiment,
      ].map(csvCell).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `ZeaVoice_CallLogs_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      setExportMessage(`Exported ${rows.length} database call records.`);
    } catch (requestError) {
      setExportMessage(requestError instanceof Error ? requestError.message : 'Call report export failed');
    } finally { setExporting(false); }
  };

  const items = report?.items ?? [];
  const summary = report?.summary ?? { total: 0, inbound: 0, outbound: 0 };
  const pagination = report?.pagination ?? { page: 1, pageSize, total: 0, totalPages: 0 };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div><h2 className="text-xl font-bold tracking-tight text-slate-800">Call Logs</h2><p className="mt-0.5 text-xs font-medium text-slate-400">Live tenant-isolated inbound and outbound call records</p></div>
        <button onClick={() => void exportReport()} disabled={exporting || pagination.total === 0} className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 shadow-xs transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
          {exporting ? <RefreshCw className="h-4 w-4 animate-spin text-emerald-600" /> : <FileSpreadsheet className="h-4 w-4 text-emerald-600" />}<span>{exporting ? 'Exporting...' : 'Export CSV'}</span>
        </button>
      </div>
      {exportMessage && <div className="flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-xs font-semibold text-emerald-800"><CheckCircle2 className="h-4 w-4" />{exportMessage}</div>}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-semibold text-red-700">Unable to load database call records: {error}</div>}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {[
          { label: 'Total Calls', value: summary.total, icon: PhoneCall, style: 'bg-pink-50 border-pink-100 text-pink-500' },
          { label: 'Inbound', value: summary.inbound, icon: PhoneIncoming, style: 'bg-blue-50 border-blue-100 text-blue-500' },
          { label: 'Outbound', value: summary.outbound, icon: PhoneOutgoing, style: 'bg-rose-50 border-rose-100 text-rose-500' },
        ].map((metric) => <div key={metric.label} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div><p className="text-xs font-bold uppercase tracking-wider text-slate-400">{metric.label}</p><p className="mt-1 text-3xl font-black tracking-tight text-slate-800">{loading && !report ? '—' : metric.value}</p></div><div className={`flex h-12 w-12 items-center justify-center rounded-2xl border ${metric.style}`}><metric.icon className="h-5 w-5" /></div></div>)}
      </div>

      <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3"><h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-800"><Filter className="h-3.5 w-3.5 text-slate-400" />Search Filters</h3><button onClick={resetFilters} className="flex items-center gap-1 text-xs font-bold text-pink-500 hover:text-pink-600"><XCircle className="h-3.5 w-3.5" />Clear Filters</button></div>
        <div className="grid grid-cols-1 gap-4 text-xs font-semibold sm:grid-cols-2 lg:grid-cols-4">
          <ReportSelect label="Date Range" icon={Calendar} value={dateRange} onChange={(value) => { setDateRange(value); setCurrentPage(1); }} options={[['All Time','All Time'],['Today','Today'],['Yesterday','Yesterday'],['Last 7 Days','Last 7 Days'],['Last 30 Days','Last 30 Days']]} />
          <ReportSelect label="Call Type" icon={Phone} value={callType} onChange={(value) => { setCallType(value); setActiveTab('All'); setCurrentPage(1); }} options={[['All Types','All Types'],['Inbound','Inbound'],['Outbound','Outbound']]} />
          <ReportSelect label="Outcome" icon={Activity} value={status} onChange={(value) => { setStatus(value); setCurrentPage(1); }} options={[['All Outcomes','All Outcomes'], ...Object.entries(reportStatusLabels).map(([value,label]) => [value,label])]} />
          <ReportSelect label="Voice Agent" icon={User} value={selectedAgentId} onChange={(value) => { setSelectedAgentId(value); setCurrentPage(1); }} options={[['','All Agents'], ...agents.map((agent) => [agent.id, agent.name])]} />
        </div>
        <div className="grid grid-cols-1 gap-4 text-xs font-semibold sm:grid-cols-2">
          <ReportSelect label="Call Duration" icon={Clock} value={callDuration} onChange={(value) => { setCallDuration(value); setCurrentPage(1); }} options={[['All Durations','All Durations'],['0-30s','0-30s'],['31-60s','31-60s'],['1-2m','1-2m'],['2-5m','2-5m'],['5m+','5m+']]} />
          <ReportSelect label="Outbound Campaign" icon={Megaphone} value={selectedCampaignId} onChange={(value) => { setSelectedCampaignId(value); setCurrentPage(1); }} options={[['','All Campaigns'], ...campaignOptions.map((campaign) => [campaign.id, campaign.name])]} />
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">{(['All','Inbound','Outbound'] as const).map((tab) => <button key={tab} onClick={() => { setActiveTab(tab); setCallType('All Types'); setCurrentPage(1); }} className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-xs font-bold transition ${activeTab === tab ? 'border-pink-500 bg-pink-500 text-white shadow-md shadow-pink-100/50' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>{tab === 'Inbound' ? <PhoneIncoming className="h-3.5 w-3.5" /> : tab === 'Outbound' ? <PhoneOutgoing className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}<span>{tab === 'All' ? 'All Calls' : tab}</span></button>)}</div>
        <div className="flex flex-1 items-center gap-3 lg:max-w-md"><div className="relative flex-1"><Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" /><input value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setCurrentPage(1); }} placeholder="Search number, agent, campaign..." className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-4 text-xs font-semibold text-slate-800 outline-none transition focus:border-pink-500 focus:bg-white" /></div><span className="shrink-0 whitespace-nowrap text-xs font-bold text-slate-400">{pagination.total} records</span></div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto"><table className="w-full border-collapse text-left"><thead><tr className="border-b border-slate-200 bg-slate-50/50 text-[9px] font-extrabold uppercase tracking-widest text-slate-400"><th className="px-6 py-4">S.No</th><th className="px-6 py-4">Time Stamp</th><th className="px-6 py-4">Agent</th><th className="px-6 py-4">Call Type</th><th className="px-6 py-4">Outcome</th><th className="px-6 py-4">Duration</th><th className="px-6 py-4">Prospect Number</th><th className="px-6 py-4 text-center">Action</th></tr></thead>
          <tbody className="divide-y divide-slate-100 text-xs font-semibold">
            {loading ? <tr><td colSpan={8} className="py-16 text-center text-slate-400"><RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin text-pink-500" />Loading database call records...</td></tr>
              : items.length === 0 ? <tr><td colSpan={8} className="py-16 text-center text-slate-400"><Phone className="mx-auto mb-2 h-8 w-8 text-slate-300" /><p className="font-bold">No database call records match these filters.</p></td></tr>
                : items.map((call, index) => <tr key={call.id} className="transition hover:bg-slate-50/40"><td className="px-6 py-4 font-mono text-slate-400">{(pagination.page - 1) * pagination.pageSize + index + 1}</td><td className="px-6 py-4 text-slate-500">{formatReportTimestamp(call.startedAt)}</td><td className="px-6 py-4 font-bold text-slate-700">{call.agentName || 'Unassigned'}</td><td className="px-6 py-4"><span className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[10px] font-black ${call.direction === 'inbound' ? 'border-blue-100 bg-blue-50 text-blue-600' : 'border-pink-100 bg-pink-50 text-pink-600'}`}>{call.direction === 'inbound' ? <PhoneIncoming className="h-3 w-3" /> : <PhoneOutgoing className="h-3 w-3" />}{call.direction === 'inbound' ? 'Inbound' : 'Outbound'}</span></td><td className="px-6 py-4"><span className={`rounded-md border px-2 py-0.5 text-[10px] font-extrabold uppercase ${reportStatusStyles[call.status]}`}>{reportStatusLabels[call.status]}</span></td><td className="px-6 py-4 font-mono font-bold text-slate-600"><span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-slate-400" />{formatReportDuration(call.durationSeconds)}</span></td><td className="px-6 py-4 font-mono font-bold text-slate-800">{call.direction === 'inbound' ? call.fromNumber : call.toNumber}</td><td className="px-6 py-4 text-center"><button onClick={() => void openCall(call)} className="inline-flex rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-pink-500" title="Open database call details"><ChevronRight className="h-4 w-4" /></button></td></tr>)}
          </tbody></table></div>
        {pagination.totalPages > 1 && <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/50 px-6 py-4"><span className="text-xs font-bold text-slate-400">Page {pagination.page} of {pagination.totalPages} ({pagination.total} records)</span><div className="flex gap-2"><button disabled={pagination.page <= 1 || loading} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-50">Previous</button><button disabled={pagination.page >= pagination.totalPages || loading} onClick={() => setCurrentPage((page) => Math.min(pagination.totalPages, page + 1))} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-50">Next</button></div></div>}
      </div>

      {activeCall && <div className="fixed inset-0 z-50 flex items-center justify-end bg-slate-900/50 backdrop-blur-xs"><div className="flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-[#fafafb] shadow-2xl"><div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white p-6"><div><span className="block text-[10px] font-black uppercase tracking-widest text-slate-400">Database record</span><h3 className="mt-0.5 text-xl font-extrabold text-slate-800">Call Details</h3></div><div className="flex gap-2"><button onClick={() => setDrawerMode((mode) => mode === 'details' ? 'transcript' : 'details')} disabled={detailsLoading} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700">{drawerMode === 'details' ? 'View Transcript' : 'View Details'}</button><button onClick={() => setActiveCall(null)} className="rounded-xl border border-slate-200 bg-white p-2 text-slate-400"><X className="h-4 w-4" /></button></div></div>
        <div className="flex-1 overflow-y-auto p-6">{detailsLoading ? <div className="py-20 text-center text-xs font-semibold text-slate-400"><RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin text-pink-500" />Loading transcript and call details...</div> : drawerMode === 'transcript' ? <div className="space-y-5">{detailsError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{detailsError}</div>}{activeCall.transcript?.length ? activeCall.transcript.map((entry) => <div key={entry.id} className={`flex flex-col ${entry.speaker === 'agent' ? 'items-end' : 'items-start'}`}><span className="mb-1 text-[9px] font-extrabold uppercase tracking-widest text-slate-400">{entry.speaker === 'agent' ? activeCall.agentName || 'Agent' : entry.speaker === 'user' ? 'Customer' : 'System'}</span><div className={`max-w-[85%] rounded-2xl p-4 text-xs font-semibold leading-relaxed ${entry.speaker === 'agent' ? 'rounded-tr-none bg-gradient-to-r from-purple-600 to-fuchsia-500 text-white' : 'rounded-tl-none border border-slate-200 bg-white text-slate-800'}`}>{entry.text}</div><span className="mt-1 text-[9px] font-medium text-slate-400">{formatReportDuration(Math.floor(entry.offsetMs / 1000))}</span></div>) : <div className="py-16 text-center text-xs font-semibold text-slate-400">No transcript entries are stored for this call.</div>}</div>
          : <div className="space-y-5">{detailsError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{detailsError}</div>}<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{[
            ['Agent', activeCall.agentName || 'Unassigned'], ['Timestamp', formatReportTimestamp(activeCall.startedAt)],
            ['Direction', activeCall.direction.toUpperCase()], ['Status', reportStatusLabels[activeCall.status]],
            ['From', activeCall.fromNumber], ['To', activeCall.toNumber], ['Duration', formatReportDuration(activeCall.durationSeconds)],
            ['Cost', `${activeCall.currency} ${Number(activeCall.cost).toFixed(2)}`], ['Sentiment', activeCall.sentiment],
            ['Campaign', activeCall.campaignName || 'None'],
          ].map(([label,value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"><span className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</span><span className="mt-2 block break-words text-sm font-black capitalize text-slate-800">{value}</span></div>)}</div><div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white p-5 text-[11px] font-semibold">{[['Call ID',activeCall.id],['Provider Call ID',activeCall.providerCallId || 'Not available'],['Agent ID',activeCall.agentId || 'Not assigned'],['Campaign ID',activeCall.campaignId || 'Not assigned'],['Recording',activeCall.recordingAvailable ? 'Stored' : 'Not available']].map(([label,value]) => <div key={label} className="flex justify-between gap-4 py-2.5"><span className="font-bold uppercase tracking-wider text-slate-400">{label}</span><span className="break-all text-right font-mono font-bold text-slate-800">{value}</span></div>)}</div></div>}</div>
        <div className="flex shrink-0 items-center justify-between border-t border-slate-200 bg-white p-6"><span className="truncate font-mono text-[10px] font-black uppercase tracking-widest text-slate-400">ID: {activeCall.id}</span><button onClick={() => setActiveCall(null)} className="rounded-xl bg-slate-800 px-5 py-2.5 text-xs font-bold text-white">Close Review</button></div></div></div>}
    </div>
  );
}

function ReportSelect({ label, icon: Icon, value, onChange, options }: {
  label: string; icon: React.ComponentType<{ className?: string }>; value: string;
  onChange: (value: string) => void; options: string[][];
}) {
  return <div className="space-y-1.5"><label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</label><div className="relative"><select value={value} onChange={(event) => onChange(event.target.value)} className="w-full appearance-none rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-8 pr-8 font-bold text-slate-800 outline-none transition hover:bg-slate-100/50"><option hidden={false} value={options[0]?.[0]}>{options[0]?.[1]}</option>{options.slice(1).map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select><Icon className="pointer-events-none absolute left-3 top-3 h-3.5 w-3.5 text-slate-400" /><ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-3.5 w-3.5 text-slate-400" /></div></div>;
}

/* ==========================================
   7. COMPANY PHONE NUMBERS
   ========================================== */
interface TenantPhoneNumber {
  id: string;
  number: string;
  countryIso: string | null;
  numberType: string | null;
  capabilities: Record<string, unknown>;
  status: 'active' | 'unavailable' | 'released';
  assignedAt: string;
  assignedAgent: { id: string; name: string; status: 'draft' | 'active' } | null;
}

interface PhoneAgentOption {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'archived';
}

function CompanyPhoneNumbersView() {
  const { role } = useAppState();
  const isReadOnly = role === 'USER';
  const [phoneNumbers, setPhoneNumbers] = useState<TenantPhoneNumber[]>([]);
  const [agents, setAgents] = useState<PhoneAgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [mappingId, setMappingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<string | null>(null);

  const loadPhoneNumbers = async (forceRefresh = false) => {
    setLoading(true);
    setError('');
    try {
      const options = forceRefresh ? { zeaCache: 'reload' as const } : { zeaCache: 'bypass' as const };
      const numbersRequest = apiRequest<TenantPhoneNumber[]>('/phone-numbers', options);
      if (isReadOnly) {
        setPhoneNumbers(await numbersRequest);
        setAgents([]);
      } else {
        const [numbers, agentResponse] = await Promise.all([
          numbersRequest,
          apiRequest<{ items: PhoneAgentOption[] }>('/agents?page=1&pageSize=100', options),
        ]);
        setPhoneNumbers(numbers);
        setAgents(agentResponse.items.filter((agent) => agent.status !== 'archived'));
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Company phone numbers could not be loaded');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadPhoneNumbers(); }, [role]);

  const mapAgent = async (phoneNumberId: string, agentId: string) => {
    if (isReadOnly) return;
    setMappingId(phoneNumberId);
    setError('');
    setSuccess(null);
    try {
      const updated = await apiRequest<TenantPhoneNumber>('/phone-numbers/' + phoneNumberId + '/agent', {
        method: 'PUT',
        body: JSON.stringify({ agentId: agentId || null }),
        zeaCache: 'bypass',
      });
      setPhoneNumbers((current) => current.map((number) => number.id === updated.id ? updated : number));
      setSuccess(updated.assignedAgent
        ? 'Routing updated to ' + updated.assignedAgent.name + '.'
        : 'Agent routing removed from this number.');
      window.setTimeout(() => setSuccess(null), 3000);
      await loadPhoneNumbers(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Agent routing could not be updated');
    } finally {
      setMappingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-xl font-black tracking-tight text-slate-800">Phone Numbers</h2>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              Company-assigned phone numbers and their voice-agent routing.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isReadOnly && (
              <span className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-[10px] font-black text-sky-700">
                READ ONLY
              </span>
            )}
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadPhoneNumbers(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              <RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">
          {success}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
          Unable to load company phone-number data: {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[9px] font-black uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3.5">Phone Number</th>
                <th className="px-5 py-3.5">Type</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5">Assigned Agent</th>
                {!isReadOnly && <th className="px-5 py-3.5 text-right">Agent Routing</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-semibold">
              {phoneNumbers.map((number) => (
                <tr key={number.id} className="hover:bg-slate-50/50">
                  <td className="px-5 py-4">
                    <span className="block font-mono font-black text-slate-800">{number.number}</span>
                    <span className="mt-1 block text-[9px] font-semibold text-slate-400">
                      Assigned {new Date(number.assignedAt).toLocaleDateString()}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-slate-500">
                    {number.numberType ? agentLabelShort(number.numberType) : 'Voice'}
                    {number.countryIso ? ' · ' + number.countryIso : ''}
                  </td>
                  <td className="px-5 py-4">
                    <span className={'rounded-full border px-2.5 py-1 text-[9px] font-black uppercase ' + (
                      number.status === 'active'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
                        : 'border-amber-200 bg-amber-50 text-amber-600'
                    )}>
                      {number.status.replaceAll('_', ' ')}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    {number.assignedAgent ? (
                      <span className="rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-1 font-bold text-indigo-700">
                        {number.assignedAgent.name}
                      </span>
                    ) : (
                      <span className="italic text-slate-400">Not mapped</span>
                    )}
                  </td>
                  {!isReadOnly && (
                    <td className="px-5 py-4 text-right">
                      <select
                        value={number.assignedAgent?.id || ''}
                        disabled={mappingId === number.id || number.status !== 'active'}
                        onChange={(event) => void mapAgent(number.id, event.target.value)}
                        aria-label={'Agent routing for ' + number.number}
                        className="cursor-pointer rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs font-semibold text-slate-700 outline-none focus:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <option value="">Not mapped</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>{agent.name} ({agent.status})</option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
              ))}
              {!loading && phoneNumbers.length === 0 && (
                <tr>
                  <td colSpan={isReadOnly ? 4 : 5} className="px-5 py-14 text-center text-xs font-semibold text-slate-400">
                    No phone numbers are assigned to this company.
                  </td>
                </tr>
              )}
              {loading && phoneNumbers.length === 0 && (
                <tr>
                  <td colSpan={isReadOnly ? 4 : 5} className="px-5 py-14 text-center text-xs font-semibold text-slate-400">
                    Loading company phone numbers...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
interface CompanyIdentitySettings {
  fullName: string;
  emailAddress: string;
  organizationName: string;
  workspaceName: string;
  organizationId: string;
  tenantId: string;
  workspaceId: string;
}

function CompanySettingsView() {
  const [identity, setIdentity] = useState<CompanyIdentitySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadIdentity = async () => {
    setLoading(true);
    setError('');
    try {
      setIdentity(await apiRequest<CompanyIdentitySettings>('/settings/profile', { zeaCache: 'bypass' }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Company identity could not be loaded');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadIdentity(); }, []);

  const copyIdentifier = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedId(key);
    window.setTimeout(() => setCopiedId(null), 1800);
  };

  const identifiers = identity ? [
    { key: 'organization', label: 'Organization ID', value: identity.organizationId },
    { key: 'tenant', label: 'Tenant ID', value: identity.tenantId },
    { key: 'workspace', label: 'Workspace ID', value: identity.workspaceId },
  ] : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-black tracking-tight text-slate-800">Company Settings</h2>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">
            Read-only organization, tenant and active workspace identity.
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadIdentity()}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
          Unable to load database settings: {error}
        </div>
      )}

      {loading && !identity ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white" />
          <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        </div>
      ) : identity && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
            <div className="mb-6 flex items-center gap-3">
              <div className="rounded-xl bg-violet-50 p-2.5 text-violet-600">
                <User className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-800">Organization Profile</h3>
                <p className="text-[10px] font-semibold text-slate-400">Persisted company workspace details</p>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              <div className="flex items-center justify-between gap-4 py-4">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Full Name</span>
                <span className="text-right text-sm font-black text-slate-800">{identity.fullName}</span>
              </div>
              <div className="flex items-center justify-between gap-4 py-4">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Email Address</span>
                <span className="break-all text-right text-sm font-black text-slate-800">{identity.emailAddress}</span>
              </div>
              <div className="flex items-center justify-between gap-4 py-4">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Organization Name</span>
                <span className="text-right text-sm font-black text-slate-800">{identity.organizationName}</span>
              </div>
              <div className="flex items-center justify-between gap-4 py-4">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Workspace Name</span>
                <span className="text-right text-sm font-black text-slate-800">{identity.workspaceName}</span>
              </div>
            </div>
            <div className="mt-5 rounded-xl border border-sky-100 bg-sky-50 p-3 text-[10px] font-semibold leading-5 text-sky-700">
              These values are managed during company creation and displayed here as read-only settings.
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
            <div className="mb-6 flex items-center gap-3">
              <div className="rounded-xl bg-blue-50 p-2.5 text-blue-600">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-800">System Identifiers</h3>
                <p className="text-[10px] font-semibold text-slate-400">IDs for API and webhook integration</p>
              </div>
            </div>
            <div className="space-y-4">
              {identifiers.map((item) => (
                <div key={item.key}>
                  <label className="mb-1.5 block text-[9px] font-black uppercase tracking-wider text-slate-400">
                    {item.label}
                  </label>
                  <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <input
                      readOnly
                      value={item.value}
                      aria-label={item.label}
                      className="min-w-0 flex-1 bg-transparent font-mono text-[11px] font-bold text-slate-700 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void copyIdentifier(item.key, item.value)}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-violet-600"
                      aria-label={'Copy ' + item.label}
                    >
                      {copiedId === item.key ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-[10px] font-semibold leading-5 text-slate-500">
              Identifiers are generated by the backend and uniquely map to the authenticated tenant and active workspace.
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function CompanyIntegrationsView() {
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
