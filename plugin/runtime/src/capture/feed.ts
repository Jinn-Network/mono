// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { z } from "zod";

import { PluginRuntimeError } from "../errors.js";
import { PRODUCER_IRI, SESSION_FEED_VERSION, executorIri } from "./identity.js";

/**
 * Bounds on the producer-controlled inputs one session may bind. Enforced at parse time so an
 * oversized feed is a refused capture rather than a partial one — the same strictness the rest
 * of this parser holds. Workflow text, skill text, prompts, and effective configuration are
 * kilobyte-scale; anything past these bounds is a host bug, not a capture the runtime should
 * quietly truncate.
 */
export const CONTROLLED_INPUT_MAX_BYTES = 256 * 1024;
export const CONTROLLED_INPUT_MAX_COUNT = 32;

/**
 * A coarse pre-decode guard: refuse an obviously oversized string before allocating its decoding.
 * The exact byte bound is still checked after decoding, because base64 padding makes this length
 * a block-rounded ceiling rather than an equality.
 */
const CONTROLLED_INPUT_MAX_BASE64_LENGTH = Math.ceil(CONTROLLED_INPUT_MAX_BYTES / 3) * 4;

/** The producer-controlled input classes the protocol needs bound rather than labelled. */
export const CONTROLLED_INPUT_ROLES = ["workflow", "skill", "prompt", "config"] as const;
export type ControlledInputRole = (typeof CONTROLLED_INPUT_ROLES)[number];

/** Unsigned decimal, no leading zeros — the OTLP nanosecond encoding the spans reuse. */
const UnixNano = z.string().regex(/^(0|[1-9]\d*)$/u, "must be an unsigned decimal string");

const Rfc3339 = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
    "must be a strict RFC 3339 timestamp",
  )
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a real instant");

/**
 * A string the recorder will also accept. Its `nonEmptyString` trims first, so a blank-but-present
 * value would pass a plain `min(1)` here and then fail deep inside `start()` — an unsealable
 * session with an unnamed error instead of a named feed error naming the line.
 */
const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "must not be blank");

/**
 * Canonical base64 with correct padding. `Buffer.from` is lenient, so the shape is checked here.
 * Non-empty: a zero-byte controlled input would seal a record that claims to bind an input and
 * binds nothing.
 */
const Base64 = z
  .string()
  .min(1)
  .max(CONTROLLED_INPUT_MAX_BASE64_LENGTH, "must not exceed the controlled-input byte bound")
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
    "must be canonical base64",
  );

/**
 * The recorder rejects a non-absolute IRI at capture time; catching it here instead turns a
 * late `InvalidCaptureInput` into a named feed error naming the offending line.
 * Mirrors `isAbsoluteIri` in `@jinn-network/execution-recorder`, which is not public API.
 */
function isAbsoluteIri(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || /\s/u.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

/** Matches the recorder's `AbsoluteIri`, so a parsed feed needs no cast at the assembly seam. */
export type AbsoluteIriString = `${string}:${string}`;

const AbsoluteIri = z.custom<AbsoluteIriString>(
  (value) => typeof value === "string" && isAbsoluteIri(value),
  { message: "must be an absolute IRI" },
);

/**
 * A Git object name, SHA-1 or SHA-256. Lowercase hex only: the object name is the content
 * binding, and two spellings of one commit would be two identifiers for one fact.
 */
const GitObjectName = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, "must be a lowercase hex Git object name");

/**
 * The hosted model's full service identity. The fixture's second capture gap is a model known
 * only by its label; this is the deployment identity the protocol wants recorded instead, and
 * it maps onto the recorder's `opaque` runtime component.
 */
const ModelServiceSchema = z.strictObject({
  iri: AbsoluteIri,
  name: nonBlank(256).optional(),
  version: nonBlank(128).optional(),
  deployment: nonBlank(256).optional(),
  providerIri: AbsoluteIri.optional(),
});

const SessionOpenSchema = z.strictObject({
  type: z.literal("session-open"),
  v: z.literal(SESSION_FEED_VERSION),
  sessionId: z.string().min(1).max(128),
  startedAt: Rfc3339,
  atUnixNano: UnixNano,
  host: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  model: z.strictObject({
    provider: z.string().min(1),
    name: z.string().min(1),
    service: ModelServiceSchema.optional(),
  }),
  conversationId: z.string().min(1).optional(),
});

