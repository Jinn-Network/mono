// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_COMPLETE_JSON_LABEL_PARSER_ID,
  BINARY_CORRECT_WRONG_PARSER_IDENTITY,
  BINARY_CORRECT_WRONG_PARSER_ID,
  BINARY_EVERMEM_JSON_LABEL_PARSER_ID,
  BINARY_JSON_VERDICT_PARSER_IDENTITY,
  BINARY_JSON_VERDICT_PARSER_ID,
  BINARY_LABEL_IN_PROSE_PARSER_IDENTITY,
  BINARY_LABEL_IN_PROSE_PARSER_ID,
  BINARY_MEM0_JSON_LABEL_PARSER_ID,
  BINARY_STRICT_JSON_LABEL_PARSER_ID,
  BINARY_YES_NO_PARSER_IDENTITY,
  type BinaryJudgmentResponseParserId,
} from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import {
  parseBinaryJudgmentResponse,
  selectBinaryJudgmentResponseParser,
  trimBinaryJudgmentResponseEdges,
  type BinaryJudgmentDecision,
} from "./parse.js";

const encoder = new TextEncoder();

interface FixtureExpectation {
  readonly decision: BinaryJudgmentDecision;
  readonly parseValid: boolean;
  readonly invalidReason?: "invalid-utf8" | "unexpected-token";
}
interface FixtureInput {
  readonly text?: string;
  readonly bytesBase64?: string;
}
interface FixtureCase {
  readonly case: string;
  readonly input: FixtureInput;
  readonly expect: FixtureExpectation;
}
interface FixtureFile {
  readonly parser: { readonly id: string; readonly version: string; readonly digest: string };
  readonly cases: readonly FixtureCase[];
}

const fixturesDir = fileURLToPath(
  new URL("../../fixtures/binary-judgment-parsers/", import.meta.url),
);

function loadFixture(name: string): FixtureFile {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as FixtureFile;
}

function caseBytes(input: FixtureInput): Uint8Array {
  if (input.text !== undefined) return encoder.encode(input.text);
  if (input.bytesBase64 !== undefined) return new Uint8Array(Buffer.from(input.bytesBase64, "base64"));
  throw new TypeError("fixture case input must carry text or bytesBase64");
}

// The full fifteen adversarial case ids from spec §4.3's table (the table has fifteen rows even
// though its prose says "fourteen"; see docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md).
const ALL_ADVERSARIAL_CASE_IDS = [
  "empty-output",
  "whitespace-only",
  "edge-newlines-around-valid-token",
  "lowercase-token",
  "interior-whitespace-in-token",
  "token-followed-by-period",
  "token-embedded-in-word",
  "both-tokens-present",
  "bom-prefixing-valid-token",
  "invalid-utf8",
  "truncated-at-generation-cap",
  "json-object-with-extra-members",
  "json-inside-code-fence",
  "json-array-root",
  "duplicate-verdict-member",
] as const;

// PC-4 (binary-json-verdict) omits token-followed-by-period and token-embedded-in-word: the
// table marks both n/a for the JSON-wrapped contract, which has no bare-token adjacency to test.
const JSON_VERDICT_CASE_IDS = ALL_ADVERSARIAL_CASE_IDS.filter(
  (id) => id !== "token-followed-by-period" && id !== "token-embedded-in-word",
);

const FIXTURE_FILES: readonly {
  readonly file: string;
  readonly identity: { readonly id: string; readonly version: string; readonly digest: string };
  readonly requiredCaseIds: readonly string[];
}[] = [
  {
    file: "binary-accept-reject.cases.json",
    identity: BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
    requiredCaseIds: ALL_ADVERSARIAL_CASE_IDS,
  },
  {
    file: "binary-yes-no.cases.json",
    identity: BINARY_YES_NO_PARSER_IDENTITY,
    requiredCaseIds: ALL_ADVERSARIAL_CASE_IDS,
  },
  {
    file: "binary-correct-wrong.cases.json",
    identity: BINARY_CORRECT_WRONG_PARSER_IDENTITY,
    requiredCaseIds: ALL_ADVERSARIAL_CASE_IDS,
  },
  {
    file: "binary-json-verdict.cases.json",
    identity: BINARY_JSON_VERDICT_PARSER_IDENTITY,
    requiredCaseIds: JSON_VERDICT_CASE_IDS,
  },
  {
    file: "binary-label-in-prose.cases.json",
    identity: BINARY_LABEL_IN_PROSE_PARSER_IDENTITY,
    requiredCaseIds: ALL_ADVERSARIAL_CASE_IDS,
  },
];

