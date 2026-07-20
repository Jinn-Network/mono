/**
 * Gemini CLI session transcript parser.
 *
 * Reads `~/.gemini/sessions/<id>.jsonl` (or comparable path) line-by-line,
 * mapping per-record content to canonical TranscriptEvent shapes (Task 3.1).
 *
 * Gemini's content shape follows the GenerativeAI Content schema: each record
 * has a `role` ('user' or 'model') and a `parts` array. Each part may be:
 *   - { text: string }                  → user-message / assistant-message
 *   - { functionCall: { name, args } }  → tool-call
 *   - { functionResponse: { name, response } } → tool-result
 *
 * Multiple parts in a single record can produce multiple events, mirroring
 * the Claude Code parser's tool_use-block handling. Text parts within the
 * same model record are concatenated into a single assistant-message; mixing
 * text and functionCall parts emits both, in order.
 *
 * `parseChunk` preserves any incomplete trailing line across calls.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import { readFile } from 'node:fs/promises';
import type { TranscriptEvent, TranscriptParser } from './types.js';

interface TextPart {
  text: string;
}

interface FunctionCallPart {
  functionCall: {
    name: string;
    args?: Record<string, unknown>;
  };
}

interface FunctionResponsePart {
  functionResponse: {
    name: string;
    response?: unknown;
  };
}

type Part = TextPart | FunctionCallPart | FunctionResponsePart | Record<string, unknown>;

interface GeminiRecord {
  role?: string;
  timestamp?: string;
  ts?: string;
  parts?: Part[];
}

export class GeminiSessionParser implements TranscriptParser {
  readonly tool = 'gemini-cli' as const;
  private buffer = '';

  parseChunk(input: { sessionId: string; chunk: Buffer | string }): TranscriptEvent[] {
    const text =
      typeof input.chunk === 'string' ? input.chunk : input.chunk.toString('utf-8');
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    const events: TranscriptEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: GeminiRecord;
      try {
        record = JSON.parse(line) as GeminiRecord;
      } catch {
        continue;
      }
      events.push(...this.recordToEvents(record));
    }
    return events;
  }

  async parseFull(input: { sessionId: string; path: string }): Promise<TranscriptEvent[]> {
    const text = await readFile(input.path, 'utf-8');
    const normalised = text.endsWith('\n') ? text : text + '\n';
    const previousBuffer = this.buffer;
    this.buffer = '';
    try {
      return this.parseChunk({ sessionId: input.sessionId, chunk: normalised });
    } finally {
      this.buffer = previousBuffer;
    }
  }

  private recordToEvents(record: GeminiRecord): TranscriptEvent[] {
    if (!record || typeof record !== 'object') return [];
    const ts = record.timestamp ?? record.ts;
    if (typeof ts !== 'string') return [];
    if (!Array.isArray(record.parts)) return [];

    const role = record.role;
    const out: TranscriptEvent[] = [];

    for (const part of record.parts) {
      if (!part || typeof part !== 'object') continue;

      if (isTextPart(part)) {
        if (role === 'user') {
          out.push({ kind: 'user-message', timestamp: ts, content: part.text });
        } else if (role === 'model' || role === 'assistant') {
          out.push({ kind: 'assistant-message', timestamp: ts, content: part.text });
        }
        continue;
      }

      if (isFunctionCallPart(part)) {
        out.push({
          kind: 'tool-call',
          timestamp: ts,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        });
        continue;
      }

      if (isFunctionResponsePart(part)) {
        const response = part.functionResponse.response;
        const content = stringifyResponse(response);
        out.push({
          kind: 'tool-result',
          timestamp: ts,
          name: part.functionResponse.name,
          content,
          isError: false,
        });
        continue;
      }
    }

    return out;
  }
}

function isTextPart(part: unknown): part is TextPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    typeof (part as TextPart).text === 'string'
  );
}

function isFunctionCallPart(part: unknown): part is FunctionCallPart {
  if (typeof part !== 'object' || part === null) return false;
  const fc = (part as FunctionCallPart).functionCall;
  return Boolean(fc) && typeof fc.name === 'string';
}

function isFunctionResponsePart(part: unknown): part is FunctionResponsePart {
  if (typeof part !== 'object' || part === null) return false;
  const fr = (part as FunctionResponsePart).functionResponse;
  return Boolean(fr) && typeof fr.name === 'string';
}

function stringifyResponse(response: unknown): string {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  // Gemini wraps tool output as { response: { content: '...' } } commonly;
  // unwrap a single-string `content` field for readability, otherwise
  // round-trip the JSON.
  if (
    typeof response === 'object' &&
    !Array.isArray(response) &&
    'content' in (response as Record<string, unknown>) &&
    typeof (response as Record<string, unknown>).content === 'string'
  ) {
    return (response as Record<string, unknown>).content as string;
  }
  return JSON.stringify(response);
}
