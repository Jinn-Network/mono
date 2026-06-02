/**
 * DaemonOfflineScreen — full-screen state rendered when the connection probe
 * determines the daemon process is not reachable.
 *
 * Issue #110: when the daemon exits before the API binds (or via a
 * funding_required exit before earning_state.json is written), the SPA was
 * left on "Starting jinn / no events yet" indefinitely. This screen provides
 * a clear "daemon not running" state with a one-command recovery instruction.
 *
 * Structurally mirrors LoadingScreen: same eyebrow / serif display / mono body
 * class tokens; ghost Button for the disclosure toggle; Card for the details
 * panel.
 */
import { useState, type JSX } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { ConnectionState } from '../api/connection-state.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';

/** Narrowed to the disconnected variant — the App gate guarantees this before rendering. */
type DisconnectedState = Extract<ConnectionState, { status: 'disconnected' }>;

const eyebrow =
  'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--accent-gold)]';
const display = 'font-serif font-normal leading-[1.05] text-foreground text-[64px]';

export function DaemonOfflineScreen({
  connection,
}: {
  connection: DisconnectedState;
}): JSX.Element {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-10 py-16 text-foreground"
      data-testid="daemon-offline-screen"
    >
      <div className="flex w-full max-w-xl flex-col gap-6">
        <span className={eyebrow}>Jinn · offline</span>
        <h1 className={display}>Daemon not running.</h1>

        <div className="flex flex-col gap-2">
          <p className="font-mono text-sm text-[var(--fg-muted)]">
            Open a terminal and run:
          </p>
          <code className="self-start rounded bg-[var(--bg-elevated)] px-2 py-1 font-mono text-sm text-foreground">
            jinn run
          </code>
          <p className="font-mono text-xs text-[var(--fg-dim)]">
            (or the command you originally used to start it)
          </p>
        </div>

        <p className="font-mono text-sm text-[var(--fg-muted)]">
          Reconnecting&hellip;
          {connection.attempts > 0 && (
            <span className="ml-1 text-[var(--fg-dim)]">
              (attempt {connection.attempts})
            </span>
          )}
        </p>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-[var(--fg-dim)] hover:text-foreground"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
        >
          {showDetails ? <ChevronUp /> : <ChevronDown />}
          {showDetails ? 'Hide details' : 'Show details'}
        </Button>

        {showDetails && connection.lastError && (
          <Card className="bg-[var(--bg-elevated)]">
            <CardContent className="px-3 py-2">
              <p className="font-mono text-xs text-[var(--fg-muted)]">{connection.lastError}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
