import React, { useEffect, useRef, useState } from 'react';

export interface CampaignDeletePreview {
  id: string; name: string; status: string; totalTasks: number; remainingTasks: number;
}
export function CampaignDeleteDialog({ name, preview, error, deleting, onCancel, onConfirm }: {
  name: string; preview: CampaignDeletePreview | null; error: string; deleting: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const allowed = !!preview && preview.status !== 'running' && confirmation === 'DELETE' && !deleting && !error;
  return <dialog ref={dialog} aria-labelledby="delete-campaign-title"
    onCancel={event => { event.preventDefault(); if (!deleting) onCancel(); }}
    className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-2xl backdrop:bg-slate-900/50">
    <form onSubmit={event => { event.preventDefault(); if (allowed) onConfirm(); }} className="space-y-4">
      <h2 id="delete-campaign-title" className="text-xl font-bold">Permanently delete campaign?</h2>
      <p className="break-words text-sm font-semibold">{name}</p>
      {preview ? <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <p><strong>{preview.totalTasks.toLocaleString()} total lead tasks</strong>, including <strong>{preview.remainingTasks.toLocaleString()} remaining waiting tasks</strong>, will be permanently deleted along with this campaign.</p>
        <p className="mt-2">Imports and task attempts will also be deleted. This cannot be undone.</p>
      </div> : <p className="text-sm text-slate-500">Loading task counts...</p>}
      <p className="text-xs text-slate-500">Historical call reports, transcripts, recordings and billing are retained. Pause the campaign and wait for active calls to finish first.</p>
      {preview?.status === 'running' && <p className="text-sm text-red-700">Pause this campaign before deleting it.</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <label className="block text-sm font-semibold">Type DELETE to confirm
        <input autoFocus aria-label="Type DELETE to confirm" autoComplete="off" value={confirmation}
          disabled={deleting} onChange={event => setConfirmation(event.target.value)}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono" />
      </label>
      <div className="flex justify-end gap-3">
        <button type="button" disabled={deleting} onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold">Cancel</button>
        <button type="submit" disabled={!allowed} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{deleting ? 'Deleting...' : 'Delete permanently'}</button>
      </div>
    </form>
  </dialog>;
}
