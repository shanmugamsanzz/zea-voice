import React from 'react';

export interface CompanyQueueLimits {
  maxInboundQueueSize: number;
  maxInboundWaitSeconds: number;
  maxOutboundQueuedTasks: number;
}
export function CompanyQueueLimitFields({ limits, onChange }: {
  limits: CompanyQueueLimits; onChange: (limits: CompanyQueueLimits) => void;
}) {
  const fields: Array<{ key: keyof CompanyQueueLimits; label: string; min: number; max: number }> = [
    { key: 'maxInboundQueueSize', label: 'Inbound waiting callers', min: 1, max: 10000 },
    { key: 'maxInboundWaitSeconds', label: 'Maximum inbound wait (seconds)', min: 10, max: 3600 },
    { key: 'maxOutboundQueuedTasks', label: 'Outbound waiting tasks', min: 1, max: 100000 },
  ];
  return <fieldset className="grid gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-3">
    <legend className="px-1 text-xs font-bold text-slate-700">Company queue limits</legend>
    {fields.map(field => <label key={field.key} className="block text-xs font-bold text-slate-500">
      {field.label}<input type="number" required min={field.min} max={field.max} step={1} value={limits[field.key] || ''}
        onChange={event => onChange({ ...limits, [field.key]: Number(event.target.value) })}
        className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 outline-none focus:border-indigo-500" />
    </label>)}
    <p className="text-xs font-normal text-slate-500 sm:col-span-3">Outbound limits apply to new imports and real-time tasks. Existing calls and retries continue when a limit is reduced.</p>
  </fieldset>;
}
