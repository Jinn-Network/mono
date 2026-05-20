/**
 * Persistent, full-width banner that surfaces a dead-daemon condition.
 *
 * Issue #335: when the daemon process dies (intentional shutdown, crash, or
 * a restart that fails to respawn — see #289), the SPA used to keep rendering
 * its last-known state forever. Operators thought the node was still working;
 * only a manual page refresh told the truth.
 *
 * `useConnectionState` (api/connection-state.ts) polls `/v1/status` and flips
 * to `disconnected` within ~4s of the daemon going down. This banner renders
 * that state: a clear "daemon is offline" message and a "reconnecting" cue.
 * The in-app restart respawn (#289) and auto-reconnect supersede any terminal
 * CTA. When the daemon answers again the hook flips back to `connected` and
 * this banner unmounts itself — the rest of the app's react-query refetches
 * resume naturally.
 *
 * This is a money/safety-adjacent surface: it must speak plainly. No vow
 * metaphor here.
 */
import type { ConnectionState } from '../api/connection-state.js';

export interface OfflineBannerProps {
  connection: ConnectionState;
}

export function OfflineBanner({ connection }: OfflineBannerProps): JSX.Element | null {
  if (connection.status === 'connected') return null;

  return (
    <div
      role="alert"
      data-testid="offline-banner"
      style={{
        background: 'var(--bg-elevated)',
        borderBottom: '2px solid var(--break-red)',
        padding: '10px 24px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '13px',
      }}
    >
      <span style={{ color: 'var(--fg)' }}>
        <strong style={{ color: 'var(--break-red)' }}>Daemon offline.</strong>{' '}
        The jinn node stopped responding — what you see below may be stale.
        Reconnecting automatically…
      </span>
    </div>
  );
}
