import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check, ChevronDown, FileAudio, Loader2, Music, Pause, Play, Plus, RefreshCw, Trash2, Upload, X,
} from 'lucide-react';
import { apiBlobRequest, apiRequest, isAbortError, uploadApiFormData } from '../../lib/api';

type AssetStatus = 'active' | 'inactive' | 'archived';
type StorageStatus = 'pending' | 'ready' | 'failed';

interface AmbienceAsset {
  id: string;
  name: string;
  description: string | null;
  status: AssetStatus;
  storageStatus: StorageStatus;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  listeningVolumePercent: number;
  speakingVolumePercent: number;
  continueDuringSilence: boolean;
}

interface AmbienceList {
  items: AmbienceAsset[];
  limits: { maximum: number; used: number; remaining: number };
}

interface AmbienceManagerProps {
  selectedAssetId: string | null;
  onSelectionChange: (assetId: string | null) => void;
  readOnly?: boolean;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

const initialForm = {
  name: '',
  description: '',
  listeningVolumePercent: 10,
  speakingVolumePercent: 5,
  continueDuringSilence: true,
};

function fileSize(bytes: number | null) {
  if (!bytes) return '';
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AmbienceManager({
  selectedAssetId,
  onSelectionChange,
  readOnly = false,
  onError,
  onSuccess,
}: AmbienceManagerProps) {
  const [assets, setAssets] = useState<AmbienceAsset[]>([]);
  const [limits, setLimits] = useState({ maximum: 20, used: 0, remaining: 20 });
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const reportError = (error: unknown, fallback: string) => {
    onError?.(error instanceof Error ? error.message : fallback);
  };

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await apiRequest<AmbienceList>(
        '/ambience-assets?page=1&pageSize=100',
        { signal, zeaCache: 'reload' },
      );
      setAssets(result.items);
      setLimits(result.limits);
    } catch (error) {
      if (!isAbortError(error)) reportError(error, 'Company ambience could not be loaded');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => () => {
    audioRef.current?.pause();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const createAndUpload = async () => {
    if (!form.name.trim() || !file || saving) return;
    setSaving(true);
    setUploadProgress(0);
    try {
      const created = await apiRequest<AmbienceAsset>('/ambience-assets', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim() || null,
          status: 'active',
          listeningVolumePercent: form.listeningVolumePercent,
          speakingVolumePercent: form.speakingVolumePercent,
          continueDuringSilence: form.continueDuringSilence,
        }),
      });
      const body = new FormData();
      body.append('file', file);
      const uploaded = await uploadApiFormData<AmbienceAsset>(
        `/ambience-assets/${created.id}/audio`,
        body,
        setUploadProgress,
      );
      await load();
      onSelectionChange(uploaded.id);
      setForm(initialForm);
      setFile(null);
      setShowCreate(false);
      onSuccess?.('Ambience audio uploaded. Save Voice to assign it to this agent.');
    } catch (error) {
      reportError(error, 'Ambience audio could not be uploaded');
      await load();
    } finally {
      setSaving(false);
      window.setTimeout(() => setUploadProgress(null), 600);
    }
  };

  const remove = async (asset: AmbienceAsset) => {
    if (deletingId || !window.confirm(`Delete "${asset.name}"? This cannot be undone.`)) return;
    setDeletingId(asset.id);
    try {
      await apiRequest(`/ambience-assets/${asset.id}`, { method: 'DELETE' });
      if (selectedAssetId === asset.id) onSelectionChange(null);
      await load();
      onSuccess?.('Ambience deleted.');
    } catch (error) {
      reportError(error, 'Ambience could not be deleted');
    } finally {
      setDeletingId(null);
    }
  };

