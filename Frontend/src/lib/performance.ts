const API_STORAGE_KEY = 'zea_voice_performance_api_v1';
const TAB_STORAGE_KEY = 'zea_voice_performance_tabs_v1';
const MAX_RECORDS = 500;
const SETTLE_DELAY_MS = 150;
const SUPER_ADMIN_TABS = [
  'dashboard', 'companies', 'developers', 'providers', 'phone-numbers',
  'credits', 'queue-monitor', 'call-monitoring', 'payments', 'settings',
];

export interface ApiPerformanceRecord {
  id: string;
  tab: string;
  path: string;
  method: string;
  startedAt: string;
  durationMs: number;
  backendDurationMs: number;
  sqlDurationMs: number;
  sqlQueryCount: number;
  externalDurationMs: number;
  externalCallCount: number;
  status: number;
  requestId: string | null;
  success: boolean;
}

export interface TabPerformanceRecord {
  id: string;
  tab: string;
  startedAt: string;
  frontendLoadMs: number;
  apiRequestCount: number;
  apiDurationSumMs: number;
  slowestApiMs: number;
  sqlDurationSumMs: number;
  sqlQueryCount: number;
  externalDurationSumMs: number;
  externalCallCount: number;
  complete: boolean;
}

interface ActiveTabMeasurement {
  id: string;
  tab: string;
  startedAt: string;
  startedMark: number;
  pending: Set<string>;
  apiRecords: ApiPerformanceRecord[];
  settleTimer: number | null;
}

interface ApiMeasurement {
  id: string;
  tabSessionId: string | null;
  tab: string;
  path: string;
  method: string;
  startedAt: string;
  startedMark: number;
}

let activeTab: ActiveTabMeasurement | null = null;

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function readRecords<T>(key: string): T[] {
  try { return JSON.parse(localStorage.getItem(key) || '[]') as T[]; }
  catch { return []; }
}

function appendRecord<T>(key: string, record: T) {
  const records = readRecords<T>(key);
  records.push(record);
  localStorage.setItem(key, JSON.stringify(records.slice(-MAX_RECORDS)));
}

