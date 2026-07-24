/**
 * AiUnitsPauseAlert — issue #815 running-mode surface.
 *
 * Compact per-credential banner shown on the Overview while one or more
 * credentials are paused by the claim-spend ceiling. The daemon now emits
 * USD accumulators plus an `estimated` bit, so the running-mode surface must
 * show the real spend units and distinguish metered from estimated usage.
 * Render-only — no event subscription; the /v1/status poll on Overview is the
 * upstream feed.
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
  /** Actual USD spend this 6h block, in micros. Optional for backward-compat. */
  usdMicrosThisBlock?: number;
  /** Actual USD spend this 7d window, in micros. Optional for backward-compat. */
  usdMicrosThisWeek?: number;
  /** USD cap for the current 6h block, in micros. Optional for backward-compat. */
  capPerBlockUsdMicros?: number;
  /** USD cap for the current 7d window, in micros. Optional for backward-compat. */
  capPerWeekUsdMicros?: number;
  /** True when the summed spend includes any estimate-backed rows. */
  estimated?: boolean;
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
   * backward-compat with daemons that predate the field; the use site falls
   * back to USD fields first, then legacy unit fields — issue #830, item 2.
   */
  pausedWindow?: 'block' | 'week' | null;
  blockResetsAt: string;
  weekResetsAt: string | null;
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

function formatUsdMicros(usdMicros: number): string {
  return `$${(usdMicros / 1_000_000).toFixed(4)}`;
}

export function AiUnitsPauseAlert({ aiUnits }: AiUnitsPauseAlertProps): JSX.Element | null {
  if (!aiUnits) return null;
  const paused = aiUnits.credentials.filter((c) => c.paused);
  if (paused.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {paused.map((row) => {
        const hasUsdFields =
          typeof row.usdMicrosThisBlock === 'number' &&
          typeof row.usdMicrosThisWeek === 'number' &&
          typeof row.capPerBlockUsdMicros === 'number' &&
          typeof row.capPerWeekUsdMicros === 'number';
        const usdMicrosThisBlock = row.usdMicrosThisBlock ?? 0;
        const usdMicrosThisWeek = row.usdMicrosThisWeek ?? 0;
        const capPerBlockUsdMicros = row.capPerBlockUsdMicros ?? 0;
        const capPerWeekUsdMicros = row.capPerWeekUsdMicros ?? 0;
        // Prefer the gate-sourced binding window (issue #830, item 2). For
        // older daemons, derive it from the USD gate fields when available,
        // then fall back to the legacy unit fields.
        const blockHit = hasUsdFields
          ? usdMicrosThisBlock >= capPerBlockUsdMicros
          : row.unitsThisBlock >= row.capPerBlock;
        const window: 'block' | 'week' =
          row.pausedWindow ?? (blockHit ? 'block' : 'week');
        const resumeAt = window === 'block' ? row.blockResetsAt : row.weekResetsAt;
        const windowLabel = window === 'block' ? '6h' : '7d';
        const usageLabel = hasUsdFields
          ? `${row.estimated ? 'estimated' : 'metered'} ${
              window === 'block'
                ? `${formatUsdMicros(usdMicrosThisBlock)} / ${formatUsdMicros(capPerBlockUsdMicros)}`
                : `${formatUsdMicros(usdMicrosThisWeek)} / ${formatUsdMicros(capPerWeekUsdMicros)}`
            }`
          : window === 'block'
            ? `${row.unitsThisBlock} / ${row.capPerBlock} units`
            : `${row.unitsThisWeek} / ${row.capPerWeek} units`;
        const periodLabel = window === 'block' ? 'this block' : 'this 7-day window';
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
              Paused — {windowLabel} spend cap reached
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
                {usageLabel} {periodLabel}
                {resumeAt == null ? (
                  <>
                    . Claims cannot resume under the current weekly cap until the task projection
                    or cap configuration changes.
                  </>
                ) : (
                  <>
                    . Claims resume at{' '}
                    <span className="text-foreground">{formatUtc(resumeAt)}</span>.
                  </>
                )}
              </span>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
