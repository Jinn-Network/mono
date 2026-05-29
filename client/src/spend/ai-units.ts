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

/** 6h block in milliseconds — UTC blocks start at 00:00 / 06:00 / 12:00 / 18:00. */
const SIX_HOUR_BLOCK_MS = 6 * 60 * 60 * 1_000;
/** 7 days in milliseconds — UTC-aligned. */
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Project the AI-unit cost of one task for a harness/model combination.
 *
 * - Returns `0` when the credential resolves to a subscription path
 *   (`anthropic:subscription`, `openai:subscription`) — the provider's
 *   own quota is the cap; the AI-units gate stays out of the way.
 * - Returns `0` for harnesses that make no marginal LLM call
 *   (prediction harnesses, evaluators, unknown harnesses).
 * - Returns `null` when the harness IS on a paid-API path but the model
 *   is unknown to the cost table — the caller treats that as "no
 *   projection available" and surfaces "unavailable" rather than
 *   gating on a guess.
 * - Otherwise returns `cost.usd / GPT_5_4_MINI_USD_PER_BLOCK * 100`.
 *
 * `credentialId` is the env-resolved auth path
 * (`anthropic:subscription`, `anthropic:api-key`, `openai:api-key`,
 * `hermes:api-key`, …). When omitted, defaults to "treat the harness as
 * subscription-only" so callers without env access (the SPA panel
 * pre-join) get the safer reading.
 */
export function projectAiUnits(
  harness: string | undefined,
  model: string | undefined,
  credentialId?: string | null,
): number | null {
  if (!harness) return null;
  const canonical = canonicalHarnessName(harness);
  const isPaidLlmHarness =
    canonical === CLAUDE_CODE_HARNESS ||
    canonical === CODEX_HARNESS ||
    canonical === HERMES_AGENT_HARNESS;
  if (!isPaidLlmHarness) return 0;
  // Subscription credentials => the provider's quota is the cap.
  if (credentialId && credentialId.endsWith(':subscription')) return 0;
  // Paid-API credential (`*:api-key`) or no resolved credential (caller
  // doesn't know): project the model cost. When no credential is
  // resolved AND the harness is claude-code / codex, prefer 0 — that's
  // the "no provider key set" state where no claims will actually run.
  if (!credentialId && (canonical === CLAUDE_CODE_HARNESS || canonical === CODEX_HARNESS)) {
    return 0;
  }
  if (!model) return null;
  const cost = estimateModelCost(model);
  if (!cost) return null;
  return (cost.usd / GPT_5_4_MINI_USD_PER_BLOCK) * 100;
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

/** Reset instant for the 7-day window — `now + (boundary - elapsed)`. We use rolling 7d here. */
export function weekResetsAtUtc(now: Date): Date {
  return new Date(now.getTime() + SEVEN_DAY_MS);
}
