// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  assertScriptWithinEnvelope,
  ChainSolutionScriptSchema,
  ReferenceScriptSchema,
  referenceScriptDigest,
  sealReferenceScript,
  sealSolutionScript,
  type CapabilityEnvelope,
  type ReferenceScript,
} from "./solution-script.js";
import { WELL_KNOWN_DEV_ADDRESSES } from "./fixture-accounts.js";

const ENVELOPE: CapabilityEnvelope = {
  maxTransactions: 4,
  maxAggregateValueWei: "0",
  maxChainSecondsAdvanced: 60,
  maxBlocksMined: 8,
  signerRoles: ["borrower"],
};

function script(overrides: Partial<ReferenceScript> = {}): ReferenceScript {
  return {
    schemaVersion: "https://jinn.network/records/chain-reference-script/1",
    operations: [
      {
        op: "transactionIntent",
        signerRole: "borrower",
        to: "0x1111111111111111111111111111111111111111",
        abiRef: "IPool.supply",
        args: ["0x22...", "1000"],
        valueWei: "0",
      },
      { op: "mine", blocks: 1 },
    ],
    ...overrides,
  };
}

describe("the reference script is an ordered document, sealed once", () => {
  it("an empty script is legal — it is what the do-nothing side executes", () => {
    expect(() => assertScriptWithinEnvelope(script({ operations: [] }), ENVELOPE)).not.toThrow();
  });

  it("orders matter: reversing the operations changes the digest", () => {
    const forward = script();
    const reversed = script({ operations: [...forward.operations].reverse() });
    expect(referenceScriptDigest(forward)).not.toBe(referenceScriptDigest(reversed));
  });

  it("seals to bytes whose digest is the document digest", () => {
    const sealed = sealReferenceScript(script());
    expect(sealed.digest).toBe(referenceScriptDigest(script()));
    expect(sealed.mediaType).toBe("application/vnd.jinn.chain-reference-script.v1+json");
  });
});

describe("both documents round-trip through their schemas", () => {
  it("parses sealed reference-script bytes back through the schema", () => {
    const sealed = sealReferenceScript(script());
    const roundTripped = ReferenceScriptSchema.parse(JSON.parse(new TextDecoder().decode(sealed.bytes)));
    expect(roundTripped).toEqual(sealed.document);
  });

  it("parses sealed solution-script bytes back through the schema", () => {
    const solution = {
      schemaVersion: "https://jinn.network/records/chain-solution/1",
      operations: [
        { op: "signedTransaction", rawTransaction: "0xdeadbeef" },
        { op: "report", name: "outcome", value: true },
      ],
    };
    const sealed = sealSolutionScript(solution);
    const roundTripped = ChainSolutionScriptSchema.parse(JSON.parse(new TextDecoder().decode(sealed.bytes)));
    expect(roundTripped).toEqual(sealed.document);
    expect(sealed.mediaType).toBe("application/vnd.jinn.chain-solution.v1+json");
  });
});

describe("report values are JSON scalars only", () => {
  it("refuses a report whose value is an object", () => {
    const invalid = script({
      operations: [{ op: "report", name: "x", value: { nested: true } as never }],
    });
    expect(ReferenceScriptSchema.safeParse(invalid).success).toBe(false);
  });

  it("refuses a report whose value is null", () => {
    const invalid = script({
      operations: [{ op: "report", name: "x", value: null as never }],
    });
    expect(ReferenceScriptSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("the envelope is enforced here, so a violating script is refused and never graded", () => {
  it("refuses more transactions than the envelope permits", () => {
    const many = script({
      operations: Array.from({ length: 5 }, () => script().operations[0]!),
    });
    expect(() => assertScriptWithinEnvelope(many, ENVELOPE)).toThrow(/transaction count/);
  });

  it("refuses time advancement beyond the bound", () => {
    const warped = script({ operations: [{ op: "timeWarp", chainSeconds: 61 }] });
    expect(() => assertScriptWithinEnvelope(warped, ENVELOPE)).toThrow(/time advancement/);
  });

  it("sums time advancement across operations rather than checking each in isolation", () => {
    const warped = script({
      operations: [
        { op: "timeWarp", chainSeconds: 40 },
        { op: "timeWarp", chainSeconds: 40 },
      ],
    });
    expect(() => assertScriptWithinEnvelope(warped, ENVELOPE)).toThrow(/time advancement/);
  });

  it("refuses a signer role the envelope does not grant", () => {
    const other = script({
      operations: [{ ...script().operations[0], signerRole: "treasury" } as never],
    });
    expect(() => assertScriptWithinEnvelope(other, ENVELOPE)).toThrow(/signer role "treasury"/);
  });

  it("refuses aggregate native value above the ceiling", () => {
    const paying = script({
      operations: [{ ...script().operations[0], valueWei: "1" } as never],
    });
    expect(() => assertScriptWithinEnvelope(paying, ENVELOPE)).toThrow(/aggregate native value/);
  });

  it("refuses a transaction intent whose to is a banned dev address", () => {
    const banned = script({
      operations: [
        {
          ...script().operations[0],
          to: WELL_KNOWN_DEV_ADDRESSES[0]!,
        } as never,
      ],
    });
    expect(() => assertScriptWithinEnvelope(banned, ENVELOPE)).toThrow(/well-known development address/);
  });
});
