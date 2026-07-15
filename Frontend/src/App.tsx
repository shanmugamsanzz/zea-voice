/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AppStateProvider, useAppState } from './store/AppState';
import { LoginView } from './views/LoginView';
import { DashboardLayout } from './components/layouts/DashboardLayouts';
import { SuperAdminViews } from './components/views/SuperAdminViews';
import { CompanyViews } from './components/views/CompanyViews';
import { logout } from './lib/api';
import { startTabMeasurement } from './lib/performance';

function CoreApp() {
  const { role } = useAppState();
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // If not logged in, prompt role choosing and credential submission
  if (!isLoggedIn) {
    return <LoginView onLogin={() => { startTabMeasurement('dashboard'); setIsLoggedIn(true); }} />;
  }

  // Once logged in, render the main dashboard layout frame
  return (
    <DashboardLayout onLogout={async () => { await logout(); setIsLoggedIn(false); }}>
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
