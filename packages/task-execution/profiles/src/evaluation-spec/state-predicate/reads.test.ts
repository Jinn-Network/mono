/**
 * Fixture-address convention (program §4.8): synthetic documentation addresses only.
 */
import { describe, expect, it } from "vitest";
import type { StatePredicateBlock } from "../family-blocks.js";
import { CRYPTO_ENVIRONMENT_MEDIA_TYPE } from "./vocabulary.js";
import { stateReadKey, stateReadRequests } from "./reads.js";

const ADDR1 = "0x0000000000000000000000000000000000000001";
const ADDR2 = "0x0000000000000000000000000000000000000002";
const TOKEN = "0x00000000000000000000000000000000000000aa";
const ABI_DIGEST = "a".repeat(64);
const BALANCE_OF_CALL = `0x70a08231${"0".repeat(24)}${ADDR2.slice(2)}`;

const ENV_RECORD = {
  digest: { sha256: ABI_DIGEST },
  mediaType: CRYPTO_ENVIRONMENT_MEDIA_TYPE,
};

function blockWithPredicates(
  successPredicates: StatePredicateBlock["successPredicates"],
): StatePredicateBlock {
  return {
    environmentRecord: ENV_RECORD,
    predicateSemanticsVersion: "1",
    successPredicates,
    safetyConstraints: [],
    measurements: [],
    timeout: 600,
  };
}

describe("stateReadRequests", () => {
  it("projects nativeBalance post-replay and reportedValue ground truth at baseline", () => {
    const block = blockWithPredicates([
      { kind: "nativeBalance", account: ADDR1, cmp: "eq", value: "0" },
      {
        kind: "reportedValue",
        name: "price",
        cmp: "eq",
        value: "100",
        groundTruth: {
          to: TOKEN,
          call: { encodedCall: BALANCE_OF_CALL },
          decode: "uint256",
        },
      },
    ]);

    const requests = stateReadRequests(block);
    expect(requests).toEqual([
      {
        key: `native-balance|${ADDR1}`,
        state: "post-replay",
        read: { kind: "nativeBalance", account: ADDR1 },
      },
      {
        key: `call|${TOKEN}|encoded|${BALANCE_OF_CALL}`,
        state: "baseline",
        read: {
          kind: "call",
          to: TOKEN,
          call: { encodedCall: BALANCE_OF_CALL },
        },
      },
    ]);
  });

  it("tags reportedValue ground truth at post-replay when groundTruthState is declared", () => {
    const block = blockWithPredicates([
      { kind: "nativeBalance", account: ADDR1, cmp: "eq", value: "0" },
      {
        kind: "reportedValue",
        name: "price",
        cmp: "eq",
        value: "100",
        groundTruthState: "post-replay",
        groundTruth: {
          to: TOKEN,
          call: { encodedCall: BALANCE_OF_CALL },
          decode: "uint256",
        },
      },
    ]);

    const requests = stateReadRequests(block);
    expect(requests[1]).toMatchObject({
      key: `call|${TOKEN}|encoded|${BALANCE_OF_CALL}`,
      state: "post-replay",
    });
  });

  it("passes declarative call targets unencoded and keys over the declaration (CR6)", () => {
    const declarativeCall = {
      abiRef: { digest: { sha256: ABI_DIGEST } },
      function: "balanceOf(address)",
      args: [{ type: "address" as const, value: ADDR2 }],
    };
    const block = blockWithPredicates([
      {
        kind: "callResult",
        to: TOKEN,
        call: declarativeCall,
        decode: "uint256",
        cmp: "gte",
        value: "0",
      },
    ]);

    const requests = stateReadRequests(block);
    expect(requests).toHaveLength(1);
    expect(requests[0].read).toEqual({
      kind: "call",
      to: TOKEN,
      call: declarativeCall,
    });
    expect(requests[0].key).toBe(
      `call|${TOKEN}|abi|${ABI_DIGEST}|balanceOf(address)|address:${ADDR2}`,
    );
    expect(stateReadKey({ kind: "call", to: TOKEN, call: declarativeCall })).toBe(
      requests[0].key,
    );
  });

  it("deduplicates identical declarative calls across predicates with different labels and comparators", () => {
    const declarativeCall = {
      abiRef: { digest: { sha256: ABI_DIGEST } },
      function: "balanceOf(address)",
      args: [{ type: "address" as const, value: ADDR2 }],
    };
    const block = blockWithPredicates([
      {
        kind: "callResult",
        label: "first",
        to: TOKEN,
        call: declarativeCall,
        decode: "uint256",
        cmp: "gte",
        value: "0",
      },
      {
        kind: "callResult",
        label: "second",
        to: TOKEN,
        call: declarativeCall,
        decode: "uint256",
        cmp: "lte",
        value: "999999",
      },
    ]);

    const requests = stateReadRequests(block);
    expect(requests).toHaveLength(1);
    expect(requests[0].key).toBe(
      `call|${TOKEN}|abi|${ABI_DIGEST}|balanceOf(address)|address:${ADDR2}`,
    );
  });

  it("keeps declarative and encoded spellings as distinct keys for the same underlying call", () => {
    const declarativeCall = {
      abiRef: { digest: { sha256: ABI_DIGEST } },
      function: "balanceOf(address)",
      args: [{ type: "address" as const, value: ADDR2 }],
    };
    const block = blockWithPredicates([
      {
        kind: "callResult",
        to: TOKEN,
        call: { encodedCall: BALANCE_OF_CALL },
        decode: "uint256",
        cmp: "gte",
        value: "0",
      },
      {
        kind: "callResult",
        to: TOKEN,
        call: declarativeCall,
        decode: "uint256",
        cmp: "gte",
        value: "0",
      },
    ]);

    const requests = stateReadRequests(block);
    expect(requests).toHaveLength(2);
    expect(requests[0].key).toBe(`call|${TOKEN}|encoded|${BALANCE_OF_CALL}`);
    expect(requests[1].key).toBe(
      `call|${TOKEN}|abi|${ABI_DIGEST}|balanceOf(address)|address:${ADDR2}`,
    );
  });
});
