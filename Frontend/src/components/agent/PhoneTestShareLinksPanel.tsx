import { useEffect, useState } from 'react';
import { apiRequest, isAbortError } from '../../lib/api';

interface ShareLink { id: string; token?: string; expiresAt: string | null; permanent: boolean; revokedAt: string | null; createdAt: string; }
export function PhoneTestShareLinksPanel({ agentId }: { agentId: string }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [expiry, setExpiry] = useState<'24h' | 'permanent'>('24h');
  const [url, setUrl] = useState('');
  const [createdId, setCreatedId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<ShareLink[]>(`/agents/${agentId}/phone-test-share-links`, { signal: controller.signal, zeaCache: 'bypass' })
      .then(setLinks).catch(failure => { if (!isAbortError(failure)) setError(failure instanceof Error ? failure.message : 'Links could not be loaded.'); });
    return () => controller.abort();
  }, [agentId, refresh]);
  const create = async () => {
    if (busy) return; setBusy(true); setError('');
    try {
      const link = await apiRequest<ShareLink>(`/agents/${agentId}/phone-test-share-links`, { method: 'POST', body: JSON.stringify({ expiresIn: expiry }) });
      if (!link.token) throw new Error('The link token was not returned.');
      const shared = new URL('/shared/phone-call', window.location.origin);
      shared.hash = new URLSearchParams({ token: link.token }).toString();
      setUrl(shared.toString()); setCreatedId(link.id); setRefresh(value => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Link could not be created.'); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    if (busy || !window.confirm('Revoke this link and cancel its waiting call requests?')) return;
    setBusy(true); setError('');
    try {
      await apiRequest(`/agents/${agentId}/phone-test-share-links/${id}`, { method: 'DELETE' });
      if (id === createdId) { setUrl(''); setCreatedId(''); }
      setRefresh(value => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Link could not be revoked.'); }
    finally { setBusy(false); }
  };
  return <section className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-700">
    <h4 className="text-sm font-bold">Share the calling tab</h4>
    <p className="mt-1 text-xs text-slate-500">Anyone with the link can request calls using company credits. Share it with people you trust.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <select aria-label="Share link expiry" value={expiry} onChange={event => setExpiry(event.target.value as '24h' | 'permanent')} disabled={busy}
        className="rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm"><option value="24h">24 hours</option><option value="permanent">Permanent</option></select>
      <button type="button" onClick={() => void create()} disabled={busy} className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Create link</button>
    </div>
    {url && <div className="mt-3"><input aria-label="New share link" readOnly value={url} onFocus={event => event.target.select()} className="w-full rounded-lg border border-slate-300 bg-transparent p-2 text-xs" />
      <button type="button" className="mt-2 text-xs font-bold text-amber-600" onClick={async () => {
        try { await navigator.clipboard.writeText(url); } catch { setError('Copy the link from the field above.'); }
      }}>Copy link</button><p className="mt-1 text-xs text-slate-500">Copy now. The secret link is shown only when created.</p></div>}
    {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
    <ul className="mt-3 max-h-36 space-y-2 overflow-y-auto text-xs">{links.map(link => {
      const expired = link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now();
      return <li key={link.id} className="flex items-center justify-between gap-2">
        <span>{link.revokedAt ? 'Revoked' : expired ? 'Expired' : link.permanent ? 'Permanent' : `Expires ${new Date(link.expiresAt!).toLocaleString()}`}<span className="mt-1 block text-slate-500">Created {new Date(link.createdAt).toLocaleString()}</span></span>
        {!link.revokedAt && <button type="button" disabled={busy} onClick={() => void revoke(link.id)} className="font-bold text-red-500 disabled:opacity-50">Revoke</button>}
      </li>;
    })}</ul>
  </section>;
}
