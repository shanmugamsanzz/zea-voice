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

function CoreApp() {
  const { role } = useAppState();
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // If not logged in, prompt role choosing and credential submission
  if (!isLoggedIn) {
    return <LoginView onLogin={() => setIsLoggedIn(true)} />;
  }

  // Once logged in, render the main dashboard layout frame
  return (
    <DashboardLayout>
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
