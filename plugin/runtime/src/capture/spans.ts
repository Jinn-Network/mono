// SPDX-License-Identifier: Apache-2.0

import {
  type Attribute,
  GEN_AI_ATTRIBUTES,
  JINN_ATTRIBUTES,
  OPERATION_NAMES,
  SPAN_KIND,
  STATUS_CODE,
  type Span,
  compareCodeUnitStrings,
  deriveSpanId,
} from "@jinn-network/evidence-trace";

import type { FeedLine, ParsedSessionFeed } from "./feed.js";

export interface BuildTraceSpansInput {
  readonly feed: ParsedSessionFeed;
  readonly traceId: string;
}

type MutableSpan = Omit<Span, "spanId" | "parentSpanId">;

const USER_MESSAGE_EVENT = "gen_ai.user.message" as const;

function text(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } };
}

function integer(key: string, value: number): Attribute {
  return { key, value: { intValue: String(value) } };
}

/** OTLP defines no attribute ordering; this profile fixes one (program finding F4). */
function sorted(attributes: readonly Attribute[]): Attribute[] {
  return [...attributes].sort((left, right) => compareCodeUnitStrings(left.key, right.key));
}

function userMessageEvent(line: FeedLine): Span["events"][number] {
  return {
    timeUnixNano: line.event.atUnixNano,
    name: USER_MESSAGE_EVENT,
    attributes: sorted([
      integer(JINN_ATTRIBUTES.sourceOrdinal, line.ordinal),
      text(JINN_ATTRIBUTES.turnRole, "user"),
    ]),
  };
}

function sessionStatus(outcome: string | undefined): Span["status"] {
  if (outcome === "completed") return { code: STATUS_CODE.OK };
  if (outcome === "failed") return { code: STATUS_CODE.ERROR };
  return { code: STATUS_CODE.UNSET };
}

/**
 * Builds the span list for one session feed.
 *
 * Pure: no wall clock, no randomness, no ambient state. Every timing, identity and ordinal
 * comes from the feed, so the same feed bytes always produce the same spans — which is what
 * the record's derived identity asserts and what a consumer can re-check.
 */
export function buildTraceSpans(input: BuildTraceSpansInput): readonly Span[] {
  const { feed, traceId } = input;
  const outcome = feed.close?.outcome;
  const lastNano =
    feed.lines.length > 0 ? feed.lines[feed.lines.length - 1]!.event.atUnixNano : feed.open.atUnixNano;

  const sessionAttributes: Attribute[] = [
    text(GEN_AI_ATTRIBUTES.agentName, feed.open.host.name),
    text(GEN_AI_ATTRIBUTES.conversationId, feed.open.conversationId ?? feed.sessionId),
    text(GEN_AI_ATTRIBUTES.operationName, OPERATION_NAMES.invokeAgent),
    text(GEN_AI_ATTRIBUTES.providerName, feed.open.model.provider),
    text(GEN_AI_ATTRIBUTES.requestModel, feed.open.model.name),
    text(JINN_ATTRIBUTES.outcome, outcome ?? "abandoned"),
    integer(JINN_ATTRIBUTES.sourceOrdinal, 0),
  ];
  if (feed.tokens !== undefined) {
    sessionAttributes.push(
      integer(GEN_AI_ATTRIBUTES.inputTokens, feed.tokens.inputTokens),
      integer(GEN_AI_ATTRIBUTES.outputTokens, feed.tokens.outputTokens),
    );
  }

  const session: MutableSpan = {
    name: `${OPERATION_NAMES.invokeAgent} ${feed.open.host.name}`,
    kind: SPAN_KIND.INTERNAL,
    startTimeUnixNano: feed.open.atUnixNano,
    endTimeUnixNano: feed.close?.atUnixNano ?? lastNano,
    attributes: sorted(sessionAttributes),
    events: [],
    status: sessionStatus(outcome),
  };

  const children: MutableSpan[] = [];
  let pendingUserTurns: FeedLine[] = [];
  let chatStartNano = feed.open.atUnixNano;

  for (const line of feed.lines) {
    const { event, ordinal } = line;
    if (event.type === "user-turn") {
      pendingUserTurns.push(line);
      continue;
    }
    if (event.type === "assistant-turn") {
      const responseModel = event.model ?? feed.open.model.name;
      children.push({
        name: `${OPERATION_NAMES.chat} ${responseModel}`,
        kind: SPAN_KIND.CLIENT,
        startTimeUnixNano: chatStartNano,
        endTimeUnixNano: event.atUnixNano,
        attributes: sorted([
          text(GEN_AI_ATTRIBUTES.operationName, OPERATION_NAMES.chat),
          text(GEN_AI_ATTRIBUTES.providerName, feed.open.model.provider),
          text(GEN_AI_ATTRIBUTES.requestModel, feed.open.model.name),
          text(GEN_AI_ATTRIBUTES.responseModel, responseModel),
          integer(JINN_ATTRIBUTES.sourceOrdinal, ordinal),
          text(JINN_ATTRIBUTES.turnRole, "assistant"),
        ]),
        events: pendingUserTurns.map(userMessageEvent),
        status: { code: STATUS_CODE.OK },
      });
      pendingUserTurns = [];
      chatStartNano = event.atUnixNano;
      continue;
    }
    if (event.type === "tool-call") {
      children.push({
        name: `${OPERATION_NAMES.executeTool} ${event.toolName}`,
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: event.startedAtUnixNano,
        endTimeUnixNano: event.atUnixNano,
        attributes: sorted([
          text(GEN_AI_ATTRIBUTES.operationName, OPERATION_NAMES.executeTool),
          text(GEN_AI_ATTRIBUTES.toolCallId, event.toolCallId),
          text(GEN_AI_ATTRIBUTES.toolName, event.toolName),
          integer(JINN_ATTRIBUTES.sourceOrdinal, ordinal),
        ]),
        events: [],
        status:
          event.status === "ok"
            ? { code: STATUS_CODE.OK }
            : { code: STATUS_CODE.ERROR, message: event.errorMessage ?? "tool call failed" },
      });
    }
  }

  // Trailing user turns never answered by the model still happened; they land on the session.
  const ordered: MutableSpan[] = [
    { ...session, events: pendingUserTurns.map(userMessageEvent) },
    ...children,
  ];

  const sessionSpanId = deriveSpanId(traceId, 0);
  return ordered.map((span, ordinal) => ({
    ...span,
    spanId: deriveSpanId(traceId, ordinal),
    parentSpanId: ordinal === 0 ? null : sessionSpanId,
  }));
}
