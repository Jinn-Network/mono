/**
 * Cursor SQLite chat-store parser.
 *
 * Cursor stores its workspace chat history in a SQLite key-value DB at
 * `<workspace>/.cursor/state.vscdb` (or `<state-dir>/User/workspaceStorage/
 * <hash>/state.vscdb` for the global store). Chat data lives under the key
 * `workbench.panel.aichat.view.aichat.chatdata` in the `ItemTable` row, with
 * the value being a JSON blob structured as `{ tabs: [{ bubbles: [...] }] }`.
 *
 * Each bubble is one of:
 *   - { type: 'user' | 'human', text/content }     → user-message
 *   - { type: 'ai' | 'assistant', text/content }   → assistant-message
 *   - { type: 'tool_call', toolName, args }        → tool-call
 *   - { type: 'tool_result', toolName, content }   → tool-result
 *
 * Cursor's exact on-disk shape varies by version; this parser is best-effort
 * and skips bubbles it doesn't recognise. Hand-crafted fixtures cover the
 * canonical happy paths; no binary `.vscdb` files are committed (the test
 * suite builds an SQLite DB at runtime via better-sqlite3).
 *
 * `parseChunk` is a no-op for SQLite — the watcher polls the DB and replays
 * via `parseFull`. `parseFull` opens read-only, queries the chat-data row,
 * decodes the JSON, and walks bubbles in order.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import Database from 'better-sqlite3';
import type { TranscriptEvent, TranscriptParser } from './types.js';

const CHAT_DATA_KEY = 'workbench.panel.aichat.view.aichat.chatdata';

interface CursorBubble {
  type?: string;
  timestamp?: string;
  ts?: string;
  text?: string;
  content?: unknown;
  toolName?: string;
  name?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
}

interface CursorTab {
  tabId?: string;
  bubbles?: unknown[];
}

interface CursorChatData {
  tabs?: CursorTab[];
}

export class CursorSqliteParser implements TranscriptParser {
  readonly tool = 'cursor' as const;

  parseChunk(_input: { sessionId: string; chunk: Buffer | string }): TranscriptEvent[] {
    // SQLite is not a streaming format — the watcher polls and re-runs parseFull.
    return [];
  }

  async parseFull(input: { sessionId: string; path: string }): Promise<TranscriptEvent[]> {
    const db = new Database(input.path, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get(CHAT_DATA_KEY) as { value?: string } | undefined;
      if (!row || typeof row.value !== 'string') return [];

      let parsed: CursorChatData;
      try {
        parsed = JSON.parse(row.value) as CursorChatData;
      } catch {
        return [];
      }
      if (!parsed || !Array.isArray(parsed.tabs)) return [];

      const events: TranscriptEvent[] = [];
      for (const tab of parsed.tabs) {
        if (!tab || !Array.isArray(tab.bubbles)) continue;
        for (const raw of tab.bubbles) {
          const event = bubbleToEvent(raw);
          if (event) events.push(event);
        }
      }
      return events;
    } finally {
      db.close();
    }
  }
}

function bubbleToEvent(raw: unknown): TranscriptEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const bubble = raw as CursorBubble;
  const ts = bubble.timestamp ?? bubble.ts;
  if (typeof ts !== 'string') return null;

  const type = bubble.type;

  if (type === 'user' || type === 'human') {
    const content = bubble.text ?? (typeof bubble.content === 'string' ? bubble.content : null);
    if (typeof content !== 'string') return null;
    return { kind: 'user-message', timestamp: ts, content };
  }

  if (type === 'ai' || type === 'assistant') {
    const content = bubble.text ?? (typeof bubble.content === 'string' ? bubble.content : null);
    if (typeof content !== 'string') return null;
    return { kind: 'assistant-message', timestamp: ts, content };
  }

  if (type === 'tool_call') {
    const name = bubble.toolName ?? bubble.name;
    if (typeof name !== 'string') return null;
    return {
      kind: 'tool-call',
      timestamp: ts,
      name,
      args: bubble.args && typeof bubble.args === 'object' ? bubble.args : {},
    };
  }

  if (type === 'tool_result') {
    const name = bubble.toolName ?? bubble.name;
    if (typeof name !== 'string') return null;
    const content =
      typeof bubble.content === 'string'
        ? bubble.content
        : bubble.content == null
          ? ''
          : JSON.stringify(bubble.content);
    return {
      kind: 'tool-result',
      timestamp: ts,
      name,
      content,
      isError: bubble.isError ?? false,
    };
  }

  return null;
}
