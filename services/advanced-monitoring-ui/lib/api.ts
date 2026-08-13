/** Fetch wrapper against advanced-monitoring-api.
 *
 * Runtime-configured, never build-time: the ML Platform bakes NEXT_PUBLIC_* into its
 * image and then has to rebuild per cluster. window.__ENV is written at container start.
 */
declare global { interface Window { __ENV?: Record<string, string> } }

export function apiBase(): string {
  if (typeof window !== 'undefined' && window.__ENV?.MONITORING_API)
    return window.__ENV.MONITORING_API;
  return process.env.NEXT_PUBLIC_MONITORING_API || 'http://127.0.0.1:8000';
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail ?? detail; } catch { /* non-JSON body */ }
    throw new ApiError(detail, r.status);
  }
  return r.json();
}

export interface PanelSpec {
  id: number; type: string; title: string; description: string;
  gridPos: { h: number; w: number; x: number; y: number };
  targets: { expr: string; legendFormat: string }[];
  unit?: string; min?: number; max?: number;
}
export interface RowSpec { title: string; collapsed: boolean; panels: PanelSpec[] }
export interface DashboardSpec { uid: string; title: string; rows: RowSpec[] }
export interface Catalog {
  dashboards: DashboardSpec[];
  variables: { name: string; query: string; includeAll: boolean; multi: boolean }[];
}

export const api = {
  getCatalog: () => get<Catalog>('/catalog'),
  query: (q: string) => get<{ resultType: string; result: any[] }>(
    `/query?q=${encodeURIComponent(q)}`),
  queryRange: (q: string, start: number, end: number, step: number) => get<{ result: any[] }>(
    `/query_range?q=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`),
  labelValues: (name: string, start: number, end: number) => get<{ values: string[]; error?: string }>(
    `/label/${encodeURIComponent(name)}/values?start=${start}&end=${end}`),
};
