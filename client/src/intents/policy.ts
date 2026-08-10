/**
 * Policy intent module.
 *
 * Per the intent-module law (DR-2026-08-05 decision-3 / headless design §4.1,
 * docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md): a CLI verb is a
 * thin front-end over a PURE intent module — config in, structured result out. No
 * `CommandContext`, no argv parsing, no writer/exit. The `jinn policy` CLI verb
 * (`cli/commands/policy.ts`) is one front-end; a future read-plane HTTP twin would be another, and
 * neither invokes the other — both converge here.
 *
 * Read-only: it reports the resolved claim policy (config shape v2's `claimPolicy`, spec §9). The
 * only impurity is `generatedAt` (a wall-clock read).
 */
import type { ClaimPolicyConfig } from '../config/shape-v2.js';

export interface PolicyIntentInput {
  /** The resolved `claimPolicy` config slice, or undefined when unconfigured. */
  readonly claimPolicy: ClaimPolicyConfig | undefined;
}

export interface PolicyShowResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verb: 'policy show';
  /** The configured claim policy, or `null` when unconfigured (the CLAIM_NOTHING posture). */
  readonly claimPolicy: ClaimPolicyConfig | null;
}

export function describeClaimPolicyIntent(input: PolicyIntentInput): PolicyShowResult {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'policy show',
    claimPolicy: input.claimPolicy ?? null,
  };
}
