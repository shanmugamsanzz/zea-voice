import { useEffect, useMemo, useState } from 'react';
import { BrowserAgentTestPanel } from '../components/agent/BrowserAgentTestPanel';
import type { BrowserTestSessionContract } from '../lib/browserAgentMedia';

// Keep this aligned with the authenticated API client. In production the
// frontend proxies this to /api; a shared visitor has no session to refresh.
const apiBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:1112').replace(/\/$/u, '');

async function publicRequest<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error?.message || 'This shared test link is unavailable.');
  return body.data as T;
}

export function PublicBrowserAgentTestView({ shareToken }: { shareToken: string }) {
  const [details, setDetails] = useState<{ agent: { id: string; name: string; status: string; agentUsage?: 'inbound' | 'outbound' | 'both' }; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void publicRequest<{ agent: { id: string; name: string; status: string; agentUsage?: 'inbound' | 'outbound' | 'both' }; expiresAt: string }>(
      `/public/browser-test-links/${encodeURIComponent(shareToken)}`,
    ).then(setDetails).catch((reason) => setError(reason instanceof Error ? reason.message : 'This shared test link is unavailable.'));
  }, [shareToken]);
  const sessionClient = useMemo(() => ({
    create: (agent: { agentUsage?: 'inbound' | 'outbound' | 'both' }) => publicRequest<BrowserTestSessionContract>(
      `/public/browser-test-links/${encodeURIComponent(shareToken)}/sessions`, {
        method: 'POST', body: JSON.stringify({ direction: agent.agentUsage === 'outbound' ? 'outbound' : 'inbound' }),
      },
    ),
    end: (_agent: unknown, testCallId: string) => publicRequest<void>(
      `/public/browser-test-links/${encodeURIComponent(shareToken)}/sessions/${encodeURIComponent(testCallId)}`,
      { method: 'DELETE' },
    ).then(() => undefined),
  }), [shareToken]);
  if (error) return <div className="flex min-h-dvh items-center justify-center bg-slate-950 p-6 text-center"><div className="max-w-md rounded-3xl border border-red-500/30 bg-slate-900 p-8 text-red-100"><h1 className="text-lg font-black">Shared test unavailable</h1><p className="mt-3 text-sm text-slate-400">{error}</p></div></div>;
  if (!details) return <div className="flex min-h-dvh items-center justify-center bg-slate-950 text-sm font-bold text-slate-400">Loading shared browser test…</div>;
  return <BrowserAgentTestPanel agent={details.agent} sessionClient={sessionClient} allowSharing={false} onClose={() => window.close()} />;
}
