// SPDX-License-Identifier: Apache-2.0
import type { VerifyDriver } from "@jinn-network/record-discovery-client";
import { describe, expect, test, vi } from "vitest";

import type { RuntimeLogger } from "../logger.js";
import {
  SYNC_ABORTED_REASON,
  SYNC_TRUNCATED_REASON,
  UNVERIFIED_CHAIN_ACKNOWLEDGEMENT,
  createDriverChainVerification,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
} from "./chain-verification.js";

const head = {
  protocol: "https://spec.jinn.network/record-discovery/v1",
  origin: "https://agents.test/alice/attempts",
  sequence: "0000000000000003",
  entry: `sha256:${"a".repeat(64)}` as const,
  issuedAt: "2026-07-30T00:00:00Z",
  refreshBy: "2026-08-30T00:00:00Z",
};

const envelope = { payloadType: "x", payload: "e30=", signatures: [] } as never;

const source = { agent: "https://agents.test/alice", name: "attempts" };

const input = {
  source,
  head,
  headSignature: envelope,
  entries: [],
  truncation: "none" as const,
  firstAdoption: true,
};

const headInput = { source, head, headSignature: envelope };

/**
 * The driver posture's logger seam (#3253). Every construction below supplies
 * one, because a posture that swallowed the driver's cause is the defect these
 * tests exist to hold closed.
 */
function spyLogger(): RuntimeLogger & { readonly warnings: Array<[string, Record<string, unknown> | undefined]> } {
  const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message, fields) => {
      warnings.push([message, fields as Record<string, unknown> | undefined]);
    },
    error: () => {},
  };
}

describe("rejecting chain verification (the default)", () => {
  test("rejects everything and reports its mode", async () => {
    const verification = createRejectingChainVerification();
    expect(verification.mode).toBe("unverified");
    await expect(verification.verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "chain-verification-not-configured",
    });
    // Revalidating an unchanged head is the one call a source can make over
    // and over without appending anything; a posture that admits nothing must
    // not admit that either.
    await expect(verification.revalidateHead(headInput)).resolves.toEqual({
      status: "rejected",
      reason: "chain-verification-not-configured",
    });
  });
});

describe("acknowledged unverified chain verification", () => {
  test("admits only when the exact acknowledgement is supplied", async () => {
    const verification = createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT);
    expect(verification.mode).toBe("unverified");
    await expect(verification.verify(input)).resolves.toEqual({ status: "ok" });
    await expect(verification.revalidateHead(headInput)).resolves.toEqual({ status: "ok" });
  });
});

