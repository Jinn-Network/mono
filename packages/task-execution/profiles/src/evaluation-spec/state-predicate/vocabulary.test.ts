/**
 * Fixture-address convention (program §4.8): every address in this family's tests is a synthetic
 * documentation address — `0x` + repeated nibble or `0x0000…00NN` counter. Never a well-known
 * dev-mnemonic address someone might fund.
 */
import { describe, expect, it } from "vitest";
import { PredicateSchema } from "./vocabulary.js";

const ADDR1 = "0x0000000000000000000000000000000000000001";
const ADDR2 = "0x0000000000000000000000000000000000000002";
const TOKEN = "0x00000000000000000000000000000000000000aa";
const HEX32 = `0x${"0".repeat(64)}`;
const BALANCE_OF_CALL = `0x70a08231${"0".repeat(24)}${ADDR2.slice(2)}`;
const ABI_REF = { digest: { sha256: "a".repeat(64) } };

const MINIMAL_BY_KIND = {
  addressForbidden: { kind: "addressForbidden", targets: [ADDR1] },
  approvalConstraint: { kind: "approvalConstraint", noUnlimited: true },
  budget: { kind: "budget", metric: "gasTotal", cmp: "lte", value: "1000000" },
  callResult: {
    kind: "callResult",
    to: TOKEN,
    call: { encodedCall: BALANCE_OF_CALL },
    decode: "uint256",
    cmp: "gte",
    value: "0",
  },
  erc20Balance: { kind: "erc20Balance", token: TOKEN, account: ADDR1, cmp: "eq", value: "0" },
  eventEmitted: {
    kind: "eventEmitted",
    topic0: HEX32,
    countCmp: { cmp: "gte", value: "1" },
  },
  eventForbidden: { kind: "eventForbidden", signature: "Transfer(address,address,uint256)" },
  nativeBalance: { kind: "nativeBalance", account: ADDR1, cmp: "eq", value: "0" },
  reportedValue: {
    kind: "reportedValue",
    name: "price",
    cmp: "eq",
    value: "100",
    groundTruth: { to: TOKEN, call: { encodedCall: BALANCE_OF_CALL }, decode: "uint256" },
  },
  sourceConsulted: { kind: "sourceConsulted", world: "test", requestKey: "key1" },
  sourceValue: {
    kind: "sourceValue",
    world: "test",
    requestKey: "key1",
    selector: "value",
    cmp: "eq",
    value: true,
  },
  storageValue: {
    kind: "storageValue",
    address: ADDR1,
    slot: HEX32,
    decode: "uint256",
    cmp: "eq",
    value: "0",
  },
  timeBound: { kind: "timeBound", metric: "completedWithinBlocks", maximum: "100" },
  txOutcome: { kind: "txOutcome", selector: { all: true }, status: "success" },
} as const;

describe("closed state-predicate vocabulary", () => {
  it.each(Object.entries(MINIMAL_BY_KIND))("parses minimal %s", (_kind, input) => {
    expect(PredicateSchema.safeParse(input).success).toBe(true);
  });

  it("rejects an unknown predicate kind", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "nativeBalanceX",
        account: ADDR1,
        cmp: "eq",
        value: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects strict-object extras on a predicate", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "nativeBalance",
        account: ADDR1,
        cmp: "eq",
        value: "1",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects tolerance without a within-* comparator", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "nativeBalance",
        account: ADDR1,
        cmp: "eq",
        value: "1",
        tolerance: "0.1",
      }).success,
    ).toBe(false);
  });

  it("rejects within-rel without tolerance", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "nativeBalance",
        account: ADDR1,
        cmp: "within-rel",
        value: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects uppercase addresses", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "nativeBalance",
        account: "0xAB0000000000000000000000000000000000000001",
        cmp: "eq",
        value: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects JSON numbers where a decimal string is required", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "nativeBalance",
        account: ADDR1,
        cmp: "eq",
        value: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects eventEmitted with both topic0 and signature", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "eventEmitted",
        topic0: HEX32,
        signature: "Transfer(address,address,uint256)",
        countCmp: { cmp: "gte", value: "1" },
      }).success,
    ).toBe(false);
  });

  it("rejects eventEmitted with neither topic0 nor signature", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "eventEmitted",
        countCmp: { cmp: "gte", value: "1" },
      }).success,
    ).toBe(false);
  });

  it("rejects callResult raw decode with ordered comparison", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: { encodedCall: BALANCE_OF_CALL },
        decode: "raw",
        cmp: "gt",
        value: "0x00",
      }).success,
    ).toBe(false);
  });

  it("rejects callResult uint256 decode with a hex value", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: { encodedCall: BALANCE_OF_CALL },
        decode: "uint256",
        cmp: "eq",
        value: "0x00",
      }).success,
    ).toBe(false);
  });

  it("parses callResult with encodedCall", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: { encodedCall: BALANCE_OF_CALL },
        decode: "uint256",
        cmp: "eq",
        value: "0",
      }).success,
    ).toBe(true);
  });

  it("parses callResult with declarative abiRef form (CR6)", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: {
          abiRef: ABI_REF,
          function: "balanceOf(address)",
          args: [{ type: "address", value: ADDR1 }],
        },
        decode: "uint256",
        cmp: "eq",
        value: "0",
      }).success,
    ).toBe(true);
  });

  it("rejects merging encodedCall with declarative abi fields", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: {
          encodedCall: BALANCE_OF_CALL,
          abiRef: ABI_REF,
          function: "balanceOf(address)",
          args: [{ type: "address", value: ADDR1 }],
        },
        decode: "uint256",
        cmp: "eq",
        value: "0",
      }).success,
    ).toBe(false);
  });

  it("rejects non-canonical function signatures with parameter names", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: {
          abiRef: ABI_REF,
          function: "balanceOf(address owner)",
          args: [{ type: "address", value: ADDR1 }],
        },
        decode: "uint256",
        cmp: "eq",
        value: "0",
      }).success,
    ).toBe(false);
  });

  it("rejects declarative call arity mismatch", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: {
          abiRef: ABI_REF,
          function: "balanceOf(address)",
          args: [
            { type: "address", value: ADDR1 },
            { type: "address", value: ADDR2 },
          ],
        },
        decode: "uint256",
        cmp: "eq",
        value: "0",
      }).success,
    ).toBe(false);
  });

  it("rejects declarative call type mismatch", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: {
          abiRef: ABI_REF,
          function: "balanceOf(address)",
          args: [{ type: "uint256", value: "1" }],
        },
        decode: "uint256",
        cmp: "eq",
        value: "0",
      }).success,
    ).toBe(false);
  });

  it("rejects uint256 abi arg with a JSON number value", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: {
          abiRef: ABI_REF,
          function: "balanceOf(address)",
          args: [{ type: "uint256", value: 1 }],
        },
        decode: "uint256",
        cmp: "eq",
        value: "0",
      }).success,
    ).toBe(false);
  });

  it("rejects nested-tuple abi arg types as out-of-vocabulary", () => {
    expect(
      PredicateSchema.safeParse({
        kind: "callResult",
        to: TOKEN,
        call: {
          abiRef: ABI_REF,
          function: "pair(address,uint256)",
          args: [{ type: "(address,uint256)", value: ADDR1 }],
        },
        decode: "uint256",
        cmp: "eq",
        value: "0",
      }).success,
    ).toBe(false);
  });
});
