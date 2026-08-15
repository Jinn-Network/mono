// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_SEPOLIA_TODAY,
  JINN_ROUTER_V3_ABI,
  JINN_ROUTER_V4_ABI,
} from "@jinn-network/marketplace-binding";
import { encodeFunctionData, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BaseVenueSafeBroadcaster, SafeBroadcastReceipt } from "../broadcast/safe-broadcaster.js";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createLifecyclePorts, createReleasePort, type LifecycleWriterInput } from "./lifecycle.js";

const REVISED_CONFIG = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
const TASK_ID = 42n;
const ATTEMPT_INDEX = 3;
const VERDICT_INDEX = 1;
const TX_HASH = `0x${"a".repeat(64)}` as Hex;
const ATTEMPT_URI = "urn:uuid:11111111-1111-1111-1111-111111111111" as const;

function successReceipt(): SafeBroadcastReceipt {
  return { txHash: TX_HASH, blockNumber: 1n, blockHash: `0x${"d".repeat(64)}` as Hex, logs: [], alreadySettled: false };
}

function mockBroadcaster(execute: (request: unknown) => Promise<SafeBroadcastReceipt>): BaseVenueSafeBroadcaster {
  return {
    execute: vi.fn(execute) as BaseVenueSafeBroadcaster["execute"],
    classify: () => {
      throw new Error("not exercised by this test");
    },
    broadcastCreateTask: () => {
      throw new Error("not exercised by this test");
    },
  };
}

let root: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-lifecycle-"));
  state = openVenueState(join(root, "venue.db"));
});

afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

function makeInput(
  chain: LifecycleWriterInput["chain"],
  broadcaster: BaseVenueSafeBroadcaster,
  resolveAttempt: LifecycleWriterInput["resolveAttempt"] = vi.fn(),
): LifecycleWriterInput {
  return {
    chain,
    publicClient: {} as LifecycleWriterInput["publicClient"],
    broadcaster,
    state,
    resolveAttempt,
  };
}

describe("createLifecyclePorts", () => {
  test("today generation: refundUnusedTaskBudget is defined; closeTask and releaseAttempt are undefined", () => {
    const ports = createLifecyclePorts(makeInput(BASE_SEPOLIA_TODAY, mockBroadcaster(async () => successReceipt())));

    expect(ports.refundUnusedTaskBudget).toBeDefined();
    expect(ports.closeTask).toBeUndefined();
    expect(ports.releaseAttempt).toBeUndefined();
  });

  test("revised generation: closeTask and releaseAttempt are defined; refundUnusedTaskBudget is undefined", () => {
    const ports = createLifecyclePorts(makeInput(REVISED_CONFIG, mockBroadcaster(async () => successReceipt())));

    expect(ports.closeTask).toBeDefined();
    expect(ports.releaseAttempt).toBeDefined();
    expect(ports.refundUnusedTaskBudget).toBeUndefined();
  });

  test("withdrawAnnouncement is a no-op that resolves", async () => {
    const broadcaster = mockBroadcaster(async () => successReceipt());
    const ports = createLifecyclePorts(makeInput(BASE_SEPOLIA_TODAY, broadcaster));

    await expect(ports.withdrawAnnouncement({ taskId: TASK_ID })).resolves.toBeUndefined();
    expect(broadcaster.execute).not.toHaveBeenCalled();
  });

  test("resolveAttempt delegates to the injected resolver and propagates its result unchanged", async () => {
    const resolved = { taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX };
    const resolveAttempt = vi.fn(async () => resolved);
    const ports = createLifecyclePorts(
      makeInput(BASE_SEPOLIA_TODAY, mockBroadcaster(async () => successReceipt()), resolveAttempt),
    );

    await expect(ports.resolveAttempt(ATTEMPT_URI)).resolves.toBe(resolved);
    expect(resolveAttempt).toHaveBeenCalledWith(ATTEMPT_URI);
  });

  test("requestCancel writes the cancel_signals row and returns \"requested\" the first time", async () => {
    const ports = createLifecyclePorts(makeInput(BASE_SEPOLIA_TODAY, mockBroadcaster(async () => successReceipt())));

    const result = await ports.requestCancel({
      attempt: ATTEMPT_URI, taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, reason: "requester withdrew",
    });

    expect(result).toBe("requested");
    const row = state.db.prepare("SELECT * FROM cancel_signals WHERE attempt = ?").get(ATTEMPT_URI) as
      { task_id: string; attempt_index: number; reason: string; requested_at_ms: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.task_id).toBe(TASK_ID.toString());
    expect(row?.attempt_index).toBe(ATTEMPT_INDEX);
    expect(row?.reason).toBe("requester withdrew");
  });

  test("a second requestCancel for the same attempt returns \"already-requested\" and does not rewrite requested_at_ms", async () => {
    const ports = createLifecyclePorts(makeInput(BASE_SEPOLIA_TODAY, mockBroadcaster(async () => successReceipt())));
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);

    const first = await ports.requestCancel({
      attempt: ATTEMPT_URI, taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, reason: "requester withdrew",
    });
    const second = await ports.requestCancel({
      attempt: ATTEMPT_URI, taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, reason: "requester withdrew again",
    });

    expect(first).toBe("requested");
    expect(second).toBe("already-requested");
    const row = state.db.prepare("SELECT requested_at_ms, reason FROM cancel_signals WHERE attempt = ?")
      .get(ATTEMPT_URI) as { requested_at_ms: number; reason: string };
    expect(row.requested_at_ms).toBe(1_000);
    expect(row.reason).toBe("requester withdrew");
    nowSpy.mockRestore();
  });
});

