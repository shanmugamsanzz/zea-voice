/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useAppState } from '../store/AppState';
import { ShieldAlert, Key, Mail, ShieldCheck } from 'lucide-react';
import { login } from '../lib/api';
import zeaVoiceBrand from '../zea-voice-brand.png';
import loginBackgroundVideo from '../../video2.mp4';

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
    <div className="zea-login min-h-screen overflow-hidden font-sans">
      <video className="zea-login-video" autoPlay muted loop playsInline preload="auto" aria-hidden="true"
        onCanPlay={(event) => { void event.currentTarget.play().catch(() => undefined); }}>
        <source src={loginBackgroundVideo} type="video/mp4" />
      </video>
      <main className="relative z-10 flex min-h-screen items-center justify-center p-4 sm:p-6 lg:p-8">
        <section className="zea-login-frame grid min-h-[min(820px,calc(100vh-4rem))] w-full max-w-[1500px] overflow-hidden rounded-3xl md:grid-cols-[1.08fr_0.92fr]">
          <div className="hidden min-h-[420px] md:block" aria-hidden="true" />

          <div className="flex items-center justify-center px-6 py-10 sm:px-10 lg:px-16">
            <form onSubmit={handleSubmit} className="w-full max-w-[470px] space-y-7">
              <div className="text-center">
                <img src={zeaVoiceBrand} alt="Zea Voice" className="mx-auto h-24 w-full max-w-[300px] object-contain sm:h-28" />
                <h1 className="mt-3 text-3xl font-bold tracking-[0.08em] text-amber-400 sm:text-4xl">WELCOME</h1>
                <p className="mt-2 text-xs font-medium uppercase tracking-[0.24em] text-amber-100/55">Autonomous Voice SaaS Platform</p>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-950/45 p-3 text-xs font-semibold text-red-200">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-7">
                <label className="zea-login-field flex items-center gap-4">
                  <Mail className="h-5 w-5 shrink-0 text-amber-400" />
                  <span className="sr-only">Email Address</span>
                  <input type="email" required value={emailInput} onChange={(e) => setEmailInput(e.target.value)}
                    className="min-w-0 flex-1 border-0 bg-transparent px-0 py-3 text-base font-medium text-white outline-none"
                    placeholder="Email address" />
                </label>

                <label className="zea-login-field flex items-center gap-4">
                  <Key className="h-5 w-5 shrink-0 text-amber-400" />
                  <span className="sr-only">Password</span>
                  <input type="password" required value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)}
                    className="min-w-0 flex-1 border-0 bg-transparent px-0 py-3 text-base font-medium text-white outline-none"
                    placeholder="Password" />
                </label>
              </div>

              <button type="submit" disabled={loading}
                className="zea-login-submit flex w-full items-center justify-center gap-2 rounded-full py-3.5 text-sm font-bold uppercase tracking-[0.12em] transition">
                <ShieldCheck className="h-4 w-4" />
                <span>{loading ? 'Connecting…' : 'Login'}</span>
              </button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
