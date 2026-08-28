import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFactsProfile } from "@jinn-network/record-discovery-protocol";
import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// Declarative field labeling only, loaded from the bundled `profiles/*.json` and parsed (and
// record-kind-URI-validated) through protocol's owned contract.

const profilesRoot = new URL("../profiles/", import.meta.url);

function loadProfile(filename: string): FactsProfileDocument {
  return parseFactsProfile(
    JSON.parse(readFileSync(fileURLToPath(new URL(filename, profilesRoot)), "utf8")),
  );
}

export const chainEnvironmentFactsProfile: FactsProfileDocument =
  loadProfile("chain-environment.v1.json");

export const cryptoEnvironmentFactsProfile: FactsProfileDocument =
  loadProfile("crypto-environment.v1.json");

export const informationWorldFactsProfile: FactsProfileDocument =
  loadProfile("information-world.v1.json");

// The v2 revisions close the join-edge gap the completeness rule names (protocol design §12,
// amendment 2026-08-28). Each coexists with its v1; v1 bytes and meaning stay frozen.

/** Adds the promotion-lineage edge every chain environment may carry. */
export const chainEnvironmentFactsProfileV2: FactsProfileDocument =
  loadProfile("chain-environment.v2.json");

/**
 * Adds the composite's remaining outbound references: the information worlds it composes (v1
 * counted them without naming them, so "which composites use this world" was unanswerable from
 * the card), the service-runtime images it pins, and its lineage pointer.
 */
export const cryptoEnvironmentFactsProfileV2: FactsProfileDocument =
  loadProfile("crypto-environment.v2.json");

/** Adds the re-capture lineage edge. A corpus body is inline, not a referenced record. */
export const informationWorldFactsProfileV2: FactsProfileDocument =
  loadProfile("information-world.v2.json");
