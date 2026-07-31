// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import type { CaptureCapability } from "../../capture/capability.js";
import { PluginRuntimeError } from "../../errors.js";
import { type ToolResponse, toolFailure, toolJson } from "../result.js";

/**
 * A session id becomes a directory name under `<captureDirectory>/sessions/`,
 * so it is constrained to a slug here as well as by C4's own path helpers.
 */
const SessionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a path-safe slug");

export const captureOpenInputShape = {
  sessionId: SessionId.optional().describe(
    "Caller-chosen session id. Omit to have the runtime mint one.",
  ),
} as const;

export const captureSealInputShape = {
  sessionId: SessionId.describe("The session id returned by capture_open."),
  outcome: z
    .enum(["completed", "failed", "abandoned"])
    .optional()
    .describe("Supplied only when the feed carries no session-close event."),
  endedAt: z
    .string()
    .datetime()
    .optional()
    .describe("RFC 3339 end time, under the same condition as outcome."),
} as const;

export const captureAbandonInputShape = {
  sessionId: SessionId.describe("The session id returned by capture_open."),
} as const;

export type CaptureOpenArgs = z.infer<z.ZodObject<typeof captureOpenInputShape>>;
export type CaptureSealArgs = z.infer<z.ZodObject<typeof captureSealInputShape>>;
export type CaptureAbandonArgs = z.infer<z.ZodObject<typeof captureAbandonInputShape>>;

export interface CaptureToolDeps {
  readonly capture: CaptureCapability;
}

export const CAPTURE_OPEN_DESCRIPTION =
  "Open a capture session and return the path of its append-only session feed. Adapter-facing; transcript bytes move by path, never through this call.";
export const CAPTURE_SEAL_DESCRIPTION =
  "Read this session's feed from disk and seal it into the local evidence archive. Adapter-facing.";
export const CAPTURE_ABANDON_DESCRIPTION =
  "Discard a capture session without sealing it. Adapter-facing.";

function busy(error: PluginRuntimeError): ToolResponse {
  return toolFailure({
    code: error.code,
    detail:
      "the local archive is held by another operation on this machine; the session feed is intact, retry the seal in a moment.",
    retryable: true,
  });
}

export async function handleCaptureOpen(
  deps: CaptureToolDeps,
  args: CaptureOpenArgs,
): Promise<ToolResponse> {
  try {
    const opened = await deps.capture.openSession(
      args.sessionId ? { sessionId: args.sessionId } : undefined,
    );
    return toolJson({ sessionId: opened.sessionId, feedPath: opened.feedPath });
  } catch (error) {
    return toolFailure({
      code: error instanceof PluginRuntimeError ? error.code : "CAPTURE_OPEN_FAILED",
      detail: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
  }
}

export async function handleCaptureSeal(
  deps: CaptureToolDeps,
  args: CaptureSealArgs,
): Promise<ToolResponse> {
  try {
    const result = await deps.capture.sealSession({
      sessionId: args.sessionId,
      ...(args.outcome ? { outcome: args.outcome } : {}),
      ...(args.endedAt ? { endedAt: args.endedAt } : {}),
    });
    if (result.sealed) {
      return toolJson({ sealed: true, digest: result.capture.record.digest });
    }
    // An unsealable feed is a report, not a tool error: the adapter logs it and
    // the session continues. Failing the call would make a capture problem look
    // like a broken product to the host.
    return toolJson({ sealed: false, diagnostics: result.diagnostics });
  } catch (error) {
    if (error instanceof PluginRuntimeError && error.code === "capture-archive-busy") {
      return busy(error);
    }
    return toolFailure({
      code: error instanceof PluginRuntimeError ? error.code : "CAPTURE_SEAL_FAILED",
      detail: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
  }
}

export async function handleCaptureAbandon(
  deps: CaptureToolDeps,
  args: CaptureAbandonArgs,
): Promise<ToolResponse> {
  try {
    await deps.capture.abandonSession(args.sessionId);
  } catch {
    // Abandoning is idempotent by intent: an unknown or already-discarded
    // session is the desired end state, not a failure to report.
  }
  return toolJson({ abandoned: true, sessionId: args.sessionId });
}
