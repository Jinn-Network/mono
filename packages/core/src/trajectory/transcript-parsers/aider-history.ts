/**
 * Aider history parser.
 *
 * Aider records two transcript flavours:
 *
 *   1. `.aider.analytics.log.jsonl` (preferred; emitted when --analytics-log
 *      is enabled). One JSON record per line. Common events:
 *        - { event: 'message_send', role: 'user', content }   → user-message
 *        - { event: 'model_response', role: 'assistant', content } → assistant-message
 *        - { event: 'edit', path, diff }                      → edit
 *
 *   2. `.aider.chat.history.md` (fallback; always emitted by Aider). A
 *      timestamped markdown log:
 *        # 2026-05-07 00:00:00 +0000
 *
 *        > user message
 *
 *        assistant reply text
 *
 * The parser dispatches on file extension: `.jsonl` → analytics path; `.md`
 * (or anything else) → markdown path. Both produce canonical TranscriptEvents.
 *
 * For the JSONL path, `parseChunk` follows the streaming pattern (preserves
 * any incomplete trailing line). For the markdown path, `parseChunk` is a
 * no-op — markdown is not line-stable, so the watcher polls and replays
 * `parseFull`.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import { readFile } from 'node:fs/promises';
import type { TranscriptEvent, TranscriptParser } from './types.js';

interface AnalyticsRecord {
  event?: string;
  ts?: string;
  timestamp?: string;
  role?: string;
  content?: unknown;
  path?: string;
  diff?: string;
}

export class AiderHistoryParser implements TranscriptParser {
  readonly tool = 'aider' as const;
  private buffer = '';

  parseChunk(input: { sessionId: string; chunk: Buffer | string }): TranscriptEvent[] {
    // parseChunk is the streaming-friendly path; only meaningful for the
    // JSONL analytics format. Callers wiring the markdown fallback through
    // a watcher poll the file and re-run parseFull.
    const text =
      typeof input.chunk === 'string' ? input.chunk : input.chunk.toString('utf-8');
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    const events: TranscriptEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: AnalyticsRecord;
      try {
        record = JSON.parse(line) as AnalyticsRecord;
      } catch {
        continue;
      }
      const event = analyticsRecordToEvent(record);
      if (event) events.push(event);
    }
    return events;
  }

  async parseFull(input: { sessionId: string; path: string }): Promise<TranscriptEvent[]> {
    const lower = input.path.toLowerCase();
    if (lower.endsWith('.jsonl')) {
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
    // Markdown fallback (.md or otherwise).
    const text = await readFile(input.path, 'utf-8');
    return parseMarkdownHistory(text);
  }
}

function analyticsRecordToEvent(record: AnalyticsRecord): TranscriptEvent | null {
  if (!record || typeof record !== 'object') return null;
  const ts = record.ts ?? record.timestamp;
  if (typeof ts !== 'string') return null;

  const event = record.event;

  if (event === 'message_send' || record.role === 'user') {
    if (typeof record.content !== 'string') return null;
    return { kind: 'user-message', timestamp: ts, content: record.content };
  }

  if (event === 'model_response' || record.role === 'assistant') {
    if (typeof record.content !== 'string') return null;
    return { kind: 'assistant-message', timestamp: ts, content: record.content };
  }

  if (event === 'edit') {
    if (typeof record.path !== 'string' || typeof record.diff !== 'string') return null;
    return { kind: 'edit', timestamp: ts, path: record.path, diff: record.diff };
  }

  return null;
}

/**
 * Best-effort markdown chat-history parser. The format is human-friendly and
 * not designed for round-tripping; we split on date headings (`# YYYY-MM-DD ...`)
 * and within each block treat lines starting with `> ` as user messages and
 * the remaining non-empty text as the assistant reply.
 */
function parseMarkdownHistory(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const lines = text.split('\n');

  let currentTs: string | null = null;
  let userBuf: string[] = [];
  let assistantBuf: string[] = [];
  let mode: 'idle' | 'user' | 'assistant' = 'idle';

  const flush = (): void => {
    if (!currentTs) {
      userBuf = [];
      assistantBuf = [];
      mode = 'idle';
      return;
    }
    if (userBuf.length > 0) {
      const content = userBuf.join('\n').trim();
      if (content) {
        events.push({ kind: 'user-message', timestamp: currentTs, content });
      }
    }
    if (assistantBuf.length > 0) {
      const content = assistantBuf.join('\n').trim();
      if (content) {
        events.push({ kind: 'assistant-message', timestamp: currentTs, content });
      }
    }
    userBuf = [];
    assistantBuf = [];
    mode = 'idle';
  };

  for (const line of lines) {
    const headingMatch = /^#\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(line);
    if (headingMatch) {
      flush();
      // Normalise to ISO 8601 UTC. The header includes a tz offset which we
      // drop here for v0; downstream ingest only needs a parseable timestamp.
      currentTs = `${headingMatch[1]}T${headingMatch[2]}.000Z`;
      continue;
    }
    if (line.startsWith('> ')) {
      // Switch into user-message mode. If we were previously in assistant
      // mode, flush the assistant buffer as the previous turn's reply.
      if (mode === 'assistant') {
        if (currentTs) {
          const content = assistantBuf.join('\n').trim();
          if (content) {
            events.push({ kind: 'assistant-message', timestamp: currentTs, content });
          }
        }
        assistantBuf = [];
      }
      mode = 'user';
      userBuf.push(line.slice(2));
      continue;
    }
    if (line.startsWith('>')) {
      // Continuation of a user message ("> ").
      if (mode === 'user') userBuf.push(line.slice(1));
      continue;
    }
    if (mode === 'user' && line.trim() === '') {
      // Blank line ends the user block; assistant text (if any) follows.
      mode = 'assistant';
      continue;
    }
    if (mode === 'assistant' || (mode === 'idle' && currentTs && line.trim() !== '')) {
      mode = 'assistant';
      assistantBuf.push(line);
    }
  }
  flush();
  return events;
}
