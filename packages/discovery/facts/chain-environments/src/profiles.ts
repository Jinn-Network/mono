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
