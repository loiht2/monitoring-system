'use client';

export type PanelState = 'ok' | 'loading' | 'nodata' | 'unsupported' | 'down';

const MESSAGE: Record<Exclude<PanelState, 'ok' | 'loading'>, string> = {
  // The three causes an empty panel can have. Collapsing them into one "No data" is
  // exactly the ambiguity gpu_metric_supported exists to remove.
  nodata: 'No data in this range',
  unsupported: 'Not supported on this GPU',
  down: 'Prometheus unreachable',
};

export function PanelFrame({ title, description, state, children }: {
  title: string; description?: string; state: PanelState; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--bg-panel,#161b22)', border: '1px solid var(--border-color,#30363d)',
      borderRadius: 10, padding: '1rem', height: '100%', display: 'flex', flexDirection: 'column',
    }}>
      <div title={description} style={{
        fontSize: '0.82rem', color: 'var(--text-muted)', fontWeight: 500, marginBottom: '0.6rem',
      }}>{title}</div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {state === 'ok' ? children : (
          <div style={{
            height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontSize: '0.85rem',
          }}>{state === 'loading' ? '…' : MESSAGE[state]}</div>
        )}
      </div>
    </div>
  );
}