describe("parseBinaryJudgmentResponse", () => {
  test.each([
    ["ACCEPT", "ACCEPT"],
    ["REJECT", "REJECT"],
    [" \t\r\nACCEPT\n\t ", "ACCEPT"],
    ["\nREJECT\r", "REJECT"],
  ] as const)("accepts the exact token in %j", (input, decision) => {
    expect(parseBinaryJudgmentResponse(encoder.encode(input))).toEqual({
      decision,
      parseValid: true,
    });
  });

  test.each([
    "",
    "accept",
    "Reject",
    "ACCEPT.",
    "ACCEPT REJECT",
    "ACCEPT\u000b",
    "\u00a0ACCEPT\u00a0",
    "\ufeffACCEPT",
    "ＡＣＣＥＰＴ",
    "A\u0301CCEPT",
    "ACCEPT\u0000",
  ])("maps the unexpected token %j to an invalid REJECT", (input) => {
    expect(parseBinaryJudgmentResponse(encoder.encode(input))).toEqual({
      decision: "REJECT",
      parseValid: false,
      invalidReason: "unexpected-token",
    });
  });

  test.each([
    new Uint8Array([0xff]),
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    new Uint8Array([0x41, 0x43, 0x43, 0x45, 0x50, 0x54, 0x80]),
  ])("maps malformed UTF-8 to an invalid REJECT", (input) => {
    expect(parseBinaryJudgmentResponse(input)).toEqual({
      decision: "REJECT",
      parseValid: false,
      invalidReason: "invalid-utf8",
    });
  });

  test("does not mutate the caller's byte buffer", () => {
    const bytes = encoder.encode("\tACCEPT\n");
    const before = new Uint8Array(bytes);
    parseBinaryJudgmentResponse(bytes);
    expect(bytes).toEqual(before);
  });
});

describe("trimBinaryJudgmentResponseEdges", () => {
  test("only trims the four sealed ASCII edge code points", () => {
    expect(trimBinaryJudgmentResponseEdges("\u00a0 \tACCEPT\r\n \u00a0"))
      .toBe("\u00a0 \tACCEPT\r\n \u00a0");
    expect(trimBinaryJudgmentResponseEdges(" \t\r\nACCEPT\n\r\t ")).toBe("ACCEPT");
  });
});

describe("binary judgment response parser fixture corpus (PC-1..PC-5, spec \u00a74.3)", () => {
  for (const { file, identity, requiredCaseIds } of FIXTURE_FILES) {
    const fixture = loadFixture(file);

    test(`${file}: parser triple matches the profiles-owned registered identity`, () => {
      expect(fixture.parser).toEqual(identity);
    });

    test(`${file}: case-id set matches the required adversarial id set exactly`, () => {
      expect([...fixture.cases.map((testCase) => testCase.case)].sort()).toEqual(
        [...requiredCaseIds].sort(),
      );
    });

    describe(file, () => {
      test.each(fixture.cases.map((testCase) => [testCase.case, testCase] as const))(
        "%s",
        (_caseId, testCase) => {
          const parse = selectBinaryJudgmentResponseParser(
            fixture.parser.id as BinaryJudgmentResponseParserId,
          );
          expect(parse(caseBytes(testCase.input))).toEqual(testCase.expect);
        },
      );
    });
  }
});

describe("selectBinaryJudgmentResponseParser", () => {
  test("selects the same PC-1 behavior as the exported parseBinaryJudgmentResponse", () => {
    const selected = selectBinaryJudgmentResponseParser(BINARY_ACCEPT_REJECT_PARSER_IDENTITY.id);
    expect(selected(encoder.encode("ACCEPT"))).toEqual(parseBinaryJudgmentResponse(encoder.encode("ACCEPT")));
  });
});

// Mechanisms the fixture corpus above cannot express as neatly: PC-4's root-level duplicate
// detection versus a nested duplicate of the same member name, PC-4's member-name escape form,
// and PC-5's repeated-token / underscore-delimiter edge cases (plan \u00a72e).
describe("binary-json-verdict direct unit cases", () => {
  const parse = selectBinaryJudgmentResponseParser(BINARY_JSON_VERDICT_PARSER_ID);

  test("a nested member named verdict is not confused with the root-level member", () => {
    // Only one root-level "verdict" (value ACCEPT); the nested "verdict" (value REJECT) lives
    // inside the "nested" object at depth 2 and must not count toward the duplicate check.
    const bytes = encoder.encode('{"verdict":"ACCEPT","nested":{"verdict":"REJECT"}}');
    expect(parse(bytes)).toEqual({ decision: "ACCEPT", parseValid: true });
  });

  test("a genuine root-level duplicate is invalid even when a nested member shares the name", () => {
    const bytes = encoder.encode(
      '{"verdict":"ACCEPT","verdict":"REJECT","nested":{"verdict":"ACCEPT"}}',
    );
    expect(parse(bytes)).toEqual({
      decision: "REJECT",
      parseValid: false,
      invalidReason: "unexpected-token",
    });
  });

  test("a member name written with a JSON string escape still decodes to exactly verdict", () => {
    // "verdict" decodes to "verdict" (v is 'v'); the detector must JSON-decode the raw
    // key slice rather than literal-compare it against the unescaped string "verdict".
    const bytes = encoder.encode('{"\\u0076erdict":"ACCEPT"}');
    expect(parse(bytes)).toEqual({ decision: "ACCEPT", parseValid: true });
  });
});

