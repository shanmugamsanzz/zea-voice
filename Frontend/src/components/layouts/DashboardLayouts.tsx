/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * test cmd
 * test-2
 */

import React, { useEffect, useState } from 'react';
import { useAppState } from '../../store/AppState';
import { startTabMeasurement } from '../../lib/performance';
import {
  LayoutDashboard,
  Building2,
  Users,
  Cpu,
  Phone,
  Coins,
  Activity,
  Tv,
  CreditCard,
  Settings,
  Megaphone,
  Bot,
  FileSpreadsheet,
  History,
  User,
  ChevronDown,
  Menu,
  X,
  ClipboardList,
  Wifi,
  MessageSquare,
  Brain,
  Link,
  Key,
  LogOut,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import zeaVoiceIcon from '../../zea-voice-icon.png';
import zeaVoiceBrand from '../../zea-voice-brand.png';

interface SidebarItem {
  name: string;
  viewId: string;
  icon: React.ComponentType<any>;
}

export function DashboardLayout({ children, onLogout }: { children: React.ReactNode; onLogout: () => void | Promise<void> }) {
  const { role, view, setView, userEmail } = useAppState();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isSidebarMinimized, setIsSidebarMinimized] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const root = document.getElementById('root');
    const previous = {
      htmlOverflow: document.documentElement.style.overflow,
      bodyOverflow: document.body.style.overflow,
      rootOverflow: root?.style.overflow ?? '',
      rootHeight: root?.style.height ?? '',
    };
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    if (root) {
      root.style.height = '100dvh';
      root.style.overflow = 'hidden';
    }
    return () => {
      document.documentElement.style.overflow = previous.htmlOverflow;
      document.body.style.overflow = previous.bodyOverflow;
      if (root) {
        root.style.height = previous.rootHeight;
        root.style.overflow = previous.rootOverflow;
      }
    };
  }, []);

  const handleItemClick = (viewId: string) => {
    startTabMeasurement(viewId);
    setView(viewId);
    setMobileMenuOpen(false);
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try { await onLogout(); }
    finally { setLoggingOut(false); setMobileMenuOpen(false); }
  };

  // Super Admin Navigation
  const superAdminItems: SidebarItem[] = [
    { name: 'Dashboard', viewId: 'dashboard', icon: LayoutDashboard },
    { name: 'Companies', viewId: 'companies', icon: Building2 },
    { name: 'Users', viewId: 'developers', icon: Users },
    { name: 'Voice Providers', viewId: 'providers', icon: Cpu },
    { name: 'Phone Numbers', viewId: 'phone-numbers', icon: Phone },
    { name: 'Credits Manager', viewId: 'credits', icon: Coins },
    { name: 'Queue Monitor', viewId: 'queue-monitor', icon: Activity },
    { name: 'Call Monitoring', viewId: 'call-monitoring', icon: Tv },
    { name: 'Payments', viewId: 'payments', icon: CreditCard },
    { name: 'Settings', viewId: 'settings', icon: Settings },
  ];

  // ZEA VOICE (Company / Developer / User) Navigation Categories
  const zeaCategories = [
    {
      title: 'OVERVIEW',
      items: [
        { name: 'Dashboard', viewId: 'dashboard', icon: LayoutDashboard },
        { name: 'Analytics', viewId: 'analytics', icon: Activity },
      ],
    },
    {
      title: 'VOICE AI',
      items: [
        { name: 'Campaigns', viewId: 'campaigns', icon: Megaphone },
        { name: 'Agents', viewId: 'agents', icon: Bot },
        { name: 'Reports', viewId: 'reports', icon: FileSpreadsheet },
        { name: 'VQA Voice', viewId: 'vqa-voice', icon: MessageSquare },
      ],
    },
    {
      title: 'DATA',
      items: [
        { name: 'Call Logs Analytics', viewId: 'call-logs', icon: History },
        { name: 'AI Insights', viewId: 'ai-insights', icon: Brain },
      ],
    },
    {
      title: 'ACCOUNT',
      items: [
        { name: 'Phone Numbers', viewId: 'phone-numbers', icon: Phone },
        ...(role === 'DEVELOPER' ? [
          { name: 'Integrations', viewId: 'integrations', icon: Link },
          { name: 'API Keys', viewId: 'api-keys', icon: Key },
          { name: 'Settings', viewId: 'settings', icon: Settings },
        ] : []),
      ],
    }
  ];

  const getViewName = (viewId: string) => {
    switch (viewId) {
      case 'dashboard': return 'Dashboard';
      case 'analytics': return 'Analytics';
      case 'campaigns': return 'Campaigns';
      case 'agents': return 'Agents';
      case 'reports': return 'Reports';
      case 'vqa-voice': return 'VQA Voice';
      case 'call-logs': return 'Call Logs Analytics';
      case 'ai-insights': return 'AI Insights';
      case 'phone-numbers': return 'Phone Numbers';
      case 'integrations': return 'Integrations';
      case 'api-keys': return 'API Keys';
      case 'settings': return 'Settings';
      default: return 'Dashboard';
    }
  };

  const getViewMeta = (viewId: string) => {
    switch (viewId) {
      case 'dashboard':
        return { 
          title: role === 'SUPER_ADMIN' ? 'Oversight Console' : 'Operational Pulse', 
          subtitle: role === 'SUPER_ADMIN' ? 'Global SaaS operations and enterprise tenant activity' : 'Operational performance and state metrics for active voice agents' 
        };
      case 'companies':
        return { title: 'Tenant Organizations', subtitle: 'Manage active enterprise companies and subscription tiers' };
      case 'developers':
        return { title: 'Company Users', subtitle: 'Create developers and users, then assign them to tenant companies' };
      case 'providers':
        return { title: 'Voice Providers', subtitle: 'Configure carrier trunks, speech synthesis, and neural LLM backends' };
      case 'phone-numbers':
        return { title: 'Trunk Assignations', subtitle: 'Route and map leased DID telephone numbers to operators' };
      case 'credits':
        return { title: 'Balance Manager', subtitle: 'Recharge currency reserves and adjust tenant quota limits' };
      case 'queue-monitor':
        return { title: 'Queue Telemetry', subtitle: 'Realtime concurrent call dialing and active conversation pipelines' };
      case 'call-monitoring':
        return { title: 'Call Intercept', subtitle: 'Auditing and feedback for active voice operations' };
      case 'payments':
        return { title: 'Invoices Ledger', subtitle: 'Audit, manage, and track transaction histories and logs' };
      case 'analytics':
        return { title: 'Conversational Analytics', subtitle: 'Verbal conversion rate, talk time, and customer sentiment analytics' };
      case 'campaigns':
        return { title: 'Outbound Campaigns', subtitle: 'Control concurrent dialers and campaign triggers' };
      case 'agents':
      case 'agents/create':
      case 'agents/edit':
        return { title: 'Voice Operators', subtitle: 'Design prompt loops, listening filters, and neural outputs' };
      case 'reports':
        return { title: 'On-Demand Reports', subtitle: 'Filter transcript histories and export CSV/JSON digests' };
      case 'call-logs':
        return { title: 'Verbatim Logs', subtitle: 'Historical transcript logs and billing records' };
      case 'settings':
        return { title: 'Account Integrations', subtitle: 'Configure developer webhooks and secure API access' };
      case 'api-keys':
        return { title: 'API Keys', subtitle: 'Create tenant-bound credentials for n8n and approved integrations' };
      default:
        return { title: 'SaaS Dashboard', subtitle: 'Voice AI Autonomous Workspace' };
    }
  };

  const meta = getViewMeta(view);

  return (
    <div className="zea-premium-shell h-dvh bg-slate-50 flex font-sans text-slate-800 overflow-hidden">
      {/* Desktop Persistent Sidebar */}
      {role === 'SUPER_ADMIN' ? (
        <aside className={`${isSidebarMinimized ? 'w-20' : 'w-64'} bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-300 hidden md:flex flex-col justify-between shrink-0 h-full border-r border-slate-200 dark:border-slate-850 transition-all duration-300`}>
          <div className="flex flex-col flex-1 overflow-y-auto">
            {/* Brand Logo Header */}
            <div className={`relative flex items-center justify-center shrink-0 border-b border-slate-100 dark:border-slate-800/40 ${isSidebarMinimized ? 'p-4' : 'p-6'}`}>
              <div className="flex items-center justify-center">
                <img src={isSidebarMinimized ? zeaVoiceIcon : zeaVoiceBrand} alt="Zea Voice"
                  className={isSidebarMinimized ? 'h-12 w-12 rounded-xl object-contain shrink-0' : 'h-16 w-44 object-contain object-center shrink-0'} />
              </div>
              <button
                onClick={() => setIsSidebarMinimized(!isSidebarMinimized)}
                className="absolute right-2 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer shrink-0"
                title={isSidebarMinimized ? "Expand Sidebar" : "Collapse Sidebar"}
              >
                {isSidebarMinimized ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
              </button>
            </div>

            <nav className="flex-1 px-4 py-6 space-y-1.5">
              {!isSidebarMinimized && (
                <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest px-4 mb-3 block">
                  Super Admin Portal
                </div>
              )}
              {superAdminItems.map((item) => {
                const Icon = item.icon;
                const isActive = view === item.viewId || view.startsWith(item.viewId + '/');
                return (
                  <button
                    key={item.viewId}
                    onClick={() => handleItemClick(item.viewId)}
                    className={`w-full flex items-center rounded-lg text-sm font-semibold transition-all ${
                      isSidebarMinimized ? 'justify-center p-3' : 'space-x-3 px-4 py-3'
                    } ${
                      isActive
                        ? 'bg-indigo-50 dark:bg-slate-800 text-indigo-600 dark:text-white border-l-2 border-indigo-500 pl-3.5'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-800 dark:hover:text-white'
                    }`}
                    id={`sidebar-link-${item.viewId}`}
                    title={isSidebarMinimized ? item.name : undefined}
                  >
                    <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}`} />
                    {!isSidebarMinimized && <span>{item.name}</span>}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Sidebar Footer Profile Block */}
          <div className={`mt-auto border-t border-slate-100 dark:border-slate-850 shrink-0 ${isSidebarMinimized ? 'p-3 flex flex-col items-center gap-2' : 'p-4 space-y-3'}`}>
            <div className={`flex items-center ${isSidebarMinimized ? 'justify-center' : 'space-x-3'}`}>
              <div className="w-10 h-10 rounded-full bg-indigo-50 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-slate-700 flex items-center justify-center font-bold text-sm shrink-0" title="Project Lead">
                JS
              </div>
              {!isSidebarMinimized && (
                <div className="overflow-hidden">
                  <p className="text-sm font-semibold text-slate-800 dark:text-white truncate">Project Lead</p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate">{userEmail}</p>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              title={isSidebarMinimized ? 'Logout' : undefined}
              className={`flex items-center rounded-xl text-xs font-bold text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10 transition disabled:opacity-50 cursor-pointer ${
                isSidebarMinimized ? 'justify-center p-3' : 'w-full space-x-3 px-4 py-3'
              }`}
            >
              <LogOut className="w-4 h-4 shrink-0" />
              {!isSidebarMinimized && <span>{loggingOut ? 'Logging out...' : 'Logout'}</span>}
            </button>
          </div>
        </aside>
      ) : (
        /* Zea Voice Light Sidebar (Competitor View) */
        <aside className={`${isSidebarMinimized ? 'w-20' : 'w-64'} bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-300 hidden md:flex flex-col justify-between shrink-0 h-full border-r border-slate-200 dark:border-slate-850 transition-all duration-300`}>
          <div className="flex flex-col flex-1 overflow-y-auto">
            {/* Brand Logo Header */}
            <div className={`relative flex items-center justify-center shrink-0 border-b border-slate-100 dark:border-slate-800/40 ${isSidebarMinimized ? 'p-4' : 'p-6'}`}>
              <div className="flex items-center justify-center">
                <img src={isSidebarMinimized ? zeaVoiceIcon : zeaVoiceBrand} alt="Zea Voice"
                  className={isSidebarMinimized ? 'h-12 w-12 rounded-xl object-contain shrink-0' : 'h-16 w-44 object-contain object-center shrink-0'} />
                <div className="hidden w-10 h-10 bg-[#E0E7FF]/50 dark:bg-slate-800 rounded-2xl items-center justify-center relative shrink-0">
                  <div className="absolute -top-1.5 -right-1.5 bg-[#4F46E5] w-4 h-4 rounded-full border-2 border-white dark:border-slate-800 flex items-center justify-center">
                    <span className="text-[8px] text-white font-black">✔</span>
                  </div>
                  {/* smiling blue mic mascot character svg representation */}
                  <svg className="w-6 h-6 text-[#4F46E5]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                {!isSidebarMinimized && (
                  <div className="hidden">
                    <span className="text-xl font-black text-[#1E293B] dark:text-white tracking-tight block leading-none">ZEA VOICE</span>
                    <span className="text-[8px] font-extrabold text-slate-400 dark:text-slate-500 tracking-wider block uppercase mt-1">AI VOICE AGENT</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => setIsSidebarMinimized(!isSidebarMinimized)}
                className="absolute right-2 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer shrink-0"
                title={isSidebarMinimized ? "Expand Sidebar" : "Collapse Sidebar"}
              >
                {isSidebarMinimized ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
              </button>
            </div>

            {/* Navigation categorized list */}
            <nav className={`flex-1 py-6 space-y-5 ${isSidebarMinimized ? 'px-2' : 'px-4'}`}>
              {zeaCategories.map((category) => (
                <div key={category.title} className="space-y-1">
                  {!isSidebarMinimized && (
                    <div className="text-[10px] font-black text-slate-400 dark:text-slate-500 tracking-wider px-3 mb-2 block uppercase">
                      {category.title}
                    </div>
                  )}
                  {category.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = view === item.viewId || view.startsWith(item.viewId + '/');
                    return (
                      <button
                        key={item.viewId}
                        onClick={() => handleItemClick(item.viewId)}
                        className={`w-full flex items-center rounded-xl text-xs font-bold transition-all ${
                          isSidebarMinimized ? 'justify-center p-3' : 'space-x-3 px-3 py-2.5'
                        } ${
                          isActive
                            ? 'bg-gradient-to-r from-[#A855F7] to-[#8B5CF6] text-white shadow-md shadow-purple-100/30'
                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-950 dark:hover:text-white'
                        }`}
                        id={`sidebar-link-${item.viewId}`}
                        title={isSidebarMinimized ? item.name : undefined}
                      >
                        <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-white' : 'text-slate-400 dark:text-slate-500'}`} />
                        {!isSidebarMinimized && <span>{item.name}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
          </div>

          {/* Sidebar Footer Logout */}
          <div className={`mt-auto border-t border-slate-100 dark:border-slate-800 shrink-0 ${isSidebarMinimized ? 'p-2 flex justify-center' : 'p-4'}`}>
            <button
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              className={`flex items-center rounded-xl text-xs font-bold text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10 transition cursor-pointer ${
                isSidebarMinimized ? 'justify-center p-3' : 'w-full space-x-3 px-4 py-3'
              }`}
              title={isSidebarMinimized ? "Logout" : undefined}
            >
              <LogOut className="w-4 h-4 text-amber-400 shrink-0" />
              {!isSidebarMinimized && <span>{loggingOut ? 'Logging out...' : 'Logout'}</span>}
            </button>
          </div>
        </aside>
      )}

      {/* Mobile Sidebar overlay drawer */}
      {mobileMenuOpen && (
        <>
          <div className="fixed inset-0 bg-slate-900/60 z-40 md:hidden transition-opacity duration-200" onClick={() => setMobileMenuOpen(false)} />
          <aside className="fixed left-0 top-0 bottom-0 w-64 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-300 z-50 md:hidden flex flex-col justify-between py-6 shadow-2xl animate-in slide-in-from-left duration-250 border-r border-slate-200 dark:border-slate-850">
            <div className="flex flex-col flex-1 overflow-y-auto">
              <div className="p-6 flex items-center justify-center shrink-0 border-b border-slate-100 dark:border-slate-800/40 mb-4">
                <img src={zeaVoiceBrand} alt="Zea Voice" className="h-18 w-48 object-contain object-center" />
              </div>

              <nav className="flex-1 px-4 space-y-6">
                {role === 'SUPER_ADMIN' ? (
                  <div className="space-y-1.5">
                    {superAdminItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = view === item.viewId || view.startsWith(item.viewId + '/');
                      return (
                        <button
                          key={item.viewId}
                          onClick={() => handleItemClick(item.viewId)}
                          className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all ${
                            isActive
                              ? 'bg-indigo-50 dark:bg-slate-800 text-indigo-600 dark:text-white border-l-2 border-indigo-500 pl-3.5'
                              : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}`} />
                          <span>{item.name}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  zeaCategories.map((category) => (
                    <div key={category.title} className="space-y-1">
                      <div className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-wider px-3 mb-2 block">
                        {category.title}
                      </div>
                      {category.items.map((item) => {
                        const Icon = item.icon;
                        const isActive = view === item.viewId || view.startsWith(item.viewId + '/');
                        return (
                          <button
                            key={item.viewId}
                            onClick={() => handleItemClick(item.viewId)}
                            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all ${
                              isActive
                                ? 'bg-gradient-to-r from-[#A855F7] to-[#8B5CF6] text-white shadow-sm'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-950 dark:hover:text-white'
                            }`}
                          >
                            <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-white' : 'text-slate-400 dark:text-slate-500'}`} />
                            <span>{item.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </nav>
            </div>
            <div className="p-4 border-t border-slate-100 dark:border-slate-800/60">
              {role === 'SUPER_ADMIN' ? (
                <button type="button" onClick={() => void handleLogout()} disabled={loggingOut}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-xs font-bold text-amber-400 hover:bg-amber-100 disabled:opacity-50 cursor-pointer">
                  <LogOut className="w-4 h-4" />
                  <span>{loggingOut ? 'Logging out...' : 'Logout'}</span>
                </button>
              ) : <p className="text-xs text-slate-400 dark:text-slate-500 font-bold">© 2026 Zea Voice Corp.</p>}
            </div>
          </aside>
        </>
      )}

      {/* Main View Container */}
      <div className="min-h-0 flex-1 flex flex-col h-full overflow-hidden bg-slate-50/30">
        {/* Dynamic Header */}
        <header className="h-14 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between px-6 md:px-8 shrink-0 z-10 shadow-sm">
          <div className="flex items-center space-x-4 overflow-hidden">
            {/* Mobile Menu Trigger */}
            <button 
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)} 
              className="md:hidden p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg focus:outline-none shrink-0"
              id="mobile-menu-toggle"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
            
            {/* Mobile Brand Accent */}
            <div className="md:hidden flex items-center space-x-2 shrink-0">
              <img src={zeaVoiceBrand} alt="Zea Voice" className="h-12 w-36 object-contain object-left" />
            </div>

            {/* Desktop Dynamic Titles */}
            <div className="hidden md:flex flex-col overflow-hidden">
              {role !== 'SUPER_ADMIN' && (
                <div className="flex items-center">
                  <span className="text-xl font-bold text-slate-800 dark:text-white tracking-tight leading-none">
                    {getViewName(view)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Topbar Right Area */}
          <div className="flex items-center space-x-4 shrink-0">
            {/* User profile identifier */}
            <div className="flex items-center space-x-3 border-l border-slate-200 pl-4 shrink-0">
              {role === 'SUPER_ADMIN' ? (
                <>
                  <div className="hidden lg:flex flex-col text-right">
                    <span className="text-xs font-bold text-slate-800 leading-none">Zea Administrator</span>
                    <span className="text-[10px] text-slate-400 font-mono mt-1">{userEmail}</span>
                  </div>
                  <div className="w-10 h-10 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm border border-indigo-100 shadow-xs">
                    JS
                  </div>
                </>
              ) : role === 'DEVELOPER' ? (
                <>
                  <div className="hidden lg:flex flex-col text-right">
                    <span className="text-[10px] text-indigo-500 font-bold uppercase tracking-wider block">Developer Account</span>
                    <span className="text-xs font-black text-slate-800 mt-0.5 block">Lead Developer</span>
                  </div>
                  <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-slate-800 to-indigo-950 text-indigo-300 flex items-center justify-center font-black text-sm border border-slate-700 shadow-md">
                    D
                  </div>
                </>
              ) : (
                <>
                  <div className="hidden lg:flex flex-col text-right">
                    <span className="text-[10px] text-purple-500 font-bold uppercase tracking-wider block">User Account (Restricted)</span>
                    <span className="text-xs font-black text-slate-800 mt-0.5 block">url factory's Org</span>
                  </div>
                  <div className="w-10 h-10 rounded-full bg-[#7C3AED] text-white flex items-center justify-center font-black text-sm border border-[#DDD6FE] shadow-sm">
                    U
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Content Area */}
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-[#F8FAFC] px-6 pt-6 pb-4 md:px-10 md:pt-8 md:pb-6">
          <div className="mx-auto w-full max-w-7xl flex-1 space-y-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
