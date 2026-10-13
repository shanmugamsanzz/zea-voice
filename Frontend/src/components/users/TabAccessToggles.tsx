import { companyTabs } from '../../lib/tabAccess';

export function TabAccessToggles({ value, onChange, role }: {
  value: string[] | null; onChange: (value: string[]) => void;
  role: 'COMPANY_USER' | 'COMPANY_DEVELOPER';
}) {
  return <fieldset className="space-y-3 rounded-xl border border-slate-200 p-4">
    <legend className="px-1 text-sm font-bold text-slate-800">Tab access</legend>
    <p className="text-xs text-slate-500">Choose the sections this account can access. Existing role permissions still apply.</p>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{companyTabs.map(([id, label]) => {
      const unavailable = role === 'COMPANY_USER' && ['integrations', 'api-keys', 'settings'].includes(id);
      const enabled = !unavailable && (value === null || value.includes(id));
      return <label key={id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
        <span>{label}{unavailable && <span className="block text-[10px] text-slate-400">Developer only</span>}</span>
        <input type="checkbox" role="switch" aria-label={`${label} access`} checked={enabled} disabled={unavailable}
          onChange={event => {
            const selected = value ?? companyTabs.map(([key]) => key);
            onChange(event.target.checked ? [...new Set([...selected, id])] : selected.filter(key => key !== id));
          }} className="h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-slate-300 transition checked:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600 before:block before:h-4 before:w-4 before:translate-x-0.5 before:translate-y-0.5 before:rounded-full before:bg-white before:shadow before:transition-transform checked:before:translate-x-[18px]" />
      </label>;
    })}</div>
  </fieldset>;
}
