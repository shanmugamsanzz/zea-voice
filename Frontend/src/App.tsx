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
import { apiRequest, logout, setAccessToken } from './lib/api';
import { startTabMeasurement } from './lib/performance';
import { useResizableTables } from './lib/useResizableTables';
import { useKpiCardDecorations } from './lib/useKpiCardDecorations';
import { useSurfaceDecorations } from './lib/useSurfaceDecorations';
import zeaVoiceBrand from './zea-voice-brand.png';

function CoreApp() {
  useResizableTables();
  useKpiCardDecorations();
  useSurfaceDecorations();
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

  if (authState === 'checking') {
    return <div className="flex min-h-dvh items-center justify-center bg-slate-50"><div className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white px-8 py-6 text-xs font-bold text-slate-600 shadow-sm"><img src={zeaVoiceBrand} alt="Zea Voice" className="h-20 w-52 object-contain" /><span className="flex items-center gap-3"><span className="h-4 w-4 animate-spin rounded-full border-2 border-amber-200 border-t-amber-500" />Restoring your session...</span></div></div>;
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
