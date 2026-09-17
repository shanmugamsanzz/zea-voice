import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Database, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

type ColumnType = 'text' | 'number' | 'date' | 'boolean';
type LiveDataColumn = { id: string; name: string; key: string; dataType: ColumnType; position: number };
type LiveDataRow = { id: string; values: Record<string, string | number | boolean | null> };
type LiveDataTable = { id: string; name: string; columns: LiveDataColumn[]; rows: LiveDataRow[]; sync?: { status: 'pending' | 'syncing' | 'synced' | 'failed'; error?: string | null } };
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
  const applyTable = (table: LiveDataTable) => setTables((current) => current.map((item) => item.id === table.id ? table : item));
  const load = async () => {
    setLoading(true); setError('');
    try {
      const values = await apiRequest<LiveDataTable[]>(`/agents/${agentId}/live-data/tables`, { zeaCache: 'reload' });
      setTables(values);
      setSelectedTableId((current) => values.some((table) => table.id === current) ? current : (values[0]?.id ?? ''));
    } catch (requestError) { if (!isAbortError(requestError)) setError(requestError instanceof Error ? requestError.message : 'Live Data could not be loaded.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [agentId]);
  useEffect(() => {
    if (!selectedTableId) { setHistory([]); return; }
    void apiRequest<LiveDataHistory[]>(`/agents/${agentId}/live-data/tables/${selectedTableId}/history`, { zeaCache: 'reload' }).then(setHistory).catch(() => setHistory([]));
  }, [agentId, selectedTableId]);
  const request = async <T,>(path: string, init: RequestInit, successMessage: string, onSuccess: (data: T) => void) => {
    setBusy(true); setError(''); setNotice('');
    try { const data = await apiRequest<T>(path, init); onSuccess(data); setNotice(successMessage); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Live Data could not be saved.'); }
    finally { setBusy(false); }
  };
  const addTable = async () => { const name = newTableName.trim(); if (!name) return; await request<LiveDataTable>(`/agents/${agentId}/live-data/tables`, { method: 'POST', body: JSON.stringify({ name }) }, 'Spreadsheet created.', (table) => { setTables((current) => [...current, table]); setSelectedTableId(table.id); setNewTableName(''); }); };
  const updateTableName = async (name: string) => { if (!selected || !name.trim() || name === selected.name) return; await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) }, 'Sheet renamed.', applyTable); };
  const deleteTable = async () => { if (!selected || !window.confirm(`Delete spreadsheet "${selected.name}" and every row in it?`)) return; await request<{ id: string; deleted: boolean }>(`/agents/${agentId}/live-data/tables/${selected.id}`, { method: 'DELETE' }, 'Spreadsheet deleted.', () => { setTables((current) => current.filter((table) => table.id !== selected.id)); setSelectedTableId(''); }); };
  const addColumn = async () => { if (!selected || !newColumnName.trim()) return; await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/columns`, { method: 'POST', body: JSON.stringify({ name: newColumnName.trim(), dataType: newColumnType }) }, 'Column added.', (table) => { applyTable(table); setNewColumnName(''); }); };
  const saveColumn = async (column: LiveDataColumn, name: string, dataType: ColumnType) => { if (!selected || !name.trim() || (name === column.name && dataType === column.dataType)) return; await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/columns/${column.id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim(), dataType }) }, 'Column updated.', applyTable); };
  const deleteColumn = async (column: LiveDataColumn) => { if (!selected || !window.confirm(`Delete column "${column.name}" and its values from every row?`)) return; await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/columns/${column.id}`, { method: 'DELETE' }, 'Column deleted.', applyTable); };
  const addRow = async () => { if (!selected) return; await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/rows`, { method: 'POST', body: JSON.stringify({ values: {} }) }, 'New row added.', applyTable); };
  const saveRow = async (row: LiveDataRow, values: LiveDataRow['values']) => { if (!selected) return; await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/rows/${row.id}`, { method: 'PUT', body: JSON.stringify({ values }) }, 'Row saved.', applyTable); };
  const deleteRow = async (row: LiveDataRow) => { if (!selected || !window.confirm('Delete this row?')) return; await request<LiveDataTable>(`/agents/${agentId}/live-data/tables/${selected.id}/rows/${row.id}`, { method: 'DELETE' }, 'Row deleted.', applyTable); };
  const visibleRows = useMemo(() => {
    if (!selected) return [];
    const needle = search.trim().toLocaleLowerCase();
    const columns = filterColumn && selected.columns.some((column) => column.key === filterColumn) ? selected.columns.filter((column) => column.key === filterColumn) : selected.columns;
    const rows = needle ? selected.rows.filter((row) => columns.some((column) => valueForInput(row.values[column.key]).toLocaleLowerCase().includes(needle))) : [...selected.rows];
    return sortKey ? rows.sort((left, right) => valueForInput(left.values[sortKey]).localeCompare(valueForInput(right.values[sortKey]), undefined, { numeric: true }) * (sortAscending ? 1 : -1)) : rows;
  }, [selected, search, filterColumn, sortKey, sortAscending]);
  const syncTone = selected?.sync?.status === 'synced' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : selected?.sync?.status === 'failed' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700';
  return <div className="space-y-4">
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between"><div><h3 className="flex items-center gap-2 text-base font-black text-slate-900"><Database className="h-5 w-5 text-emerald-600" />Live Data spreadsheet</h3><p className="mt-1 text-xs font-medium text-slate-500">Edit current business data in a familiar sheet layout. Changes sync to the agent index.</p></div><button type="button" onClick={() => void load()} disabled={loading || busy} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div>
    {error && <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}{notice && <div className="flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</div>}
    <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row"><input value={newTableName} onChange={(event) => setNewTableName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addTable(); }} placeholder="New spreadsheet name" maxLength={160} className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 outline-none focus:border-emerald-500" /><button type="button" disabled={busy || !newTableName.trim()} onClick={() => void addTable()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-50"><Plus className="h-4 w-4" />New sheet</button></div>
    {loading ? <div className="h-52 animate-pulse rounded-2xl bg-slate-100" /> : !tables.length ? <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-12 text-center text-sm font-semibold text-slate-500">Create a spreadsheet, then add columns and data rows.</div> : <><div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1.5">{tables.map((table) => <button key={table.id} type="button" onClick={() => setSelectedTableId(table.id)} className={`rounded-lg px-3 py-2 text-xs font-black transition ${selectedTableId === table.id ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:bg-white/70'}`}>{table.name}</button>)}</div>{selected && <div className="overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 lg:flex-row lg:items-center"><input defaultValue={selected.name} key={selected.id} onBlur={(event) => void updateTableName(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm font-black text-slate-900 outline-none" aria-label="Spreadsheet name" /><span title={selected.sync?.error ?? undefined} className={`inline-flex w-fit rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wide ${syncTone}`}>Index {selected.sync?.status ?? 'pending'}</span><button type="button" disabled={busy} onClick={() => void deleteTable()} className="inline-flex items-center gap-1.5 text-xs font-bold text-red-600 hover:text-red-800 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />Delete sheet</button></div>
      <div className="flex flex-col gap-2 border-b border-slate-200 bg-white p-3 lg:flex-row lg:items-center"><div className="flex min-w-0 flex-1 gap-2"><input value={newColumnName} onChange={(event) => setNewColumnName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addColumn(); }} placeholder="Column name" maxLength={160} className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold outline-none focus:border-emerald-500" /><select value={newColumnType} onChange={(event) => setNewColumnType(event.target.value as ColumnType)} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs font-bold text-slate-600"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / No</option></select><button type="button" disabled={busy || !newColumnName.trim()} onClick={() => void addColumn()} className="rounded-md bg-slate-800 px-3 py-2 text-xs font-bold text-white hover:bg-slate-900 disabled:opacity-50">Add column</button></div><button type="button" disabled={busy || !selected.columns.length} onClick={() => void addRow()} className="inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-50"><Plus className="h-4 w-4" />Add row</button></div>
      <div className="flex flex-col gap-2 border-b border-slate-200 bg-slate-50 p-3 sm:flex-row"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find in sheet" className="w-full rounded-md border border-slate-300 bg-white py-2 pl-8 pr-3 text-xs font-semibold outline-none focus:border-emerald-500" /></div><select value={filterColumn} onChange={(event) => setFilterColumn(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600"><option value="">Search all columns</option>{selected.columns.map((column) => <option key={column.id} value={column.key}>{column.name}</option>)}</select><span className="self-center text-[10px] font-bold text-slate-400">{visibleRows.length} rows</span></div>
      {!selected.columns.length ? <p className="p-10 text-center text-sm font-semibold text-slate-500">Add a column to start using this sheet.</p> : <div className="max-h-[520px] overflow-auto"><table className="min-w-full border-separate border-spacing-0 text-left text-xs"><thead className="sticky top-0 z-20 bg-slate-100"><tr><th className="sticky left-0 z-30 w-12 border-b border-r border-slate-300 bg-slate-100 px-2 py-3 text-center text-[10px] font-black text-slate-400">#</th>{selected.columns.map((column) => <SpreadsheetColumnHeader key={column.id} column={column} busy={busy} sorted={sortKey === column.key} ascending={sortAscending} onSort={() => { setSortKey(column.key); setSortAscending(sortKey === column.key ? !sortAscending : true); }} onSave={(name, type) => void saveColumn(column, name, type)} onDelete={() => void deleteColumn(column)} />)}<th className="sticky right-0 z-30 w-20 border-b border-l border-slate-300 bg-slate-100 px-2 py-3" /></tr></thead><tbody>{visibleRows.map((row, index) => <SpreadsheetRow key={row.id} row={row} rowNumber={index + 1} columns={selected.columns} busy={busy} onSave={(values) => void saveRow(row, values)} onDelete={() => void deleteRow(row)} />)}</tbody></table>{!visibleRows.length && <p className="p-10 text-center text-sm font-semibold text-slate-400">No rows match your search.</p>}</div>}
      <div className="border-t border-slate-200 bg-slate-50 px-4 py-3"><p className="text-[10px] font-black uppercase tracking-wide text-slate-400">Recent history</p><p className="mt-1 text-xs text-slate-500">{history[0] ? `${history[0].action.replaceAll('_', ' ').toLowerCase()} - ${new Date(history[0].createdAt).toLocaleString()}` : 'No saved changes yet.'}</p></div>
    </div>}</>}
  </div>;
}

function SpreadsheetColumnHeader({ column, busy, sorted, ascending, onSort, onSave, onDelete }: { column: LiveDataColumn; busy: boolean; sorted: boolean; ascending: boolean; onSort: () => void; onSave: (name: string, type: ColumnType) => void; onDelete: () => void }) {
  const [name, setName] = useState(column.name); const [type, setType] = useState<ColumnType>(column.dataType);
  useEffect(() => { setName(column.name); setType(column.dataType); }, [column.id, column.name, column.dataType]);
  return <th className="min-w-52 border-b border-r border-slate-300 px-2 py-2 align-top"><div className="flex items-center gap-1"><input value={name} onChange={(event) => setName(event.target.value)} onBlur={() => onSave(name, type)} className="min-w-0 flex-1 bg-transparent px-1 py-1 text-xs font-black text-slate-800 outline-none focus:bg-white" /><button type="button" disabled={busy} onClick={onDelete} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button></div><div className="mt-1 flex items-center justify-between gap-2"><select value={type} onChange={(event) => { const next = event.target.value as ColumnType; setType(next); onSave(name, next); }} className="bg-transparent text-[9px] font-bold uppercase text-slate-400 outline-none"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / No</option></select><button type="button" onClick={onSort} className={`text-[10px] font-black ${sorted ? 'text-emerald-700' : 'text-slate-400 hover:text-emerald-700'}`}>{sorted ? (ascending ? 'ASC' : 'DESC') : 'SORT'}</button></div></th>;
}

function SpreadsheetRow({ row, rowNumber, columns, busy, onSave, onDelete }: { row: LiveDataRow; rowNumber: number; columns: LiveDataColumn[]; busy: boolean; onSave: (values: LiveDataRow['values']) => void; onDelete: () => void }) {
  const [values, setValues] = useState(row.values);
  useEffect(() => setValues(row.values), [row.id, row.values]);
  return <tr className="group hover:bg-emerald-50/30"><td className="sticky left-0 z-10 border-b border-r border-slate-200 bg-slate-50 px-2 py-2 text-center text-[10px] font-bold text-slate-400 group-hover:bg-emerald-50">{rowNumber}</td>{columns.map((column) => <td key={column.id} className="border-b border-r border-slate-200 p-0">{column.dataType === 'boolean' ? <select value={String(values[column.key] ?? '')} onChange={(event) => setValues((current) => ({ ...current, [column.key]: normalizeValue(event.target.value, column.dataType) }))} className="h-10 w-full bg-transparent px-3 text-xs font-medium text-slate-700 outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-emerald-400"><option value="">-</option><option value="true">Yes</option><option value="false">No</option></select> : <input type={column.dataType === 'number' ? 'number' : column.dataType === 'date' ? 'date' : 'text'} value={valueForInput(values[column.key])} onChange={(event) => setValues((current) => ({ ...current, [column.key]: normalizeValue(event.target.value, column.dataType) }))} className="h-10 w-full bg-transparent px-3 text-xs font-medium text-slate-700 outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-emerald-400" />}</td>)}<td className="sticky right-0 z-10 border-b border-l border-slate-200 bg-white px-2 py-1 group-hover:bg-emerald-50"><div className="flex gap-1"><button type="button" disabled={busy} onClick={() => onSave(values)} className="rounded p-1.5 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50" title="Save row"><Save className="h-3.5 w-3.5" /></button><button type="button" disabled={busy} onClick={onDelete} className="rounded p-1.5 text-red-600 hover:bg-red-100 disabled:opacity-50" title="Delete row"><Trash2 className="h-3.5 w-3.5" /></button></div></td></tr>;
}
