// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parserAllowlistKey } from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import {
  BINARY_CORRECT_WRONG_PARSER,
  BINARY_JSON_VERDICT_PARSER,
  BINARY_JUDGMENT_PARSER,
  BINARY_LABEL_IN_PROSE_PARSER,
  BINARY_YES_NO_PARSER,
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

  test("the binary-judgment identity is the profiles-owned umbrella oracle", async () => {
    const { BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY } = await import(
      "@jinn-network/task-execution-profiles"
    );
    expect(BINARY_JUDGMENT_PARSER).toEqual(
      BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
    );
  });

  test.each([
    ["BINARY_YES_NO_PARSER", () => BINARY_YES_NO_PARSER, "BINARY_YES_NO_PARSER_IDENTITY"],
    [
      "BINARY_CORRECT_WRONG_PARSER",
      () => BINARY_CORRECT_WRONG_PARSER,
      "BINARY_CORRECT_WRONG_PARSER_IDENTITY",
    ],
    [
      "BINARY_JSON_VERDICT_PARSER",
      () => BINARY_JSON_VERDICT_PARSER,
      "BINARY_JSON_VERDICT_PARSER_IDENTITY",
    ],
    [
      "BINARY_LABEL_IN_PROSE_PARSER",
      () => BINARY_LABEL_IN_PROSE_PARSER,
      "BINARY_LABEL_IN_PROSE_PARSER_IDENTITY",
    ],
  ] as const)(
    "%s is the profiles-owned oracle for its registered identity",
    async (_label, actual, oracleExportName) => {
      const profiles = await import("@jinn-network/task-execution-profiles");
      const oracle = (profiles as Record<string, unknown>)[oracleExportName];
      expect(actual()).toEqual(oracle);
    },
  );

  test("the deployment allowlist carries exactly the seven parser keys", () => {
    expect([...evaluatorAdaptersParserAllowlist()].sort()).toEqual(
      [
        parserAllowlistKey(BINARY_JUDGMENT_PARSER),
        parserAllowlistKey(BINARY_YES_NO_PARSER),
        parserAllowlistKey(BINARY_CORRECT_WRONG_PARSER),
        parserAllowlistKey(BINARY_JSON_VERDICT_PARSER),
        parserAllowlistKey(BINARY_LABEL_IN_PROSE_PARSER),
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

  test("a registered id with the wrong digest is not allowlisted", () => {
    expect(
      evaluatorAdaptersParserAllowlist().has(
        parserAllowlistKey({
          id: BINARY_YES_NO_PARSER.id,
          version: BINARY_YES_NO_PARSER.version,
          digest: `sha256:${"0".repeat(64)}`,
        }),
      ),
    ).toBe(false);
  });
});
