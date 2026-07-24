/**
 * AI-units calibration — the universal cost language for the M1
 * cost-protection throttle (issue #815).
 *
 * One "AI unit" is the marginal USD cost of one task on the
 * GPT-5.4-mini Codex-Plus baseline, scaled so that **100 units = 10% of a
 * 6-hour-block-equivalent USD spend on that baseline**. Every other
 * harness/model converts its USD cost-per-task through the same peg
 * (`USD / GPT_5_4_MINI_USD_PER_BLOCK * 100`).
 *
 * Why a unit-of-account rather than raw USD: the ceiling is the same
 * **100 units per 6h block** for every harness/model, so an operator on
 * Haiku 4.5 (~1 unit/task) gets ~100 tasks per block, while an operator
 * on Opus 4.7 (~50 units/task) gets ~2 tasks per block. The peg keeps the
 * ceiling readable and ties it to the milestone framing of "~10% of a
 * baseline AI subscription's weekly cap" (#605).
 *
 * The cap is layered with the existing per-credential USD `spendCaps`
 * spend-cap gate from PR #345/#346 — both gates run; the more
 * conservative one wins. This module owns the AI-units side only.
 *
 * Issue #1004: the gate's comparison now runs in **USD** (actual harvested
 * spend vs a USD ceiling), not projected AI units. The peg below survives
 * as the calibration constant deriving that USD ceiling and as the
 * presentation-layer conversion for the legacy unit fields the SPA still
 * reads. For subscription credentials the USD ceiling is a *proxy* budget —
 * it bounds Jinn-attributable model cost, not the provider's plan quota.
 */

import { estimateModelCost } from '../harnesses/cost-estimates.js';
import {
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,
  canonicalHarnessName,
} from '../harnesses/names.js';

/**
 * Calibration peg: the USD cost of one GPT-5.4-mini Codex-Plus 6h block.
 * Derived from a typical Codex Plus 6h block on GPT-5.4-mini: ~10 tasks at
 * ~$0.0525/task (50k input × $0.00025/1k + 20k output × $0.002/1k) → ~$0.5.
 *
 * Conservative — biases toward over-warning rather than under-warning so
 * the ceiling pauses early rather than late.
 *
 * Issue #1004: demoted to a calibration constant — it derives
 * {@link REFERENCE_CEILING_USD_MICROS} and converts the legacy unit fields
 * for presentation, but no longer appears in the gate's comparison. Kept
 * exported because the SPA's `HarnessFootprintPanel.tsx` imports it (#1006).
 */
export const GPT_5_4_MINI_USD_PER_BLOCK = 0.5;

/**
 * The default reference ceiling — 100 AI units per 6h UTC-aligned block,
 * with a weekly safety net at 28 × that (one block × 28 blocks/week).
 *
 * Override at runtime with `JINN_AI_UNITS_CEILING_OVERRIDE` (see
 * `resolveReferenceCeiling`). Set as `<units>` for a per-block override
 * (weekly auto-scales to 28×) or `<block>:<week>` for both explicitly.
 */
export const REFERENCE_CEILING: { readonly units_per_block: number; readonly units_per_week: number } = {
  units_per_block: 100,
  units_per_week: 100 * 28,
};

/**
 * USD-micros ceiling (issue #1004). The gate now compares **actual USD
 * spend** against this ceiling rather than projected AI units. Derived
 * directly from {@link REFERENCE_CEILING} through the GPT-5.4-mini peg:
 *   usd_micros = units / 100 * GPT_5_4_MINI_USD_PER_BLOCK * 1_000_000.
 * Default 100 units/block => $0.50/block (500_000 micros); 2800 units/week
 * => $14/week (14_000_000 micros). Calibration is preserved; only the
 * comparison unit changed. For subscription credentials this USD budget is
 * a *proxy* — it bounds Jinn-attributable model cost, not the provider's
 * plan quota directly.
 */
export const REFERENCE_CEILING_USD_MICROS: {
  readonly usd_micros_per_block: number;
  readonly usd_micros_per_week: number;
} = {
  usd_micros_per_block: unitsToUsdMicros(REFERENCE_CEILING.units_per_block),
  usd_micros_per_week: unitsToUsdMicros(REFERENCE_CEILING.units_per_week),
};

/** Convert an AI-unit count to USD micros through the GPT-5.4-mini peg. */
function unitsToUsdMicros(units: number): number {
  return Math.round((units / 100) * GPT_5_4_MINI_USD_PER_BLOCK * 1_000_000);
}

/** 6h block in milliseconds — UTC blocks start at 00:00 / 06:00 / 12:00 / 18:00. */
const SIX_HOUR_BLOCK_MS = 6 * 60 * 60 * 1_000;
/** 7 days in milliseconds — UTC-aligned. */
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1_000;

