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
