import { useState } from 'react';

const dynamicValues = [
  ['contact.name', "Caller's saved name"],
  ['contact.phone', "Caller's phone number"],
  ['call.direction', 'Inbound or outbound'],
  ['call.purpose', 'Purpose of the current call'],
  ['conversation.is_returning', 'Whether the caller has a previous answered conversation'],
  ['conversation.recent_summaries', 'Recent summaries within your configured count and length limits'],
  ['conversation.latest_summary', 'Most recent included summary'],
  ['conversation.last_outcome', 'Outcome from the most recent included summary'],
  ['conversation.pending_questions', 'Pending questions from the most recent included summary'],
  ['conversation.last_call_at', 'Previous answered call date and time'],
  ['callback.reason', 'Callback or reminder purpose'],
  ['callback.status', 'Callback or reminder status'],
  ['callback.scheduled_for', 'Scheduled callback time (UTC)'],
  ['callback.requested_at', 'When the callback request was saved (UTC)'],
  ['current.datetime', 'Current date and time in the configured timezone'],
  ['current.timezone', 'Configured timezone'],
] as const;

type Direction = 'inbound' | 'outbound';
interface Props {
  usage?: string;
  inbound: string;
  outbound: string;
  readOnly: boolean;
  maximum: number | null;
  onChange: (direction: Direction, value: string) => void;
}

export function AgentPromptEditor({ usage, inbound, outbound, readOnly, maximum, onChange }: Props) {
  const [selected, setSelected] = useState<Direction>('inbound');
  const [copyStatus, setCopyStatus] = useState('');
  const direction: Direction = usage === 'inbound' || usage === 'outbound' ? usage : selected;
  const value = direction === 'inbound' ? inbound : outbound;
  const count = Array.from(value).length;

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopyStatus(`Copied ${token}`);
    } catch {
      setCopyStatus('Clipboard unavailable. Select the value and copy it manually.');
    }
  }

  return <div className="space-y-4">
    <div className="overflow-hidden rounded-xl border border-slate-200">
      <div className="flex gap-2 border-b border-slate-200 bg-slate-50 p-2" role="tablist" aria-label="Prompt direction">
        {(['inbound', 'outbound'] as const).map(option => <button key={option} type="button"
          id={`prompt-tab-${option}`} role="tab" aria-selected={direction === option}
          aria-controls="agent-prompt-panel" tabIndex={direction === option ? 0 : -1}
          disabled={!!usage && usage !== 'both' && usage !== option}
          onClick={() => setSelected(option)}
          onKeyDown={event => {
            if ((!usage || usage === 'both') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const next = event.key === 'Home' ? 'inbound' : event.key === 'End' ? 'outbound' : option === 'inbound' ? 'outbound' : 'inbound';
              setSelected(next);
              document.getElementById(`prompt-tab-${next}`)?.focus();
            }
          }}
          className={`rounded-lg px-4 py-2 text-xs font-bold capitalize disabled:opacity-40 ${direction === option ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-500 hover:bg-white'}`}>
          {option} prompt
        </button>)}
      </div>
      <div id="agent-prompt-panel" role="tabpanel" aria-labelledby={`prompt-tab-${direction}`}>
        <textarea rows={12} value={value} disabled={readOnly} aria-label={`${direction} system prompt`}
          aria-invalid={maximum !== null && count > maximum}
          onChange={event => onChange(direction, event.target.value)}
          className="block w-full resize-y bg-slate-950 p-5 font-mono text-xs text-sky-400 outline-none focus:ring-2 focus:ring-inset focus:ring-amber-500" />
      </div>
    </div>
    <p className="text-xs text-slate-500">{count.toLocaleString()} / {maximum?.toLocaleString() ?? '…'} characters. Each direction saves its own prompt.</p>
    <details className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <summary className="cursor-pointer text-xs font-bold text-slate-800">Dynamic values — copy into either prompt</summary>
      <p className="mt-3 text-xs text-slate-500">Click Copy, then paste the value where needed. Missing information stays empty or unknown. Conversation history requires the company continuity feature to be enabled.</p>
      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        {dynamicValues.map(([key, description]) => {
          const token = `{{${key}}}`;
          return <div key={key} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex items-center gap-2">
              <input readOnly value={token} aria-label={`Dynamic value ${key}`} onFocus={event => event.target.select()}
                className="min-w-0 flex-1 bg-transparent font-mono text-xs text-amber-800 outline-none focus:ring-1 focus:ring-amber-500" />
              <button type="button" onClick={() => void copy(token)} aria-label={`Copy ${token}`}
                className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold hover:bg-amber-50">Copy</button>
            </div>
            <p className="mt-1 text-xs text-slate-500">{description}</p>
          </div>;
        })}
      </div>
      <p role="status" className="mt-2 text-xs text-slate-600">{copyStatus}</p>
    </details>
  </div>;
}
