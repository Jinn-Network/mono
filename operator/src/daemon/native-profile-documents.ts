/**
 * The task-profile documents a native operator registers, and the store it resolves them from
 * (#2534 F3a).
 *
 * This exists as one named export rather than an inline array because the list has a hard
 * invariant against `PHASE_B_NATIVE_PROFILE_ALLOWLIST` in `native-claim-policy.ts`: a profile a
 * native operator is ALLOWED TO CLAIM must be a profile it can RESOLVE. Those two lists were
 * maintained independently and drifted — `prediction-forecast/1.0` was the sole allowlist entry
 * and was never registered, so every claimed prediction task died 9 ms after submit-intent with
 * "profile digest … is not resolvable in the store" (`task-profile/resolve.ts`), taking the
 * engagement terminal and spending the task (`maxClaims=1`).
 *
 * `native-profile-documents.test.ts` pins the invariant, so the next profile added to the
 * allowlist without a document fails a test instead of every solve.
 */
import {
  buildEvaluationTaskProfile,
  buildPredictionForecastProfile,
  buildRepositoryWorkProfile,
  sealTaskProfile,
  type ProfileStore,
  type TaskProfileDocument,
} from '@jinn-network/task-execution-profiles';

/** Every task-profile document a native operator registers, in registration order. */
export function buildNativeProfileDocuments(): readonly TaskProfileDocument[] {
  return [
    buildRepositoryWorkProfile(),
    buildPredictionForecastProfile(),
    buildEvaluationTaskProfile(),
  ];
}

/**
 * The `ProfileStore` the execution backend resolves pinned profile descriptors against. Keyed by
 * each document's own sealed digest, so a store entry can never disagree with the document it
 * holds — `resolveProfile` re-seals and refuses a mismatch anyway.
 */
export function buildNativeProfileStore(): ProfileStore {
  const byDigest = new Map<`sha256:${string}`, TaskProfileDocument>(
    buildNativeProfileDocuments().map((doc) => [sealTaskProfile(doc).digest, doc]),
  );
  return { get: (digest) => byDigest.get(digest) };
}
