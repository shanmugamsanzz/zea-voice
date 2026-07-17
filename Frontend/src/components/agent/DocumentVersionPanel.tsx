import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, History, RefreshCw, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { apiRequest } from '../../lib/api';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
interface DocumentVersion {
  id: string; documentId: string; versionNumber: number; status: string; isCurrent: boolean;
  checksumSha256: string; sizeBytes: number; pageCount: number | null; chunkCount: number;
  embeddingModel: string | null; embeddingDimensions: number | null; processedAt: string | null;
  activatedAt: string | null; createdAt: string;
}

function size(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
function validPdf(file: File) {
  if (!file.name.toLowerCase().endsWith('.pdf') || (file.type && file.type !== 'application/pdf')) return 'Only PDF files are supported.';
  if (file.size <= 0) return 'The selected PDF is empty.';
  if (file.size > MAX_PDF_BYTES) return `PDF must not exceed ${size(MAX_PDF_BYTES)}.`;
  return '';
}

export function DocumentVersionPanel({ knowledgeBaseId, document, readOnly, refreshKey, onClose, onUpdated }: {
  knowledgeBaseId: string;
  document: { id: string; displayName: string; status: string };
  readOnly: boolean;
  refreshKey: number;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      setVersions(await apiRequest<DocumentVersion[]>(`/knowledge-bases/${knowledgeBaseId}/documents/${document.id}/versions`, { zeaCache: 'bypass' }));
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Version history could not be loaded'); }
    finally { setLoading(false); }
  };
  useEffect(() => { setReplacement(null); void load(); }, [knowledgeBaseId, document.id, refreshKey]);

  const chooseReplacement = (file: File | null) => {
    if (!file) return;
    const validation = validPdf(file);
    if (validation) { setError(validation); return; }
    setReplacement(file); setError('');
  };

  const uploadReplacement = async () => {
    if (!replacement || uploading || readOnly) return;
    setUploading(true); setError('');
    const form = new FormData();
    form.append('file', replacement, replacement.name);
    form.append('displayName', document.displayName);
    form.append('metadata', JSON.stringify({ replacement: true }));
    try {
      await apiRequest(`/knowledge-bases/${knowledgeBaseId}/documents/${document.id}/versions`, { method: 'POST', body: form });
      setReplacement(null); await load(); onUpdated();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Replacement PDF could not be uploaded'); }
    finally { setUploading(false); }
  };

  const activate = async (version: DocumentVersion) => {
    if (readOnly || busyVersionId || version.isCurrent) return;
    if (!window.confirm(`Activate version ${version.versionNumber} of "${document.displayName}"? The Knowledge Base must be reviewed and published again.`)) return;
    setBusyVersionId(version.id); setError('');
    try {
      await apiRequest(`/knowledge-bases/${knowledgeBaseId}/documents/${document.id}/versions/${version.id}/activate`, { method: 'POST', body: '{}' });
      await load(); onUpdated();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Document version could not be activated'); }
    finally { setBusyVersionId(null); }
  };

  const remove = async (version: DocumentVersion) => {
    if (readOnly || busyVersionId || version.isCurrent) return;
    if (!window.confirm(`Permanently delete non-current version ${version.versionNumber}? Its B2 files and Qdrant points will be removed.`)) return;
    setBusyVersionId(version.id); setError('');
    try {
      await apiRequest(`/knowledge-bases/${knowledgeBaseId}/documents/${document.id}/versions/${version.id}`, { method: 'DELETE' });
      setVersions((current) => current.filter((item) => item.id !== version.id)); onUpdated();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Document version could not be deleted'); }
    finally { setBusyVersionId(null); }
  };

  const documentBusy = ['uploading', 'queued', 'processing', 'deleting'].includes(document.status);
  return <section className="rounded-2xl border border-blue-200 bg-blue-50/30 p-4 sm:p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><span className="text-[10px] font-black uppercase tracking-wider text-blue-600">Immutable Versions</span><h4 className="mt-1 text-base font-bold text-slate-800">{document.displayName}</h4><p className="mt-1 text-[11px] font-medium text-slate-500">Replacement PDFs create new versions; previous processed versions remain available for rollback.</p></div><div className="flex gap-2"><button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button><button type="button" onClick={onClose} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50"><X className="h-4 w-4" /></button></div></div>

    {!readOnly && <div className="mt-4 rounded-xl border border-blue-200 bg-white p-4"><div className="flex items-center gap-2"><Upload className="h-4 w-4 text-blue-600" /><span className="text-xs font-bold text-slate-700">Upload replacement PDF</span></div><div className="mt-3 flex flex-col gap-2 sm:flex-row"><label className={`flex min-w-0 flex-1 cursor-pointer items-center rounded-lg border border-dashed border-slate-300 px-3 py-2 text-[10px] font-semibold text-slate-500 hover:border-blue-400 ${documentBusy ? 'pointer-events-none opacity-50' : ''}`}><span className="truncate">{replacement?.name ?? 'Select a different PDF (maximum 25 MB)'}</span><input key={`${document.id}-${replacement?.name ?? 'empty'}`} type="file" accept=".pdf,application/pdf" disabled={documentBusy || uploading} className="sr-only" onChange={(event) => chooseReplacement(event.target.files?.[0] ?? null)} /></label><button type="button" onClick={() => void uploadReplacement()} disabled={!replacement || uploading || documentBusy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[10px] font-bold text-white hover:bg-blue-700 disabled:opacity-40">{uploading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}{uploading ? 'Uploading...' : 'Create New Version'}</button></div>{documentBusy && <p className="mt-2 text-[9px] font-semibold text-amber-700">Wait for the current document job to finish before replacing it.</p>}</div>}
    {error && <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-[10px] font-semibold text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
    {loading && versions.length === 0 && <div className="mt-4 h-28 animate-pulse rounded-xl bg-white" />}
    {!loading && versions.length === 0 && !error && <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-xs font-semibold text-slate-400">No version history was returned.</div>}
    {versions.length > 0 && <div className="mt-4 space-y-3">{versions.map((version) => {
      const canActivate = !version.isCurrent && ['ready', 'archived'].includes(version.status) && Boolean(version.processedAt);
      return <article key={version.id} className={`rounded-xl border p-4 ${version.isCurrent ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-white'}`}><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold text-slate-800">Version {version.versionNumber}</span>{version.isCurrent && <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-[9px] font-black uppercase text-emerald-700"><CheckCircle className="h-3 w-3" />Current</span>}<span className="rounded-md bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-600">{version.status}</span></div><p className="mt-1 text-[9px] font-semibold text-slate-400">{size(version.sizeBytes)} · {version.pageCount ?? 0} pages · {version.chunkCount} chunks · {new Date(version.createdAt).toLocaleString()}</p><p className="mt-1 font-mono text-[8px] text-slate-400" title={version.checksumSha256}>SHA-256 {version.checksumSha256.slice(0, 12)}…</p></div>{!readOnly && <div className="flex flex-wrap gap-2">{canActivate && <button type="button" onClick={() => void activate(version)} disabled={Boolean(busyVersionId)} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 px-3 py-2 text-[10px] font-bold text-blue-700 hover:bg-blue-50 disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" />Activate</button>}{!version.isCurrent && <button type="button" onClick={() => void remove(version)} disabled={Boolean(busyVersionId)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-[10px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />Delete</button>}</div>}</div>{version.activatedAt && <p className="mt-2 text-[9px] font-semibold text-blue-600"><History className="mr-1 inline h-3 w-3" />Activated {new Date(version.activatedAt).toLocaleString()}</p>}</article>;
    })}</div>}
  </section>;
}
