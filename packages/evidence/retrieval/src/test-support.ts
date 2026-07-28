import { readFile } from "node:fs/promises";

import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";

const GOLDEN_FIXTURES = {
  "execution-evidence":
    "golden-execution-evidence-v1/execution/ro-crate-metadata.json",
  "result-evaluation":
    "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
  "execution-verification":
    "golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
} as const;

export async function loadProtocolFixture(
  family: EvidenceRecordReference["family"],
): Promise<Uint8Array> {
  const url = import.meta.resolve(
    `@jinn-network/evidence-protocol/fixtures/${GOLDEN_FIXTURES[family]}`,
  );
  return new Uint8Array(await readFile(new URL(url)));
}
