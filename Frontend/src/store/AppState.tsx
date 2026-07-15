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
}

const AppStateContext = createContext<AppState | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<UserRole>('DEVELOPER'); // Default to DEVELOPER
  const [view, setViewState] = useState<string>('dashboard');
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
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

  const setTheme = (newTheme: 'light' | 'dark') => {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  const setRole = (newRole: UserRole) => {
    setRoleState(newRole);
    // Automatically reset view to dashboard on role swap
    setViewState('dashboard');
    setSelectedCompanyId(null);
    setSelectedAgentId(null);
    setSelectedCampaignId(null);
    setSelectedCallId(null);
  };

  const setView = (newView: string) => {
    setViewState(newView);
    // Reset secondary states if switching top-level views
    if (!newView.startsWith('companies/')) setSelectedCompanyId(null);
    if (!newView.startsWith('agents/')) setSelectedAgentId(null);
    if (!newView.startsWith('campaigns/')) setSelectedCampaignId(null);
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
