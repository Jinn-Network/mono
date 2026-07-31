import type { PublicClient } from "viem";
import { describe, expect, test, vi, type Mock } from "vitest";
import { BASE_SEPOLIA_TODAY } from "../addresses.js";
import type { PostingIntent } from "../broadcast-intent.js";
import { DEFAULT_SCAN_BLOCK_RANGE, scanForOnChainMatch } from "./task-created-scan.js";

const CREATOR = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;
const TASK_DIGEST = "a".repeat(64);
const INTENT: PostingIntent = {
  creatorSafe: CREATOR,
  taskCidDigest: `sha256:${TASK_DIGEST}`,
  submissionDigest: `sha256:${"b".repeat(64)}`,
  idempotencyKey: "key-1",
  createdAt: "2026-07-31T00:00:00Z",
};

function log(overrides: Record<string, unknown> = {}) {
  return {
    args: { creator: CREATOR, taskId: 42n, taskCidDigest: `0x${TASK_DIGEST}` },
    transactionHash: `0x${"cd".repeat(32)}`,
    blockNumber: 100n,
    logIndex: 0,
    ...overrides,
  };
}

/** The one `getLogs` query shape the scan issues; declared so the stubs' `mock.calls` are typed. */
interface ScanLogQuery {
  readonly address: `0x${string}`;
  readonly args: { readonly creator: `0x${string}` };
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}
type GetLogsMock = Mock<(query: ScanLogQuery) => Promise<readonly ReturnType<typeof log>[]>>;

function client(getLogs: GetLogsMock, head = 1_000n): PublicClient {
  return { getLogs, getBlockNumber: vi.fn(async () => head) } as unknown as PublicClient;
}

describe("scanForOnChainMatch", () => {
  test("adopts a post whose creator and task digest both match", async () => {
    const getLogs: GetLogsMock = vi.fn(async (_query: ScanLogQuery) => [log()]);
    const scan = scanForOnChainMatch(client(getLogs), { chain: BASE_SEPOLIA_TODAY, fromBlock: 0n });
    expect(await scan(INTENT)).toEqual({ taskId: 42n, txHash: `0x${"cd".repeat(32)}` });
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({
      address: BASE_SEPOLIA_TODAY.jinnRouter,
      args: { creator: CREATOR },
    });
  });

  test("ignores a post by the same creator for a different task digest", async () => {
    const getLogs: GetLogsMock = vi.fn(async (_query: ScanLogQuery) => [log({ args: { creator: CREATOR, taskId: 9n, taskCidDigest: `0x${"f".repeat(64)}` } })]);
    const scan = scanForOnChainMatch(client(getLogs), { chain: BASE_SEPOLIA_TODAY, fromBlock: 0n });
    expect(await scan(INTENT)).toBeNull();
  });

  test("returns null when nothing landed", async () => {
    const scan = scanForOnChainMatch(client(vi.fn(async (_query: ScanLogQuery) => [])), { chain: BASE_SEPOLIA_TODAY, fromBlock: 0n });
    expect(await scan(INTENT)).toBeNull();
  });

  test("windows the scan so a capped provider is never asked for the whole range at once", async () => {
    const getLogs: GetLogsMock = vi.fn(async (_query: ScanLogQuery) => []);
    const scan = scanForOnChainMatch(client(getLogs, 5_000n), {
      chain: BASE_SEPOLIA_TODAY, fromBlock: 0n, blockRange: 2_000n,
    });
    await scan(INTENT);
    expect(getLogs.mock.calls.map((call) => [call[0].fromBlock, call[0].toBlock]))
      .toEqual([[0n, 1_999n], [2_000n, 3_999n], [4_000n, 5_000n]]);
  });

  test("defaults to a provider-safe window and honors an explicit toBlock without asking for head", async () => {
    expect(DEFAULT_SCAN_BLOCK_RANGE).toBe(2_000n);
    const getBlockNumber = vi.fn();
    const getLogs: GetLogsMock = vi.fn(async (_query: ScanLogQuery) => []);
    const scan = scanForOnChainMatch({ getLogs, getBlockNumber } as unknown as PublicClient, {
      chain: BASE_SEPOLIA_TODAY, fromBlock: 10n, toBlock: 20n,
    });
    await scan(INTENT);
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 10n, toBlock: 20n });
  });

  test("adopts the earliest of two matching posts and reports the ambiguity", async () => {
    const onAmbiguousMatch = vi.fn();
    const getLogs: GetLogsMock = vi.fn(async (_query: ScanLogQuery) => [
      log({ taskId: 77n, blockNumber: 300n, args: { creator: CREATOR, taskId: 77n, taskCidDigest: `0x${TASK_DIGEST}` } }),
      log({ blockNumber: 200n }),
    ]);
    const scan = scanForOnChainMatch(client(getLogs), {
      chain: BASE_SEPOLIA_TODAY, fromBlock: 0n, onAmbiguousMatch,
    });
    expect(await scan(INTENT)).toMatchObject({ taskId: 42n });
    expect(onAmbiguousMatch).toHaveBeenCalledTimes(1);
  });

  test("rejects a non-positive window rather than looping forever", () => {
    expect(() => scanForOnChainMatch(client(vi.fn(async (_query: ScanLogQuery) => [])), {
      chain: BASE_SEPOLIA_TODAY, fromBlock: 0n, blockRange: 0n,
    })).toThrow(RangeError);
  });
});
