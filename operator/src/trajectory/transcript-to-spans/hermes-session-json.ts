/**
 * hermes-session-json — converts a Hermes solve transcript (the finished
 * `$HERMES_HOME/sessions/session_*.json` record the hermes-agent adapter lifts
 * into `<workingDir>/.hermes-agent/session.json`) into jinn.agent_turn /
 * jinn.tool_call spans for TrajectoryCollector.
 *
 * The lifted record is a single JSON object whose `messages[]` array is in
 * canonical OpenAI Chat-Completions shape:
 *   - `{role:"user", content}`                          → agent_turn(user)
 *   - `{role:"assistant", content}`                     → agent_turn(assistant)
 *   - assistant `tool_calls: [{id, type:"function",     → one tool_call each,
 *      function:{name, arguments}}]`                       correlated to its
 *                                                          result by exact `id`
 *   - `{role:"tool", tool_call_id, content}`            → paired to the pending
 *                                                          tool_call by
 *                                                          tool_call_id
 *   - assistant `reasoning`                             → dropped (parity with
 *                                                          claude-code's
 *                                                          `thinking` drop)
 *   - `{role:"system", ...}`                            → skipped (no span)
 *
 * `function.arguments` is a JSON *string* per the OpenAI contract, so the
 * parser JSON.parse-s it (guarded — degrades to `{}` on non-JSON) before
 * stamping it on `tool.args` as an object.
 *
 * Tool-result OK/ERROR: Hermes `role:"tool"` messages carry NO structured
 * error flag (unlike claude-code's `tool_result.is_error`) — Hermes surfaces
 * tool failures inside `content`, not via a boolean. So every paired result is
 * recorded OK / `tool.result.is_error:false` (matches codex's `?? false`
 * fallback). Sniffing `content` for failure markers is out of scope for v1.
 *
 * The record carries no per-message wall-clock timestamps, so this parser
 * synthesizes monotonic nanosecond timestamps seeded at parse time and
 * incremented one tick per message — sufficient for span ordering, not
 * wall-clock accuracy (identical to the claude-code-stream-json strategy).
 *
 * Degrades to [] (never throws) on a missing/unreadable/unparseable file or a
 * record with no `messages` array — per-solve transcript parsing must never
 * fail the solve (AC-3).
 */

import { readFile } from 'node:fs/promises';
import type { SpanInput } from '../collector.js';
import type { TranscriptSpanParser } from './types.js';
import { truncate, truncateLeaves, makeProvenanceAttrs, stringifyResultContent } from './attrs.js';

const SOURCE_FORMAT = 'hermes-session-json';
const PARSER_NAME = 'hermes-session-json';
const PARSER_VERSION = '1.0.0';

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface HermesMessage {
  role?: string;
  content?: unknown;
  reasoning?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface HermesSession {
  messages?: HermesMessage[];
}

function provenanceAttrs(): Record<string, unknown> {
  return makeProvenanceAttrs(SOURCE_FORMAT, PARSER_NAME, PARSER_VERSION);
}

/** OpenAI `function.arguments` is a JSON string; degrade to {} on non-JSON. */
function parseToolArgs(raw: string | undefined): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export class HermesSessionJsonParser implements TranscriptSpanParser {
  readonly sourceFormat = SOURCE_FORMAT;
  readonly parserName = PARSER_NAME;
  readonly parserVersion = PARSER_VERSION;

  async parse(transcriptPath: string): Promise<SpanInput[]> {
    let rawText: string;
    try {
      rawText = await readFile(transcriptPath, 'utf-8');
    } catch {
      return [];
    }

    let session: HermesSession;
    try {
      session = JSON.parse(rawText) as HermesSession;
    } catch {
      return [];
    }
    if (!session || !Array.isArray(session.messages)) return [];

    const spans: SpanInput[] = [];
    const pendingByToolCallId = new Map<string, SpanInput>();
    let nextNs = BigInt(Date.now()) * 1_000_000n;

    const nextTimestamp = (): string => {
      const ts = nextNs;
      nextNs += 1n;
      return String(ts);
    };

    for (const message of session.messages) {
      if (!message || typeof message !== 'object') continue;
      const role = message.role;

      if (role === 'system') continue;

      if (role === 'user') {
        // Only scalar-string content yields an agent_turn span. Array-shaped
        // `content` (OpenAI multimodal content parts) is out of scope for v1
        // and is treated as no text — consistent with the codex parser. Applies
        // to the assistant `content` gate below too.
        if (typeof message.content === 'string' && message.content.length > 0) {
          const ts = nextTimestamp();
          spans.push({
            name: 'agent_turn.user',
            kind: 'INTERNAL',
            startTimeUnixNano: ts,
            endTimeUnixNano: ts,
            attributes: {
              'jinn.span.kind': 'jinn.agent_turn',
              'jinn.turn.role': 'user',
              'message.content': truncate(message.content),
              ...provenanceAttrs(),
            },
            events: [],
            status: { code: 'OK' },
          });
        }
        continue;
      }

      if (role === 'assistant') {
        // reasoning is intentionally never emitted (parity with the
        // claude-code thinking-block drop).
        if (typeof message.content === 'string' && message.content.length > 0) {
          const ts = nextTimestamp();
          spans.push({
            name: 'agent_turn.assistant',
            kind: 'INTERNAL',
            startTimeUnixNano: ts,
            endTimeUnixNano: ts,
            attributes: {
              'jinn.span.kind': 'jinn.agent_turn',
              'jinn.turn.role': 'assistant',
              'message.content': truncate(message.content),
              ...provenanceAttrs(),
            },
            events: [],
            status: { code: 'OK' },
          });
        }
        for (const toolCall of message.tool_calls ?? []) {
          if (!toolCall || typeof toolCall !== 'object') continue;
          const name = toolCall.function?.name ?? '';
          const args = truncateLeaves(parseToolArgs(toolCall.function?.arguments));
          const ts = nextTimestamp();
          const call: SpanInput = {
            name: `tool_call.${name}`,
            kind: 'INTERNAL',
            startTimeUnixNano: ts,
            endTimeUnixNano: ts,
            attributes: {
              'jinn.span.kind': 'jinn.tool_call',
              'tool.name': name,
              'tool.args': args,
              ...provenanceAttrs(),
            },
            events: [],
            status: { code: 'UNSET' },
          };
          spans.push(call);
          if (typeof toolCall.id === 'string') pendingByToolCallId.set(toolCall.id, call);
        }
        continue;
      }

      if (role === 'tool') {
        const id = message.tool_call_id;
        if (typeof id !== 'string') continue;
        const call = pendingByToolCallId.get(id);
        if (!call) continue; // Orphan result — drop, keep going.
        pendingByToolCallId.delete(id);
        const ts = nextTimestamp();
        call.endTimeUnixNano = ts;
        call.events = [
          {
            timeUnixNano: ts,
            name: 'tool_result',
            attributes: {
              'tool.result': truncate(stringifyResultContent(message.content)),
              // Hermes tool messages carry no error flag — default OK.
              'tool.result.is_error': false,
            },
          },
        ];
        call.status = { code: 'OK' };
        continue;
      }
    }

    return spans;
  }
}
