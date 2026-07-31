// SPDX-License-Identifier: Apache-2.0
// Test-only. Not exported from `src/corpus/index.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(
  new URL("../../fixtures/corpus/execution-evidence.valid.json", import.meta.url),
);

/**
 * A conforming Execution Evidence record, taken byte-for-byte from
 * `packages/evidence/protocol`'s own golden fixture so this tree never
 * authors a second copy of the record family's truth.
 */
export const executionEvidenceFixture = {
  bytes: new Uint8Array(readFileSync(path)),
};
