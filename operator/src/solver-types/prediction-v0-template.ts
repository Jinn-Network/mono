/**
 * Sentinel resolution for prediction.v1 Task templates.
 *
 * Two sentinels are supported in template JSON (e.g.,
 * `operator/fixtures/prediction-v1-task.example.json`):
 *
 *   1. window.startTs = 0 → rewritten as Date.now() at call time; the rest of
 *      the window (endTs) and resolveTs are computed relative to that.
 *
 *   2. spec.question.threshold = "current[±N[%]]" → read the Chainlink feed
 *      named in spec.oracle and substitute an absolute price:
 *
 *        "current"         → current price exactly
 *        "current+0.5%"    → current × 1.005
 *        "current-2%"      → current × 0.98
 *        "current+100"     → current + 100
 *        "current-50"      → current - 50
 *
 *      The on-chain Task always carries an absolute decimal string; the
 *      sentinel is ONLY resolved at post time. Evaluator + Harnesses
 *      never see the sentinel form.
 *
 * Exported as a pure function with a `readCurrent` dep so it's trivially
 * unit-testable. Both the `jinn tasks submit --spec-file` path and the
 * future auto-generator (jinn-mono-9ew) call through this helper.
 */

import {
  PredictionV1TaskSchema,
  type PredictionV1Task,
} from '../types/prediction.js';
import { PREDICTION_V1_KIND } from './constants.js';

// ── Sentinel parsers ──────────────────────────────────────────────────────────

/**
 * Parse a `current[±N[%]]` sentinel. Returns a function that takes the current
 * price (decimal string) and produces an absolute threshold (decimal string).
 * Throws if the sentinel doesn't match the expected grammar.
 */
function parseCurrentSentinel(sentinel: string): (current: string) => string {
  if (sentinel === 'current') {
    return (current) => current;
  }
  const match = sentinel.match(/^current([+-])(\d+(?:\.\d+)?)(%?)$/);
  if (!match) {
    throw new Error(
      `invalid threshold sentinel: ${JSON.stringify(sentinel)}. ` +
      `Expected "current" or "current±N" or "current±N%" (e.g., "current+0.5%").`,
    );
  }
  const [, sign, numStr, pct] = match;
  const delta = parseFloat(numStr!);
  if (!Number.isFinite(delta) || delta < 0) {
    throw new Error(`invalid threshold sentinel magnitude: ${numStr}`);
  }
  return (current: string) => {
    const curNum = parseFloat(current);
    if (!Number.isFinite(curNum) || curNum < 0) {
      throw new Error(`invalid current price for sentinel resolution: ${current}`);
    }
    const offset = pct ? curNum * (delta / 100) : delta;
    const signed = sign === '+' ? offset : -offset;
    const result = curNum + signed;
    // 4 decimal places is plenty of resolution for price comparisons.
    // Strip trailing zeros for human-readable output.
    return result.toFixed(4).replace(/\.?0+$/, '');
  };
}

/** Returns true iff the given value looks like a "current[±N[%]]" sentinel. */
export function isCurrentSentinel(value: unknown): boolean {
  return typeof value === 'string' && /^current([+-]\d+(\.\d+)?%?)?$/.test(value);
}

// ── Resolve a template ─────────────────────────────────────────────────────────

export interface TemplateReaderDeps {
  /**
   * Read the current price of the Chainlink feed referenced in the template.
   * Required only when the template uses a `current[±…]` threshold sentinel
   * (see {@link predictionV1TemplateNeedsReadCurrent}).
   */
  readCurrent?: (args: {
    feed: `0x${string}`;
    venue: 'chainlink-base' | 'chainlink-base-sepolia';
  }) => Promise<string>;
  /**
   * Window duration when the template uses `window.startTs = 0` (now-relative
   * sentinel). Default: 10 min — syncs with the 15-min fast-test epoch cadence
   * on testnet. Set to 3_600_000 for a 1h window (mainnet-style dogfood).
   */
  windowDurationMs?: number;
  /**
   * Resolve gap when the template uses `window.startTs = 0`. Default: 5 min.
   * `resolveTs = endTs + resolveGapMs`. Bounded by schema to ≤ 1h.
   */
  resolveGapMs?: number;
}

