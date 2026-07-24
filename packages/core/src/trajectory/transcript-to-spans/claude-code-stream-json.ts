import { readFile } from 'node:fs/promises';
import {
  makeProvenanceAttrs,
  stringifyResultContent,
  truncate,
  truncateLeaves,
} from './attrs.js';
import type { TranscriptSpanInput, TranscriptSpanParser } from './types.js';

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

type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string };

interface StreamRecord {
  type: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function provenanceAttrs(): Record<string, unknown> {
  return makeProvenanceAttrs(SOURCE_FORMAT, PARSER_NAME, PARSER_VERSION);
}

export class ClaudeCodeStreamJsonParser implements TranscriptSpanParser {
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
    const spans: TranscriptSpanInput[] = [];
    const pendingByToolUseId = new Map<string, TranscriptSpanInput>();
    const agentTurns: TranscriptSpanInput[] = [];
    let nextNs = BigInt(Date.now()) * 1_000_000n;

    const nextTimestamp = (): string => {
      const timestamp = nextNs;
      nextNs += 1n;
      return String(timestamp);
    };

    for (const line of rawText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record: StreamRecord;
      try {
        record = JSON.parse(trimmed) as StreamRecord;
      } catch {
        continue;
      }
      if (!record || typeof record.type !== 'string' || record.type === 'system') continue;

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
          const timestamp = nextTimestamp();
          const turn: TranscriptSpanInput = {
            name: 'agent_turn.user',
            kind: 'INTERNAL',
            startTimeUnixNano: timestamp,
            endTimeUnixNano: timestamp,
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
            if (
              !block ||
              typeof block !== 'object' ||
              (block as ContentBlock).type !== 'tool_result'
            ) {
              continue;
            }
            const toolResult = block as ToolResultBlock;
            const call = pendingByToolUseId.get(toolResult.tool_use_id);
            if (!call) continue;
            pendingByToolUseId.delete(toolResult.tool_use_id);
            const timestamp = nextTimestamp();
            call.endTimeUnixNano = timestamp;
            call.events = [
              {
                timeUnixNano: timestamp,
                name: 'tool_result',
                attributes: {
                  'tool.result': truncate(stringifyResultContent(toolResult.content)),
                  'tool.result.is_error': toolResult.is_error ?? false,
                },
              },
            ];
            call.status = toolResult.is_error ? { code: 'ERROR' } : { code: 'OK' };
          }
        }
        continue;
      }

      if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue;

      for (const block of record.message.content) {
        if (!block || typeof block !== 'object') continue;
        const blockType = (block as ContentBlock).type;
        if (blockType === 'thinking') continue;
        if (blockType === 'text') {
          const text = block as TextBlock;
          const timestamp = nextTimestamp();
          const turn: TranscriptSpanInput = {
            name: 'agent_turn.assistant',
            kind: 'INTERNAL',
            startTimeUnixNano: timestamp,
            endTimeUnixNano: timestamp,
            attributes: {
              'jinn.span.kind': 'jinn.agent_turn',
              'jinn.turn.role': 'assistant',
              'message.content': truncate(text.text),
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
          const toolUse = block as ToolUseBlock;
          const timestamp = nextTimestamp();
          const call: TranscriptSpanInput = {
            name: `tool_call.${toolUse.name}`,
            kind: 'INTERNAL',
            startTimeUnixNano: timestamp,
            endTimeUnixNano: timestamp,
            attributes: {
              'jinn.span.kind': 'jinn.tool_call',
              'tool.name': toolUse.name,
              'tool.args': truncateLeaves(toolUse.input),
              ...provenanceAttrs(),
            },
            events: [],
            status: { code: 'UNSET' },
          };
          spans.push(call);
          pendingByToolUseId.set(toolUse.id, call);
        }
      }
    }

    return spans;
  }
}
