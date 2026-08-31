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

export const taskProfile: FactsProfileDocument = loadProfile("task.v1.json");
export const submissionProfile: FactsProfileDocument = loadProfile("submission.v1.json");
export const deliveryProfile: FactsProfileDocument = loadProfile("delivery.v1.json");
export const profileDocumentProfile: FactsProfileDocument = loadProfile("profile-document.v1.json");
export const evaluationSpecProfile: FactsProfileDocument = loadProfile("evaluation-spec.v1.json");
export const pluginProfile: FactsProfileDocument = loadProfile("plugin.v1.json");
export const checkpointProfile: FactsProfileDocument = loadProfile("checkpoint.v1.json");

// The v2 revisions close the join-edge gap the completeness rule names (protocol design §12,
// amendment 2026-08-28). Each coexists with its v1; v1 bytes and meaning stay frozen.

/** Adds the digest-pinned inputs a Task supplies to its attempts. */
export const taskProfileV2: FactsProfileDocument = loadProfile("task.v2.json");

/**
 * Adds the records a Delivery points at beyond its Task: the outputs it produced, the evidence
 * records that describe the work, and the earlier Delivery of the same Attempt it replaces.
 * Without them an index cannot walk from a Delivery to the evidence and verdicts about it.
 */
export const deliveryProfileV2: FactsProfileDocument = loadProfile("delivery.v2.json");

/**
 * Adds every component an evaluation spec pins by digest: its graders, and whatever its family
 * block references — the composite crypto environment a state-predicate spec runs against, a
 * deterministic-process image, test material and parser, a model-graded rubric and judge output
 * schema, a human-review form, a composite's sub-specs. v1 declared only the family, so "which
 * evaluation specs run in this crypto environment" was unanswerable from a card, and a grader is
 * exactly the access-classified case where fetching to join is not possible at all.
 */
export const evaluationSpecProfileV2: FactsProfileDocument = loadProfile("evaluation-spec.v2.json");

/**
 * Adds the output-slot schemas a profile pins. `extends` was v1's only declared edge, but a
 * slot's optional `schema` is the same digest-bearing-descriptor shape this leaf treats as an
 * edge on an evaluation spec; a descriptor satisfied by a `uri` alone pins nothing and is not
 * carried.
 */
export const profileDocumentProfileV2: FactsProfileDocument = loadProfile("profile-document.v2.json");
