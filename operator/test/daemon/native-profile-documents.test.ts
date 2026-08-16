/**
 * #2534 F3a. The registered profile documents and the native claim allowlist are two lists with a
 * hard invariant between them, and they drifted: `prediction-forecast/1.0` was the sole entry in
 * `PHASE_B_NATIVE_PROFILE_ALLOWLIST` — the only profile a native operator may claim — and was
 * never registered. Every claimed prediction task then died in `resolveProfile` with
 * "profile digest … is not resolvable in the store", 9 ms after submit-intent, terminal, with the
 * task spent (`maxClaims=1`).
 *
 * Before the fix, the first test here goes red.
 */
import { describe, expect, it } from 'vitest';
import {
  PREDICTION_FORECAST_PROFILE_DIGEST,
  PREDICTION_FORECAST_PROFILE_URI,
  resolveProfile,
  sealTaskProfile,
} from '@jinn-network/task-execution-profiles';
import { PHASE_B_NATIVE_PROFILE_ALLOWLIST } from '../../src/daemon/native-claim-policy.js';
import {
  buildNativeProfileDocuments,
  buildNativeProfileStore,
} from '../../src/daemon/native-profile-documents.js';

describe('native profile registration', () => {
  it('registers a resolvable document for every profile a native operator may claim', () => {
    const store = buildNativeProfileStore();
    const byUri = new Map(buildNativeProfileDocuments().map((doc) => [doc.profile, doc]));

    // The invariant, stated directly: allowed-to-claim implies able-to-resolve.
    for (const uri of PHASE_B_NATIVE_PROFILE_ALLOWLIST) {
      const document = byUri.get(uri);
      expect(document, `${uri} is claimable but not registered`).toBeDefined();
      expect(resolveProfile(
        { uri, digest: { sha256: sealTaskProfile(document!).digest.slice('sha256:'.length) } },
        store,
      )).toStrictEqual(document);
    }
  });

  it('resolves prediction-forecast/1.0 at the digest the sealed profile actually carries', () => {
    expect(resolveProfile(
      {
        uri: PREDICTION_FORECAST_PROFILE_URI,
        digest: { sha256: PREDICTION_FORECAST_PROFILE_DIGEST.slice('sha256:'.length) },
      },
      buildNativeProfileStore(),
    ).profile).toBe(PREDICTION_FORECAST_PROFILE_URI);
  });

  it('still refuses a profile digest the store does not hold', () => {
    expect(() => resolveProfile(
      { uri: PREDICTION_FORECAST_PROFILE_URI, digest: { sha256: 'e'.repeat(64) } },
      buildNativeProfileStore(),
    )).toThrow(/is not resolvable in the store/u);
  });

  it('keys the store by each document\'s own sealed digest', () => {
    const store = buildNativeProfileStore();
    for (const document of buildNativeProfileDocuments()) {
      const digest = sealTaskProfile(document).digest;
      expect(store.get(digest)).toStrictEqual(document);
    }
  });
});
