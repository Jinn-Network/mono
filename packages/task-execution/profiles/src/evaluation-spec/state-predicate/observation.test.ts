/**
 * Fixture-address convention (program §4.8): synthetic documentation addresses only.
 */
import { describe, expect, it } from "vitest";
import { CanonicalChainObservationSchema } from "./observation.js";

const ADDR1 = "0x0000000000000000000000000000000000000001";
const HEX32 = `0x${"0".repeat(64)}`;
const ENV_RECORD = `sha256:${"a".repeat(64)}`;
const TRACE_DIGEST = `sha256:${"b".repeat(64)}`;

const GOLDEN_OBSERVATION = {
  observationVersion: "1",
  environmentRecord: ENV_RECORD,
  informationWorlds: ["corpus-world"],
  replay: { status: "completed" },
  timeline: {
    initialBlockNumber: "100",
    initialChainTimestamp: "1700000000",
    finalStateChangingBlockNumber: "105",
    finalStateChangingChainTimestamp: "1700000300",
  },
  transactions: [
    {
      index: "0",
      hash: HEX32,
      from: ADDR1,
      to: ADDR1,
      valueWei: "0",
      status: "success",
      gasUsed: "21000",
      returnData: "0x",
      logs: [],
      blockNumber: "105",
      blockTimestamp: "1700000300",
    },
  ],
  blocks: [{ number: "105", timestamp: "1700000300", hash: HEX32 }],
  touchedState: [
    {
      address: ADDR1,
      nativeBalanceWei: "0",
      nonce: "1",
      codeHash: HEX32,
      storage: [],
    },
  ],
  traceProjectionDigest: TRACE_DIGEST,
  finalStateCommitment: `0x${"c".repeat(64)}`,
  errorClasses: [],
  stateReads: [
    {
      key: `native-balance|${ADDR1}`,
      state: "post-replay",
      resolution: "resolved",
      value: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
  ],
  sourceReads: [],
  sourceConsultations: [],
  reports: [{ name: "price", value: "100" }],
};

describe("CanonicalChainObservationSchema", () => {
  it("parses a full golden observation", () => {
    const parsed = CanonicalChainObservationSchema.safeParse(GOLDEN_OBSERVATION);
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown top-level key (strict object)", () => {
    const parsed = CanonicalChainObservationSchema.safeParse({
      ...GOLDEN_OBSERVATION,
      extraField: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate stateReads for the same (key, state)", () => {
    const parsed = CanonicalChainObservationSchema.safeParse({
      ...GOLDEN_OBSERVATION,
      stateReads: [
        {
          key: `native-balance|${ADDR1}`,
          state: "post-replay",
          resolution: "resolved",
          value: "0x0000000000000000000000000000000000000000000000000000000000000000",
        },
        {
          key: `native-balance|${ADDR1}`,
          state: "post-replay",
          resolution: "resolved",
          value: "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects uppercase addresses in nested transaction fields", () => {
    const parsed = CanonicalChainObservationSchema.safeParse({
      ...GOLDEN_OBSERVATION,
      transactions: [
        {
          ...GOLDEN_OBSERVATION.transactions[0],
          from: "0xAB0000000000000000000000000000000000000001",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
