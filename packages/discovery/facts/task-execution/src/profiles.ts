import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFactsProfile } from "@jinn-network/record-discovery-protocol";
import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// The seven task-execution-tree facts-profile documents (design §12, plan
// Task 24, program §6.5): declarative field labeling only, loaded from the
// bundled `profiles/*.json` and parsed (and record-kind-URI-validated)
// through protocol's owned contract. One leaf, one record-kind tree, seven
// kinds -- the folded `facts/profiles` + `facts/task-execution` split
// (program §6.5 confirmation 5).

const profilesRoot = new URL("../profiles/", import.meta.url);

function loadProfile(filename: string): FactsProfileDocument {
  const path = fileURLToPath(new URL(filename, profilesRoot));
  return parseFactsProfile(JSON.parse(readFileSync(path, "utf8")));
}

export const taskProfile: FactsProfileDocument = loadProfile("task.1.0.json");
export const submissionProfile: FactsProfileDocument = loadProfile("submission.1.0.json");
export const deliveryProfile: FactsProfileDocument = loadProfile("delivery.1.0.json");
export const profileDocumentProfile: FactsProfileDocument = loadProfile("profile-document.1.0.json");
export const evaluationSpecProfile: FactsProfileDocument = loadProfile("evaluation-spec.1.0.json");
export const pluginProfile: FactsProfileDocument = loadProfile("plugin.1.0.json");
export const checkpointProfile: FactsProfileDocument = loadProfile("checkpoint.1.0.json");
