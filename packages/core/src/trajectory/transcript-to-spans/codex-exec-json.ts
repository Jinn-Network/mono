import { readFile } from 'node:fs/promises';
import { CodexSessionParser } from '../transcript-parsers/codex-session.js';
import type { TranscriptEvent } from '../transcript-parsers/types.js';
import { makeProvenanceAttrs, truncate, truncateLeaves } from './attrs.js';
import type { TranscriptSpanInput, TranscriptSpanParser } from './types.js';

const SOURCE_FORMAT = 'codex-exec-json';
const PARSER_NAME = 'codex-exec-json';
const PARSER_VERSION = '1.0.0';

class TimestampCursor {
  private lastGoodNs = 0n;

  next(iso: string): string {
    const milliseconds = new Date(iso).getTime();
    if (Number.isFinite(milliseconds)) {
      const nanoseconds = BigInt(milliseconds) * 1_000_000n;
      this.lastGoodNs = nanoseconds;
      return String(nanoseconds);
    }
    this.lastGoodNs += 1n;
    return String(this.lastGoodNs);
  }
}

function provenanceAttrs(): Record<string, unknown> {
  return makeProvenanceAttrs(SOURCE_FORMAT, PARSER_NAME, PARSER_VERSION);
}

function findTerminalUsage(
  rawText: string,
): { inputTokens: number; outputTokens: number } | null {
  let result: { inputTokens: number; outputTokens: number } | null = null;
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let object: Record<string, unknown>;
    try {
      object = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      (object['type'] === 'turn.completed' || object['type'] === 'turn.failed') &&
      object['usage']
    ) {
      const usage = object['usage'] as Record<string, unknown>;
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

  async parse(transcriptPath: string): Promise<TranscriptSpanInput[]> {
    let rawText: string;
    try {
      rawText = await readFile(transcriptPath, 'utf-8');
    } catch {
      return [];
    }
    return this.parseText(rawText);
  }

  parseText(rawText: string): TranscriptSpanInput[] {
    let events: TranscriptEvent[];
    try {
      const normalized = rawText.endsWith('\n') ? rawText : `${rawText}\n`;
      events = new CodexSessionParser().parseChunk({
        sessionId: 'engine-pack',
        chunk: normalized,
      });
    } catch {
      return [];
    }

    const spans: TranscriptSpanInput[] = [];
    const pendingByName = new Map<string, TranscriptSpanInput[]>();
    const agentTurns: TranscriptSpanInput[] = [];
    const cursor = new TimestampCursor();

    for (const event of events) {
      switch (event.kind) {
        case 'user-message':
        case 'assistant-message': {
          const timestamp = cursor.next(event.timestamp);
          const turn: TranscriptSpanInput = {
            name: `agent_turn.${event.kind === 'user-message' ? 'user' : 'assistant'}`,
            kind: 'INTERNAL',
            startTimeUnixNano: timestamp,
            endTimeUnixNano: timestamp,
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
          const timestamp = cursor.next(event.timestamp);
          const call: TranscriptSpanInput = {
            name: `tool_call.${event.name}`,
            kind: 'INTERNAL',
            startTimeUnixNano: timestamp,
            endTimeUnixNano: timestamp,
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
          if (!call) break;
          const timestamp = cursor.next(event.timestamp);
          call.endTimeUnixNano = timestamp;
          call.events = [
            {
              timeUnixNano: timestamp,
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
