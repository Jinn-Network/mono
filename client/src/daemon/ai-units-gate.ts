/**
 * AI-units claim gate — issue #815.
 *
 * The spend comparison delegates to the shared, side-effect-free
 * `classifyAiUnitsSpend` primitive. This wrapper adds operator warnings and
 * pause-edge deduplication around that decision. The classifier fails over
 * to *proceed* when projection is unknown (paranoia: a model gap must not
 * silently halt a working daemon — log loudly, keep claiming).
 *
 * Module-level memo tracks per-credential paused state keyed on
 * (credentialId, window, blockId) so the daemon emits exactly one
 * `ai_units_cap_reached` event + one warn log per pause edge, exactly
 * as the issue's acceptance contract requires. Block rollover (new
 * blockId) re-fires `newlyPaused` so the operator sees pauses in each
 * new 6h block instead of one silent indefinite mute.
 */
import type { GateLogger } from './gate-logger.js';
import {
  classifyAiUnitsSpend,
  type AiUnitsSpendWindow,
} from '../spend/ai-units.js';

export type AiUnitsGateWindow = AiUnitsSpendWindow;

export interface AiUnitsGateArgs {
  credentialId: string;
  /** USD micros projected for the next claim, or `null` when unknown. */
  projectedUsdMicros: number | null;
  usdMicrosThisBlock: number;
  usdMicrosThisWeek: number;
  capPerBlockUsdMicros: number;
  capPerWeekUsdMicros: number;
  /** Stable id for the current 6h UTC block — used to dedupe pause logs. */
  blockId: string;
  logger: GateLogger;
  /**
   * Optional cross-restart memo hydration. Called the first time this
   * process sees `(credentialId, window)` and an over-cap decision is
   * being made — returns true iff an `ai_units_cap_reached` row was
   * already persisted for `(credentialId, window, blockId)`. When true,
   * the gate seeds its memo silently so the daemon does not re-emit the
   * event after a restart inside the same 6h block. Issue #815 finding 1.
   */
  hasPersistedCapReached?: (window: AiUnitsGateWindow, blockId: string) => boolean;
}

export type AiUnitsGateDecision =
  | { proceed: true }
  | {
      proceed: false;
      window: AiUnitsGateWindow;
      reason: string;
      newlyPaused: boolean;
    };

/**
 * Module-level memo: last-paused state per (credential, window, blockId).
 * Both windows key on the same 6h `blockId`: the block-window pause naturally
 * resets at block rollover, and the week-window pause re-fires on each new 6h
 * block so operators see the pause persists in fresh logs/events instead of
 * one silent indefinite mute. The spec's "exactly one event per (credential,
 * window, block-id)" guarantee is satisfied by the blockId-keyed dedup.
 *
 * To preserve that guarantee across daemon restarts inside the same 6h block,
 * the gate hydrates this memo on first encounter of a `(credentialId, window)`
 * pair by calling `args.hasPersistedCapReached` (issue #815 finding 1).
 */
const lastPausedMemo = new Map<string, { window: AiUnitsGateWindow; blockId: string }>();
/** Tracks which `(credentialId, window)` pairs have been hydrated this process lifetime. */
const hydrated = new Set<string>();

function memoKey(credentialId: string, window: AiUnitsGateWindow): string {
  return `${credentialId}::${window}`;
}

/**
 * Fail-open paranoia: an unknown projection (model not in cost table,
 * harness misconfigured) MUST NOT silently halt a working daemon. We
 * surface a one-time warn and let the claim through; #345's per-task
 * USD gate + the provider's monthly cap remain the hard floors.
 */
const warnedUnknownProjection = new Set<string>();

export function gateClaimByAiUnits(args: AiUnitsGateArgs): AiUnitsGateDecision {
  const classification = classifyAiUnitsSpend(args);

  if (args.projectedUsdMicros == null) {
    if (!warnedUnknownProjection.has(args.credentialId)) {
      args.logger.warn(
        `[ai-units-gate] ${args.credentialId} projection unknown for this harness/model; ` +
          'gate is fail-open (proceeding). Add the model to MODEL_COST_TABLE to enable spend gating.',
      );
      warnedUnknownProjection.add(args.credentialId);
    }
    if (!classification.proceed) {
      throw new Error('unreachable: unknown AI-spend projection must classify fail-open');
    }
    return classification;
  }

  const projected = args.projectedUsdMicros;
  const blockTotal = args.usdMicrosThisBlock + projected;
  const weekTotal = args.usdMicrosThisWeek + projected;

  if (classification.proceed) {
    // Clear memos for this credential when we are below both caps.
    lastPausedMemo.delete(memoKey(args.credentialId, 'block'));
    lastPausedMemo.delete(memoKey(args.credentialId, 'week'));
    return { proceed: true };
  }

  // Prefer the block reason when both fire — the block is the tighter,
  // operator-relevant frame; the weekly cap is the safety net.
  const window = classification.window;
  const total = window === 'block' ? blockTotal : weekTotal;
  const cap = window === 'block' ? args.capPerBlockUsdMicros : args.capPerWeekUsdMicros;
  const reason =
    `Spend ${window} cap reached for ${args.credentialId} ` +
    `($${(total / 1_000_000).toFixed(4)} / $${(cap / 1_000_000).toFixed(4)}; ` +
    `+$${(projected / 1_000_000).toFixed(4)} projected for this claim)`;

  const key = memoKey(args.credentialId, window);
  // Cross-restart hydration: the first time this process encounters a
  // `(credentialId, window)` pair, ask the store whether the cap-reached
  // event was already persisted for this `(credentialId, window, blockId)`.
  // If so, seed the memo so `newlyPaused` stays false. Issue #815 finding 1.
  if (!hydrated.has(key)) {
    hydrated.add(key);
    if (
      !lastPausedMemo.has(key) &&
      args.hasPersistedCapReached?.(window, args.blockId) === true
    ) {
      lastPausedMemo.set(key, { window, blockId: args.blockId });
    }
  }

  const prev = lastPausedMemo.get(key);
  const newlyPaused =
    prev === undefined || prev.window !== window || prev.blockId !== args.blockId;

  if (newlyPaused) {
    args.logger.warn(`[ai-units-gate] ${reason}; pausing claims for this credential`);
  }
  lastPausedMemo.set(key, { window, blockId: args.blockId });

  return { proceed: false, window, reason, newlyPaused };
}

/**
 * Test-only: reset all module-level memos between tests. The gate stores
 * per-credential paused state across calls so transitions log/event once.
 */
export function _resetAiUnitsGateMemoForTests(): void {
  lastPausedMemo.clear();
  warnedUnknownProjection.clear();
  hydrated.clear();
}