export type AiUnitsSpendWindow = 'block' | 'week';

export interface AiUnitsSpendClassificationArgs {
  /** USD micros projected for the next claim, or `null` when unknown. */
  projectedUsdMicros: number | null;
  usdMicrosThisBlock: number;
  usdMicrosThisWeek: number;
  capPerBlockUsdMicros: number;
  capPerWeekUsdMicros: number;
}

export type AiUnitsSpendClassification =
  | { proceed: true }
  | { proceed: false; window: AiUnitsSpendWindow };

/**
 * Classify one prospective claim against the AI-spend ceilings.
 *
 * This is the shared, side-effect-free source of truth used by both the
 * daemon gate and `/v1/status`: compare current spend plus the prospective
 * debit using the gate's strict `>` boundary, fail open when the projection
 * is unknown, and prefer the block window when both ceilings would be
 * exceeded.
 */
export function classifyAiUnitsSpend(
  args: AiUnitsSpendClassificationArgs,
): AiUnitsSpendClassification {
  if (args.projectedUsdMicros == null) return { proceed: true };

  const overBlock =
    args.usdMicrosThisBlock + args.projectedUsdMicros > args.capPerBlockUsdMicros;
  const overWeek =
    args.usdMicrosThisWeek + args.projectedUsdMicros > args.capPerWeekUsdMicros;

  if (overBlock) return { proceed: false, window: 'block' };
  if (overWeek) return { proceed: false, window: 'week' };
  return { proceed: true };
}

/**
 * Project the AI-unit cost of one task for a harness/model combination.
 *
 * The AI-units cap meters every paid-LLM harness by model cost,
 * regardless of whether the operator routes through a subscription
 * (`*:subscription`) or a raw API key (`*:api-key`). Subscription
 * quota is finite — the cap exists exactly to bound how much of it a
 * node will burn on Jinn (the spec's "operators commit to a 48h
 * burn-in knowing exactly what their node will consume" — issue #901
 * corrected the #815 implementer's "subscription = 0 units" shortcut).
 *
 * - Returns `0` for harnesses that make no marginal LLM call
 *   (prediction harnesses, evaluators, unknown harnesses).
 * - Returns `null` when the harness IS a paid-LLM harness but the
 *   model is unknown to the cost table — the caller treats that as
 *   "no projection available" and the gate fails *open* with a warn.
 * - Otherwise returns `cost.usd / GPT_5_4_MINI_USD_PER_BLOCK * 100`.
 *
 * `credentialId` is the env-resolved auth path. It does NOT change
 * the projection (the model costs the same regardless of auth path);
 * it only labels the accounting bucket. The parameter remains for
 * call-site clarity and future-proofing.
 */
export function projectAiUnits(
  harness: string | undefined,
  model: string | undefined,
  _credentialId?: string | null,
): number | null {
  if (!harness) return null;
  const canonical = canonicalHarnessName(harness);
  const isPaidLlmHarness =
    canonical === CLAUDE_CODE_HARNESS ||
    canonical === CODEX_HARNESS ||
    canonical === HERMES_AGENT_HARNESS;
  if (!isPaidLlmHarness) return 0;
  if (!model) return null;
  const cost = estimateModelCost(model);
  if (!cost) return null;
  return (cost.usd / GPT_5_4_MINI_USD_PER_BLOCK) * 100;
}

/**
 * Project the per-task cost of one harness/model combination in USD micros
 * (issue #1004). This is the in-flight debit the gate books for a claim
 * before its actual cost is harvested. Same harness classification as
 * {@link projectAiUnits}:
 *   - `0` for harnesses that make no marginal LLM call,
 *   - `null` when a paid-LLM harness's model is unknown to the cost table
 *     (gate fails open with a warn),
 *   - otherwise `round(estimateModelCost(model).usd * 1_000_000)`.
 *
 * `_credentialId` does not change the projection (the model costs the same
 * regardless of auth path); it labels the accounting bucket only.
 */
export function projectTaskUsdMicros(
  harness: string | undefined,
  model: string | undefined,
  _credentialId?: string | null,
): number | null {
  if (!harness) return null;
  const canonical = canonicalHarnessName(harness);
  const isPaidLlmHarness =
    canonical === CLAUDE_CODE_HARNESS ||
    canonical === CODEX_HARNESS ||
    canonical === HERMES_AGENT_HARNESS;
  if (!isPaidLlmHarness) return 0;
  if (!model) return null;
  const cost = estimateModelCost(model);
  if (!cost) return null;
  return Math.round(cost.usd * 1_000_000);
}

