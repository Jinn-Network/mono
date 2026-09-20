/**
 * The `bind` human line (issue #3871). The index word follows the beacon source's time basis, so a
 * height-indexed source reads as a height here, as it does on the report face.
 *
 * Every digest and value below is synthetic.
 */

import { describe, expect, test } from "vitest";
import type { BeaconReference } from "@colophon-claims/check";
import type { RunBindResult } from "../operations/index.js";
import { renderBindLine } from "./main.js";

const SEAL = `sha256:${"1".repeat(64)}`;
const RECORD = "2".repeat(64);
const STATEMENT = "This run carries a beacon binding.";

function result(source: BeaconReference["source"], round: number): RunBindResult {
  return {
    recordSha256: RECORD,
    boundAt: "2026-01-01T00:00:00.000Z",
    binding: { sealDigest: SEAL, beacon: { source, round, value: "3".repeat(64) } },
    statement: STATEMENT,
  } as unknown as RunBindResult;
}

describe("bind human line", () => {
  test("names a drand index a round", () => {
    expect(renderBindLine(result("drand/quicknet", 1000))).toBe(
      `bound run ${SEAL} to drand/quicknet round 1000: ${RECORD}\n${STATEMENT}\n`,
    );
  });

  test("names a bitcoin index a height", () => {
    expect(renderBindLine(result("bitcoin/mainnet", 900000))).toBe(
      `bound run ${SEAL} to bitcoin/mainnet height 900000: ${RECORD}\n${STATEMENT}\n`,
    );
  });
});