/** Default window duration for the startTs-sentinel fill. Tuned for fast-test. */
export const DEFAULT_WINDOW_DURATION_MS = 600_000;
/** Default resolve gap for the startTs-sentinel fill. Tuned for fast-test. */
export const DEFAULT_RESOLVE_GAP_MS = 300_000;

/**
 * True if {@link resolvePredictionV1Template} will call `readCurrent` for this
 * template (Chainlink). `window.startTs === 0` does not need `readCurrent`.
 */
export function predictionV1TemplateNeedsReadCurrent(template: unknown): boolean {
  if (typeof template !== 'object' || template === null) return false;
  const t = template as Record<string, unknown>;
  const spec = t['spec'] as
    | {
        kind?: string;
        question?: { kind?: string; threshold?: unknown };
      }
    | undefined;
  if ((t['solverType'] ?? PREDICTION_V1_KIND) !== PREDICTION_V1_KIND) return false;
  if (spec?.question?.kind === 'threshold' && typeof spec.question.threshold === 'string') {
    return isCurrentSentinel(spec.question.threshold);
  }
  return false;
}

/**
 * Resolve all supported sentinels in a raw prediction.v1 template + return a
 * parsed, validated PredictionV1Task.
 *
 * The template must be the JSON shape of a PredictionV1Task with optional
 * sentinel values. Callers that build the template from multiple sources
 * (CLI --spec-file + --id + --description) should merge their bits BEFORE
 * calling this helper.
 */
export async function resolvePredictionV1Template(
  template: unknown,
  deps: TemplateReaderDeps,
): Promise<PredictionV1Task> {
  if (typeof template !== 'object' || template === null) {
    throw new Error('resolvePredictionV1Template: template must be an object');
  }
  // Shallow clone so we don't mutate caller's input.
  const stub = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;

  // ── (1) window.startTs = 0 → now-relative ──────────────────────────────────
  const windowMs = deps.windowDurationMs ?? DEFAULT_WINDOW_DURATION_MS;
  const resolveMs = deps.resolveGapMs ?? DEFAULT_RESOLVE_GAP_MS;
  const win = stub['window'] as { startTs?: number; endTs?: number } | undefined;
  if (win && win.startTs === 0) {
    const now = Date.now();
    win.startTs = now;
    win.endTs = now + windowMs;
    const spec = stub['spec'] as { question?: { resolveTs?: number } } | undefined;
    if (spec?.question) {
      spec.question.resolveTs = now + windowMs + resolveMs;
    }
  }

  // ── (2) spec.question.threshold sentinel → absolute price ──────────────────
  const spec = stub['spec'] as
    | {
        oracle?: { feed?: `0x${string}`; venue?: 'chainlink-base' | 'chainlink-base-sepolia' };
        question?: { kind?: string; threshold?: string };
      }
    | undefined;

  if (
    spec &&
    spec.question?.kind === 'threshold' &&
    typeof spec.question.threshold === 'string'
  ) {
    const t = spec.question.threshold;
    if (isCurrentSentinel(t)) {
      if (!deps.readCurrent) {
        throw new Error(
          'resolvePredictionV1Template: readCurrent is required when spec.question.threshold uses a current[±…] sentinel',
        );
      }
      if (!spec.oracle?.feed || !spec.oracle.venue) {
        throw new Error(
          'cannot resolve threshold sentinel: spec.oracle.feed and spec.oracle.venue are required',
        );
      }
      const current = await deps.readCurrent({
        feed: spec.oracle.feed,
        venue: spec.oracle.venue,
      });
      const resolveFn = parseCurrentSentinel(t);
      spec.question.threshold = resolveFn(current);
    } else if (t.toLowerCase().startsWith('current')) {
      // Eager error: looks like an intended sentinel but didn't match the grammar.
      // Saves operators from pushing garbage on-chain only to fail at eval time.
      throw new Error(
        `unknown threshold sentinel: ${JSON.stringify(t)}. ` +
        `Expected "current" or "current±N" or "current±N%" (e.g., "current+0.5%"). ` +
        `If you meant a literal absolute threshold, use a pure decimal string (e.g., "3000").`,
      );
    }
  }

  // Final Zod parse — all refinements (window span, resolveTs offset) enforced.
  return PredictionV1TaskSchema.parse(stub);
}
