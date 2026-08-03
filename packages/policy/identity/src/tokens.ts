// SPDX-License-Identifier: MIT

/**
 * Format tokens and pinned external constants for `@jinn-network/policy-identity`.
 *
 * Authority: `docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md`
 * ("the substrate design"), §4.1, §4.2, §5.1, §5.2.
 *
 * These are **format tokens**, not record kinds and not media types (substrate §2). Nothing in
 * this package claims tier-2 status; §5.4 records the single graduation trigger.
 */

/** Substrate §4.1 — the execution-policy tuple's `formatToken`. */
export const EXECUTION_TUPLE_FORMAT_TOKEN = "network.jinn.policy.execution-tuple/1.0" as const;

/** Substrate §5.1 — the candidate manifest's `formatToken`. */
export const CANDIDATE_MANIFEST_FORMAT_TOKEN = "network.jinn.policy.candidate/1.0" as const;

/**
 * Substrate §5.2 — the DSSE payload shape is pinned to an in-toto Statement whose
 * `predicateType` is the candidate format token. Raw-bytes signing is not a conforming
 * alternative. Both spellings are adopted unchanged from the stack's Result Evaluation
 * Statement precedent (`packages/evidence/protocol/src/identifiers.ts`), mirrored rather than
 * imported: this package is pure and depends on protocol/record layers only (substrate §2).
 */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;

/** Substrate §4.1 — the four core axes, always present in a tuple, `null` when unconstrained. */
export const CORE_AXES = ["harness", "model", "loadout", "isolationPolicy"] as const;

/** Substrate §4.2 / the ratified 2026-07-23 impl-state-sharing spike — the loadout kind. */
export const HARNESS_STATE_LOADOUT_KIND = "jinn.harness-state.v1" as const;

/** Substrate §4.2 — the named tree-hash profile the harness-state loadout kind digests under. */
export const LEARNER_PUBLIC_V1 = "learner-public.v1" as const;

/**
 * `learner-public.v1` excluded roots (substrate §4.2). Bytes under these roots never reach the
 * digest — which is exactly why a package carrying **any** of them is rejected at
 * materialization on every path (§4.2, the smuggled-`.git/hooks` rule).
 */
export const LEARNER_PUBLIC_V1_EXCLUDED_ROOTS = [
  ".git",
  "operator-requests",
  "secrets",
  "transcripts",
] as const;

/**
 * `learner-public.v1` exhaustive top-level classification. Anything not named here fails
 * closed. Pinned against C3's shipped regression suite
 * (`client/test/harnesses/hash-profile.test.ts`); the two surfaces must not drift.
 */
export const LEARNER_PUBLIC_V1_ALLOWED_DIRS = [
  ".archive",
  "agents",
  "configs",
  "hooks",
  "notes",
  "patterns",
  "plans",
  "runs",
  "skills",
  "strategies",
  "tests",
  "tools",
  "tunables",
] as const;

export const LEARNER_PUBLIC_V1_ALLOWED_FILES = ["policy.json"] as const;
