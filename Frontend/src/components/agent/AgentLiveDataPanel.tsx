import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Database, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { apiRequest, isAbortError } from '../../lib/api';

type ColumnType = 'text' | 'number' | 'date' | 'boolean';
type ApiColumn = { id: string; name: string; key: string; dataType: ColumnType };
type ApiRow = { id: string; values: Record<string, string | number | boolean | null> };
type ApiTable = { id: string; name: string; columns: ApiColumn[]; rows: ApiRow[]; sync?: { status: string; error?: string | null } };
type GridColumn = { id: string; name: string; dataType: ColumnType };

const INITIAL_COLUMNS = 10;
const INITIAL_ROWS = 10;
const emptyGrid = (rows = INITIAL_ROWS, columns = INITIAL_COLUMNS) => Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''));
const columnLabel = (index: number) => {
  let value = index + 1; let label = '';
  while (value > 0) { const remainder = (value - 1) % 26; label = String.fromCharCode(65 + remainder) + label; value = Math.floor((value - 1) / 26); }
  return label;
};

export function AgentLiveDataPanel({ agentId }: { agentId: string }) {
  const [tables, setTables] = useState<ApiTable[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [newName, setNewName] = useState('');
  const [columns, setColumns] = useState<GridColumn[]>([]);
  const [cells, setCells] = useState<string[][]>(emptyGrid());
  const [active, setActive] = useState({ row: 0, column: 0 });
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selected = tables.find((table) => table.id === selectedId) ?? null;

  const load = async () => {
    setLoading(true); setError('');
    try {
      const values = await apiRequest<ApiTable[]>(`/agents/${agentId}/live-data/tables`, { zeaCache: 'reload' });
      setTables(values); setSelectedId((current) => values.some((item) => item.id === current) ? current : (values[0]?.id ?? ''));
    } catch (caught) { if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : 'Live Data could not be loaded.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [agentId]);
  useEffect(() => {
    if (!selected) { setColumns([]); setCells(emptyGrid()); return; }
    const savedColumns = selected.columns.map((column) => ({ id: column.key, name: column.name, dataType: column.dataType }));
    const visibleColumns = savedColumns.length ? savedColumns : Array.from({ length: INITIAL_COLUMNS }, (_, index) => ({ id: `draft_${index}`, name: '', dataType: 'text' as ColumnType }));
    const savedRows = selected.rows.map((row) => visibleColumns.map((column) => String(row.values[column.id] ?? '')));
    setColumns(visibleColumns);
    setCells([[...visibleColumns.map((column) => column.name)], ...savedRows, ...emptyGrid(Math.max(INITIAL_ROWS - savedRows.length - 1, 1), visibleColumns.length)]);
    setActive({ row: 0, column: 0 }); setSelectedRows([]); setSelectedColumns([]);
  }, [selectedId, selected]);

  const createSheet = async () => {
    const name = newName.trim(); if (!name) return;
    setSaving(true); setError('');
    try {
      const table = await apiRequest<ApiTable>(`/agents/${agentId}/live-data/tables`, { method: 'POST', body: JSON.stringify({ name }) });
      setTables((current) => [...current, table]); setSelectedId(table.id); setNewName(''); setNotice('New spreadsheet created. Type your column names into the first row.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Spreadsheet could not be created.'); }
    finally { setSaving(false); }
  };
  const updateCell = (row: number, column: number, value: string) => {
    const addColumn = column === columns.length - 1;
    if (addColumn) setColumns((current) => [...current, { id: `draft_${current.length}`, name: '', dataType: 'text' }]);
    setCells((current) => {
      const next = current.map((line) => addColumn ? [...line, ''] : [...line]); next[row][column] = value;
      if (row === next.length - 1) next.push(Array.from({ length: columns.length + (addColumn ? 1 : 0) }, () => ''));
      return next;
    });
  };
  const addColumn = () => { setColumns((current) => [...current, { id: `draft_${current.length}`, name: '', dataType: 'text' }]); setCells((current) => current.map((row) => [...row, ''])); };
  const addRow = () => setCells((current) => [...current, Array.from({ length: columns.length }, () => '')]);
  const toggleSelection = (value: number, setSelection: React.Dispatch<React.SetStateAction<number[]>>, event: React.MouseEvent) => {
    setSelection((current) => event.ctrlKey || event.metaKey ? (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]) : [value]);
  };
  const deleteActiveColumn = () => {
    const targets = selectedColumns.length ? selectedColumns : [active.column];
    if (!columns.length || !window.confirm(`Delete ${targets.length} selected column${targets.length === 1 ? '' : 's'}? Save Changes will permanently remove them.`)) return;
    const targetSet = new Set(targets);
    setColumns((current) => current.filter((_, index) => !targetSet.has(index)));
    setCells((current) => current.map((row) => row.filter((_, index) => !targetSet.has(index))));
    setActive((current) => ({ ...current, column: 0 })); setSelectedColumns([]);
  };
  const deleteActiveRow = () => {
    const targets = selectedRows.length ? selectedRows : [active.row];
    if (!cells.length || !window.confirm(`Delete ${targets.length} selected row${targets.length === 1 ? '' : 's'}? Save Changes will permanently remove them.`)) return;
    const targetSet = new Set(targets);
    setCells((current) => current.filter((_, index) => !targetSet.has(index)));
    setActive((current) => ({ ...current, row: 0 })); setSelectedRows([]);
  };
  const deleteSheet = async () => {
    if (!selected || !window.confirm(`Delete spreadsheet "${selected.name}" and all its data?`)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await apiRequest(`/agents/${agentId}/live-data/tables/${selected.id}`, { method: 'DELETE' });
      setTables((current) => current.filter((table) => table.id !== selected.id)); setSelectedId(''); setNotice('Spreadsheet deleted.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Spreadsheet could not be deleted.'); }
    finally { setSaving(false); }
  };
  const saveGrid = async () => {
    if (!selected) return;
    const retained = columns.map((column, index) => ({ column, index })).filter(({ index }) => cells.some((row) => row[index]?.trim()));
    if (!retained.length) { setError('Enter at least one column name in the first row before saving.'); return; }
    const sheetColumns = retained.map(({ column, index }) => ({ name: cells[0][index].trim(), dataType: column.dataType }));
    if (sheetColumns.some((column) => !column.name)) { setError('The first row must contain a name for every used column.'); return; }
    const sheetRows = cells.slice(1).map((row) => retained.map(({ column, index }) => {
      const value = row[index] ?? '';
      if (value === '') return null;
      if (column.dataType === 'number') return Number(value);
      if (column.dataType === 'boolean') return value.toLocaleLowerCase() === 'true';
      return value;
    })).filter((row) => row.some((value) => value !== null));
    if (selected.columns.length || selected.rows.length) {
      if (!window.confirm('Save all spreadsheet changes? Removed columns or rows will be deleted.')) return;
    }
    setSaving(true); setError(''); setNotice('');
    try {
      const table = await apiRequest<ApiTable>(`/agents/${agentId}/live-data/tables/${selected.id}/grid`, { method: 'PUT', body: JSON.stringify({ columns: sheetColumns, rows: sheetRows }) });
      setTables((current) => current.map((item) => item.id === table.id ? table : item)); setNotice('Spreadsheet saved and queued for index sync.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Spreadsheet could not be saved.'); }
    finally { setSaving(false); }
  };
  const gridRows = useMemo(() => cells.length, [cells.length]);

  return <div className="space-y-4">
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="flex items-center gap-2 text-sm font-black text-slate-900"><Database className="h-4 w-4 text-emerald-600" />Live Data</h3><p className="mt-1 text-xs text-slate-500">Use this exactly like a spreadsheet. First row is the column names; rows below are the live data.</p></div><button type="button" onClick={() => void load()} disabled={loading || saving} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div>
    {error && <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}{notice && <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</div>}
    <div className="flex gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3"><input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createSheet(); }} placeholder="New spreadsheet name" className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold outline-none focus:border-emerald-500" /><button type="button" onClick={() => void createSheet()} disabled={saving || !newName.trim()} className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-50"><Plus className="h-4 w-4" />New sheet</button></div>
    {loading ? <div className="h-64 animate-pulse rounded-xl bg-slate-100" /> : !tables.length ? <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center text-sm font-semibold text-slate-500">Create a spreadsheet to begin.</div> : <><div className="flex flex-wrap gap-1 border-b border-slate-200 pb-2">{tables.map((table) => <button key={table.id} type="button" onClick={() => setSelectedId(table.id)} className={`rounded-t-lg px-4 py-2 text-xs font-black ${table.id === selectedId ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{table.name}</button>)}</div>{selected && <div className="overflow-hidden rounded-xl border border-slate-300 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-300 bg-slate-50 px-3 py-2"><span className="mr-auto text-xs font-black text-slate-700">{selected.name}</span><span title={selected.sync?.error ?? undefined} className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${selected.sync?.status === 'synced' ? 'bg-emerald-100 text-emerald-700' : selected.sync?.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>Index {selected.sync?.status ?? 'pending'}</span><button type="button" onClick={addColumn} className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-[10px] font-bold text-slate-600 hover:bg-slate-100">+ Column</button><button type="button" onClick={addRow} className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-[10px] font-bold text-slate-600 hover:bg-slate-100">+ Row</button><button type="button" onClick={deleteActiveColumn} disabled={!columns.length} className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2.5 py-1.5 text-[10px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-3 w-3" />Column</button><button type="button" onClick={deleteActiveRow} disabled={!cells.length} className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2.5 py-1.5 text-[10px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-3 w-3" />Row</button><button type="button" onClick={() => void deleteSheet()} disabled={saving} className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2.5 py-1.5 text-[10px] font-black text-red-700 hover:bg-red-100 disabled:opacity-50"><Trash2 className="h-3 w-3" />Sheet</button><button type="button" disabled={saving} onClick={() => void saveGrid()} className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-[10px] font-black text-white hover:bg-emerald-700 disabled:opacity-50"><Save className="h-3.5 w-3.5" />Save changes</button></div>
      <div className="max-h-[600px] overflow-auto bg-white"><table className="border-separate border-spacing-0 text-xs"><thead className="sticky top-0 z-20"><tr><th className="sticky left-0 z-30 h-7 min-w-11 border-b border-r border-slate-300 bg-slate-100" />{columns.map((_, index) => <th key={index} onClick={(event) => toggleSelection(index, setSelectedColumns, event)} className={`h-7 min-w-24 cursor-pointer border-b border-r border-slate-300 bg-slate-100 text-center text-[10px] font-bold ${selectedColumns.includes(index) || active.column === index ? 'bg-emerald-100 text-emerald-800' : 'text-slate-500 hover:bg-slate-200'}`}>{columnLabel(index)}</th>)}</tr></thead><tbody>{Array.from({ length: gridRows }, (_, row) => <tr key={row}><th onClick={(event) => toggleSelection(row, setSelectedRows, event)} className={`sticky left-0 z-10 h-8 min-w-11 cursor-pointer border-b border-r border-slate-300 bg-slate-100 text-center text-[10px] font-bold ${selectedRows.includes(row) || active.row === row ? 'bg-emerald-100 text-emerald-800' : 'text-slate-500 hover:bg-slate-200'}`}>{row + 1}</th>{columns.map((_, column) => <td key={column} className={`h-8 min-w-24 border-b border-r border-slate-200 p-0 ${active.row === row && active.column === column ? 'ring-2 ring-inset ring-emerald-600' : ''}`}><input id={`live-cell-${row}-${column}`} value={cells[row]?.[column] ?? ''} onFocus={() => setActive({ row, column })} onChange={(event) => updateCell(row, column, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); document.getElementById(`live-cell-${Math.min(row + 1, gridRows - 1)}-${column}`)?.focus(); } }} className="h-full w-full min-w-24 bg-transparent px-2 text-xs text-slate-800 outline-none" aria-label={`Cell ${columnLabel(column)}${row + 1}`} /></td>)}</tr>)}</tbody></table></div>
      <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-semibold text-slate-500">Type into any empty cell. The grid grows automatically when you use the last row or column.</div>
    </div>}</>}
  </div>;
}
