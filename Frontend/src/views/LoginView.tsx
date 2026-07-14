/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useAppState } from '../store/AppState';
import { UserRole } from '../types';
import { Sparkles, ShieldAlert, Key, Mail, ShieldCheck } from 'lucide-react';
import { MOCK_DEVELOPERS } from '../lib/mockData';

export function LoginView({ onLogin }: { onLogin: () => void }) {
  const { setRole, setSelectedCompanyId } = useAppState();
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailInput.trim().toLowerCase();
    const password = passwordInput.trim();

    let targetRole: UserRole = 'DEVELOPER';
    let matchedCompanyId: string | null = null;

    if (email === 'superadmin@gmail.com' && password === 'super123') {
      targetRole = 'SUPER_ADMIN';
    } else if (email === 'user@gmail.com' && password === 'user@123') {
      targetRole = 'USER';
    } else if (email === 'developer@gmail.com' && password === 'developer 123') {
      targetRole = 'DEVELOPER';
    } else {
      // Look up custom created developers
      const customDev = MOCK_DEVELOPERS.find(
        d => d.email.toLowerCase() === email && d.password === password
      );
      if (customDev) {
        targetRole = 'DEVELOPER';
        matchedCompanyId = customDev.companyId;
      }
    }

    setRole(targetRole);
    if (matchedCompanyId) {
      setSelectedCompanyId(matchedCompanyId);
    }
    onLogin();
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans text-slate-800">
      <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full border border-slate-100/50 overflow-hidden">
        {/* Banner with gradient background */}
        <div className="bg-gradient-to-tr from-violet-600 via-purple-700 to-pink-500 p-8 text-white text-center relative">
          <div className="w-12 h-12 rounded-2xl bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center mx-auto shadow-lg mb-3">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-black tracking-tight">Zea Voice</h1>
          <p className="text-xs text-violet-100/80 mt-1 font-semibold uppercase tracking-widest">Autonomous Voice SaaS Platform</p>
        </div>

        {/* Form Container */}
        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-4">
            {/* Email field */}
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Email Address</label>
              <div className="relative">
                <input
                  type="email"
                  required
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-violet-500 rounded-xl pl-10 pr-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                  placeholder="name@company.com"
                />
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              </div>
            </div>

            {/* Password field */}
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Password</label>
              <div className="relative">
                <input
                  type="password"
                  required
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-violet-500 rounded-xl pl-10 pr-4 py-2.5 text-xs font-semibold text-slate-800 transition outline-none"
                  placeholder="••••••••••••"
                />
                <Key className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              </div>
            </div>
          </div>

          {/* Connect button */}
          <button
            type="submit"
            className="w-full py-3 bg-gradient-to-r from-violet-600 to-pink-500 hover:from-violet-700 hover:to-pink-600 text-white rounded-xl text-xs font-bold transition shadow-md hover:shadow-lg flex items-center justify-center space-x-1"
          >
            <ShieldCheck className="w-4 h-4 text-violet-100" />
            <span>Connect to Zea Voice Gateway</span>
          </button>
        </form>
      </div>
    </div>
  );
}
