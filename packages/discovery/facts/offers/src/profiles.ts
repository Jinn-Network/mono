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
 * priced, and — for a priced offer — the rail identifiers with their amounts. No further
 * *terms*: no gate, no fee, no expiry, no liveness. The offer remains the binding document;
 * anything a buyer commits to is checked against the sealed offer, never against a card.
 *
 * `subject` is reference-bearing, which is the whole point of the profile: inverting it
 * through discovery's `referrers` relation answers "which offers price `sha256:X`" without
 * fetching an offer.
 *
 * `supersedes` is the kind's only other outbound reference, and the completeness rule
 * (design §12, amendment 2026-08-28) is a MUST on a new profile: a card must declare its
 * kind's whole outbound set, so an index can invert every edge the record pins. It carries
 * no term — repricing is supersession, and this is the lineage edge, not a price — and it is
 * what lets an index resolve "which offer replaced this one" from cards. It never makes a
 * card self-certifying about its own liveness: supersession retires a predecessor only when
 * the successor is live and shares its subject and holder, which is a fold over a set of
 * offers, never a property of one. An offer that supersedes nothing simply does not announce
 * the field.
 */
export const offerFactsProfile: FactsProfileDocument = loadProfile("offer.v1.json");
