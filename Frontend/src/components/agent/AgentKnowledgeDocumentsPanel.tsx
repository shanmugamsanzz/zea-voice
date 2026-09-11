import React, { ChangeEvent, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, FileText, RefreshCw, Replace, Trash2, Upload } from 'lucide-react';
import { apiRequest, isAbortError, uploadApiFormData } from '../../lib/api';

const MAXIMUM_FILE_BYTES = 25 * 1024 * 1024;
const MAXIMUM_FILES_PER_UPLOAD = 20;

interface AgentKnowledgeDocument {
  id: string;
  filename: string;
  mimeType: 'text/plain';
  byteLength: number;
  checksumSha256: string;
  uploadedAt: string;
  status: 'ready';
  chunkCount: number;
  replacedDocumentId?: string;
}

interface UploadResult {
  documents: AgentKnowledgeDocument[];
}

interface AgentKnowledgeDocumentsPanelProps {
  agentId: string;
  readOnly: boolean;
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFiles(files: File[]) {
  if (!files.length) return 'Select at least one text document.';
  if (files.length > MAXIMUM_FILES_PER_UPLOAD) {
    return `Upload no more than ${MAXIMUM_FILES_PER_UPLOAD} documents at once.`;
  }
  for (const file of files) {
    if (!file.name.toLocaleLowerCase().endsWith('.txt')) return `${file.name} must be a .txt file.`;
    if (!file.size) return `${file.name} is empty.`;
    if (file.size > MAXIMUM_FILE_BYTES) return `${file.name} exceeds the 25 MB limit.`;
  }
  return '';
}

export function AgentKnowledgeDocumentsPanel({ agentId, readOnly }: AgentKnowledgeDocumentsPanelProps) {
  const [documents, setDocuments] = useState<AgentKnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const replacementDocumentId = useRef<string | null>(null);
  const replacementInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    apiRequest<AgentKnowledgeDocument[]>(`/agents/${agentId}/knowledge-documents`, {
      signal: controller.signal,
      zeaCache: refreshKey ? 'reload' : 'bypass',
    })
      .then(setDocuments)
      .catch((requestError) => {
        if (!isAbortError(requestError)) {
          setError(requestError instanceof Error ? requestError.message : 'Documents could not be loaded.');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [agentId, refreshKey]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    const validationError = validateFiles(files);
    if (validationError) { setError(validationError); return; }
    setUploading(true);
    setUploadProgress(0);
    setError('');
    setNotice('');
    try {
      const body = new FormData();
      files.forEach((file) => body.append('files', file));
      const result = await uploadApiFormData<UploadResult>(
        `/agents/${agentId}/knowledge-documents`, body, setUploadProgress,
      );
      setDocuments((current) => [...result.documents, ...current]);
      setNotice(`${result.documents.length} document${result.documents.length === 1 ? '' : 's'} uploaded and indexed.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Documents could not be uploaded.');
    } finally {
      setUploading(false);
    }
  };

  const chooseReplacement = (documentId: string) => {
    replacementDocumentId.current = documentId;
    replacementInput.current?.click();
  };

  const replaceDocument = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const documentId = replacementDocumentId.current;
    replacementDocumentId.current = null;
    if (!file || !documentId) return;
    const validationError = validateFiles([file]);
    if (validationError) { setError(validationError); return; }
    setBusyDocumentId(documentId);
    setError('');
    setNotice('');
    try {
      const body = new FormData();
      body.append('file', file);
      const replacement = await apiRequest<AgentKnowledgeDocument>(
        `/agents/${agentId}/knowledge-documents/${documentId}`,
        { method: 'PUT', body },
      );
      setDocuments((current) => [replacement, ...current.filter(({ id }) => id !== documentId)]);
      setNotice(`${file.name} replaced the previous document.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Document could not be replaced.');
    } finally {
      setBusyDocumentId(null);
    }
  };

  const deleteDocument = async (document: AgentKnowledgeDocument) => {
    if (!window.confirm(`Delete ${document.filename} and all of its Qdrant chunks?`)) return;
    setBusyDocumentId(document.id);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/agents/${agentId}/knowledge-documents/${document.id}`, { method: 'DELETE' });
      setDocuments((current) => current.filter(({ id }) => id !== document.id));
      setNotice(`${document.filename} was deleted.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Document could not be deleted.');
    } finally {
      setBusyDocumentId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">Knowledge documents</h3>
          <p className="mt-1 text-xs font-medium text-slate-400">Upload one or more UTF-8 text files. Chunks, vectors and metadata are stored directly in Qdrant.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {!readOnly && <label className={`inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white hover:bg-violet-700 ${uploading ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}>
            <Upload className="h-3.5 w-3.5" /> {uploading ? `Uploading ${uploadProgress}%` : 'Upload documents'}
            <input type="file" multiple accept=".txt,text/plain" className="hidden" disabled={uploading} onChange={(event) => void upload(event)} />
          </label>}
        </div>
      </div>

      <input ref={replacementInput} type="file" accept=".txt,text/plain" className="hidden" onChange={(event) => void replaceDocument(event)} />

      {uploading && <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-600 transition-all" style={{ width: `${uploadProgress}%` }} /></div>}
      {error && <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-semibold text-red-700"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}
      {notice && <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold text-emerald-700"><CheckCircle className="h-4 w-4 shrink-0" />{notice}</div>}

      {loading && !documents.length && <div className="space-y-3">{[1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl bg-slate-100" />)}</div>}
      {!loading && !documents.length && <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center"><FileText className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 text-sm font-bold text-slate-600">No knowledge documents uploaded.</p><p className="mt-1 text-xs font-medium text-slate-400">Add ordinary .txt files; no catalog hierarchy or special headings are required.</p></div>}

      <div className="space-y-3">
        {documents.map((document) => <article key={document.id} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-lg bg-violet-50 p-2 text-violet-600"><FileText className="h-5 w-5" /></div>
            <div className="min-w-0"><p className="truncate text-sm font-bold text-slate-800" title={document.filename}>{document.filename}</p><p className="mt-1 text-[11px] font-semibold text-slate-400">{fileSize(document.byteLength)} · {document.chunkCount} chunks · {new Date(document.uploadedAt).toLocaleString()}</p><p className="mt-1 truncate font-mono text-[9px] text-slate-300" title={document.checksumSha256}>SHA-256 {document.checksumSha256}</p></div>
          </div>
          {!readOnly && <div className="flex shrink-0 gap-2">
            <button type="button" disabled={Boolean(busyDocumentId)} onClick={() => chooseReplacement(document.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"><Replace className="h-3.5 w-3.5" /> Replace</button>
            <button type="button" disabled={Boolean(busyDocumentId)} onClick={() => void deleteDocument(document)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50">{busyDocumentId === document.id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete</button>
          </div>}
        </article>)}
      </div>
    </div>
  );
}