describe("driver-backed chain verification", () => {
  test("reports verified mode and passes the head, signature, and entries through", async () => {
    const verifySource = vi.fn(async () => ({ status: "ok" }) as never);
    const driver = { verifySource } as unknown as VerifyDriver;
    const verification = createDriverChainVerification(driver, spyLogger());

    expect(verification.mode).toBe("verified");
    await expect(verification.verify(input)).resolves.toEqual({ status: "ok" });

    const passed = (verifySource.mock.calls as unknown as Array<[{ firstAdoption: boolean; head: unknown }]>)
      [0]![0];
    expect(passed.firstAdoption).toBe(true);
    expect(passed.head).toBe(head);
  });

  test("rejects when the driver rejects, surfacing the outcome status", async () => {
    const driver = {
      verifySource: async () => ({ status: "fork-detected" }) as never,
    } as unknown as VerifyDriver;
    await expect(createDriverChainVerification(driver, spyLogger()).verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "fork-detected",
    });
  });

  test("rejects an unsigned head rather than accepting the unpublished profile", async () => {
    const driver = { verifySource: vi.fn() } as unknown as VerifyDriver;
    await expect(
      createDriverChainVerification(driver, spyLogger()).verify({ ...input, headSignature: undefined }),
    ).resolves.toEqual({ status: "rejected", reason: "head-unsigned" });
    expect((driver.verifySource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  test("revalidates an unchanged head through the driver, passing the followed source", async () => {
    const verifyHead = vi.fn(async () => ({ status: "ok" }) as never);
    const driver = { verifyHead } as unknown as VerifyDriver;

    await expect(createDriverChainVerification(driver, spyLogger()).revalidateHead(headInput)).resolves.toEqual({
      status: "ok",
    });
    const passed = (verifyHead.mock.calls as unknown as Array<[{ source: unknown; head: unknown }]>)[0]![0];
    expect(passed.source).toBe(source);
    expect(passed.head).toBe(head);
  });

  test("rejects an unchanged head when the driver refuses it, surfacing the outcome status", async () => {
    const driver = {
      verifyHead: async () => ({ status: "stale" }) as never,
    } as unknown as VerifyDriver;
    await expect(createDriverChainVerification(driver, spyLogger()).revalidateHead(headInput)).resolves.toEqual({
      status: "rejected",
      reason: "stale",
    });
  });

  test("rejects an unsigned unchanged head, exactly as it rejects an unsigned chain head", async () => {
    const driver = { verifyHead: vi.fn() } as unknown as VerifyDriver;
    await expect(
      createDriverChainVerification(driver, spyLogger()).revalidateHead({ ...headInput, headSignature: undefined }),
    ).resolves.toEqual({ status: "rejected", reason: "head-unsigned" });
    expect((driver.verifyHead as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  test("rejects when the driver throws revalidating an unchanged head", async () => {
    const driver = {
      verifyHead: async () => {
        throw new Error("transport failed");
      },
    } as unknown as VerifyDriver;
    await expect(createDriverChainVerification(driver, spyLogger()).revalidateHead(headInput)).resolves.toEqual({
      status: "rejected",
      reason: "verification-failed",
    });
  });

  test("rejects when the driver throws instead of returning", async () => {
    const driver = {
      verifySource: async () => {
        throw new Error("transport failed");
      },
    } as unknown as VerifyDriver;
    await expect(createDriverChainVerification(driver, spyLogger()).verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "verification-failed",
    });
  });

  // #3253: `verification-failed` is a closed-union literal on a health surface
  // that renders only status literals and locally configured source names, so
  // the driver's cause cannot travel in `reason`. It travels in the log, or the
  // operator has the symptom and nothing else.
  test("logs the thrown cause with the source identity, leaving the reason a literal", async () => {
    const log = spyLogger();
    const driver = {
      verifySource: async () => {
        throw new Error("transport failed");
      },
    } as unknown as VerifyDriver;

    await expect(createDriverChainVerification(driver, log).verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "verification-failed",
    });

    expect(log.warnings).toHaveLength(1);
    const [message, fields] = log.warnings[0]!;
    expect(message).toBe("corpus.chain-verification.driver-failed");
    expect(fields).toEqual({
      agent: source.agent,
      name: source.name,
      operation: "verify",
      message: expect.stringContaining("transport failed"),
    });
  });

  test("logs the thrown cause when revalidating an unchanged head too", async () => {
    const log = spyLogger();
    const driver = {
      verifyHead: async () => {
        throw new Error("head transport failed");
      },
    } as unknown as VerifyDriver;

    await expect(
      createDriverChainVerification(driver, log).revalidateHead(headInput),
    ).resolves.toEqual({ status: "rejected", reason: "verification-failed" });

    expect(log.warnings).toHaveLength(1);
    const [message, fields] = log.warnings[0]!;
    expect(message).toBe("corpus.chain-verification.driver-failed");
    expect(fields).toEqual({
      agent: source.agent,
      name: source.name,
      operation: "revalidate-head",
      message: expect.stringContaining("head transport failed"),
    });
  });

  test("stays quiet when the driver answers cleanly, refusal included", async () => {
    const log = spyLogger();
    const driver = {
      verifySource: async () => ({ status: "fork-detected" }) as never,
    } as unknown as VerifyDriver;

    await expect(createDriverChainVerification(driver, log).verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "fork-detected",
    });
    expect(log.warnings).toHaveLength(0);
  });
});

describe("a walk the mirror itself truncated (#3252)", () => {
  const truncated = { ...input, truncation: "bound" as const };

  test("the driver posture refuses it without asking the driver to verify it", async () => {
    const verifySource = vi.fn(async () => ({ status: "broken-chain" }) as never);
    const driver = { verifySource } as unknown as VerifyDriver;

    await expect(createDriverChainVerification(driver, spyLogger()).verify(truncated)).resolves.toEqual({
      status: "rejected",
      reason: "sync-truncated",
    });
    expect(verifySource).not.toHaveBeenCalled();
  });

  test("the unverified posture still admits it, so a capped mirror keeps making progress", async () => {
    const verification = createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT);
    await expect(verification.verify(truncated)).resolves.toEqual({ status: "ok" });
  });
});

// #3672: both abandonments produce a prefix, and the `verified` posture is
// right to refuse either. What differs is the REASON the operator is shown,
// because only one of the two names something they can change.
describe("a walk the mirror abandoned because it was cancelled (#3672)", () => {
  const aborted = { ...input, truncation: "aborted" as const };

  test("is refused with a reason that names cancellation, not the per-pass bound", async () => {
    const verifySource = vi.fn(async () => ({ status: "broken-chain" }) as never);
    const driver = { verifySource } as unknown as VerifyDriver;

    await expect(createDriverChainVerification(driver, spyLogger()).verify(aborted)).resolves.toEqual({
      status: "rejected",
      reason: "sync-aborted",
    });
    // Refused ahead of the driver for the same reason a bounded walk is: the
    // entry the head cites was never fetched, so linkage would come back
    // `broken-chain` and blame the archive.
    expect(verifySource).not.toHaveBeenCalled();
  });

  test("the two abandonments do not share one reason", () => {
    expect(SYNC_ABORTED_REASON).not.toBe(SYNC_TRUNCATED_REASON);
  });

  test("the unverified posture still admits it, exactly as it admits a bounded prefix", async () => {
    const verification = createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT);
    await expect(verification.verify(aborted)).resolves.toEqual({ status: "ok" });
  });
});
