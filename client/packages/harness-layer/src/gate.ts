/**
 * The promotion gate — which layer-1 evidence is eligible to distil
 * (spec/2026-07-06-distillation-v1.md §6, D3/D10).
 *
 * Tiered eligibility: a `completed` + `evaluator-verified` trace is
 * **pattern-eligible** (→ strategic pattern); a `failed` + `evaluator-verified`
 * trace is **lesson-eligible** (→ failure lesson). Both require
 * `provenance: 'contributed'`, not-held-out, and a passing redaction-health
 * check. Noise (`INVALID`/`INDETERMINATE`/`abandoned`, `user-accepted` failures)
 * is not distillable — the bridge (§8) already drops non-definitive verdicts, and
 * this gate is the second, evidence-level guard.
 *
 * The redaction-health guard (the #1409 defence, corrected per the adversarial
 * review): measure **intra-value placeholder density** (placeholder chars ÷
 * content chars) over the **union of every stage's placeholder shape**, and only
 * on values long enough for shredding to be the harm — a short fully-redacted
 * value is a legitimate single-secret redaction, not prose-mangling.
 */

import type { TraceEnvelopeV0 } from './envelope.js';

export type EligibilityTier = 'pattern' | 'lesson';

export interface RedactionHealth {
  /** True when some long content value is mostly placeholder tokens. */
  defaced: boolean;
  /** The worst intra-value placeholder density seen (over length-qualifying values). */
  maxValueDensity: number;
}

export interface EligibilityResult {
  eligible: boolean;
  tier: EligibilityTier | null;
  reasons: string[];
  redactionHealth: RedactionHealth;
}

/**
 * Union of the placeholder shapes the layer-1 pipeline emits (§6, §10).
 * Module-level `const` with the `g` flag: safe here because `String.match`
 * (used below, not `RegExp.exec` in a loop) ignores/resets `lastIndex` on each
 * call — do not switch to `.exec()` without resetting `lastIndex`.
 */
const PLACEHOLDER_RE = /\[SECRET:[^\]]*\]|\[PII:[^\]]*\]|\[EMAIL\]|\[[A-Z]+_\d+\]/g;
/** Below this length a fully-redacted value is a legit single-secret redaction, not shredding. */
const MIN_CONTENT_LEN = 64;
const DEFAULT_MAX_DENSITY = 0.4;

/**
 * Content-bearing string values to check for defacement: every step attribute
 * PLUS the scrubbed prose surfaces `task.summary` and `outcome.summary`. The
 * summaries are exactly the fields the distiller reads first (§7) and the ones
 * #1409 defaced, so guarding only step attributes would leave the module's main
 * target uncovered.
 *
 * NOTE (v1 scope): only TOP-LEVEL string values are measured. `attributes` is
 * `z.record(z.unknown())`, so a value may be a nested object/array — those are
 * skipped. v1 bridged evidence carries flat string attributes (a patch, a
 * verdict), so this is sufficient today; recursing into nested values is a
 * follow-up if a harness ever emits structured attributes.
 *
 * NOTE (deliberate deviation from §6): §6 prefers driving the guard off the
 * recorded redaction receipt (`redactedKeys`/`truncatedKeys`). We instead scan
 * the union of placeholder SHAPES across all content-bearing values, because
 * `task.summary`/`outcome.summary` have no per-key receipt and a uniform scan
 * covers them. The trade-off is brittleness: a NEW placeholder shape must be
 * added to PLACEHOLDER_RE or it is invisible to the density metric.
 */
function contentBearingValues(env: TraceEnvelopeV0): string[] {
  const out: string[] = [];
  for (const step of env.steps) {
    for (const value of Object.values(step.attributes)) {
      if (typeof value === 'string') out.push(value);
    }
  }
  if (typeof env.task.summary === 'string') out.push(env.task.summary);
  if (typeof env.outcome.summary === 'string') out.push(env.outcome.summary);
  return out;
}

export function redactionHealth(env: TraceEnvelopeV0, maxDensity = DEFAULT_MAX_DENSITY): RedactionHealth {
  let worst = 0;
  for (const value of contentBearingValues(env)) {
    if (value.length < MIN_CONTENT_LEN) continue;
    const placeholderChars = (value.match(PLACEHOLDER_RE) ?? []).reduce((n, m) => n + m.length, 0);
    const density = placeholderChars / value.length;
    if (density > worst) worst = density;
  }
  return { defaced: worst > maxDensity, maxValueDensity: worst };
}

export function evaluateEligibility(
  env: TraceEnvelopeV0,
  opts: { heldOut?: boolean; maxPlaceholderDensity?: number } = {},
): EligibilityResult {
  const maxDensity = opts.maxPlaceholderDensity ?? DEFAULT_MAX_DENSITY;
  const reasons: string[] = [];
  const rh = redactionHealth(env, maxDensity);

  if (env.provenance !== 'contributed') {
    reasons.push('not contributed (imported seeds are already-distilled layer-2, not raw evidence)');
  }
  if (opts.heldOut) {
    reasons.push('in the held-out cap-v0 slate');
  }
  if (rh.defaced) {
    reasons.push(`defaced: placeholder density ${rh.maxValueDensity.toFixed(2)} exceeds ${maxDensity}`);
  }

  let tier: EligibilityTier | null = null;
  const evaluatorVerified = env.outcome.verifiabilityTier === 'evaluator-verified';
  if (env.outcome.status === 'completed' && evaluatorVerified) {
    tier = 'pattern';
  } else if (env.outcome.status === 'failed' && evaluatorVerified) {
    tier = 'lesson';
  } else {
    reasons.push(
      `outcome not distillable (status=${env.outcome.status}, tier=${env.outcome.verifiabilityTier}; ` +
        'need evaluator-verified completed→pattern or failed→lesson)',
    );
  }

  const eligible = reasons.length === 0 && tier !== null;
  return { eligible, tier: eligible ? tier : null, reasons, redactionHealth: rh };
}
