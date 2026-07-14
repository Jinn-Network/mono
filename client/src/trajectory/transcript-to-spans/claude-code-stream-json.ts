/**
 * claude-code-stream-json — converts a claude-code solve transcript (`claude
 * --output-format stream-json` stdout, one JSON record per line) into
 * jinn.agent_turn / jinn.tool_call spans for TrajectoryCollector.
 *
 * Fresh implementation deliberately NOT built on ClaudeCodeJsonlParser
 * (transcript-parsers/claude-code-jsonl.ts): that parser hard-requires a
 * per-record `timestamp` field (absent from this stdout stream — verified
 * against the adapter's fake stdout in
 * test/harnesses/impls/learner/claude-code-adapter.test.ts) and collapses
 * tool_result.name down to tool_use_id rather than keeping the exact pairing
 * this module needs.
 *
 * Since the stream carries no per-record timestamps, this parser synthesizes
 * monotonic nanosecond timestamps seeded at process time and incremented one
 * tick per line — sufficient for span ordering, not wall-clock accuracy.
 *
 * Mapping:
 *   - `type:"user"` string content        → agent_turn(user)
 *   - `type:"user"` tool_result blocks     → paired to the in-flight
 *                                            jinn.tool_call span via exact
 *                                            tool_use_id match
 *   - `type:"assistant"` text blocks       → agent_turn(assistant)
 *   - `type:"assistant"` tool_use blocks   → tool_call (tool.args as an
 *                                            object — NOT JSON-stringified;
 *                                            the scrub pipeline's nested
 *                                            walker handles objects)
 *   - `type:"assistant"` thinking blocks   → dropped
 *   - `type:"system"`                      → skipped (no span)
 *   - `type:"result"`                      → no span; its usage (when
 *                                            present) attaches to the LAST
 *                                            agent_turn span. Per-message
 *                                            usage is not evidenced in this
 *                                            codebase (mirrors the codex
 *                                            parser's terminal-usage
 *                                            behavior — see spend/usage.ts
 *                                            parseClaudeCodeUsage).
 *
 * Degrades to [] (never throws) on a missing/unreadable file — per-solve
 * transcript parsing must never fail the solve (AC-4).
 */

import { readFile } from 'node:fs/promises';
import type { SpanInput } from '../collector.js';
import type { TranscriptSpanParser } from './types.js';
import { truncate, truncateLeaves, makeProvenanceAttrs } from './attrs.js';

const SOURCE_FORMAT = 'claude-code-stream-json';
const PARSER_NAME = 'claude-code-stream-json';
const PARSER_VERSION = '1.0.0';

interface TextBlock {
  type: 'text';
  text: string;
}
interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { type: string };

interface StreamRecord {
  type: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  total_cost_usd?: number;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function provenanceAttrs(): Record<string, unknown> {
  return makeProvenanceAttrs(SOURCE_FORMAT, PARSER_NAME, PARSER_VERSION);
}

function stringifyResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  // JSON.stringify(undefined) returns the value `undefined`, not a string —
  // guard so a tool_result block with no `content` field can't crash the
  // downstream truncate() call (which would otherwise throw on `.length`
  // and lose every span already parsed for this transcript).
  return JSON.stringify(content) ?? String(content);
}

export class ClaudeCodeStreamJsonParser implements TranscriptSpanParser {
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

    const spans: SpanInput[] = [];
    const pendingByToolUseId = new Map<string, SpanInput>();
    const agentTurns: SpanInput[] = [];
    let nextNs = BigInt(Date.now()) * 1_000_000n;

    const nextTimestamp = (): string => {
      const ts = nextNs;
      nextNs += 1n;
      return String(ts);
    };

    for (const line of rawText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: StreamRecord;
      try {
        record = JSON.parse(trimmed) as StreamRecord;
      } catch {
        continue; // Malformed line — skip, don't poison the stream.
      }
      if (!record || typeof record.type !== 'string') continue;

      if (record.type === 'system') continue;

      if (record.type === 'result') {
        const inputTokens = record.usage?.input_tokens;
        const outputTokens = record.usage?.output_tokens;
        if (
          typeof inputTokens === 'number' &&
          typeof outputTokens === 'number' &&
          agentTurns.length > 0
        ) {
          const last = agentTurns[agentTurns.length - 1];
          last.attributes['gen_ai.usage.input_tokens'] = inputTokens;
          last.attributes['gen_ai.usage.output_tokens'] = outputTokens;
        }
        continue;
      }

      if (record.type === 'user') {
        const content = record.message?.content;
        if (typeof content === 'string') {
          const ts = nextTimestamp();
          const turn: SpanInput = {
            name: 'agent_turn.user',
            kind: 'INTERNAL',
            startTimeUnixNano: ts,
            endTimeUnixNano: ts,
            attributes: {
              'jinn.span.kind': 'jinn.agent_turn',
              'jinn.turn.role': 'user',
              'message.content': truncate(content),
              ...provenanceAttrs(),
            },
            events: [],
            status: { code: 'OK' },
          };
          spans.push(turn);
          agentTurns.push(turn);
          continue;
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object' || (block as ContentBlock).type !== 'tool_result') continue;
            const b = block as ToolResultBlock;
            const call = pendingByToolUseId.get(b.tool_use_id);
            if (!call) continue; // Orphan result — drop, keep going.
            pendingByToolUseId.delete(b.tool_use_id);
            const ts = nextTimestamp();
            call.endTimeUnixNano = ts;
            call.events = [
              {
                timeUnixNano: ts,
                name: 'tool_result',
                attributes: {
                  'tool.result': truncate(stringifyResultContent(b.content)),
                  'tool.result.is_error': b.is_error ?? false,
                },
              },
            ];
            call.status = b.is_error ? { code: 'ERROR' } : { code: 'OK' };
          }
        }
        continue;
      }

      if (record.type === 'assistant') {
        const content = record.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const blockType = (block as ContentBlock).type;
          if (blockType === 'thinking') continue; // Dropped per spec.
          if (blockType === 'text') {
            const b = block as TextBlock;
            const ts = nextTimestamp();
            const turn: SpanInput = {
              name: 'agent_turn.assistant',
              kind: 'INTERNAL',
              startTimeUnixNano: ts,
              endTimeUnixNano: ts,
              attributes: {
                'jinn.span.kind': 'jinn.agent_turn',
                'jinn.turn.role': 'assistant',
                'message.content': truncate(b.text),
                ...provenanceAttrs(),
              },
              events: [],
              status: { code: 'OK' },
            };
            spans.push(turn);
            agentTurns.push(turn);
            continue;
          }
          if (blockType === 'tool_use') {
            const b = block as ToolUseBlock;
            const ts = nextTimestamp();
            const call: SpanInput = {
              name: `tool_call.${b.name}`,
              kind: 'INTERNAL',
              startTimeUnixNano: ts,
              endTimeUnixNano: ts,
              attributes: {
                'jinn.span.kind': 'jinn.tool_call',
                'tool.name': b.name,
                'tool.args': truncateLeaves(b.input),
                ...provenanceAttrs(),
              },
              events: [],
              status: { code: 'UNSET' },
            };
            spans.push(call);
            pendingByToolUseId.set(b.id, call);
          }
        }
      }
    }

    return spans;
  }
}
