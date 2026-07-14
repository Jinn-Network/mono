/**
 * codex-exec-json — converts a codex-code solve transcript (`codex exec --json`
 * stdout, envelope-wrapped session_meta/response_item lines) into
 * jinn.agent_turn / jinn.tool_call spans for TrajectoryCollector.
 *
 * Reuses CodexSessionParser.parseChunk() (transcript-parsers/codex-session.ts)
 * on the already-read transcript text — not parseFull(path), which would read
 * the file a second time — to get canonical TranscriptEvent[] (ISO timestamps,
 * tool-call/tool-result as separate events, call_id not exposed past that
 * layer), then:
 *   - user/assistant message events become jinn.agent_turn spans.
 *   - tool-call events open a pending jinn.tool_call span, queued FIFO per
 *     tool name (codex's TranscriptEvent layer does not expose call_id, so
 *     name-keyed FIFO is the best available correlation — sufficient for the
 *     in-scope non-parallel-tool-call case per the plan's stated scope).
 *   - tool-result events pop the oldest pending call for that name and attach
 *     a single `tool_result` span event; unmatched calls at EOF are emitted
 *     with empty events and UNSET status (degrade, not drop).
 * Token usage (terminal `turn.completed`/`turn.failed` `usage` field) is
 * scanned separately from the raw file and attached to the LAST agent_turn
 * span only — codex's stream does not evidence per-message usage.
 *
 * Degrades to [] (never throws) on a missing/unreadable file or a parseChunk
 * failure — per-solve transcript parsing must never fail the solve (AC-4).
 * Per event, a malformed ISO timestamp is guarded rather than left to throw
 * past this scope (#1473 finding 4) — see TimestampCursor below.
 */

import { readFile } from 'node:fs/promises';
import { CodexSessionParser } from '../transcript-parsers/codex-session.js';
import type { TranscriptEvent } from '../transcript-parsers/types.js';
import type { SpanInput } from '../collector.js';
import type { TranscriptSpanParser } from './types.js';
import { truncate, truncateLeaves, makeProvenanceAttrs } from './attrs.js';

const SOURCE_FORMAT = 'codex-exec-json';
const PARSER_NAME = 'codex-exec-json';
const PARSER_VERSION = '1.0.0';

/**
 * Timestamp cursor that guards against a malformed ISO string killing the
 * whole parse (#1473 finding 4). `BigInt(new Date(bad).getTime())` throws a
 * RangeError on NaN; one bad timestamp among otherwise-valid events used to
 * propagate past the per-event loop's try/catch scope and discard every
 * span in the transcript. next() falls back to the last good nanosecond
 * timestamp + 1ns (monotonic, keeps span ordering stable) rather than
 * dropping the event — a malformed timestamp still loses less than a
 * dropped turn would (decision-path data: the turn's own content survives).
 */
class TimestampCursor {
  private lastGoodNs = 0n;

  next(iso: string): string {
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms)) {
      const ns = BigInt(ms) * 1_000_000n;
      this.lastGoodNs = ns;
      return String(ns);
    }
    this.lastGoodNs += 1n;
    return String(this.lastGoodNs);
  }
}

function provenanceAttrs(): Record<string, unknown> {
  return makeProvenanceAttrs(SOURCE_FORMAT, PARSER_NAME, PARSER_VERSION);
}

function findTerminalUsage(rawText: string): { inputTokens: number; outputTokens: number } | null {
  let result: { inputTokens: number; outputTokens: number } | null = null;
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if ((obj['type'] === 'turn.completed' || obj['type'] === 'turn.failed') && obj['usage']) {
      const usage = obj['usage'] as Record<string, unknown>;
      const inputTokens = usage['input_tokens'];
      const outputTokens = usage['output_tokens'];
      if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
        result = { inputTokens, outputTokens };
      }
    }
  }
  return result;
}

export class CodexExecJsonParser implements TranscriptSpanParser {
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

    let events: TranscriptEvent[];
    try {
      // Reuse the already-read rawText via parseChunk() rather than
      // parseFull(path), which would read transcriptPath from disk a second
      // time — parseFull is just this same normalize-then-parseChunk on a
      // fresh instance, so the result is identical.
      const normalized = rawText.endsWith('\n') ? rawText : `${rawText}\n`;
      events = new CodexSessionParser().parseChunk({ sessionId: 'engine-pack', chunk: normalized });
    } catch {
      return [];
    }

    const spans: SpanInput[] = [];
    // Pending tool_call spans queued FIFO per tool name (call_id is not
    // exposed by TranscriptEvent, so name-keyed FIFO is the correlation we have).
    const pendingByName = new Map<string, SpanInput[]>();
    const agentTurns: SpanInput[] = [];
    const cursor = new TimestampCursor();

    for (const event of events) {
      switch (event.kind) {
        case 'user-message':
        case 'assistant-message': {
          const ts = cursor.next(event.timestamp);
          const turn: SpanInput = {
            name: `agent_turn.${event.kind === 'user-message' ? 'user' : 'assistant'}`,
            kind: 'INTERNAL',
            startTimeUnixNano: ts,
            endTimeUnixNano: ts,
            attributes: {
              'jinn.span.kind': 'jinn.agent_turn',
              'jinn.turn.role': event.kind === 'user-message' ? 'user' : 'assistant',
              'message.content': truncate(event.content),
              ...provenanceAttrs(),
            },
            events: [],
            status: { code: 'OK' },
          };
          spans.push(turn);
          agentTurns.push(turn);
          break;
        }
        case 'tool-call': {
          const ts = cursor.next(event.timestamp);
          const call: SpanInput = {
            name: `tool_call.${event.name}`,
            kind: 'INTERNAL',
            startTimeUnixNano: ts,
            endTimeUnixNano: ts,
            attributes: {
              'jinn.span.kind': 'jinn.tool_call',
              'tool.name': event.name,
              'tool.args': truncateLeaves(event.args),
              ...provenanceAttrs(),
            },
            events: [],
            status: { code: 'UNSET' },
          };
          spans.push(call);
          const queue = pendingByName.get(event.name) ?? [];
          queue.push(call);
          pendingByName.set(event.name, queue);
          break;
        }
        case 'tool-result': {
          const queue = pendingByName.get(event.name);
          const call = queue?.shift();
          if (!call) break; // No matching pending call — drop the orphan result, keep going.
          const resultTs = cursor.next(event.timestamp);
          call.endTimeUnixNano = resultTs;
          call.events = [
            {
              timeUnixNano: resultTs,
              name: 'tool_result',
              attributes: {
                'tool.result': truncate(event.content),
                'tool.result.is_error': event.isError ?? false,
              },
            },
          ];
          call.status = event.isError ? { code: 'ERROR' } : { code: 'OK' };
          break;
        }
        default:
          break;
      }
    }

    const usage = findTerminalUsage(rawText);
    if (usage && agentTurns.length > 0) {
      const last = agentTurns[agentTurns.length - 1];
      last.attributes['gen_ai.usage.input_tokens'] = usage.inputTokens;
      last.attributes['gen_ai.usage.output_tokens'] = usage.outputTokens;
    }

    return spans;
  }
}
