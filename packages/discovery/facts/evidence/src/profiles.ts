import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFactsProfile } from "@jinn-network/record-discovery-protocol";
import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// The three Evidence Protocol facts-profile documents (design §12): declarative
// field labeling only, loaded from the bundled `profiles/*.json` and parsed
// (and record-kind-URI-validated) through protocol's owned contract.

const profilesRoot = new URL("../profiles/", import.meta.url);

function loadProfile(filename: string): FactsProfileDocument {
  const path = fileURLToPath(new URL(filename, profilesRoot));
  return parseFactsProfile(JSON.parse(readFileSync(path, "utf8")));
}

export const executionEvidenceProfile: FactsProfileDocument = loadProfile("execution-evidence.v1.json");
export const resultEvaluationProfile: FactsProfileDocument = loadProfile("result-evaluation.v1.json");
export const executionVerificationProfile: FactsProfileDocument = loadProfile("execution-verification.v1.json");
/** Coexists with v1; consumers select it explicitly and v1 bytes/meaning stay frozen. */
export const executionEvidenceProfileV2: FactsProfileDocument = loadProfile("execution-evidence.v2.json");
/** Exposes every Result subject instead of v1's first-result scalar. */
export const resultEvaluationProfileV2: FactsProfileDocument = loadProfile("result-evaluation.v2.json");

// The next revisions close the join-edge gap the completeness rule names (protocol design §12,
// amendment 2026-08-28). Each coexists with the versions before it, whose bytes stay frozen.

/** Adds the native trace the record pins — the artifact an auditor replays. */
export const executionEvidenceProfileV3: FactsProfileDocument = loadProfile("execution-evidence.v3.json");

/** Adds the supersession and dispute edges that make an evaluation's lineage walkable. */
export const resultEvaluationProfileV3: FactsProfileDocument = loadProfile("result-evaluation.v3.json");

/** The same two lineage edges for verification records. */
export const executionVerificationProfileV2: FactsProfileDocument =
  loadProfile("execution-verification.v2.json");