describe("binary-label-in-prose direct unit cases", () => {
  const parse = selectBinaryJudgmentResponseParser(BINARY_LABEL_IN_PROSE_PARSER_ID);

  test("a repeated delimited token is valid, with no positional preference", () => {
    const bytes = encoder.encode("ACCEPT, restated as ACCEPT once more: ACCEPT.");
    expect(parse(bytes)).toEqual({ decision: "ACCEPT", parseValid: true });
  });

  test("an underscore-adjacent occurrence is not a delimited match", () => {
    const bytes = encoder.encode("_ACCEPT and REJECT_ both fail the delimiter rule");
    expect(parse(bytes)).toEqual({
      decision: "REJECT",
      parseValid: false,
      invalidReason: "unexpected-token",
    });
  });

  test("an undelimited occurrence earlier in the text does not stop the scan", () => {
    const bytes = encoder.encode("ACCEPTABLE, and the verdict is ACCEPT.");
    expect(parse(bytes)).toEqual({ decision: "ACCEPT", parseValid: true });
  });
});

describe("binary-correct-wrong direct unit cases", () => {
  test("shares PC-1's whole-output-token discipline over its own alphabet", () => {
    const parse = selectBinaryJudgmentResponseParser(BINARY_CORRECT_WRONG_PARSER_ID);
    expect(parse(encoder.encode("CORRECT"))).toEqual({ decision: "ACCEPT", parseValid: true });
    expect(parse(encoder.encode("WRONG"))).toEqual({ decision: "REJECT", parseValid: true });
  });
});

describe("LoCoMo JSON-label parser contracts", () => {
  const invalid = {
    decision: "REJECT",
    parseValid: false,
    invalidReason: "unexpected-token",
  } as const;

  test("complete-json-label matches Backboard/revised label handling", () => {
    const parse = selectBinaryJudgmentResponseParser(BINARY_COMPLETE_JSON_LABEL_PARSER_ID);
    expect(parse(encoder.encode('{"label":"correct","reasoning":"ok"}')))
      .toEqual({ decision: "ACCEPT", parseValid: true });
    expect(parse(encoder.encode('{"label":" WRONG ","reasoning":"ok"}')))
      .toEqual({ decision: "REJECT", parseValid: true });
    expect(parse(encoder.encode('{"reasoning":"missing defaults to wrong"}')))
      .toEqual({ decision: "REJECT", parseValid: true });
    expect(parse(encoder.encode('```json\n{"label":"CORRECT"}\n```'))).toEqual(invalid);
    expect(parse(encoder.encode('{"label":7}'))).toEqual(invalid);
  });

  test("evermem-json-label follows fenced, flat-object, then complete extraction order", () => {
    const parse = selectBinaryJudgmentResponseParser(BINARY_EVERMEM_JSON_LABEL_PARSER_ID);
    expect(parse(encoder.encode('prefix ```json\n{"label":" correct ","reasoning":"ok"}\n``` suffix')))
      .toEqual({ decision: "ACCEPT", parseValid: true });
    expect(parse(encoder.encode('prose {"label":"WRONG","reasoning":"no"} tail')))
      .toEqual({ decision: "REJECT", parseValid: true });
    expect(parse(encoder.encode('{"label":""}'))).toEqual(invalid);
    expect(parse(encoder.encode('{"reasoning":"missing"}'))).toEqual(invalid);
  });

  test("mem0-json-label uses its first optional fence and exact case-sensitive comparison", () => {
    const parse = selectBinaryJudgmentResponseParser(BINARY_MEM0_JSON_LABEL_PARSER_ID);
    expect(parse(encoder.encode('prefix ```json\n{"label":"CORRECT"}\n``` suffix')))
      .toEqual({ decision: "ACCEPT", parseValid: true });
    expect(parse(encoder.encode('{"label":"correct"}')))
      .toEqual({ decision: "REJECT", parseValid: true });
    expect(parse(encoder.encode('{"label":null}')))
      .toEqual({ decision: "REJECT", parseValid: true });
    expect(parse(encoder.encode('{"reasoning":"missing"}'))).toEqual(invalid);
  });

  test("strict-json-label accepts only the exact two-member strict-dial shape", () => {
    const parse = selectBinaryJudgmentResponseParser(BINARY_STRICT_JSON_LABEL_PARSER_ID);
    expect(parse(encoder.encode('{"label":"CORRECT","reasoning":"supported"}')))
      .toEqual({ decision: "ACCEPT", parseValid: true });
    expect(parse(encoder.encode('{"reasoning":"unsupported","label":"WRONG"}')))
      .toEqual({ decision: "REJECT", parseValid: true });
    expect(parse(encoder.encode('{"label":"correct","reasoning":"case"}'))).toEqual(invalid);
    expect(parse(encoder.encode('{"label":"CORRECT","reasoning":"ok","extra":true}')))
      .toEqual(invalid);
    expect(parse(encoder.encode('{"label":"CORRECT","label":"WRONG","reasoning":"dup"}')))
      .toEqual(invalid);
  });
});
