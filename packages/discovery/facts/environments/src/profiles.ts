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

export const environmentFactsProfile: FactsProfileDocument = loadProfile("environment.v1.json");

/**
 * Coexists with v1; v1's bytes and meaning stay frozen. v2 closes the join-edge gap the
 * completeness rule names (protocol design §12, amendment 2026-08-28): the parser is pinned by
 * digest in the record's own bytes, so `parser.digest` is an outbound reference the card owes
 * an index, and inverting it answers "which environments run parser `sha256:X`".
 */
export const environmentFactsProfileV2: FactsProfileDocument = loadProfile("environment.v2.json");
