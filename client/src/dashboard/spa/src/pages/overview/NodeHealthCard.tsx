import { useState, type JSX } from 'react';
import { useLocation } from 'wouter';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip.js';
// AlertDialog imports stay un-imported while the Stop trigger is commented
// out; re-add them from '../../components/ui/alert-dialog.js' when Stop
// un-comments (see the JSX comment block below).
import { cn } from '../../lib/utils.js';

/**
 * Node Health card — the right-rail summary of this operator's daemon and
 * RPC connection. Renders two rows:
 *
 *   1. Daemon — running/stopped, with a state-message slot. Two actions:
 *      Stop (calls POST /api/admin/stop, daemon exits and stays down) and
 *      Restart (calls POST /api/admin/restart with `forceRespawn: true` so
 *      the daemon respawns even in `--no-ui` mode).
 *
 *   2. RPC — healthy/unreachable, moved out of the page header so health
 *      state lives next to the action that resolves it.
 *
 * Migrated to shadcn primitives (Card, Button, Tooltip, AlertDialog) so
 * the Stop confirmation flow lights up automatically when the underlying
 * "dashboard outlives the daemon" issue gets fixed.
 */
export type DaemonStatus = 'running' | 'stopped';
export type RpcStatus = 'healthy' | 'unreachable';

export interface NodeHealthCardProps {
  daemonStatus: DaemonStatus;
  /** One-line reason for the current daemon state (e.g. "waiting for next task"). */
  daemonStateMessage?: string;
  rpcStatus: RpcStatus;
  /** Called when the operator clicks Stop. Should POST /api/admin/stop. */
  onStop?: () => Promise<void> | void;
  /**
   * Called when the operator clicks Restart. Should POST /api/admin/restart
   * with `forceRespawn: true`.
   */
  onRestart?: () => Promise<void> | void;
}

const rowLabel = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const rowValue = 'flex items-center gap-2 font-mono text-[17px] font-medium text-foreground';

function StatusDot({ tone }: { tone: 'good' | 'bad' | 'neutral' }): JSX.Element {
  const color =
    tone === 'good'
      ? 'bg-[var(--vow-green)]'
      : tone === 'bad'
        ? 'bg-[var(--break-red)]'
        : 'bg-[var(--fg-muted)]';
  return <span aria-hidden="true" className={cn('inline-block h-2 w-2 rounded-full', color)} />;
}

export function NodeHealthCard({
  daemonStatus,
  daemonStateMessage,
  rpcStatus,
  onRestart,
  // onStop is intentionally not destructured while the Stop button is
  // commented out — keep it in the props interface so re-enabling Stop
  // is a one-block restore.
}: NodeHealthCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState<'stop' | 'restart' | null>(null);
  const daemonRunning = daemonStatus === 'running';
  const rpcHealthy = rpcStatus === 'healthy';

  function handleRestart(): void {
    if (busy || !onRestart) return;
    setBusy('restart');
    Promise.resolve()
      .then(onRestart)
      .catch((err) => console.error('[node-health] restart failed:', err))
      .finally(() => setBusy(null));
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        data-testid="node-health-card"
        aria-labelledby="node-health-heading"
        className="flex flex-col gap-4 p-6"
      >
        <h2 id="node-health-heading" className={cn(rowLabel, 'm-0 text-[var(--fg-dim)]')}>
          Node health
        </h2>

        {/* ── DAEMON ─────────────────────────────────────────────────────── */}
        <div
          data-testid="node-health-daemon-row"
          data-status={daemonStatus}
          className="flex flex-col gap-2"
        >
          <span className={rowLabel}>Daemon</span>
          <span className={rowValue}>
            <StatusDot tone={daemonRunning ? 'good' : 'bad'} />
            {daemonRunning ? 'Running' : 'Stopped'}
          </span>
          {daemonStateMessage && (
            <span
              data-testid="node-health-daemon-state"
              className="font-mono text-[12px] leading-snug text-[var(--fg-muted)]"
            >
              {daemonStateMessage}
            </span>
          )}
          <div className="mt-2 flex gap-2">
            {/*
              Stop is commented out for now. When the daemon stops, the
              dashboard goes with it (same process serves the SPA), so the
              button gets stuck on "Stopping…" and the operator has no way
              to confirm the action completed. The deeper fix is to split
              the dashboard process off from the daemon — until then,
              shipping Stop without Start is more confusing than useful.
              The AlertDialog confirmation is already wired so re-enabling
              the trigger is the only restore step.

            <AlertDialog>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={!daemonRunning || busy !== null}
                        data-testid="node-health-stop"
                      >
                        {busy === 'stop' ? 'Stopping...' : 'Stop'}
                      </Button>
                    </AlertDialogTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {daemonRunning
                    ? 'Stop the daemon. It stays down until you re-run jinn from your terminal.'
                    : 'Daemon is already stopped.'}
                </TooltipContent>
              </Tooltip>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Stop the daemon?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The dashboard will go down with the daemon. You'll need to re-run
                    `jinn` from your terminal to bring it back up.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      if (!onStop) return;
                      setBusy('stop');
                      Promise.resolve(onStop()).finally(() => setBusy(null));
                    }}
                  >
                    Stop daemon
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={daemonRunning ? -1 : 0}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!daemonRunning || busy !== null}
                    data-testid="node-health-restart"
                    onClick={handleRestart}
                  >
                    {busy === 'restart' ? 'Restarting...' : 'Restart'}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {daemonRunning
                  ? 'Restart the daemon. The dashboard reconnects when it comes back.'
                  : 'Daemon is stopped — re-run jinn from your terminal to start it.'}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* ── RPC ────────────────────────────────────────────────────────── */}
        <div
          data-testid="node-health-rpc-row"
          data-status={rpcStatus}
          className="flex flex-col gap-2"
        >
          <span className={rowLabel}>RPC</span>
          <span className={rowValue}>
            <StatusDot tone={rpcHealthy ? 'good' : 'bad'} />
            {rpcHealthy ? 'Healthy' : 'Unreachable'}
          </span>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="node-health-rpc-settings"
              onClick={() => navigate('/operator/network')}
            >
              Manage RPC
            </Button>
          </div>
        </div>
      </Card>
    </TooltipProvider>
  );
}