function headerNumber(response: Response | null, name: string) {
  const value = Number(response?.headers.get(name) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function finalizeTab(complete: boolean) {
  if (!activeTab) return;
  if (activeTab.settleTimer !== null) window.clearTimeout(activeTab.settleTimer);
  const records = activeTab.apiRecords;
  const record: TabPerformanceRecord = {
    id: activeTab.id,
    tab: activeTab.tab,
    startedAt: activeTab.startedAt,
    frontendLoadMs: round(performance.now() - activeTab.startedMark),
    apiRequestCount: records.length,
    apiDurationSumMs: round(records.reduce((sum, item) => sum + item.durationMs, 0)),
    slowestApiMs: round(Math.max(0, ...records.map((item) => item.durationMs))),
    sqlDurationSumMs: round(records.reduce((sum, item) => sum + item.sqlDurationMs, 0)),
    sqlQueryCount: records.reduce((sum, item) => sum + item.sqlQueryCount, 0),
    externalDurationSumMs: round(records.reduce((sum, item) => sum + item.externalDurationMs, 0)),
    externalCallCount: records.reduce((sum, item) => sum + item.externalCallCount, 0),
    complete,
  };
  appendRecord(TAB_STORAGE_KEY, record);
  window.dispatchEvent(new CustomEvent('zea:tab-performance', { detail: record }));
  console.info('[Zea Performance] Tab baseline', record);
  activeTab = null;
}

function scheduleTabFinish() {
  if (!activeTab || activeTab.pending.size > 0) return;
  if (activeTab.settleTimer !== null) window.clearTimeout(activeTab.settleTimer);
  activeTab.settleTimer = window.setTimeout(() => finalizeTab(true), SETTLE_DELAY_MS);
}

export function startTabMeasurement(tab: string) {
  if (activeTab?.tab === tab) return;
  if (activeTab) finalizeTab(activeTab.pending.size === 0);
  activeTab = {
    id: crypto.randomUUID(),
    tab,
    startedAt: new Date().toISOString(),
    startedMark: performance.now(),
    pending: new Set(),
    apiRecords: [],
    settleTimer: null,
  };
  // Tabs without an API request still receive a frontend timing record.
  scheduleTabFinish();
}

export function beginApiMeasurement(path: string, method: string): ApiMeasurement {
  const measurement: ApiMeasurement = {
    id: crypto.randomUUID(),
    tabSessionId: activeTab?.id ?? null,
    tab: activeTab?.tab ?? 'unassigned',
    path: path.split('?')[0],
    method,
    startedAt: new Date().toISOString(),
    startedMark: performance.now(),
  };
  if (activeTab) {
    if (activeTab.settleTimer !== null) window.clearTimeout(activeTab.settleTimer);
    activeTab.settleTimer = null;
    activeTab.pending.add(measurement.id);
  }
  return measurement;
}

export function finishApiMeasurement(measurement: ApiMeasurement, response: Response | null) {
  const record: ApiPerformanceRecord = {
    id: measurement.id,
    tab: measurement.tab,
    path: measurement.path,
    method: measurement.method,
    startedAt: measurement.startedAt,
    durationMs: round(performance.now() - measurement.startedMark),
    backendDurationMs: headerNumber(response, 'x-response-time-ms'),
    sqlDurationMs: headerNumber(response, 'x-sql-time-ms'),
    sqlQueryCount: headerNumber(response, 'x-sql-query-count'),
    externalDurationMs: headerNumber(response, 'x-external-time-ms'),
    externalCallCount: headerNumber(response, 'x-external-call-count'),
    status: response?.status ?? 0,
    requestId: response?.headers.get('x-request-id') ?? null,
    success: response?.ok ?? false,
  };
  appendRecord(API_STORAGE_KEY, record);
  window.dispatchEvent(new CustomEvent('zea:api-performance', { detail: record }));

  if (activeTab?.id === measurement.tabSessionId) {
    activeTab.apiRecords.push(record);
    activeTab.pending.delete(measurement.id);
    scheduleTabFinish();
  }
}

export function getPerformanceBaseline() {
  return {
    generatedAt: new Date().toISOString(),
    apiRequests: readRecords<ApiPerformanceRecord>(API_STORAGE_KEY),
    tabs: readRecords<TabPerformanceRecord>(TAB_STORAGE_KEY),
  };
}

export function getPerformanceBaselineSummary() {
  const records = readRecords<TabPerformanceRecord>(TAB_STORAGE_KEY);
  return SUPER_ADMIN_TABS.map((tab) => {
    const samples = records.filter((record) => record.tab === tab && record.complete);
    const latest = samples.at(-1);
    return {
      tab,
      samples: samples.length,
      frontendLoadMs: latest?.frontendLoadMs ?? null,
      slowestApiMs: latest?.slowestApiMs ?? null,
      sqlDurationMs: latest?.sqlDurationSumMs ?? null,
      sqlQueries: latest?.sqlQueryCount ?? null,
      externalDurationMs: latest?.externalDurationSumMs ?? null,
      externalCalls: latest?.externalCallCount ?? null,
      capturedAt: latest?.startedAt ?? null,
    };
  });
}

export function clearPerformanceBaseline() {
  localStorage.removeItem(API_STORAGE_KEY);
  localStorage.removeItem(TAB_STORAGE_KEY);
}

export function downloadPerformanceBaseline() {
  const blob = new Blob([JSON.stringify(getPerformanceBaseline(), null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `zea-performance-baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

declare global {
  interface Window {
    __zeaPerformance: {
      snapshot: typeof getPerformanceBaseline;
      summary: typeof getPerformanceBaselineSummary;
      clear: typeof clearPerformanceBaseline;
      download: typeof downloadPerformanceBaseline;
    };
  }
}

window.__zeaPerformance = {
  snapshot: getPerformanceBaseline,
  summary: getPerformanceBaselineSummary,
  clear: clearPerformanceBaseline,
  download: downloadPerformanceBaseline,
};
