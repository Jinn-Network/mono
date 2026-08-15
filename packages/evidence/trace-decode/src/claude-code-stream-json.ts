// SPDX-License-Identifier: Apache-2.0

import { SPAN_KIND, STATUS_CODE } from "@jinn-network/evidence-trace";
import type { Attribute, SpanStatus } from "@jinn-network/evidence-trace";

import { sortAttributes } from "./contract.js";
import type {
  Completeness,
  DecodeResult,
  SpanDraft,
  TraceDecoder,
} from "./contract.js";

export const CLAUDE_CODE_STREAM_JSON_FORMAT_IRI =
  "https://spec.jinn.network/formats/claude-code-stream-json/v1" as const;

const DECODER_ID = "claude-code-stream-json";
const DECODER_VERSION = "1.0.0";
const PROVIDER_NAME = "anthropic";
const AGENT_NAME = "claude-code";

interface OpenSpan {
  parentOrdinal: number | null;
  name: string;
  kind: 1 | 2 | 3 | 4 | 5;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: SpanStatus;
}

const stringAttribute = (key: string, value: string): Attribute => ({
  key,
  value: { stringValue: value },
});

const integerAttribute = (key: string, value: number): Attribute => ({
  key,
  value: { intValue: String(value) },
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCount(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function blocks(message: Record<string, unknown> | undefined): readonly unknown[] {
  if (message === undefined) return [];
  return Array.isArray(message.content) ? (message.content as readonly unknown[]) : [];
}

/**
 * Decode a Claude Code `--output-format stream-json` trace.
 *
 * Span model: one root `invoke_agent` span; one `chat` span per assistant record, because a
 * `chat` span in the GenAI conventions is one model call; one `execute_tool` span per
 * `tool_use` block, a child of the chat span that requested it, closed by the matching
 * `tool_result`. `user` records are the input to the call that follows and produce no span.
 *
 * The format carries no timestamps, so times are **source line indices** and the result
 * declares `timebase: "synthetic-ordinal"`. No message content, tool argument, or tool
 * output crosses into a span; `jinn.trace.source.ordinal` points back into the
 * digest-bound bytes for consumers that need it.
 */
function decodeStream(bytes: Uint8Array): DecodeResult {
  const lines = new TextDecoder().decode(bytes).split("\n");
  const spans: OpenSpan[] = [];
  const openToolByCallId = new Map<string, number>();

  let skipped = 0;
  let rootOrdinalSource: number | undefined;
  let conversationId: string | undefined;
  let requestModel: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let outcome: string | undefined;
  let rootStatus: SpanStatus = { code: STATUS_CODE.UNSET };
  let lastTick = 0;

  const tick = (value: number): void => {
    if (value > lastTick) lastTick = value;
  };

  const ensureRoot = (index: number): void => {
    if (spans.length > 0) return;
    rootOrdinalSource = index;
    spans.push({
      parentOrdinal: null,
      name: `invoke_agent ${AGENT_NAME}`,
      kind: SPAN_KIND.INTERNAL,
      startTimeUnixNano: String(index),
      endTimeUnixNano: String(index),
      attributes: [],
      status: { code: STATUS_CODE.UNSET },
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isObject(parsed)) {
      skipped += 1;
      continue;
    }
    const type = readString(parsed, "type");
    if (type === undefined) {
      skipped += 1;
      continue;
    }

    ensureRoot(index);
    tick(index + 1);

    if (type === "system") {
      conversationId ??= readString(parsed, "session_id");
      requestModel ??= readString(parsed, "model");
      continue;
    }

    if (type === "result") {
      const usage = isObject(parsed.usage) ? parsed.usage : undefined;
      if (usage !== undefined) {
        inputTokens ??= readCount(usage, "input_tokens");
        outputTokens ??= readCount(usage, "output_tokens");
      }
      const subtype = readString(parsed, "subtype");
      const failed = parsed.is_error === true || (subtype !== undefined && subtype !== "success");
      outcome = failed ? "error" : "success";
      rootStatus = { code: failed ? STATUS_CODE.ERROR : STATUS_CODE.OK };
      continue;
    }

    const message = isObject(parsed.message) ? parsed.message : undefined;

    if (type === "user") {
      for (const block of blocks(message)) {
        if (!isObject(block) || block.type !== "tool_result") continue;
        const callId = readString(block, "tool_use_id");
        if (callId === undefined) continue;
        const target = openToolByCallId.get(callId);
        if (target === undefined) continue;
        openToolByCallId.delete(callId);
        const tool = spans[target]!;
        tool.endTimeUnixNano = String(index);
        tool.status = {
          code: block.is_error === true ? STATUS_CODE.ERROR : STATUS_CODE.OK,
        };
        if (tool.parentOrdinal !== null) {
          const chat = spans[tool.parentOrdinal]!;
          if (BigInt(chat.endTimeUnixNano) < BigInt(index)) {
            chat.endTimeUnixNano = String(index);
          }
        }
      }
      continue;
    }

    if (type !== "assistant" || message === undefined) continue;

    const responseModel = readString(message, "model");
    const chatOrdinal = spans.length;
    spans.push({
      parentOrdinal: 0,
      name: responseModel === undefined ? "chat" : `chat ${responseModel}`,
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: String(index),
      endTimeUnixNano: String(index + 1),
      attributes: [
        stringAttribute("gen_ai.operation.name", "chat"),
        stringAttribute("gen_ai.provider.name", PROVIDER_NAME),
        stringAttribute("jinn.trace.turn.role", "assistant"),
        integerAttribute("jinn.trace.source.ordinal", index),
        ...(responseModel === undefined
          ? []
          : [stringAttribute("gen_ai.response.model", responseModel)]),
      ],
      status: { code: STATUS_CODE.OK },
    });
    tick(index + 1);

    for (const block of blocks(message)) {
      if (!isObject(block) || block.type !== "tool_use") continue;
      const callId = readString(block, "id");
      const toolName = readString(block, "name");
      if (callId === undefined || toolName === undefined) continue;
      if (openToolByCallId.has(callId)) continue;
      openToolByCallId.set(callId, spans.length);
      spans.push({
        parentOrdinal: chatOrdinal,
        name: `execute_tool ${toolName}`,
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: String(index),
        endTimeUnixNano: String(index),
        attributes: [
          stringAttribute("gen_ai.operation.name", "execute_tool"),
          stringAttribute("gen_ai.tool.call.id", callId),
          stringAttribute("gen_ai.tool.name", toolName),
          stringAttribute("gen_ai.tool.type", "function"),
          integerAttribute("jinn.trace.source.ordinal", index),
        ],
        status: { code: STATUS_CODE.UNSET },
      });
    }
  }

  if (spans.length > 0) {
    const root = spans[0]!;
    let end = BigInt(lastTick);
    for (const span of spans) {
      const candidate = BigInt(span.endTimeUnixNano);
      if (candidate > end) end = candidate;
    }
    root.endTimeUnixNano = String(end);
    root.status = rootStatus;
    root.attributes = [
      stringAttribute("gen_ai.agent.name", AGENT_NAME),
      stringAttribute("gen_ai.operation.name", "invoke_agent"),
      stringAttribute("gen_ai.provider.name", PROVIDER_NAME),
      integerAttribute("jinn.trace.source.ordinal", rootOrdinalSource ?? 0),
      ...(conversationId === undefined
        ? []
        : [stringAttribute("gen_ai.conversation.id", conversationId)]),
      ...(requestModel === undefined
        ? []
        : [stringAttribute("gen_ai.request.model", requestModel)]),
      ...(inputTokens === undefined
        ? []
        : [integerAttribute("gen_ai.usage.input_tokens", inputTokens)]),
      ...(outputTokens === undefined
        ? []
        : [integerAttribute("gen_ai.usage.output_tokens", outputTokens)]),
      ...(outcome === undefined
        ? []
        : [stringAttribute("jinn.trace.outcome", outcome)]),
    ];
  }

  const completeness: Completeness =
    spans.length === 0
      ? {
          decoded: "empty",
          ...(skipped > 0 ? { skipped } : {}),
          reason: "no interpretable stream records",
        }
      : skipped > 0
        ? {
            decoded: "partial",
            skipped,
            reason: "unparseable stream lines were skipped",
          }
        : { decoded: "full" };

  const drafts: SpanDraft[] = spans.map((span) => ({
    parentOrdinal: span.parentOrdinal,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: sortAttributes(span.attributes),
    events: [],
    status: span.status,
  }));

  return { drafts, completeness, timebase: "synthetic-ordinal" };
}

export function createClaudeCodeStreamJsonDecoder(): TraceDecoder {
  return {
    formatIri: CLAUDE_CODE_STREAM_JSON_FORMAT_IRI,
    decoderId: DECODER_ID,
    decoderVersion: DECODER_VERSION,
    decode: decodeStream,
  };
}
