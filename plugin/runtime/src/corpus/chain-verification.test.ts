// SPDX-License-Identifier: Apache-2.0
import type { VerifyDriver } from "@jinn-network/record-discovery-client";
import { describe, expect, test, vi } from "vitest";

import {
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
  firstAdoption: true,
};

const headInput = { source, head, headSignature: envelope };

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
    const verification = createDriverChainVerification(driver);

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
    await expect(createDriverChainVerification(driver).verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "fork-detected",
    });
  });

  test("rejects an unsigned head rather than accepting the unpublished profile", async () => {
    const driver = { verifySource: vi.fn() } as unknown as VerifyDriver;
    await expect(
      createDriverChainVerification(driver).verify({ ...input, headSignature: undefined }),
    ).resolves.toEqual({ status: "rejected", reason: "head-unsigned" });
    expect((driver.verifySource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  test("revalidates an unchanged head through the driver, passing the followed source", async () => {
    const verifyHead = vi.fn(async () => ({ status: "ok" }) as never);
    const driver = { verifyHead } as unknown as VerifyDriver;

    await expect(createDriverChainVerification(driver).revalidateHead(headInput)).resolves.toEqual({
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
    await expect(createDriverChainVerification(driver).revalidateHead(headInput)).resolves.toEqual({
      status: "rejected",
      reason: "stale",
    });
  });

  test("rejects an unsigned unchanged head, exactly as it rejects an unsigned chain head", async () => {
    const driver = { verifyHead: vi.fn() } as unknown as VerifyDriver;
    await expect(
      createDriverChainVerification(driver).revalidateHead({ ...headInput, headSignature: undefined }),
    ).resolves.toEqual({ status: "rejected", reason: "head-unsigned" });
    expect((driver.verifyHead as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  test("rejects when the driver throws revalidating an unchanged head", async () => {
    const driver = {
      verifyHead: async () => {
        throw new Error("transport failed");
      },
    } as unknown as VerifyDriver;
    await expect(createDriverChainVerification(driver).revalidateHead(headInput)).resolves.toEqual({
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
    await expect(createDriverChainVerification(driver).verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "verification-failed",
    });
  });
});
