// SPDX-License-Identifier: Apache-2.0

/**
 * Every place the checker's own code and `@jinn-network/verify` answer differently, each with what
 * the runtime switch of issue #5120 does about it. `package-equivalence.test.ts` requires this list
 * to be exact: a difference not named here fails, and so does an entry that no longer differs.
 */

import type { Outcome, SiteId } from "./site-tap.js";
import { SITES } from "./site-tap.js";

const NEEDS_ED25519 = "did:key derivation needs an Ed25519 public key";

export interface KnownDifference {
  readonly site: SiteId;
  /** Corpus cases that show it, with both outcomes exactly. */
  readonly cases: Readonly<Record<string, { readonly local: Outcome; readonly package: Outcome }>>;
  readonly why: string;
  readonly planForRuntimeSwitch: string;
}

export const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  {
    site: SITES.didKeyDerivation,
    cases: {
      "did-key-derivation/p256-key-is-not-refused": {
        local: { returned: "did:key:z6MknnLMgi41Cef18DdXTaN6pbL5bxnvosTFSJUnixbdR9Wj" },
        package: { threw: { name: "Error", message: `${NEEDS_ED25519}, got ec` } },
      },
      "did-key-derivation/p384-key": {
        local: { threw: { name: "Error", message: "Ed25519 public key raw bytes must be 32 bytes, got 48" } },
        package: { threw: { name: "Error", message: `${NEEDS_ED25519}, got ec` } },
      },
      "did-key-derivation/rsa-key": {
        local: { threw: { name: "Error", message: "Ed25519 public key JWK export is missing its x-coordinate" } },
        package: { threw: { name: "Error", message: `${NEEDS_ED25519}, got rsa` } },
      },
    },
    why: "The package checks the key type. The checker's copy reads the JWK x member and checks its length, so a P-256 key, whose x is also 32 bytes, comes back spelled as a did:key it does not control. No bundle reaches this: the one caller, verify.ts, passes a key publicKey() has already held to Ed25519.",
    planForRuntimeSwitch: "Keep didKeyFromEd25519PublicKey in profile/signing.ts as the wrapper didKeyKeepingPinnedOutput in testing/package-sites.ts, because the characterization output must stay byte-identical. It holds the two local refusals and hands the 32 bytes to the package as an Ed25519 key, so the local base58 encoder can go. This suite runs that wrapper at every call and requires no difference.",
  },
];
