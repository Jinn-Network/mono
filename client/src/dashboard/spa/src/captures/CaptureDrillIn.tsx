import type { CaptureDetailResponse } from '../api/types.js';
import { HarnessIdCard } from './HarnessIdCard.js';
import { RedactionDiff } from './RedactionDiff.js';

export interface CaptureDrillInProps {
  detail: CaptureDetailResponse;
  approving?: boolean;
  skipping?: boolean;
  onApprove: () => void;
  onSkip: () => void;
  onTrustRepo: (trusted: boolean) => void;
}

export function CaptureDrillIn({
  detail,
  approving = false,
  skipping = false,
  onApprove,
  onSkip,
  onTrustRepo,
}: CaptureDrillInProps): JSX.Element {
  const { capture, spans } = detail;
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{capture.sessionId}</h1>
          <div style={{ marginTop: 6, color: 'var(--fg-muted)' }}>
            {new Date(capture.capturedAt).toLocaleString()} · {spans.length} spans
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'start' }}>
          {capture.repoRemoteUrl ? (
            <button type="button" onClick={() => onTrustRepo(true)}>
              Trust repo
            </button>
          ) : null}
          <button type="button" disabled={skipping} onClick={onSkip}>
            {skipping ? 'Skipping' : 'Skip'}
          </button>
          <button type="button" disabled={approving} onClick={onApprove}>
            {approving ? 'Approving' : 'Approve'}
          </button>
        </div>
      </header>

      <HarnessIdCard capture={capture} />
      <RedactionDiff spans={spans} />

      <section style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>Trajectory</h2>
        <div style={{ display: 'grid', gap: 6 }}>
          {spans.map((span) => (
            <div
              key={span.spanId}
              style={{
                padding: '10px 12px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--panel)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <strong>{span.name}</strong>
                <span style={{ color: 'var(--fg-muted)', fontFamily: 'monospace', fontSize: 12 }}>
                  {span.spanId}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
