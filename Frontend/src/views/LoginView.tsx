/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useAppState } from '../store/AppState';
import { Eye, EyeOff, ShieldAlert, Key, Mail, ShieldCheck } from 'lucide-react';
import { login } from '../lib/api';
import zeaVoiceBrand from '../zea-voice-brand.png';
import loginBackgroundVideo1 from '../../video1.mp4';
import loginBackgroundVideo2 from '../../video2.mp4';
import loginBackgroundVideo3 from '../../video3.mp4';

const LOGIN_BACKGROUND_VIDEOS = [
  loginBackgroundVideo1,
  loginBackgroundVideo2,
  loginBackgroundVideo3,
];

const loginBackgroundVideo =
  LOGIN_BACKGROUND_VIDEOS[Math.floor(Math.random() * LOGIN_BACKGROUND_VIDEOS.length)];

export function LoginView({ onLogin, notice = '' }: { onLogin: () => void; notice?: string }) {
  const { setRole, setUserEmail } = useAppState();
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
                <div className="mx-auto mb-4 max-w-[300px]">
                  <img
                    src={zeaVoiceBrand}
                    alt="Zea Voice"
                    className="mx-auto h-auto w-full max-w-[190px] object-contain"
                  />
                </div>
                <h1 className="mt-3 text-3xl font-black tracking-[0.08em] text-amber-400 sm:text-4xl">Welcome Back</h1>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-950/45 p-3 text-xs font-semibold text-red-200">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {!error && notice && (
                <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-950/45 p-3 text-xs font-semibold text-amber-100">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{notice}</span>
                </div>
              )}

              <div className="space-y-7">
                <label className="zea-login-field flex items-center gap-4">
                  <Mail className="h-5 w-5 shrink-0 text-amber-400" />
                  <span className="sr-only">Email Address</span>
                  <input type="email" required value={emailInput} onChange={(e) => setEmailInput(e.target.value)}
                    className="min-w-0 flex-1 border-0 bg-transparent px-0 py-3 text-3xl font-medium text-white outline-none"
                    placeholder="Email address" />
                </label>

                <label className="zea-login-field flex items-center gap-4">
                  <Key className="h-5 w-5 shrink-0 text-amber-400" />
                  <span className="sr-only">Password</span>
                  <input type={showPassword ? 'text' : 'password'} required value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)}
                    className="min-w-0 flex-1 border-0 bg-transparent px-0 py-3 text-2xl font-medium text-white outline-none"
                    placeholder="Password" />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-amber-400 transition-colors hover:bg-amber-400/10 hover:text-amber-300"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
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
