// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { PluginRuntimeError } from "../errors.js";
import { SESSION_FEED_VERSION } from "./identity.js";

/** Unsigned decimal, no leading zeros — the OTLP nanosecond encoding the spans reuse. */
const UnixNano = z.string().regex(/^(0|[1-9]\d*)$/u, "must be an unsigned decimal string");

const Rfc3339 = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
    "must be a strict RFC 3339 timestamp",
  )
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a real instant");

const SessionOpenSchema = z.strictObject({
  type: z.literal("session-open"),
  v: z.literal(SESSION_FEED_VERSION),
  sessionId: z.string().min(1).max(128),
  startedAt: Rfc3339,
  atUnixNano: UnixNano,
  host: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  model: z.strictObject({ provider: z.string().min(1), name: z.string().min(1) }),
  conversationId: z.string().min(1).optional(),
});

const EnvironmentSchema = z.strictObject({
  type: z.literal("environment"),
  atUnixNano: UnixNano,
  tools: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
});

const UserTurnSchema = z.strictObject({
  type: z.literal("user-turn"),
  atUnixNano: UnixNano,
  text: z.string(),
});

const AssistantTurnSchema = z.strictObject({
  type: z.literal("assistant-turn"),
  atUnixNano: UnixNano,
  text: z.string(),
  model: z.string().min(1).optional(),
});

const ToolCallSchema = z.strictObject({
  type: z.literal("tool-call"),
  startedAtUnixNano: UnixNano,
  atUnixNano: UnixNano,
  toolName: z.string().min(1),
  toolCallId: z.string().min(1),
  status: z.enum(["ok", "error"]),
  arguments: z.string(),
  result: z.string(),
  errorMessage: z.string().min(1).optional(),
});

const TokensSchema = z.strictObject({
  type: z.literal("tokens"),
  atUnixNano: UnixNano,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

const SessionCloseSchema = z.strictObject({
  type: z.literal("session-close"),
  atUnixNano: UnixNano,
  endedAt: Rfc3339,
  outcome: z.enum(["completed", "failed", "abandoned"]),
  summary: z.string(),
});

const SessionFeedEventSchema = z.discriminatedUnion("type", [
  SessionOpenSchema,
  EnvironmentSchema,
  UserTurnSchema,
  AssistantTurnSchema,
  ToolCallSchema,
  TokensSchema,
  SessionCloseSchema,
]);

export type SessionOpenEvent = z.infer<typeof SessionOpenSchema>;
export type SessionCloseEvent = z.infer<typeof SessionCloseSchema>;
export type UserTurnEvent = z.infer<typeof UserTurnSchema>;
export type AssistantTurnEvent = z.infer<typeof AssistantTurnSchema>;
export type ToolCallEvent = z.infer<typeof ToolCallSchema>;
export type SessionFeedEvent = z.infer<typeof SessionFeedEventSchema>;

export interface FeedLine {
  readonly ordinal: number;
  readonly event: SessionFeedEvent;
}

export interface ParsedSessionFeed {
  readonly sessionId: string;
  readonly open: SessionOpenEvent;
  readonly close?: SessionCloseEvent;
  readonly lines: readonly FeedLine[];
  readonly tokens?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly environment?: {
    readonly tools: readonly string[];
    readonly skills: readonly string[];
  };
}

function invalid(message: string, cause?: unknown): never {
  throw new PluginRuntimeError("capture-feed-invalid", message, { cause });
}

/**
 * Parses the append-only NDJSON session feed. Strict by construction: an unreadable feed is
 * a refused capture, never a silently truncated one. The 0-based line ordinal is preserved
 * because it is the stable back-reference from a trajectory span into the source line
 * (program finding F5 — the record carries no message content).
 */
export function parseSessionFeed(bytes: Uint8Array): ParsedSessionFeed {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    invalid("The session feed is not valid UTF-8.", error);
  }

  // Only the trailing newline is stripped. A blank line anywhere else is a malformed feed and
  // must fail loudly rather than be skipped, because skipping would shift every later ordinal
  // and silently break the span back-references.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const rawLines = body.length === 0 ? [] : body.split("\n");

  const lines: FeedLine[] = [];
  let open: SessionOpenEvent | undefined;
  let close: SessionCloseEvent | undefined;
  let tokens: ParsedSessionFeed["tokens"];
  let environment: ParsedSessionFeed["environment"];
  let previousNano = -1n;

  for (const [ordinal, raw] of rawLines.entries()) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      invalid(`The session feed is not valid JSON at line ${String(ordinal)}.`, error);
    }
    const parsed = SessionFeedEventSchema.safeParse(decoded);
    if (!parsed.success) {
      invalid(
        `The session feed carries an invalid event at line ${String(ordinal)}: ${
          parsed.error.issues[0]?.message ?? "unknown"
        }`,
        parsed.error,
      );
    }
    const event = parsed.data;

    if (event.type === "session-open") {
      if (ordinal !== 0 || open !== undefined) {
        invalid("A session feed must carry exactly one session-open event, first.");
      }
      open = event;
    } else if (ordinal === 0) {
      invalid("A session feed must begin with a session-open event.");
    }

    if (close !== undefined) {
      invalid("A session feed must carry session-close last.");
    }
    if (event.type === "session-close") close = event;

    const nano = BigInt(event.atUnixNano);
    if (nano < previousNano) {
      invalid(`Session feed timestamps must be non-decreasing (line ${String(ordinal)}).`);
    }
    previousNano = nano;

    if (event.type === "tool-call" && BigInt(event.startedAtUnixNano) > nano) {
      invalid(`A tool call must not end before it started (line ${String(ordinal)}).`);
    }
    if (event.type === "tokens") {
      tokens = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    }
    if (event.type === "environment") {
      environment = { tools: event.tools, skills: event.skills };
    }

    lines.push({ ordinal, event });
  }

  if (open === undefined) {
    invalid("A session feed must carry exactly one session-open event, first.");
  }
  if (close !== undefined && Date.parse(close.endedAt) < Date.parse(open.startedAt)) {
    invalid("The session feed's endedAt precedes its startedAt.");
  }

  return {
    sessionId: open.sessionId,
    open,
    ...(close === undefined ? {} : { close }),
    lines,
    ...(tokens === undefined ? {} : { tokens }),
    ...(environment === undefined ? {} : { environment }),
  };
}
