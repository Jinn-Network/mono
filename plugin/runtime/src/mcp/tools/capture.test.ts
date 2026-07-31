// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { CaptureCapability } from "../../capture/capability.js";
import { PluginRuntimeError } from "../../errors.js";
import {
  captureAbandonInputShape,
  captureOpenInputShape,
  captureSealInputShape,
  handleCaptureAbandon,
  handleCaptureOpen,
  handleCaptureSeal,
} from "./capture.js";

function capability(overrides: Partial<CaptureCapability>): CaptureCapability {
  return {
    name: "capture",
    openSession: async () => ({ sessionId: "s-1", feedPath: "/home/jinn/capture/sessions/s-1/feed.ndjson" }),
    sealSession: async () => ({
      sealed: true,
      capture: { record: { digest: "sha256:abc", family: "execution-evidence" } },
    }),
    abandonSession: async () => {},
    ...overrides,
  } as unknown as CaptureCapability;
}

describe("capture tools", () => {
  test("no capture schema accepts transcript content", () => {
    for (const shape of [captureOpenInputShape, captureSealInputShape, captureAbandonInputShape]) {
      const keys = Object.keys(shape);
      expect(keys).not.toContain("feed");
      expect(keys).not.toContain("feedPath");
      expect(keys).not.toContain("text");
      expect(keys).not.toContain("transcript");
    }
  });

  test("capture_open returns the session id and the feed path", async () => {
    const response = await handleCaptureOpen({ capture: capability({}) }, {});
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.sessionId).toBe("s-1");
    expect(payload.feedPath).toBe("/home/jinn/capture/sessions/s-1/feed.ndjson");
  });

  test("capture_open bounds a caller-supplied session id to a safe slug", () => {
    const schema = z.object(captureOpenInputShape);
    expect(schema.safeParse({ sessionId: "abc-123_XYZ" }).success).toBe(true);
    expect(schema.safeParse({ sessionId: "../escape" }).success).toBe(false);
    expect(schema.safeParse({ sessionId: "with/slash" }).success).toBe(false);
    expect(schema.safeParse({ sessionId: "x".repeat(200) }).success).toBe(false);
  });

  test("capture_seal reports the sealed digest", async () => {
    const response = await handleCaptureSeal({ capture: capability({}) }, { sessionId: "s-1" });
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.sealed).toBe(true);
    expect(payload.digest).toBe("sha256:abc");
  });

  test("capture_seal reports diagnostics without throwing when the feed is unsealable", async () => {
    const response = await handleCaptureSeal(
      {
        capture: capability({
          sealSession: async () =>
            ({ sealed: false, diagnostics: [{ code: "EMPTY_FEED", message: "no events" }] }) as never,
        }),
      },
      { sessionId: "s-1" },
    );
    const payload = JSON.parse(response.content[0]!.text);
    expect(response.isError).toBeUndefined();
    expect(payload.sealed).toBe(false);
    expect(payload.diagnostics[0].code).toBe("EMPTY_FEED");
  });

  test("capture_seal maps archive contention to a retryable refusal", async () => {
    const response = await handleCaptureSeal(
      {
        capture: capability({
          sealSession: async () => {
            throw new PluginRuntimeError("capture-archive-busy", "root in use");
          },
        }),
      },
      { sessionId: "s-1" },
    );
    expect(response.isError).toBe(true);
    const error = JSON.parse(response.content[0]!.text).error;
    expect(error.code).toBe("capture-archive-busy");
    expect(error.retryable).toBe(true);
  });

  test("capture_seal accepts an outcome only from the closed set", () => {
    const schema = z.object(captureSealInputShape);
    expect(schema.safeParse({ sessionId: "s", outcome: "completed" }).success).toBe(true);
    expect(schema.safeParse({ sessionId: "s", outcome: "cancelled" }).success).toBe(false);
    expect(schema.safeParse({ sessionId: "s", endedAt: "not-a-date" }).success).toBe(false);
  });

  test("capture_abandon acknowledges and never throws for an unknown session", async () => {
    const response = await handleCaptureAbandon(
      {
        capture: capability({
          abandonSession: async () => {
            throw new PluginRuntimeError("capture-session-unknown", "no such session");
          },
        }),
      },
      { sessionId: "gone" },
    );
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0]!.text).abandoned).toBe(true);
  });
});
