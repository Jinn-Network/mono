import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFactsProfile } from "@jinn-network/record-discovery-protocol";
import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// The four Benchmarking facts-profile documents (design §11, program §7.128):
// declarative field labeling only, loaded from the bundled `profiles/*.json`
// and parsed (and record-kind-URI-validated) through protocol's owned contract.

const profilesRoot = new URL("../profiles/", import.meta.url);

function loadProfile(filename: string): FactsProfileDocument {
  const path = fileURLToPath(new URL(filename, profilesRoot));
  return parseFactsProfile(JSON.parse(readFileSync(path, "utf8")));
}

export const benchmarkProfile: FactsProfileDocument = loadProfile("benchmark.v1.json");
export const runProfile: FactsProfileDocument = loadProfile("run.v1.json");
export const matrixProfile: FactsProfileDocument = loadProfile("matrix.v1.json");
export const reportProfile: FactsProfileDocument = loadProfile("report.v1.json");
/** Legacy raw Report v1 facts remain immutable; signed envelopes use this separate profile. */
export const signedReportProfile: FactsProfileDocument = loadProfile("report.v2.json");
export const benchmarkAccountingProfile: FactsProfileDocument = loadProfile("benchmark-accounting.v1.json");

// The v2 revisions close the join-edge gap the completeness rule names (protocol design §12,
// amendment 2026-08-28). Each coexists with its v1; v1 bytes and meaning stay frozen.

/** Adds the Tasks the benchmark is made of, and its supersession pointer. */
export const benchmarkProfileV2: FactsProfileDocument = loadProfile("benchmark.v2.json");

/**
 * Adds the per-cell record references — Tasks, Submissions, Deliveries, verdicts — that make a
 * matrix the join table it already is in substance. Without them, "this environment, its
 * attempts, their verdicts" is unanswerable from the card.
 */
export const matrixProfileV2: FactsProfileDocument = loadProfile("matrix.v2.json");
