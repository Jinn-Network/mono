/**
 * Continue dev_data transcript parser.
 *
 * Continue (continue.dev) writes telemetry to `<workspace>/.continue/dev_data/`
 * with one JSONL file per event kind and schema version:
 *
 *   .continue/dev_data/chat/<schema-version>.jsonl
 *   .continue/dev_data/edit/<schema-version>.jsonl
 *   .continue/dev_data/autocomplete/<schema-version>.jsonl
 *
 * For Phase 3 v0 we ingest `chat` and `edit` directories. `autocomplete` is a
 * different signal (per-keystroke completions) and is intentionally skipped.
 *
 * Per-event-kind record shapes (best-effort; schema varies slightly across
 * Continue versions):
 *   chat:  { role: 'user' | 'assistant', timestamp, content }
 *   edit:  { timestamp, filepath, diff } (also accepts `path` for filepath)
 *
 * `parseFull` is given the dev_data directory; it globs the kind-subdirs we
 * care about, reads each JSONL file, and dispatches per kind.
 *
 * `parseChunk` supports streaming a single file: callers may include a `kind`
 * field on each record (the watcher knows which file it is tailing and tags
 * each line); when missing, the parser tries chat first, then edit. Records
 * that match neither are skipped.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { TranscriptEvent, TranscriptParser } from './types.js';

interface ChatRecord {
  role?: string;
  timestamp?: string;
  ts?: string;
  content?: unknown;
  kind?: string;
}

interface EditRecord {
  timestamp?: string;
  ts?: string;
  filepath?: string;
  path?: string;
  diff?: unknown;
  kind?: string;
}

const SUPPORTED_KINDS = new Set(['chat', 'edit']);

export class ContinueDevDataParser implements TranscriptParser {
  readonly tool = 'continue' as const;
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
      let record: ChatRecord & EditRecord;
      try {
        record = JSON.parse(line) as ChatRecord & EditRecord;
      } catch {
        continue;
      }
      const event = recordToEvent(record);
      if (event) events.push(event);
    }
    return events;
  }

  async parseFull(input: { sessionId: string; path: string }): Promise<TranscriptEvent[]> {
    // For dev_data, the path is the dev_data directory (or a single file).
    // If it's a directory, walk supported kind-subdirs; otherwise treat as
    // a single JSONL file (delegate to parseChunk).
    let stats;
    try {
      stats = await stat(input.path);
    } catch {
      return [];
    }

    if (stats.isFile()) {
      const text = await readFile(input.path, 'utf-8');
      const normalised = text.endsWith('\n') ? text : text + '\n';
      const previousBuffer = this.buffer;
      this.buffer = '';
      try {
        // Tag records with the inferred kind from the parent directory so
        // ambiguous shapes resolve correctly.
        const inferredKind = inferKindFromPath(input.path);
        return this.parseChunk({
          sessionId: input.sessionId,
          chunk: tagChunkWithKind(normalised, inferredKind),
        });
      } finally {
        this.buffer = previousBuffer;
      }
    }

    if (!stats.isDirectory()) return [];

    const events: TranscriptEvent[] = [];
    let entries: string[];
    try {
      entries = await readdir(input.path);
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!SUPPORTED_KINDS.has(entry)) continue;
      const subdir = path.join(input.path, entry);
      let subEntries: string[];
      try {
        subEntries = await readdir(subdir);
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.endsWith('.jsonl')) continue;
        const filePath = path.join(subdir, sub);
        const text = await readFile(filePath, 'utf-8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let record: ChatRecord & EditRecord;
          try {
            record = JSON.parse(line) as ChatRecord & EditRecord;
          } catch {
            continue;
          }
          // Tag with the dir-inferred kind so ambiguous records resolve.
          if (!record.kind) record.kind = entry;
          const event = recordToEvent(record);
          if (event) events.push(event);
        }
      }
    }
    return events;
  }
}

function recordToEvent(record: ChatRecord & EditRecord): TranscriptEvent | null {
  if (!record || typeof record !== 'object') return null;
  const ts = record.timestamp ?? record.ts;
  if (typeof ts !== 'string') return null;

  const kind = record.kind;

  if (kind === 'chat' || (!kind && typeof record.role === 'string')) {
    if (typeof record.content !== 'string') return null;
    if (record.role === 'user') {
      return { kind: 'user-message', timestamp: ts, content: record.content };
    }
    if (record.role === 'assistant') {
      return { kind: 'assistant-message', timestamp: ts, content: record.content };
    }
    return null;
  }

  if (kind === 'edit' || (!kind && (record.filepath || record.path) && record.diff)) {
    const filePath = record.filepath ?? record.path;
    if (typeof filePath !== 'string') return null;
    if (typeof record.diff !== 'string') return null;
    return { kind: 'edit', timestamp: ts, path: filePath, diff: record.diff };
  }

  return null;
}

function inferKindFromPath(filePath: string): string | null {
  const parent = path.basename(path.dirname(filePath));
  if (SUPPORTED_KINDS.has(parent)) return parent;
  return null;
}

function tagChunkWithKind(text: string, kind: string | null): string {
  if (!kind) return text;
  // Splice a `"kind":"<kind>"` field into each JSON object. Cheap approach:
  // re-parse + re-stringify each record to set the field. Avoids string-
  // surgery edge cases on malformed lines.
  return (
    text
      .split('\n')
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (typeof obj.kind !== 'string') obj.kind = kind;
          return JSON.stringify(obj);
        } catch {
          return line;
        }
      })
      .join('\n')
  );
}
