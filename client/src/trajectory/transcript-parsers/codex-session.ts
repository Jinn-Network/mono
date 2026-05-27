/**
 * Codex CLI session transcript parser.
 *
 * Reads `~/.codex/sessions/<id>.jsonl` line-by-line, mapping per-record content
 * to canonical TranscriptEvent shapes (Task 3.1):
 *  - role: 'user' with string content       → user-message
 *  - role: 'assistant' with string content  → assistant-message
 *  - role: 'function' with function_call    → tool-call (also: assistant with
 *    a top-level function_call field)
 *  - role: 'tool' with content               → tool-result
 *
 * Codex CLI 0.129.0+ wraps each line as `{ timestamp, type, payload }` where
 * `type` is `session_meta`, `turn_context`, `response_item`, or `event_msg`.
 * Tool calls and messages live inside `payload` (e.g. `function_call`,
 * `function_call_output`, `message` with `input_text` / `output_text` blocks).
 * Older sessions use a flat per-line shape with `role` at the top level; both
 * are detected by record shape.
 *
 * `parseChunk` preserves any incomplete trailing line across calls so the
 * watcher (Task 3.9) can stream tail bytes without losing partial records.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import { readFile } from 'node:fs/promises';
import type { TranscriptEvent, TranscriptParser } from './types.js';

interface FunctionCall {
  name?: string;
  arguments?: string | Record<string, unknown>;
}

interface CodexRecord {
  role?: string;
  ts?: string;
  timestamp?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  function_call?: FunctionCall;
}

interface WrappedEnvelope {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export class CodexSessionParser implements TranscriptParser {
  readonly tool = 'codex' as const;
  private buffer = '';
  /** Maps function_call `call_id` → tool name for function_call_output rows. */
  private callNames = new Map<string, string>();

  parseChunk(input: { sessionId: string; chunk: Buffer | string }): TranscriptEvent[] {
    const text =
      typeof input.chunk === 'string' ? input.chunk : input.chunk.toString('utf-8');
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    const events: TranscriptEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(...this.lineToEvents(raw));
    }
    return events;
  }

  async parseFull(input: { sessionId: string; path: string }): Promise<TranscriptEvent[]> {
    const text = await readFile(input.path, 'utf-8');
    const normalised = text.endsWith('\n') ? text : text + '\n';
    const previousBuffer = this.buffer;
    const previousCallNames = new Map(this.callNames);
    this.buffer = '';
    this.callNames.clear();
    try {
      return this.parseChunk({ sessionId: input.sessionId, chunk: normalised });
    } finally {
      this.buffer = previousBuffer;
      this.callNames = previousCallNames;
    }
  }

  private lineToEvents(raw: unknown): TranscriptEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    if (isWrappedEnvelope(raw)) {
      return this.wrappedEnvelopeToEvents(raw);
    }
    return this.recordToEvents(raw as CodexRecord);
  }

  private wrappedEnvelopeToEvents(envelope: WrappedEnvelope): TranscriptEvent[] {
    const ts = envelope.timestamp;
    if (typeof ts !== 'string') return [];

    const payload = envelope.payload;
    if (!payload || typeof payload !== 'object') return [];

    if (envelope.type === 'response_item') {
      return this.responseItemToEvents(ts, payload);
    }

    // `event_msg` rows (user_message, agent_message, mcp_tool_call_end) duplicate
    // `response_item` message/tool rows — skip them to avoid double-counting.
    return [];
  }

  private responseItemToEvents(ts: string, payload: Record<string, unknown>): TranscriptEvent[] {
    const itemType = payload.type;
    if (itemType === 'function_call') {
      const name = payload.name;
      if (typeof name !== 'string') return [];
      const callId = payload.call_id;
      if (typeof callId === 'string') {
        this.callNames.set(callId, name);
      }
      return [
        {
          kind: 'tool-call',
          timestamp: ts,
          name,
          args: parseArgs(payload.arguments as string | Record<string, unknown> | undefined),
        },
      ];
    }

    if (itemType === 'function_call_output') {
      const output = payload.output;
      const content = typeof output === 'string' ? output : stringifyContent(output);
      if (!content) return [];
      const callId = payload.call_id;
      const name =
        (typeof callId === 'string' ? this.callNames.get(callId) : undefined) ??
        (typeof callId === 'string' ? callId : undefined);
      if (typeof name !== 'string') return [];
      return [{ kind: 'tool-result', timestamp: ts, name, content, isError: false }];
    }

    if (itemType === 'message') {
      const role = payload.role;
      const text = extractMessageText(payload.content);
      if (!text) return [];
      if (role === 'user') {
        return [{ kind: 'user-message', timestamp: ts, content: text }];
      }
      if (role === 'assistant') {
        return [{ kind: 'assistant-message', timestamp: ts, content: text }];
      }
    }

    return [];
  }

  private recordToEvents(record: CodexRecord): TranscriptEvent[] {
    if (!record || typeof record !== 'object') return [];
    const ts = record.ts ?? record.timestamp;
    if (typeof ts !== 'string') return [];

    const role = record.role;

    // function_call may sit on either a 'function' role record or alongside an
    // 'assistant' role record. Emit a tool-call event when we find one.
    if (record.function_call && typeof record.function_call === 'object') {
      const fn = record.function_call;
      if (typeof fn.name === 'string') {
        return [
          {
            kind: 'tool-call',
            timestamp: ts,
            name: fn.name,
            args: parseArgs(fn.arguments),
          },
        ];
      }
    }

    if (role === 'user') {
      const text = extractMessageText(record.content);
      if (text) {
        return [{ kind: 'user-message', timestamp: ts, content: text }];
      }
      return [];
    }

    if (role === 'assistant') {
      const text = extractMessageText(record.content);
      if (text) {
        return [{ kind: 'assistant-message', timestamp: ts, content: text }];
      }
      return [];
    }

    if (role === 'tool' || role === 'function-result') {
      const content = stringifyContent(record.content);
      if (!content) return [];
      // Prefer `name` (tool name) when present; fall back to tool_call_id so
      // downstream consumers always see a stable identifier. v0 gap: when
      // only an id is available it carries less display signal than the name.
      const name = record.name ?? record.tool_call_id;
      if (typeof name !== 'string') return [];
      return [{ kind: 'tool-result', timestamp: ts, name, content, isError: false }];
    }

    return [];
  }
}

function isWrappedEnvelope(raw: object): raw is WrappedEnvelope {
  const rec = raw as WrappedEnvelope;
  return (
    typeof rec.type === 'string' &&
    rec.payload !== undefined &&
    rec.payload !== null &&
    typeof rec.payload === 'object' &&
    !('role' in rec)
  );
}

function extractMessageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const blockType = b.type;
    if (
      (blockType === 'input_text' || blockType === 'output_text') &&
      typeof b.text === 'string'
    ) {
      parts.push(b.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function parseArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through — store the raw string under a sentinel key so the args
      // round-trip through the canonical schema's `record(unknown)` shape.
      return { _raw: raw };
    }
  }
  return {};
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return JSON.stringify(content);
}
