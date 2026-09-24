// SPDX-License-Identifier: Apache-2.0

/**
 * The public external-import marker (issue #3417): grammar, projection, and the check that
 * pairs the authenticated member with the claim section and the sealed Matrix.
 */

import { describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BenchmarkProductError } from "./errors.js";
import {
  EXTERNAL_IMPORT_BUNDLE_MEMBER,
  EXTERNAL_IMPORT_MARKER_PROTOCOL,
  IMPORTED_RUN_PINNING_LIMIT,
  assertExternalImport,
  buildExternalImportMarker,
  canonicalExternalImportMarkerBytes,
  deriveClaimExternalImport,
  dumpIdentityFromBytes,
  parseExternalImportMarker,
} from "./external-import.js";

const DUMP = new TextEncoder().encode('{"rows":1}\n');
const dump = dumpIdentityFromBytes(DUMP);
const DECLARATION_SHA256 = "ab".repeat(32);
const SOURCE = { harness: "some-external-harness", version: "2.4.0" } as const;
const ROWS = [
  { cellKey: "arm.a/task.1/r1", outcome: "graded" as const },
  { cellKey: "arm.a/task.2/r1", outcome: "unrun" as const, reason: "never scheduled" },
];

function marker() {
  return buildExternalImportMarker({
    dump,
    declarationSha256: DECLARATION_SHA256,
    source: SOURCE,
    rows: ROWS,
  });
}

describe("the external-import marker", () => {
  test("round-trips through canonical bytes and names the dump digest", () => {
    const built = marker();
    expect(built.protocol).toBe(EXTERNAL_IMPORT_MARKER_PROTOCOL);
    expect(built.dump).toEqual(dump);
    expect(built.declarationSha256).toBe(DECLARATION_SHA256);
    const bytes = canonicalExternalImportMarkerBytes(built);
    expect(parseExternalImportMarker(bytes)).toEqual(built);
    expect(dumpIdentityFromBytes(DUMP)).toEqual({
      sha256: dump.sha256,
      byteLength: DUMP.length,
    });
  });

  test("the claim section is a projection of the marker, never a second opinion", () => {
    const built = marker();
    expect(deriveClaimExternalImport(built)).toEqual({
      dumpSha256: dump.sha256,
      dumpByteLength: dump.byteLength,
      declarationSha256: DECLARATION_SHA256,
      source: SOURCE,
      rows: ROWS,
    });
  });

  test("assertExternalImport accepts a marker whose rows are exactly the Matrix cell keys", () => {
    const built = marker();
    expect(() => assertExternalImport({
      bytes: canonicalExternalImportMarkerBytes(built),
      claim: { externalImport: deriveClaimExternalImport(built) },
      matrixCellKeys: ROWS.map((row) => row.cellKey),
    })).not.toThrow();
  });

  test("refuses a non-canonical encoding at the member path", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(marker())}\n`);
    expect(() => parseExternalImportMarker(bytes)).toThrow(BenchmarkProductError);
    try {
      parseExternalImportMarker(bytes);
    } catch (error) {
      expect((error as BenchmarkProductError).issues[0]!.path).toBe(EXTERNAL_IMPORT_BUNDLE_MEMBER);
    }
  });

  test("refuses a row set that is not exactly the sealed Matrix", () => {
    const built = marker();
    expect(() => assertExternalImport({
      bytes: canonicalExternalImportMarkerBytes(built),
      claim: { externalImport: deriveClaimExternalImport(built) },
      matrixCellKeys: [ROWS[0]!.cellKey],
    })).toThrow(/not exactly the sealed Matrix cell keys/u);
  });

  test("the import-aware pinning sentence is the one disclosure line that replaces the admission gate", () => {
    expect(IMPORTED_RUN_PINNING_LIMIT).toMatch(/imported from an external harness dump/u);
    expect(IMPORTED_RUN_PINNING_LIMIT).not.toMatch(/enforced by an admission gate/u);
  });
});
