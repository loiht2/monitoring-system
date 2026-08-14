import { describe, it, expect } from 'vitest';
import { stateForError } from './panelState';
import { ApiError } from './api';

describe('stateForError', () => {
  it('reports a rejected query as a rejection, not as absence of data', () => {
    // A malformed query is a bug. Rendering it as "no data" is what hid 27 dead panels.
    expect(stateForError(new ApiError('parse error', 400))).toBe('rejected');
    expect(stateForError(new ApiError('bad_data', 422))).toBe('rejected');
  });

  it('reports an unreachable upstream as down', () => {
    expect(stateForError(new ApiError('bad gateway', 502))).toBe('down');
    expect(stateForError(new ApiError('unavailable', 503))).toBe('down');
  });

  it('treats a network failure as down, since no status came back', () => {
    expect(stateForError(new TypeError('Failed to fetch'))).toBe('down');
  });
});
