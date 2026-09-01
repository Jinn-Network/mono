import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFactsProfile } from "@jinn-network/record-discovery-protocol";
import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// The three Trust Layer facts-profile documents (design §12): declarative
// field labeling only, loaded from the bundled `profiles/*.json` and parsed
// (and record-kind-URI-validated) through protocol's owned contract.

const profilesRoot = new URL("../profiles/", import.meta.url);

function loadProfile(filename: string): FactsProfileDocument {
  const path = fileURLToPath(new URL(filename, profilesRoot));
  return parseFactsProfile(JSON.parse(readFileSync(path, "utf8")));
}

export const keyBindingProfile: FactsProfileDocument = loadProfile("key-binding.v1.json");
export const authorizationProfile: FactsProfileDocument = loadProfile("authorization.v1.json");
export const trustPolicyProfile: FactsProfileDocument = loadProfile("trust-policy.v1.json");

// The v2 revisions close the join-edge gap the completeness rule names (protocol design §12,
// amendment 2026-08-28). Each coexists with its v1; v1 bytes and meaning stay frozen.
// `trust-policy.v1` gains no revision: `predecessor` really is its whole outbound set.

/**
 * Adds the two components a key binding pins by digest and v1 left unnamed: the ceremony
 * evidence that produced the binding, and the time anchors it cites. "Which bindings rest on
 * ceremony evidence `sha256:X`" is the query a ceremony-evidence retraction has to run.
 */
export const keyBindingProfileV2: FactsProfileDocument = loadProfile("key-binding.v2.json");

/**
 * Adds the delegation chain (`proofs`, the parent authorizations this one attenuates) and the
 * statement's own subjects, each of which pins bytes by digest. v1 declared only `revocation`,
 * which is the same lineage class as `proofs` and was declared while `proofs` was not.
 */
export const authorizationProfileV2: FactsProfileDocument = loadProfile("authorization.v2.json");
