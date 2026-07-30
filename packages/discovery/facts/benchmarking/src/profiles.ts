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

export const benchmarkProfile: FactsProfileDocument = loadProfile("benchmark.1.0.json");
export const runProfile: FactsProfileDocument = loadProfile("run.1.0.json");
export const matrixProfile: FactsProfileDocument = loadProfile("matrix.1.0.json");
export const reportProfile: FactsProfileDocument = loadProfile("report.1.0.json");
