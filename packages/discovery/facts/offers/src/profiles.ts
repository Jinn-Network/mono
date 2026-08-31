// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFactsProfile } from "@jinn-network/record-discovery-protocol";
import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// Declarative field labeling only, loaded from the bundled `profiles/*.json` and parsed
// (and record-kind-URI-validated) through protocol's owned contract.

const profilesRoot = new URL("../profiles/", import.meta.url);

function loadProfile(filename: string): FactsProfileDocument {
  return parseFactsProfile(
    JSON.parse(readFileSync(fileURLToPath(new URL(filename, profilesRoot)), "utf8")),
  );
}

/**
 * The offer card: the offer's own digest, the subject it prices, whether it is free or
 * priced, and — for a priced offer — the rail identifiers with their amounts. Nothing else.
 * The offer remains the binding document; anything a buyer commits to is checked against the
 * sealed offer, never against a card.
 *
 * `subject` is reference-bearing, which is the whole point of the profile: inverting it
 * through discovery's `referrers` relation answers "which offers price `sha256:X`" without
 * fetching an offer.
 */
export const offerFactsProfile: FactsProfileDocument = loadProfile("offer.v1.json");
