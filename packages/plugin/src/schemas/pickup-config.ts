/** Pickup policy config — ported from pickup.py DEFAULT_CONFIG. Injected as a
 *  typed object; no pickup.json fs read in core (architecture §6). */
import { z } from 'zod';

// Weakest → strongest; mirrors VERIFIABILITY_TIERS in the frozen envelope schema.
export const TIER_ORDER = ['user-accepted', 'tests-passed', 'evaluator-verified'] as const;
export type Tier = (typeof TIER_ORDER)[number];

export const PickupConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** @deprecated Legacy host compatibility only — a pre-rescope `pickup.json`
   *  may still send this; evidence-first pickup (rescope §3.3) never reads
   *  it. Auto-adopt and skill classification were removed from the pickup
   *  path entirely by R1/R3 (skills are excluded from selection outright,
   *  not gated by a threshold), so there is no adopt decision left for a
   *  tier to threshold. */
  autoAdopt: z.boolean().default(false),
  /** @deprecated Legacy host compatibility only — same as `autoAdopt`. */
  autoAdoptTier: z.enum(TIER_ORDER).default('evaluator-verified'),
  /** @deprecated Legacy host compatibility only — selection has a fixed cap
   *  (`MAX_SELECTED_PACKETS` in `pickup.ts`), not an operator-configurable one. */
  maxCandidates: z.number().int().positive().default(3),
});

export type PickupConfig = z.infer<typeof PickupConfigSchema>;

export const DEFAULT_PICKUP_CONFIG: PickupConfig = PickupConfigSchema.parse({});

/** Merge partial input over defaults; a bad autoAdoptTier coerces to default
 *  (mirrors load_config()'s TIER_ORDER guard). Never throws — bad input → defaults. */
export function parsePickupConfig(input?: unknown): PickupConfig {
  if (input == null || typeof input !== 'object') return { ...DEFAULT_PICKUP_CONFIG };
  const raw = input as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...raw };
  if (!(TIER_ORDER as readonly string[]).includes(String(raw.autoAdoptTier))) {
    delete merged.autoAdoptTier; // fall back to schema default
  }
  const result = PickupConfigSchema.safeParse(merged);
  return result.success ? result.data : { ...DEFAULT_PICKUP_CONFIG };
}