/**
 * The base repository state this execution started from — the fixture's first capture gap.
 * Emitted at most once, by the host adapter, at session start.
 */
const RepositoryStateSchema = z.strictObject({
  type: z.literal("repository-state"),
  atUnixNano: UnixNano,
  repository: AbsoluteIri,
  branch: nonBlank(256),
  targetBase: nonBlank(256),
  baseCommit: GitObjectName,
  baseTree: GitObjectName,
});

/**
 * One producer-controlled input, carried by value.
 *
 * Bytes travel inline rather than by path deliberately: a feed-supplied filesystem path would
 * turn this parser into an arbitrary-file-read primitive driven by host-written data, and the
 * only path the capture layer reads today is one it computed itself.
 */
const ControlledInputSchema = z.strictObject({
  type: z.literal("controlled-input"),
  atUnixNano: UnixNano,
  role: z.enum(CONTROLLED_INPUT_ROLES),
  name: nonBlank(256),
  mediaType: nonBlank(128),
  contentBase64: Base64,
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
  RepositoryStateSchema,
  ControlledInputSchema,
  EnvironmentSchema,
  UserTurnSchema,
  AssistantTurnSchema,
  ToolCallSchema,
  TokensSchema,
  SessionCloseSchema,
]);

export type SessionOpenEvent = z.infer<typeof SessionOpenSchema>;
export type RepositoryStateEvent = z.infer<typeof RepositoryStateSchema>;
export type ControlledInputEvent = z.infer<typeof ControlledInputSchema>;
export type SessionCloseEvent = z.infer<typeof SessionCloseSchema>;
export type UserTurnEvent = z.infer<typeof UserTurnSchema>;
export type AssistantTurnEvent = z.infer<typeof AssistantTurnSchema>;
export type ToolCallEvent = z.infer<typeof ToolCallSchema>;
export type SessionFeedEvent = z.infer<typeof SessionFeedEventSchema>;

/** One producer-controlled input, decoded once at parse time. */
export interface ControlledInput {
  readonly role: ControlledInputRole;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

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
  readonly repositoryState?: RepositoryStateEvent;
  readonly controlledInputs: readonly ControlledInput[];
}

function invalid(message: string, cause?: unknown): never {
  throw new PluginRuntimeError("capture-feed-invalid", message, { cause });
}

/**
 * Parses the append-only NDJSON session feed. Strict by construction: an unreadable feed is
 * a refused capture, never a silently truncated one. The 0-based line ordinal is preserved
 * because it is the stable back-reference from a trace span into the source line
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
  let repositoryState: RepositoryStateEvent | undefined;
  const controlledInputs: ControlledInput[] = [];
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
    if (event.type === "repository-state") {
      if (repositoryState !== undefined) {
        invalid(
          `A session feed must carry at most one repository-state event (line ${String(ordinal)}).`,
        );
      }
      repositoryState = event;
    }
    if (event.type === "controlled-input") {
      if (controlledInputs.length === CONTROLLED_INPUT_MAX_COUNT) {
        invalid(
          `A session feed must carry at most ${String(CONTROLLED_INPUT_MAX_COUNT)} ` +
            `controlled-input events (line ${String(ordinal)}).`,
        );
      }
      const bytes = new Uint8Array(Buffer.from(event.contentBase64, "base64"));
      if (bytes.byteLength > CONTROLLED_INPUT_MAX_BYTES) {
        invalid(
          `A controlled input must not exceed ${String(CONTROLLED_INPUT_MAX_BYTES)} bytes ` +
            `(line ${String(ordinal)} carries ${String(bytes.byteLength)} bytes).`,
        );
      }
      controlledInputs.push({
        role: event.role,
        name: event.name,
        mediaType: event.mediaType,
        bytes,
      });
    }

    lines.push({ ordinal, event });
  }

  if (open === undefined) {
    invalid("A session feed must carry exactly one session-open event, first.");
  }
  // A service IRI equal to the executor's or the producer's makes the record builder refuse the
  // whole seal with a graph-identity conflict. Named here, the feed is refused instead.
  const service = open.model.service;
  if (service !== undefined) {
    for (const [taken, whose] of [
      [executorIri(open.host.name), "executor"],
      [PRODUCER_IRI, "producer"],
    ] as const) {
      if (service.iri === taken) {
        invalid(`The model service IRI ${service.iri} is already the ${whose} identity.`);
      }
    }
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
    ...(repositoryState === undefined ? {} : { repositoryState }),
    controlledInputs,
  };
}
