import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Database, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

type ColumnType = 'text' | 'number' | 'date' | 'boolean';
type LiveDataColumn = { id: string; name: string; key: string; dataType: ColumnType; position: number };
type LiveDataRow = { id: string; values: Record<string, string | number | boolean | null> };
type LiveDataTable = {
  id: string; name: string; columns: LiveDataColumn[]; rows: LiveDataRow[];
  sync?: { status: 'pending' | 'syncing' | 'synced' | 'failed'; error?: string | null; syncedAt?: string | null };
};
type LiveDataHistory = { id: string; action: string; createdAt: string };

function valueForInput(value: unknown) { return value === null || value === undefined ? '' : String(value); }

function normalizeValue(value: string, type: ColumnType) {
  if (type === 'number') return value === '' ? null : Number(value);
  if (type === 'boolean') return value === 'true';
  return value;
}

export function AgentLiveDataPanel({ agentId }: { agentId: string }) {
  const [tables, setTables] = useState<LiveDataTable[]>([]);
  const [history, setHistory] = useState<LiveDataHistory[]>([]);
  const [selectedTableId, setSelectedTableId] = useState('');
  const [newTableName, setNewTableName] = useState('');
  const [newColumnName, setNewColumnName] = useState('');
  const [newColumnType, setNewColumnType] = useState<ColumnType>('text');
  const [search, setSearch] = useState('');
  const [filterColumn, setFilterColumn] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortAscending, setSortAscending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selected = tables.find((table) => table.id === selectedTableId) ?? null;
  const applyTable = (table: LiveDataTable) => {
    setTables((current) => current.map((item) => item.id === table.id ? table : item));
  };
  const load = async () => {
    setLoading(true); setError('');
    try {
      const values = await apiRequest<LiveDataTable[]>(`/agents/${agentId}/live-data/tables`, { zeaCache: 'reload' });
      setTables(values);
      setSelectedTableId((current) => values.some((table) => table.id === current) ? current : (values[0]?.id ?? ''));
    } catch (requestError) {
      if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Live Data could not be loaded.');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [agentId]);
  useEffect(() => {
    if (!selectedTableId) { setHistory([]); return; }
    void apiRequest<LiveDataHistory[]>(`/agents/${agentId}/live-data/tables/${selectedTableId}/history`, { zeaCache: 'reload' })
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [agentId, selectedTableId]);

  const request = async <T,>(path: string, init: RequestInit, successMessage: string, onSuccess: (data: T) => void) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await apiRequest<T>(path, init);
      onSuccess(data); setNotice(successMessage);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Live Data could not be saved.');
    } finally { setBusy(false); }
  };

  const addTable = async () => {
    const name = newTableName.trim();
    if (!name) return;
    await request<LiveDataTable>(`/agents/${agentId}/live-data/tables`, {
      method: 'POST', body: JSON.stringify({ name }),
    }, 'Live Data table created.', (table) => {
      setTables((current) => [...current, table]); setSelectedTableId(table.id); setNewTableName('');
    });
  };

  const updateTableName = async (name: string) => {
    if (!selected || !name.trim() || name === selected.name) return;
    await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}`, {
      method: 'PUT', body: JSON.stringify({ name: name.trim() }),
    }, 'Table renamed.', applyTable);
  };

  const deleteTable = async () => {
    if (!selected || !window.confirm(`Delete Live Data table "${selected.name}" and all its columns and rows?`)) return;
    await request<{ id: string; deleted: boolean }>(`/agents/${agentId}/live-data/tables/${selected.id}`, {
      method: 'DELETE',
    }, 'Live Data table deleted.', () => {
      setTables((current) => current.filter((table) => table.id !== selected.id)); setSelectedTableId('');
    });
  };

  const addColumn = async () => {
    if (!selected || !newColumnName.trim()) return;
    await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/columns`, {
      method: 'POST', body: JSON.stringify({ name: newColumnName.trim(), dataType: newColumnType }),
    }, 'Column added.', (table) => { applyTable(table); setNewColumnName(''); });
  };

  const saveColumn = async (column: LiveDataColumn, name: string, dataType: ColumnType) => {
    if (!selected || (!name.trim() || (name === column.name && dataType === column.dataType))) return;
    await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/columns/${column.id}`, {
      method: 'PUT', body: JSON.stringify({ name: name.trim(), dataType }),
    }, 'Column updated.', applyTable);
  };

  const deleteColumn = async (column: LiveDataColumn) => {
    if (!selected || !window.confirm(`Delete column "${column.name}" and its values from every row?`)) return;
    await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/columns/${column.id}`, {
      method: 'DELETE',
    }, 'Column deleted.', applyTable);
  };

  const addRow = async () => {
    if (!selected) return;
    await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/rows`, {
      method: 'POST', body: JSON.stringify({ values: {} }),
    }, 'Row added.', applyTable);
  };

  const saveRow = async (row: LiveDataRow, values: LiveDataRow['values']) => {
    if (!selected) return;
    await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/rows/${row.id}`, {
      method: 'PUT', body: JSON.stringify({ values }),
    }, 'Row saved.', applyTable);
  };

  const deleteRow = async (row: LiveDataRow) => {
    if (!selected || !window.confirm('Delete this Live Data row?')) return;
    await request<{ id: string; deleted: boolean }>(`/agents/${agentId}/live-data/tables/${selected.id}/rows/${row.id}`, {
      method: 'DELETE',
    }, 'Row deleted.', () => applyTable({ ...selected, rows: selected.rows.filter((item) => item.id !== row.id) }));
  };

  const visibleRows = useMemo(() => {
    if (!selected) return [];
    const needle = search.trim().toLocaleLowerCase();
    const columns = filterColumn && selected.columns.some((column) => column.key === filterColumn)
      ? selected.columns.filter((column) => column.key === filterColumn)
      : selected.columns;
    const rows = needle ? selected.rows.filter((row) => columns.some((column) => (
      valueForInput(row.values[column.key]).toLocaleLowerCase().includes(needle)
    ))) : [...selected.rows];
    if (!sortKey) return rows;
    return rows.sort((left, right) => valueForInput(left.values[sortKey]).localeCompare(valueForInput(right.values[sortKey]), undefined, { numeric: true }) * (sortAscending ? 1 : -1));
  }, [selected, search, filterColumn, sortKey, sortAscending]);

  return <div className="space-y-5">
    <div className="flex flex-col gap-3 rounded-xl border border-violet-100 bg-violet-50/60 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><h3 className="flex items-center gap-2 text-sm font-black text-slate-800"><Database className="h-4 w-4 text-violet-600" />Live Data</h3><p className="mt-1 text-xs font-medium text-slate-500">Manage the current rows and columns for this agent. Knowledge documents and voice retrieval are unchanged.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading || busy} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
    </div>
    {error && <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}
    {notice && <div className="flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</div>}

    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row">
      <input value={newTableName} onChange={(event) => setNewTableName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addTable(); }} placeholder="New table name" maxLength={160} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-800 outline-none focus:border-violet-400" />
      <button type="button" disabled={busy || !newTableName.trim()} onClick={() => void addTable()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-xs font-black text-white hover:bg-violet-700 disabled:opacity-50"><Plus className="h-4 w-4" />Create table</button>
    </div>

    {loading ? <div className="h-36 animate-pulse rounded-xl bg-slate-100" /> : !tables.length ? <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-xs font-semibold text-slate-500">Create a table for this agent to manage current business data.</div> : <>
      <div className="flex flex-wrap gap-2">{tables.map((table) => <button key={table.id} type="button" onClick={() => setSelectedTableId(table.id)} className={`rounded-lg border px-3 py-2 text-xs font-bold ${selectedTableId === table.id ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>{table.name}</button>)}</div>
      {selected && <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input defaultValue={selected.name} key={selected.id} onBlur={(event) => void updateTableName(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-black text-slate-800 outline-none focus:border-violet-400" aria-label="Live Data table name" />
          <span title={selected.sync?.error ?? undefined} className={`inline-flex rounded-full px-3 py-1.5 text-[10px] font-black uppercase tracking-wide ${selected.sync?.status === 'synced' ? 'bg-emerald-50 text-emerald-700' : selected.sync?.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>Index: {selected.sync?.status ?? 'pending'}</span>
          <button type="button" disabled={busy} onClick={() => void deleteTable()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />Delete table</button>
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3 sm:flex-row">
          <input value={newColumnName} onChange={(event) => setNewColumnName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addColumn(); }} placeholder="New column name" maxLength={160} className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold" />
          <select value={newColumnType} onChange={(event) => setNewColumnType(event.target.value as ColumnType)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / No</option></select>
          <button type="button" disabled={busy || !newColumnName.trim()} onClick={() => void addColumn()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"><Plus className="h-3.5 w-3.5" />Add column</button>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex max-w-xl flex-1 gap-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search rows" className="w-full rounded-lg border border-slate-200 py-2 pl-8 pr-3 text-xs font-semibold" /></div><select value={filterColumn} onChange={(event) => setFilterColumn(event.target.value)} className="max-w-40 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-600" aria-label="Filter rows by column"><option value="">All columns</option>{selected.columns.map((column) => <option key={column.id} value={column.key}>{column.name}</option>)}</select></div><button type="button" disabled={busy || !selected.columns.length} onClick={() => void addRow()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"><Plus className="h-3.5 w-3.5" />Add row</button></div>
        {!selected.columns.length ? <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-xs font-semibold text-slate-500">Add columns before creating rows.</p> : <div className="overflow-x-auto"><table className="min-w-full text-left text-xs"><thead><tr className="border-b border-slate-200">{selected.columns.map((column) => <th key={column.id} className="min-w-44 p-2 align-top"><div className="flex gap-1"><input defaultValue={column.name} key={`${column.id}-${column.name}`} onBlur={(event) => void saveColumn(column, event.target.value, column.dataType)} className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 font-black text-slate-700" /><button type="button" onClick={() => void deleteColumn(column)} className="rounded border border-red-100 p-1 text-red-600 hover:bg-red-50"><Trash2 className="h-3 w-3" /></button></div><button type="button" onClick={() => { setSortKey(column.key); setSortAscending(sortKey === column.key ? !sortAscending : true); }} className="mt-1 text-[9px] font-bold uppercase text-slate-400 hover:text-violet-600">{column.dataType} · sort</button></th>)}<th className="p-2" /></tr></thead><tbody>{visibleRows.map((row) => <LiveDataRowEditor key={row.id} row={row} columns={selected.columns} busy={busy} onSave={(values) => void saveRow(row, values)} onDelete={() => void deleteRow(row)} />)}</tbody></table>{!visibleRows.length && <p className="p-6 text-center text-xs font-semibold text-slate-400">No rows match this search.</p>}</div>}
      </div>}
    </>}
  </div>;
}

function LiveDataRowEditor({ row, columns, busy, onSave, onDelete }: { row: LiveDataRow; columns: LiveDataColumn[]; busy: boolean; onSave: (values: LiveDataRow['values']) => void; onDelete: () => void }) {
  const [values, setValues] = useState(row.values);
  useEffect(() => setValues(row.values), [row.id, row.values]);
  return <tr className="border-b border-slate-100 last:border-0">{columns.map((column) => <td key={column.id} className="p-2">{column.dataType === 'boolean' ? <select value={String(values[column.key] ?? '')} onChange={(event) => setValues((current) => ({ ...current, [column.key]: normalizeValue(event.target.value, column.dataType) }))} className="w-full rounded border border-slate-200 px-2 py-1.5"><option value="">—</option><option value="true">Yes</option><option value="false">No</option></select> : <input type={column.dataType === 'number' ? 'number' : column.dataType === 'date' ? 'date' : 'text'} value={valueForInput(values[column.key])} onChange={(event) => setValues((current) => ({ ...current, [column.key]: normalizeValue(event.target.value, column.dataType) }))} className="w-full rounded border border-slate-200 px-2 py-1.5 text-slate-700" />}</td>)}<td className="whitespace-nowrap p-2"><div className="flex gap-1"><button type="button" disabled={busy} onClick={() => onSave(values)} className="rounded border border-emerald-200 p-1.5 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50" title="Save row"><Save className="h-3.5 w-3.5" /></button><button type="button" disabled={busy} onClick={onDelete} className="rounded border border-red-200 p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-50" title="Delete row"><Trash2 className="h-3.5 w-3.5" /></button></div></td></tr>;
}
