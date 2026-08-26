import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, AudioLines, Clock3, LoaderCircle, Mic, MicOff, PhoneOff,
  Play, Radio, Wrench, X,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import {
  BrowserAgentMediaClient, BrowserAgentMediaState, BrowserTestSessionContract,
} from '../../lib/browserAgentMedia';

type TranscriptLine = {
  sequenceNumber: number; speaker: 'agent' | 'user'; text: string; offsetMs: number;
};
type Latency = {
  epoch: number; retrievalMs?: number | null; llmMs?: number | null;
  totalFirstAudioMs?: number | null; firstAudioStatus?: string | null;
};
type Warning = { id: string; message: string; tone: 'warning' | 'error' };

interface BrowserAgentTestPanelProps {
  agent: { id: string; name: string; status: string; agentUsage?: 'inbound' | 'outbound' | 'both' };
  onClose: () => void;
}

function elapsed(offsetMs: number) {
  const seconds = Math.max(0, Math.floor(offsetMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function milliseconds(value?: number | null) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))} ms` : '—';
}

export function BrowserAgentTestPanel({ agent, onClose }: BrowserAgentTestPanelProps) {
  const mediaRef = useRef<BrowserAgentMediaClient | null>(null);
  const sessionRef = useRef<BrowserTestSessionContract | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<BrowserAgentMediaState>('idle');
  const [runtimeState, setRuntimeState] = useState('not_started');
  const [session, setSession] = useState<BrowserTestSessionContract | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [latencies, setLatencies] = useState<Latency[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [muted, setMuted] = useState(false);
  const [agentAudioMs, setAgentAudioMs] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [ending, setEnding] = useState(false);
  const [localRecordingUrl, setLocalRecordingUrl] = useState('');

  const active = ['requesting_microphone', 'connecting', 'connected'].includes(state);
  const latestLatency = latencies.at(-1);

  const addWarning = (message: string, tone: Warning['tone'] = 'warning') => {
    setWarnings((current) => [...current, { id: crypto.randomUUID(), message, tone }].slice(-20));
  };

  useEffect(() => {
    if (!startedAt || !active) return undefined;
    const timer = window.setInterval(() => setDurationSeconds(
      Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    ), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  useEffect(() => () => {
    const current = mediaRef.current;
    if (current && ['requesting_microphone', 'connecting', 'connected'].includes(current.state)) {
      void current.disconnect();
    }
    if (localRecordingUrl) URL.revokeObjectURL(localRecordingUrl);
  }, [localRecordingUrl]);

  const bindMedia = (media: BrowserAgentMediaClient) => {
    media.addEventListener('state', ((event: CustomEvent<{ state: BrowserAgentMediaState; reason?: string }>) => {
      setState(event.detail.state);
      if (event.detail.state === 'failed') addWarning(event.detail.reason || 'Browser media disconnected.', 'error');
    }) as EventListener);
    media.addEventListener('audio', ((event: CustomEvent<{ durationMs: number }>) => {
      setAgentAudioMs((value) => value + Number(event.detail.durationMs || 0));
    }) as EventListener);
    media.addEventListener('recording', ((event: CustomEvent<{ blob: Blob | null }>) => {
      if (!event.detail.blob?.size) return;
      setLocalRecordingUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(event.detail.blob!);
      });
    }) as EventListener);
    media.addEventListener('diagnostic', ((event: CustomEvent<Record<string, unknown>>) => {
      const diagnostic = event.detail;
      if (diagnostic.type === 'transcript') {
        const line = diagnostic as unknown as TranscriptLine & { type: string };
        setTranscript((current) => current.some((item) => item.sequenceNumber === line.sequenceNumber)
          ? current : [...current, line]);
      } else if (diagnostic.type === 'latency') {
        setLatencies((current) => [...current, diagnostic as unknown as Latency].slice(-20));
      } else if (diagnostic.type === 'state') {
        setRuntimeState(String(diagnostic.current ?? 'unknown'));
      } else if (diagnostic.type === 'tool_result' && diagnostic.success !== true) {
        addWarning(`${String(diagnostic.name ?? 'Tool')}: ${String(diagnostic.warning ?? 'execution was not verified')}`);
      } else if (diagnostic.type === 'error' || diagnostic.type === 'recording_warning') {
        addWarning(String(diagnostic.message ?? 'Runtime error'), diagnostic.type === 'error' ? 'error' : 'warning');
      }
    }) as EventListener);
  };

  const start = async () => {
    setWarnings([]); setTranscript([]); setLatencies([]); setAgentAudioMs(0); setDurationSeconds(0);
    setRuntimeState('starting'); setMuted(false);
    if (localRecordingUrl) { URL.revokeObjectURL(localRecordingUrl); setLocalRecordingUrl(''); }
    try {
      const created = await apiRequest<BrowserTestSessionContract>(
        `/agents/${agent.id}/browser-test-sessions`, {
          method: 'POST', body: JSON.stringify({
            direction: agent.agentUsage === 'outbound' ? 'outbound' : 'inbound',
          }),
        },
      );
      sessionRef.current = created;
      setSession(created);
      const media = new BrowserAgentMediaClient();
      mediaRef.current = media;
      bindMedia(media);
      await media.connect(created);
      setStartedAt(Date.now());
    } catch (error) {
      addWarning(error instanceof Error ? error.message : 'Test Agent could not start.', 'error');
      setState('failed');
      if (sessionRef.current) {
        await apiRequest(`/agents/${agent.id}/browser-test-sessions/${sessionRef.current.testCallId}`,
          { method: 'DELETE' }).catch(() => undefined);
      }
    }
  };

  const end = async () => {
    if (ending) return;
    setEnding(true);
    setState('closed');
    setRuntimeState('ending');
    try {
      const recording = await mediaRef.current?.disconnect();
      if (recording?.size) {
        addWarning('Recording is available locally. Server recording storage requires explicit B2 upload approval.');
      }
      if (sessionRef.current) {
        await apiRequest(`/agents/${agent.id}/browser-test-sessions/${sessionRef.current.testCallId}`,
          { method: 'DELETE' });
      }
      setRuntimeState('completed');
    } catch (error) {
      addWarning(error instanceof Error ? error.message : 'Test Agent could not end cleanly.', 'error');
    } finally {
      mediaRef.current = null;
      sessionRef.current = null;
      setSession(null);
      setStartedAt(null);
      setEnding(false);
      setState('closed');
    }
  };

  const statusTone = useMemo(() => state === 'connected'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : state === 'failed' ? 'bg-red-50 text-red-700 border-red-200'
      : 'bg-slate-100 text-slate-600 border-slate-200', [state]);

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm sm:p-6">
    <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-700 bg-slate-950 shadow-2xl">
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4 sm:px-7">
        <div className="min-w-0"><div className="flex items-center gap-2"><Radio className="h-5 w-5 text-amber-400" /><h2 className="truncate text-lg font-black text-white">Test Agent</h2></div><p className="mt-1 truncate text-xs font-semibold text-slate-400">{agent.name} · same live runtime and reporting pipeline</p></div>
        <button onClick={() => { if (active) void end().then(onClose); else onClose(); }} className="rounded-xl p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><X className="h-5 w-5" /></button>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-h-[440px] flex-col border-b border-slate-800 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-5 py-3">
            <span className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase ${statusTone}`}>{state.replaceAll('_', ' ')}</span>
            <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-[10px] font-bold text-slate-300">Runtime: {runtimeState.replaceAll('_', ' ')}</span>
            {session && <span className="max-w-[240px] truncate font-mono text-[9px] text-slate-500" title={session.testCallId}>{session.testCallId}</span>}
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {!transcript.length && <div className="flex h-full min-h-64 flex-col items-center justify-center text-center"><AudioLines className="h-10 w-10 text-slate-700" /><p className="mt-3 text-sm font-bold text-slate-400">Live transcript will appear here</p><p className="mt-1 text-xs text-slate-600">Start the test and allow microphone permission.</p></div>}
            {transcript.map((line) => <div key={line.sequenceNumber} className={`flex ${line.speaker === 'agent' ? 'justify-start' : 'justify-end'}`}><div className={`max-w-[84%] rounded-2xl px-4 py-3 ${line.speaker === 'agent' ? 'rounded-tl-none bg-slate-800 text-slate-100' : 'rounded-tr-none bg-amber-400 text-slate-950'}`}><div className="mb-1 flex items-center gap-2 text-[9px] font-black uppercase opacity-60"><span>{line.speaker}</span><span>{elapsed(line.offsetMs)}</span></div><p className="text-sm font-semibold leading-relaxed">{line.text}</p></div></div>)}
            <div ref={transcriptEndRef} />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 border-t border-slate-800 p-4">
            {!active ? <button disabled={agent.status !== 'active' || ending} onClick={() => void start()} className="inline-flex items-center gap-2 rounded-xl bg-amber-400 px-5 py-3 text-xs font-black text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"><Play className="h-4 w-4 fill-current" />Start</button> : <>
              <button onClick={() => { const next = !muted; mediaRef.current?.setMuted(next); setMuted(next); }} className={`inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-black ${muted ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-slate-700 bg-slate-900 text-slate-200'}`}>{muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}{muted ? 'Unmute' : 'Mute'}</button>
              <button disabled={ending} onClick={() => void end()} className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-5 py-3 text-xs font-black text-white hover:bg-red-400 disabled:opacity-50">{ending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}End</button>
            </>}
            {localRecordingUrl && <a href={localRecordingUrl} download={`browser-test-${agent.id}.webm`} className="rounded-xl border border-slate-700 px-4 py-3 text-xs font-bold text-slate-300 hover:bg-slate-800">Download local recording</a>}
          </div>
        </section>

        <aside className="min-h-0 space-y-5 overflow-y-auto bg-slate-900/60 p-5">
          <div><h3 className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-300"><Clock3 className="h-4 w-4 text-cyan-400" />Live metrics</h3><div className="mt-3 grid grid-cols-2 gap-2">{[
            ['Duration', `${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')}`],
            ['Agent audio', `${(agentAudioMs / 1000).toFixed(1)}s`],
            ['Retrieval', milliseconds(latestLatency?.retrievalMs)],
            ['First audio', milliseconds(latestLatency?.totalFirstAudioMs)],
          ].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-[9px] font-black uppercase text-slate-600">{label}</p><p className="mt-1 font-mono text-sm font-black text-slate-200">{value}</p></div>)}</div></div>
          <div><h3 className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-300"><Wrench className="h-4 w-4 text-violet-400" />Tools and errors</h3><div className="mt-3 space-y-2">{warnings.length ? warnings.map((warning) => <div key={warning.id} className={`rounded-xl border p-3 text-xs font-semibold ${warning.tone === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'}`}><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{warning.message}</span></div></div>) : <p className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs font-semibold text-slate-600">No runtime or tool warnings.</p>}</div></div>
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-[10px] font-semibold leading-relaxed text-cyan-100/70">The session uses the selected agent’s published prompt, providers, Knowledge Bases, memory, retrieval, grounded LLM, validation, tools and TTS. It is stored as a non-billable browser test call.</div>
        </aside>
      </div>
    </div>
  </div>;
}
