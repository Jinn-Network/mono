/**
 * AiUnitsPauseAlert — issue #815 running-mode surface.
 *
 * Compact per-credential banner shown on the Overview while one or more
 * credentials are paused by the AI-units ceiling. The acceptance
 * criterion: "the running-mode dashboard surfaces the pause reason and
 * the next reset time (e.g. 'Paused — 6h AI-unit cap reached. Claims
 * resume at 12:00 UTC.')". Render-only — no event subscription; the
 * /v1/status poll on Overview is the upstream feed.
 */
import type { JSX } from 'react';
import { PauseCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';

export interface AiUnitsStatusRow {
  credentialId: string;
  unitsThisBlock: number;
  unitsThisWeek: number;
  capPerBlock: number;
  capPerWeek: number;
  paused: boolean;
  /**
   * True when this credential has spend in the current 7d window — i.e. it is
   * the one actually being worked against, not a configured-but-idle one
   * (issue #891). Optional for backward-compat with daemons that predate the
   * field (see the `?? true` default at the use site).
   */
  active?: boolean;
  /**
   * The binding window the daemon gate is actually pausing on
   * (block-preferred precedence), from the /v1/status feed. Optional for
   * backward-compat with daemons that predate the field (see the
   * `?? (unitsThisBlock >= capPerBlock ? 'block' : 'week')` fallback at the
   * use site) — issue #830, item 2.
   */
  pausedWindow?: 'block' | 'week' | null;
  blockResetsAt: string;
  weekResetsAt: string;
}

export interface AiUnitsStatusBlock {
  credentials: AiUnitsStatusRow[];
}

export interface AiUnitsPauseAlertProps {
  aiUnits: AiUnitsStatusBlock | undefined;
}

/** Format an ISO instant as `HH:MM UTC` for the resume-at copy. */
function formatUtc(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

export function AiUnitsPauseAlert({ aiUnits }: AiUnitsPauseAlertProps): JSX.Element | null {
  if (!aiUnits) return null;
  const paused = aiUnits.credentials.filter((c) => c.paused);
  if (paused.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {paused.map((row) => {
        // Prefer the gate-sourced binding window (issue #830, item 2) — it
        // reflects the daemon's actual block-preferred precedence and can't
        // disagree with it. Fall back to local derivation only for daemons
        // predating the `pausedWindow` field.
        const window: 'block' | 'week' =
          row.pausedWindow ?? (row.unitsThisBlock >= row.capPerBlock ? 'block' : 'week');
        const resumeAt = window === 'block' ? row.blockResetsAt : row.weekResetsAt;
        const windowLabel = window === 'block' ? '6h' : '7d';
        // A paused credential is by definition the active one; default to active
        // for daemons predating the `active` field (issue #891).
        const isActive = row.active ?? true;
        return (
          <Alert
            key={row.credentialId}
            variant="warning"
            data-testid={`ai-units-pause-alert-${row.credentialId}`}
          >
            <PauseCircle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle className="font-mono text-[13px]">
              Paused — {windowLabel} AI-unit cap reached
              {isActive ? (
                <span
                  className="ml-2 text-foreground"
                  data-testid={`ai-units-credential-state-${row.credentialId}`}
                >
                  (Active)
                </span>
              ) : null}
            </AlertTitle>
            <AlertDescription className="font-mono text-[12px] text-muted-foreground">
              <span>
                Credential <span className="text-foreground">{row.credentialId}</span> used{' '}
                {window === 'block'
                  ? `${row.unitsThisBlock} / ${row.capPerBlock} units this block`
                  : `${row.unitsThisWeek} / ${row.capPerWeek} units this 7-day window`}
                . Claims resume at <span className="text-foreground">{formatUtc(resumeAt)}</span>.
              </span>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
