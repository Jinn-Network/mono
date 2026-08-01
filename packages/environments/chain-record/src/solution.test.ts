import { describe, expect, test } from "vitest";

import {
  CHAIN_SOLUTION_MEDIA_TYPE,
  ChainSolutionScriptSchema,
  parseChainSolutionScript,
  sealChainSolutionScript,
} from "./solution.js";

const script = () => ({
  mediaType: CHAIN_SOLUTION_MEDIA_TYPE,
  environmentRecordDigest: `sha256:${"1".repeat(64)}`,
  operations: [
    { kind: "signedTransaction", rawTransaction: "0x02f8710182" },
    { kind: "timeWarp", seconds: 3600 },
    { kind: "mine", blocks: 1 },
    { kind: "report", name: "supplyRateBps", value: "412" },
  ],
});

const parse = (document: unknown) => ChainSolutionScriptSchema.safeParse(document);

describe("chain solution script (§6.4, §14)", () => {
  test("pins the media type the design's naming pass settled", () => {
    expect(CHAIN_SOLUTION_MEDIA_TYPE).toBe("application/vnd.jinn.chain-solution.v1+json");
  });

  test("accepts an ordered script over the four permitted operations", () => {
    expect(parse(script()).success).toBe(true);
  });

  test("an empty operation list is legal — it is the do-nothing script admission executes", () => {
    expect(parse({ ...script(), operations: [] }).success).toBe(true);
  });

  test("refuses a fifth operation kind: the vocabulary is closed", () => {
    const document = script();
    document.operations.push({ kind: "shellCommand", command: "cast send" } as never);
    expect(parse(document).success).toBe(false);
  });

  test("refuses an unsigned transaction: the script carries raw signed bytes, never a request", () => {
    const document = script();
    document.operations[0] = { kind: "signedTransaction", to: `0x${"a1".repeat(20)}` } as never;
    expect(parse(document).success).toBe(false);
  });

  test("binds the environment it replays against, by digest", () => {
    const document = script() as Record<string, unknown>;
    delete document.environmentRecordDigest;
    expect(parse(document).success).toBe(false);
  });

  test("reported values are strings: a reported quantity is compared, never arithmetic'd here", () => {
    const document = script();
    document.operations[3] = { kind: "report", name: "supplyRateBps", value: 412 } as never;
    expect(parse(document).success).toBe(false);
  });

  test("seals and re-parses to identical bytes", () => {
    const once = sealChainSolutionScript(script());
    expect(new TextDecoder().decode(sealChainSolutionScript(parseChainSolutionScript(once))))
      .toBe(new TextDecoder().decode(once));
  });
});
