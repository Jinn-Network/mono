import type { CaptureSummary } from '../api/types.js';

export interface CapturesListProps {
  captures: CaptureSummary[];
  selectedSessionId?: string;
  onSelect: (sessionId: string) => void;
}

export function CapturesList({ captures, selectedSessionId, onSelect }: CapturesListProps): JSX.Element {
  if (captures.length === 0) {
    return (
      <div style={{ padding: 24, color: 'var(--fg-muted)' }}>
        No pending captures.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {captures.map((capture) => {
        const active = capture.sessionId === selectedSessionId;
        return (
          <button
            key={capture.sessionId}
            type="button"
            onClick={() => onSelect(capture.sessionId)}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              border: `1px solid ${active ? 'var(--accent-sky)' : 'var(--border)'}`,
              borderRadius: 8,
              background: active ? 'rgba(56, 189, 248, 0.08)' : 'var(--panel)',
              color: 'var(--fg)',
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <strong>{capture.originatingTool.name}</strong>
              <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{capture.capturePath}</span>
            </div>
            <div style={{ marginTop: 6, color: 'var(--fg-muted)', fontSize: 12 }}>
              {capture.repoRemoteUrl ?? 'No repo'} · {capture.spanCount} spans · {capture.redactedSpanCount} redacted
            </div>
          </button>
        );
      })}
    </div>
  );
}
