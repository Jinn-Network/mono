/**
 * Named impl-state hash profiles.
 *
 * A hash profile is the *identity scheme* for an `implStateDir` tree: which
 * top-level paths are excluded from the digest, which are allowed to
 * contribute, and what happens to anything else. Callers name a profile; they
 * never hand `hashImplStateDir` an ad hoc ignore list, because an ad hoc list
 * is exactly how one tree ends up with two digests.
 *
 * `learner-public.v1` is ratified by
 * docs/superpowers/specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md
 * §3.2 (profile) and §4.1 (exhaustive top-level classification), and is the
 * scheme the policy-identity design
 * (docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md
 * §4.2) pins `jinn.harness-state.v1` loadout digests to.
 *
 * Adding a root is a new profile id, never an in-place mutation of this one.
 */

import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, canonicalHarnessName } from './names.js';

export const LEARNER_PUBLIC_V1 = 'learner-public.v1';

export type HashProfileId = typeof LEARNER_PUBLIC_V1;

export interface HashProfile {
  readonly id: HashProfileId;
  /**
   * Top-level paths excluded from both the digest and any package built from
   * the tree. The array order is canonical (spike §3.2) — it is part of the
   * profile's published identity, so consumers can compare a manifest's list
   * against their registered copy byte-for-byte.
   */
  readonly ignoreRelPaths: readonly string[];
  /** Top-level directories that may contribute to the digest. */
  readonly allowedDirs: readonly string[];
  /** Top-level regular files that may contribute to the digest. */
  readonly allowedFiles: readonly string[];
}

/**
 * Spike §4.1, in full. Every top-level entry of a learner `implStateDir` is
 * either ignored, allowed, or refused — there is no fourth outcome and no v0
 * override.
 */
const LEARNER_PUBLIC_V1_PROFILE: HashProfile = {
  id: LEARNER_PUBLIC_V1,
  ignoreRelPaths: ['.git', 'operator-requests', 'secrets', 'transcripts'],
  allowedDirs: [
    '.archive',
    'agents',
    'configs',
    'hooks',
    'notes',
    'patterns',
    'plans',
    'runs',
    'skills',
    'strategies',
    'tests',
    'tools',
    'tunables',
  ],
  allowedFiles: ['policy.json'],
};

const REGISTRY: ReadonlyMap<string, HashProfile> = new Map([
  [LEARNER_PUBLIC_V1, LEARNER_PUBLIC_V1_PROFILE],
]);

export class UnknownHashProfileError extends Error {
  readonly profileId: string;
  constructor(profileId: string) {
    super(`unknown impl-state hash profile "${profileId}"`);
    this.name = 'UnknownHashProfileError';
    this.profileId = profileId;
  }
}

/** Resolve a registered profile. Unknown ids fail closed. */
export function resolveHashProfile(id: string): HashProfile {
  const profile = REGISTRY.get(id);
  if (!profile) throw new UnknownHashProfileError(id);
  return profile;
}

/**
 * The profile a harness's `implStateDir` is hashed under, resolved from the
 * harness *name* alone — for surfaces (the daemon status panel) that know the
 * configured harness name but never construct the harness. `claude-code` and
 * `codex` are both `LearnerHarness` instances; every other harness has no
 * registered public profile and keeps its own declared ignore list.
 */
export function hashProfileForHarness(name: string): HashProfileId | undefined {
  const canonical = canonicalHarnessName(name);
  if (canonical === CLAUDE_CODE_HARNESS || canonical === CODEX_HARNESS) return LEARNER_PUBLIC_V1;
  return undefined;
}