/**
 * Resolve the active ceiling from env. CI / tests override the baked-in
 * 100 units via `JINN_AI_UNITS_CEILING_OVERRIDE`. Accepts:
 *
 *  - `"<n>"` — sets `units_per_block = n`; weekly auto-scales to `n * 28`.
 *  - `"<block>:<week>"` — sets both explicitly.
 *
 * Falls back to the baked-in `REFERENCE_CEILING` on a missing or
 * malformed value (env-typo must not silently disable the gate).
 */
export function resolveReferenceCeiling(
  env: NodeJS.ProcessEnv,
): { units_per_block: number; units_per_week: number } {
  const raw = env['JINN_AI_UNITS_CEILING_OVERRIDE'];
  if (raw == null || raw.trim() === '') {
    return { units_per_block: REFERENCE_CEILING.units_per_block, units_per_week: REFERENCE_CEILING.units_per_week };
  }
  const trimmed = raw.trim();
  if (trimmed.includes(':')) {
    const [a, b] = trimmed.split(':', 2);
    const block = Number(a);
    const week = Number(b);
    if (Number.isFinite(block) && block > 0 && Number.isFinite(week) && week > 0) {
      return { units_per_block: block, units_per_week: week };
    }
    warnMalformedOverride(raw);
    return { units_per_block: REFERENCE_CEILING.units_per_block, units_per_week: REFERENCE_CEILING.units_per_week };
  }
  const block = Number(trimmed);
  if (Number.isFinite(block) && block > 0) {
    return { units_per_block: block, units_per_week: block * 28 };
  }
  warnMalformedOverride(raw);
  return { units_per_block: REFERENCE_CEILING.units_per_block, units_per_week: REFERENCE_CEILING.units_per_week };
}

/**
 * Resolve the active USD-micros ceiling from env (issue #1004). Reuses
 * {@link resolveReferenceCeiling} so the `JINN_AI_UNITS_CEILING_OVERRIDE`
 * parsing (integer or `<block>:<week>`, malformed-warn, default fallback)
 * lives in one place, then converts both bounds through the peg.
 */
export function resolveReferenceCeilingUsdMicros(
  env: NodeJS.ProcessEnv,
): { usd_micros_per_block: number; usd_micros_per_week: number } {
  const units = resolveReferenceCeiling(env);
  return {
    usd_micros_per_block: unitsToUsdMicros(units.units_per_block),
    usd_micros_per_week: unitsToUsdMicros(units.units_per_week),
  };
}

function warnMalformedOverride(raw: string): void {
  // One-time warn per resolve call — the function is only invoked at
  // startup, so a module-level memo is unnecessary. Surfaces the operator's
  // typo instead of silently falling back to the baked-in default.
  console.warn(
    `[ai-units] warn: JINN_AI_UNITS_CEILING_OVERRIDE="${raw}" is malformed — ` +
      `using default ${REFERENCE_CEILING.units_per_block}/${REFERENCE_CEILING.units_per_week} per (block, week)`,
  );
}

/**
 * Start of the 6h UTC-aligned block containing `now`. Blocks begin at
 * 00:00, 06:00, 12:00, 18:00 UTC; `blockStartUtc(t)` returns the most
 * recent such instant ≤ t. Used to bound the "units this block" sum.
 */
function blockStartUtc(now: Date): Date {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceDayStart = now.getTime() - startOfDay;
  // Cap at 3 — 4 blocks per day (indices 0..3); defensive against
  // millisecond rounding pushing the floor over 4 at day boundaries.
  const blocksIn = Math.min(Math.floor(sinceDayStart / SIX_HOUR_BLOCK_MS), 3);
  return new Date(startOfDay + blocksIn * SIX_HOUR_BLOCK_MS);
}

/** Start of the next 6h UTC-aligned block after `now`. */
export function blockResetsAtUtc(now: Date): Date {
  return new Date(blockStartUtc(now).getTime() + SIX_HOUR_BLOCK_MS);
}

/**
 * Stable id for a 6h block — used to dedupe `ai_units_cap_reached`
 * activity events to one-per-(credential, block).
 */
export function blockIdUtc(now: Date): string {
  return blockStartUtc(now).toISOString();
}

/**
 * Coarse fallback reset instant for the 7-day window: `now + 7d`. This is
 * NOT the true "claims resume at" instant for a paused week window — the
 * window is rolling, so it sheds its oldest rows continuously rather than
 * resetting all at once at a fixed point 7 days out. When a credential is
 * actually paused on the week window, `Store.weekWindowResumeAt` computes
 * the accurate resume instant (the moment enough in-window spend expires
 * that `remaining + projected <= cap`); callers should prefer that and fall
 * back to this fixed instant only when the week window is not binding (in
 * which case the value isn't operator-relevant). See issue #830.
 */
export function weekResetsAtUtc(now: Date): Date {
  return new Date(now.getTime() + SEVEN_DAY_MS);
}
