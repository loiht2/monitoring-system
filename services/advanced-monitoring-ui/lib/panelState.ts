import { ApiError } from './api';
import type { PanelState } from '@/components/PanelFrame';

/** Which empty state an error means. A 4xx is Prometheus rejecting the query we sent —
 *  a bug in the expression or its substitution, not an observation about the cluster.
 *  Anything else is treated as the upstream being unreachable. See §6. */
export function stateForError(e: unknown): PanelState {
  if (e instanceof ApiError && e.status >= 400 && e.status < 500) return 'rejected';
  return 'down';
}