describe("createReleasePort", () => {
  test("today generation returns { ok: false, kind: \"unsupported\" } without broadcasting anything", async () => {
    const broadcaster = mockBroadcaster(async () => successReceipt());
    const release = createReleasePort({ chain: BASE_SEPOLIA_TODAY, broadcaster });

    await expect(release.releaseAttempt({ taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX }))
      .resolves.toEqual({ ok: false, kind: "unsupported" });
    expect(broadcaster.execute).not.toHaveBeenCalled();
    expect(release.forfeitDeliveredReservation).toBeUndefined();
  });

  test("revised generation broadcasts releaseAttempt(taskId, attemptIndex) and resolves undefined", async () => {
    const broadcaster = mockBroadcaster(async () => successReceipt());
    const release = createReleasePort({ chain: REVISED_CONFIG, broadcaster });

    await expect(release.releaseAttempt({ taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX })).resolves.toBeUndefined();
    expect(broadcaster.execute).toHaveBeenCalledWith({
      to: REVISED_CONFIG.jinnRouter,
      value: 0n,
      data: encodeFunctionData({
        abi: JINN_ROUTER_V4_ABI, functionName: "releaseAttempt", args: [TASK_ID, ATTEMPT_INDEX],
      }),
      logicalTx: `lifecycle.releaseAttempt:${TASK_ID}:${ATTEMPT_INDEX}`,
    });
  });

  test("forfeitDeliveredReservation is defined only in revised generation and encodes all four arguments including legKind", async () => {
    const broadcaster = mockBroadcaster(async () => successReceipt());
    const release = createReleasePort({ chain: REVISED_CONFIG, broadcaster });
    expect(release.forfeitDeliveredReservation).toBeDefined();

    await release.forfeitDeliveredReservation?.({
      taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, verdictIndex: VERDICT_INDEX, legKind: 2,
    });

    expect(broadcaster.execute).toHaveBeenCalledWith({
      to: REVISED_CONFIG.jinnRouter,
      value: 0n,
      data: encodeFunctionData({
        abi: JINN_ROUTER_V4_ABI, functionName: "forfeitDeliveredReservation",
        args: [TASK_ID, ATTEMPT_INDEX, VERDICT_INDEX, 2],
      }),
      logicalTx: `lifecycle.forfeitDeliveredReservation:${TASK_ID}:${ATTEMPT_INDEX}:${VERDICT_INDEX}`,
    });
  });
});

describe("createLifecyclePorts chain writes", () => {
  test("today generation encodes refundUnusedTaskBudget against the V3 ABI", async () => {
    const broadcaster = mockBroadcaster(async () => successReceipt());
    const ports = createLifecyclePorts(makeInput(BASE_SEPOLIA_TODAY, broadcaster));

    await ports.refundUnusedTaskBudget?.({ taskId: TASK_ID });

    expect(broadcaster.execute).toHaveBeenCalledWith({
      to: BASE_SEPOLIA_TODAY.jinnRouter,
      value: 0n,
      data: encodeFunctionData({
        abi: JINN_ROUTER_V3_ABI, functionName: "refundUnusedTaskBudget", args: [TASK_ID],
      }),
      logicalTx: `lifecycle.refundUnusedTaskBudget:${TASK_ID}`,
    });
  });

  test("revised generation encodes closeTask against the V4 ABI", async () => {
    const broadcaster = mockBroadcaster(async () => successReceipt());
    const ports = createLifecyclePorts(makeInput(REVISED_CONFIG, broadcaster));

    await ports.closeTask?.({ taskId: TASK_ID });

    expect(broadcaster.execute).toHaveBeenCalledWith({
      to: REVISED_CONFIG.jinnRouter,
      value: 0n,
      data: encodeFunctionData({
        abi: JINN_ROUTER_V4_ABI, functionName: "closeTask", args: [TASK_ID],
      }),
      logicalTx: `lifecycle.closeTask:${TASK_ID}`,
    });
  });
});
