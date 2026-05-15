/**
 * Claude Code JSONL transcript parser.
 *
 * Reads `~/.claude/projects/<project>/<session-id>.jsonl` line-by-line, mapping
 * per-record content to canonical TranscriptEvent shapes (Task 3.1):
 *  - user record with string content              → user-message
 *  - user record with tool_result content blocks  → tool-result
 *  - assistant record with text content blocks    → assistant-message
 *  - assistant record with tool_use content blocks → tool-call
 *
 * `parseChunk` preserves any incomplete trailing line across calls so the
 * watcher (Task 3.9) can stream tail bytes without losing partial records.
 * `parseFull` is a one-shot for `jinn capture import` and end-of-session
 * safety-net ingest.
 *
 * Known v0 limitation: `tool-result.name` is filled from `tool_use_id` (the
 * reference back to the originating call) rather than the actual tool name —
 * resolving the name requires remembering each `tool_use` block's name across
 * the stream. A follow-up will add that resolution map; for now, downstream
 * consumers see a stable identifier even if it carries less display signal.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import { readFile } from 'node:fs/promises';
import type { TranscriptEvent, TranscriptParser } from './types.js';

interface TextBlock {
  type: 'text';
  text: string;
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
  content: string | Array<unknown>;
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

interface ClaudeCodeRecord {
  type: 'user' | 'assistant' | string;
  timestamp?: string;
  message?: {
    content?: string | ContentBlock[];
  };
}

export class ClaudeCodeJsonlParser implements TranscriptParser {
  readonly tool = 'claude-code' as const;
  private buffer = '';

  parseChunk(input: { sessionId: string; chunk: Buffer | string }): TranscriptEvent[] {
    const text =
      typeof input.chunk === 'string' ? input.chunk : input.chunk.toString('utf-8');
    this.buffer += text;
    const lines = this.buffer.split('\n');
    // Last fragment (no trailing newline) is preserved for the next chunk.
    this.buffer = lines.pop() ?? '';

    const events: TranscriptEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: ClaudeCodeRecord;
      try {
        record = JSON.parse(line) as ClaudeCodeRecord;
      } catch {
        // Malformed line — skip silently. The watcher cannot recover bytes
        // we drop, but a single corrupt line should not poison the stream.
        continue;
      }
      events.push(...this.recordToEvents(record));
    }
    return events;
  }

  async parseFull(input: { sessionId: string; path: string }): Promise<TranscriptEvent[]> {
    const text = await readFile(input.path, 'utf-8');
    // Ensure the final record has a terminating newline so parseChunk drains it.
    const normalised = text.endsWith('\n') ? text : text + '\n';
    // parseFull is a one-shot. Use a fresh parser-like state to avoid leaking
    // the buffer if a caller reuses the same instance for streaming + full.
    const previousBuffer = this.buffer;
    this.buffer = '';
    try {
      return this.parseChunk({ sessionId: input.sessionId, chunk: normalised });
    } finally {
      this.buffer = previousBuffer;
    }
  }

  private recordToEvents(record: ClaudeCodeRecord): TranscriptEvent[] {
    if (!record || typeof record.timestamp !== 'string') return [];
    const ts = record.timestamp;

    if (record.type === 'user') {
      const content = record.message?.content;
      // String content is the canonical user message shape.
      if (typeof content === 'string') {
        return [{ kind: 'user-message', timestamp: ts, content }];
      }
      // Array content typically carries tool_result blocks (Claude Code emits
      // tool responses inside a synthetic user turn). Other block types in a
      // user-array record are skipped.
      if (Array.isArray(content)) {
        const out: TranscriptEvent[] = [];
        for (const block of content) {
          if (isToolResultBlock(block)) {
            const resultText =
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
            out.push({
              kind: 'tool-result',
              timestamp: ts,
              // v0: use the reference id as `name`. Resolution-map upgrade
              // pending — see file header.
              name: block.tool_use_id,
              content: resultText,
              isError: block.is_error ?? false,
            });
          }
        }
        return out;
      }
      return [];
    }

    if (record.type === 'assistant') {
      const content = record.message?.content;
      const blocks: ContentBlock[] = Array.isArray(content)
        ? content
        : typeof content === 'string'
          ? [{ type: 'text', text: content } as TextBlock]
          : [];
      const out: TranscriptEvent[] = [];
      for (const block of blocks) {
        if (isTextBlock(block)) {
          out.push({ kind: 'assistant-message', timestamp: ts, content: block.text });
        } else if (isToolUseBlock(block)) {
          out.push({
            kind: 'tool-call',
            timestamp: ts,
            name: block.name,
            args: block.input ?? {},
          });
        }
        // `thinking` and any other unrecognised block types are intentionally
        // dropped — the canonical TranscriptEvent shape doesn't carry them and
        // including them would violate downstream identity-scrub assumptions.
      }
      return out;
    }

    // Records with unknown `type` (e.g. queue-operation, summary) are dropped.
    return [];
  }
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text' && typeof (block as TextBlock).text === 'string';
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return (
    block.type === 'tool_use' &&
    typeof (block as ToolUseBlock).name === 'string' &&
    typeof (block as ToolUseBlock).id === 'string'
  );
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return (
    block.type === 'tool_result' &&
    typeof (block as ToolResultBlock).tool_use_id === 'string'
  );
}
