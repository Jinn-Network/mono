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
 * `parseChunk` preserves any incomplete trailing line across calls so the
 * watcher (Task 3.9) can stream tail bytes without losing partial records.
 *
 * Codex CLI versions vary in their on-disk shape; this parser follows a
 * defensible best-effort: timestamps are read from `ts` (or `timestamp`),
 * function-call arguments are JSON-decoded best-effort, and tool-results
 * carry the call's `name` (or `tool_call_id` as a fallback) so downstream
 * consumers always see a stable identifier even if it is opaque.
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

export class CodexSessionParser implements TranscriptParser {
  readonly tool = 'codex' as const;
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
      let record: CodexRecord;
      try {
        record = JSON.parse(line) as CodexRecord;
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
      if (typeof record.content === 'string') {
        return [{ kind: 'user-message', timestamp: ts, content: record.content }];
      }
      return [];
    }

    if (role === 'assistant') {
      if (typeof record.content === 'string') {
        return [{ kind: 'assistant-message', timestamp: ts, content: record.content }];
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
