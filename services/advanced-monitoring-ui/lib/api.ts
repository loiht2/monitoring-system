/** Fetch wrapper against advanced-monitoring-api. */

/** The UI proxies /api/* to the monitoring API server-side (app/api/[...path]/route.ts), so the
 *  browser only ever calls its own origin. No API address is baked into the page, which
 *  is what previously made a deployment cluster-specific. */
export function apiBase(): string {
  return '/api';
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
export interface VariableSpec {
  name: string; query: string; includeAll: boolean; multi: boolean;
}
export interface DashboardSpec {
  uid: string; title: string; description: string;
  variables: VariableSpec[]; rows: RowSpec[];
}
export interface Catalog {
  dashboards: DashboardSpec[];
  variables: VariableSpec[];
}

/** `label_values(metric, label)` → metric; `label_values(label)` → undefined. */
export function matchFromVariableQuery(query: string): string | undefined {
  const m = /^label_values\(\s*([^,)]+)\s*,/.exec(query);
  return m ? m[1].trim() : undefined;
}

export const api = {
  getCatalog: () => get<Catalog>('/catalog'),
  query: (q: string) => get<{ resultType: string; result: any[] }>(
    `/query?q=${encodeURIComponent(q)}`),
  queryRange: (q: string, start: number, end: number, step: number) => get<{ result: any[] }>(
    `/query_range?q=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`),
  labelValues: (name: string, start: number, end: number, match?: string) =>
    get<{ values: string[]; error?: string }>(
      `/label/${encodeURIComponent(name)}/values?start=${start}&end=${end}`
      + (match ? `&match=${encodeURIComponent(match)}` : '')),
};
