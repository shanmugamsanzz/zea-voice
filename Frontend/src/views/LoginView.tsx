/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useAppState } from '../store/AppState';
import { ShieldAlert, Key, Mail, ShieldCheck } from 'lucide-react';
import { login } from '../lib/api';
import zeaVoiceBrand from '../zea-voice-brand.png';

export function LoginView({ onLogin }: { onLogin: () => void }) {
  const { setRole, setUserEmail } = useAppState();
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const result = await login(emailInput.trim().toLowerCase(), passwordInput);
      const targetRole = result.user.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN'
        : result.user.role === 'COMPANY_DEVELOPER' ? 'DEVELOPER' : 'USER';
      setRole(targetRole);
      setUserEmail(result.user.email);
      onLogin();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="zea-login min-h-screen flex items-center justify-center p-4 font-sans">
      <div className="zea-login-card rounded-3xl max-w-md w-full overflow-hidden">
        {/* Banner with gradient background */}
        <div className="zea-login-banner p-8 text-center relative">
          <img src={zeaVoiceBrand} alt="Zea Voice" className="mx-auto h-28 w-full max-w-[320px] object-contain" />
          <p className="text-xs text-amber-100/70 mt-1 font-semibold uppercase tracking-widest">Autonomous Voice SaaS Platform</p>
        </div>

        {/* Form Container */}
        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
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
            disabled={loading}
            className="zea-login-submit w-full py-3 rounded-xl text-xs font-bold transition shadow-md hover:shadow-lg flex items-center justify-center space-x-1"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>{loading ? 'Connecting…' : 'Connect to Zea Voice Gateway'}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