  const preview = async (asset: AmbienceAsset) => {
    if (playingId === asset.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    setPreviewLoadingId(asset.id);
    try {
      const blob = await apiBlobRequest(`/ambience-assets/${asset.id}/audio`);
      audioRef.current?.pause();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = URL.createObjectURL(blob);
      const audio = new Audio(previewUrlRef.current);
      audioRef.current = audio;
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => {
        setPlayingId(null);
        onError?.('Ambience preview could not be played.');
      };
      await audio.play();
      setPlayingId(asset.id);
    } catch (error) {
      reportError(error, 'Ambience preview could not be loaded');
    } finally {
      setPreviewLoadingId(null);
    }
  };

  const readyAssets = assets.filter((asset) => asset.status === 'active' && asset.storageStatus === 'ready');

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-amber-500">
          <Music className="h-5 w-5" />
          <div>
            <div className="text-xs font-black uppercase tracking-wider">Background Sound</div>
            <div className="mt-0.5 text-[10px] font-medium normal-case tracking-normal text-slate-400">
              Private company audio · {limits.used}/{limits.maximum}
            </div>
          </div>
        </div>
        {!readOnly && (
          <button
            type="button"
            disabled={limits.remaining === 0 || saving}
            onClick={() => setShowCreate((value) => !value)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 px-3 py-2 text-[10px] font-bold text-amber-600 hover:bg-amber-50 disabled:opacity-50"
          >
            {showCreate ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showCreate ? 'Cancel' : 'Upload ambience'}
          </button>
        )}
      </div>

      <label className="mt-5 block text-[10px] font-bold uppercase text-slate-400">Ambience Type</label>
      <div className="relative mt-1.5">
        <select
          value={selectedAssetId ?? ''}
          disabled={readOnly || loading}
          onChange={(event) => onSelectionChange(event.target.value || null)}
          className="w-full appearance-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 pr-10 text-xs font-semibold text-slate-800 outline-none focus:border-amber-500 disabled:opacity-60"
        >
          <option value="">Silent (Default)</option>
          {readyAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-4 top-3.5 h-4 w-4 text-slate-400" />
      </div>
      <p className="mt-2 text-[10px] leading-4 text-slate-400">
        Silent stores no assignment. Audio remains isolated to this company and workspace.
      </p>

      {showCreate && !readOnly && (
        <div className="mt-4 space-y-3 rounded-xl border border-amber-100 bg-amber-50/40 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <input
              value={form.name}
              maxLength={160}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Ambience name *"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs outline-none focus:border-amber-400"
            />
            <input
              value={form.description}
              maxLength={1000}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Description (optional)"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs outline-none focus:border-amber-400"
            />
          </div>
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-amber-200 bg-white px-3 py-4 text-xs font-bold text-slate-600 hover:border-amber-400">
            <Upload className="h-4 w-4 text-amber-500" />
            {file ? file.name : 'Select WAV or MP3 (5–300 seconds, max 20 MB)'}
            <input
              type="file"
              accept=".wav,.mp3,audio/wav,audio/mpeg"
              className="hidden"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[10px] font-bold uppercase text-slate-500">
              Listening volume ({form.listeningVolumePercent}%)
              <input type="range" min={0} max={100} value={form.listeningVolumePercent}
                onChange={(event) => setForm({ ...form, listeningVolumePercent: Number(event.target.value) })}
                className="mt-2 w-full accent-amber-500" />
            </label>
            <label className="text-[10px] font-bold uppercase text-slate-500">
              Speaking volume ({form.speakingVolumePercent}%)
              <input type="range" min={0} max={100} value={form.speakingVolumePercent}
                onChange={(event) => setForm({ ...form, speakingVolumePercent: Number(event.target.value) })}
                className="mt-2 w-full accent-amber-500" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
            <input type="checkbox" checked={form.continueDuringSilence}
              onChange={(event) => setForm({ ...form, continueDuringSilence: event.target.checked })}
              className="accent-amber-500" />
            Continue ambience while both caller and agent are silent
          </label>
          {uploadProgress !== null && (
            <div>
              <div className="mb-1 flex justify-between text-[10px] font-bold text-amber-600">
                <span>{uploadProgress === 100 ? 'Upload complete' : 'Uploading audio'}</span><span>{uploadProgress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-amber-100">
                <div className="h-full bg-amber-500 transition-all" style={{ width: `${uploadProgress}%` }} />
              </div>
            </div>
          )}
          <button type="button" disabled={!form.name.trim() || !file || saving} onClick={() => void createAndUpload()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-xs font-bold text-white hover:bg-amber-600 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileAudio className="h-4 w-4" />}
            {saving ? 'Creating and uploading...' : 'Create ambience'}
          </button>
        </div>
      )}

      {assets.length > 0 && (
        <div className="mt-4 max-h-56 space-y-2 overflow-y-auto pr-1">
          {assets.map((asset) => {
            const selected = selectedAssetId === asset.id;
            return (
              <div key={asset.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${selected ? 'border-amber-300 bg-amber-50' : 'border-slate-100 bg-slate-50'}`}>
                <div className={`rounded-lg p-2 ${selected ? 'bg-amber-100 text-amber-600' : 'bg-white text-slate-400'}`}>
                  {selected ? <Check className="h-4 w-4" /> : <Music className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-bold text-slate-700">{asset.name}</div>
                  <div className="mt-0.5 text-[9px] font-medium text-slate-400">
                    {asset.storageStatus.replace('_', ' ')}{asset.originalFileName ? ` · ${asset.originalFileName}` : ''}{asset.sizeBytes ? ` · ${fileSize(asset.sizeBytes)}` : ''}
                  </div>
                </div>
                {asset.storageStatus === 'ready' && (
                  <button type="button" title="Preview" onClick={() => void preview(asset)}
                    className="rounded-lg p-2 text-slate-500 hover:bg-white hover:text-amber-600">
                    {previewLoadingId === asset.id ? <Loader2 className="h-4 w-4 animate-spin" /> : playingId === asset.id ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                )}
                {!readOnly && (
                  <button type="button" title="Delete" disabled={deletingId === asset.id} onClick={() => void remove(asset)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-50">
                    {deletingId === asset.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
