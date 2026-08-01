import { describe, expect, test } from "vitest";

import { DeterminismControlsSchema } from "./determinism.js";

const controls = () => ({
  miningMode: "manual",
  orderingPolicy: "fifo",
  mempoolPolicy: "none",
  initialBlockNumber: 21_000_001,
  initialTimestamp: 1_735_689_612,
  blockTimeProgression: { mode: "fixed-increment", secondsPerBlock: 12 },
  baseFeePolicy: { mode: "fixed", weiPerGas: "1000000000" },
  gasPricePolicy: { mode: "fixed", weiPerGas: "1000000000" },
  blockGasLimit: "30000000",
  perTransactionGasCeiling: "15000000",
  coinbase: `0x${"c0".repeat(20)}`,
  prevrandao: `0x${"4".repeat(64)}`,
  replacementPolicy: "reject",
  noncePolicy: "strict",
  timeoutClock: "chain-time",
  timeWarp: { maxSecondsPerOperation: 86_400, maxAggregateSeconds: 2_592_000, maxBlocksPerOperation: 7200 },
  resetMechanism: "fresh-process",
});

const parse = (document: unknown) => DeterminismControlsSchema.safeParse(document);

describe("determinism controls (§4.3)", () => {
  test("accepts a fully fixed control set", () => {
    expect(parse(controls()).success).toBe(true);
  });

  test.each([
    "miningMode", "orderingPolicy", "mempoolPolicy", "initialBlockNumber", "initialTimestamp",
    "blockTimeProgression", "baseFeePolicy", "gasPricePolicy", "blockGasLimit",
    "perTransactionGasCeiling", "coinbase", "prevrandao", "replacementPolicy", "noncePolicy",
    "timeoutClock", "timeWarp", "resetMechanism",
  ])("requires %s: an omitted knob is the one whose default moved", (key) => {
    const document = controls() as Record<string, unknown>;
    delete document[key];
    expect(parse(document).success).toBe(false);
  });

  test("gas and fee ceilings are decimal strings, not numbers", () => {
    expect(parse({ ...controls(), blockGasLimit: 30_000_000 }).success).toBe(false);
  });

  test("time-warp bounds are mandatory: unbounded accrual is how balance predicates get gamed", () => {
    const document = controls() as Record<string, unknown>;
    document.timeWarp = { maxSecondsPerOperation: 86_400 };
    expect(parse(document).success).toBe(false);
  });

  test("a fixed-increment progression must say how many seconds per block", () => {
    const document = controls();
    document.blockTimeProgression = { mode: "fixed-increment" } as never;
    expect(parse(document).success).toBe(false);
  });

  test("a `none` progression must not also carry a per-block increment", () => {
    const document = controls();
    document.blockTimeProgression = { mode: "none", secondsPerBlock: 12 } as never;
    expect(parse(document).success).toBe(false);
  });

  test("a fixed base-fee policy must say what the fee is; a disabled one must not", () => {
    expect(parse({ ...controls(), baseFeePolicy: { mode: "fixed" } }).success).toBe(false);
    expect(
      parse({ ...controls(), baseFeePolicy: { mode: "disabled", weiPerGas: "7" } }).success,
    ).toBe(false);
    expect(parse({ ...controls(), baseFeePolicy: { mode: "disabled" } }).success).toBe(true);
  });

  test("interval mining is refused outright: block production would follow the wall clock", () => {
    expect(parse({ ...controls(), miningMode: "interval" }).success).toBe(false);
  });

  test("auto mining is accepted: a block per transaction is driven by the agent, not the clock", () => {
    expect(parse({ ...controls(), miningMode: "auto" }).success).toBe(true);
  });
});
