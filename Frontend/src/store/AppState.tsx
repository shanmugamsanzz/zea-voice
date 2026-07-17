/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, ReactNode } from 'react';
import { UserRole } from '../types';

interface AppState {
  role: UserRole;
  view: string;
  selectedCompanyId: string | null;
  selectedAgentId: string | null;
  selectedCampaignId: string | null;
  selectedCallId: string | null;
  userEmail: string;
  theme: 'light' | 'dark';
  setRole: (role: UserRole) => void;
  setView: (view: string) => void;
  setSelectedCompanyId: (id: string | null) => void;
  setSelectedAgentId: (id: string | null) => void;
  setSelectedCampaignId: (id: string | null) => void;
  setSelectedCallId: (id: string | null) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setUserEmail: (email: string) => void;
  resetNavigation: () => void;
}

const AppStateContext = createContext<AppState | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<UserRole>('DEVELOPER'); // Default to DEVELOPER
  const stored = (key: string) => typeof window === 'undefined' ? null : sessionStorage.getItem(key);
  const [view, setViewState] = useState<string>(() => stored('zea_voice_view') || 'dashboard');
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(() => stored('zea_voice_company_id'));
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => stored('zea_voice_agent_id'));
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(() => stored('zea_voice_campaign_id'));
  const [selectedCallId, setSelectedCallId] = useState<string | null>(() => stored('zea_voice_call_id'));
  const [userEmail, setUserEmail] = useState('');
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      if (saved === 'dark' || saved === 'light') return saved;
    }
    return 'light';
  });

  React.useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  React.useEffect(() => { sessionStorage.setItem('zea_voice_view', view); }, [view]);
  React.useEffect(() => {
    if (selectedCompanyId) sessionStorage.setItem('zea_voice_company_id', selectedCompanyId);
    else sessionStorage.removeItem('zea_voice_company_id');
  }, [selectedCompanyId]);
  React.useEffect(() => {
    if (selectedAgentId) sessionStorage.setItem('zea_voice_agent_id', selectedAgentId);
    else sessionStorage.removeItem('zea_voice_agent_id');
  }, [selectedAgentId]);
  React.useEffect(() => {
    if (selectedCampaignId) sessionStorage.setItem('zea_voice_campaign_id', selectedCampaignId);
    else sessionStorage.removeItem('zea_voice_campaign_id');
  }, [selectedCampaignId]);
  React.useEffect(() => {
    if (selectedCallId) sessionStorage.setItem('zea_voice_call_id', selectedCallId);
    else sessionStorage.removeItem('zea_voice_call_id');
  }, [selectedCallId]);

  const setTheme = (newTheme: 'light' | 'dark') => {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  const setRole = (newRole: UserRole) => {
    setRoleState(newRole);
  };

  const setView = (newView: string) => {
    setViewState(newView);
    // Reset secondary states if switching top-level views
    if (newView !== 'companies' && !newView.startsWith('companies/')) setSelectedCompanyId(null);
    if (newView !== 'agents' && !newView.startsWith('agents/')) setSelectedAgentId(null);
    if (newView !== 'campaigns' && !newView.startsWith('campaigns/')) setSelectedCampaignId(null);
  };

  const resetNavigation = () => {
    setViewState('dashboard');
    setSelectedCompanyId(null);
    setSelectedAgentId(null);
    setSelectedCampaignId(null);
    setSelectedCallId(null);
  };

  return (
    <AppStateContext.Provider value={{
      role,
      view,
      selectedCompanyId,
      selectedAgentId,
      selectedCampaignId,
      selectedCallId,
      userEmail,
      theme,
      setRole,
      setView,
      setSelectedCompanyId,
      setSelectedAgentId,
      setSelectedCampaignId,
      setSelectedCallId,
      setTheme,
      setUserEmail,
      resetNavigation,
    }}>
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error('useAppState must be used within an AppStateProvider');
  }
  return context;
}
