/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { AppStateProvider, useAppState } from './store/AppState';
import { LoginView } from './views/LoginView';
import { DashboardLayout } from './components/layouts/DashboardLayouts';
import { SuperAdminViews } from './components/views/SuperAdminViews';
import { CompanyViews } from './components/views/CompanyViews';
import { apiRequest, logout, SESSION_EXPIRED_EVENT, setAccessToken } from './lib/api';
import { startTabMeasurement } from './lib/performance';

function CoreApp() {
  const { role, setRole, setUserEmail, resetNavigation } = useAppState();
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'anonymous'>('checking');

  useEffect(() => {
    let active = true;
    apiRequest<{ user: { email?: string; role: string } }>('/auth/me', { zeaCache: 'bypass' })
      .then(({ user }) => {
        if (!active) return;
        setRole(user.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : user.role === 'COMPANY_DEVELOPER' ? 'DEVELOPER' : 'USER');
        setUserEmail(user.email ?? '');
        setAuthState('authenticated');
      })
      .catch(() => {
        if (!active) return;
        setAccessToken(null, true);
        resetNavigation();
        setAuthState('anonymous');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleSessionExpired = () => {
      resetNavigation();
      setAuthState('anonymous');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [resetNavigation]);

  if (authState === 'checking') {
    return <div className="flex min-h-dvh items-center justify-center bg-slate-50"><div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-xs font-bold text-slate-600 shadow-sm"><span className="h-4 w-4 animate-spin rounded-full border-2 border-violet-200 border-t-violet-600" />Restoring your Zea Voice session...</div></div>;
  }

  if (authState === 'anonymous') {
    return <LoginView onLogin={() => { startTabMeasurement('dashboard'); setAuthState('authenticated'); }} />;
  }

  // Once logged in, render the main dashboard layout frame
  return (
    <DashboardLayout onLogout={async () => { await logout(); resetNavigation(); setAuthState('anonymous'); }}>
      {role === 'SUPER_ADMIN' ? (
        <SuperAdminViews />
      ) : (
        <CompanyViews />
      )}
    </DashboardLayout>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <CoreApp />
    </AppStateProvider>
  );
}
