// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parserAllowlistKey } from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import {
  evaluatorAdaptersParserAllowlist,
  PREDICTION_PARSER,
  SWE_REBENCH_PARSER,
} from "./parser-identity.js";

const fixtures = fileURLToPath(new URL("../fixtures/parsers/", import.meta.url));

function fileDigest(name: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(join(fixtures, name))).digest("hex")}`;
}

describe("parser identities", () => {
  test("the swe-rebench digest is its semantics document, byte for byte", () => {
    expect(SWE_REBENCH_PARSER.id).toBe("network.jinn.parser.swe-rebench-v2");
    expect(SWE_REBENCH_PARSER.version).toBe("1.0.0");
    expect(SWE_REBENCH_PARSER.digest).toBe(fileDigest("swe-rebench-v2.parser.json"));
  });

  test("the prediction digest is its semantics document, byte for byte", () => {
    expect(PREDICTION_PARSER.id).toBe("network.jinn.parser.prediction-market");
    expect(PREDICTION_PARSER.version).toBe("1.0.0");
    expect(PREDICTION_PARSER.digest).toBe(fileDigest("prediction-market.parser.json"));
  });

  test("the deployment allowlist carries exactly both parser keys", () => {
    expect([...evaluatorAdaptersParserAllowlist()].sort()).toEqual(
      [
        parserAllowlistKey(PREDICTION_PARSER),
        parserAllowlistKey(SWE_REBENCH_PARSER),
      ].sort(),
    );
  });

  test("an unrelated parser identity is not allowlisted", () => {
    expect(
      evaluatorAdaptersParserAllowlist().has(
        parserAllowlistKey({
          id: "network.jinn.parser.swe-rebench-v2",
          version: "1.0.0",
          digest: `sha256:${"0".repeat(64)}`,
        }),
      ),
    ).toBe(false);
  });
});
