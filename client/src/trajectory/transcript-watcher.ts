/**
 * Transcript watcher dispatcher.
 *
 * Watches operator-supplied transcript files via chokidar; on append, reads
 * only the new bytes (tail-from-end semantics) and dispatches through the
 * matching per-tool parser into the canonical DispatchEnvelope shape:
 *   { tool, sessionId, event }
 *
 * Composes the path-B end-to-end capture flow:
 *
 *   fs change → watcher → per-tool parser → TranscriptEvent[]
 *             → synthetic-span builder (Task 3.2) → OTel receiver
 *             → processors → pending_captures
 *
 * The operator wires `onEvent` to `emitSyntheticSpan(provider, envelope)` so
 * capture-bound spans flow into the receiver+processor pipeline.
 *
 * ## Tail-from-end semantics
 *
 * On `startTranscriptWatcher`, each source's current file size is recorded
 * as the read offset. Only bytes appended *after* the watcher starts are
 * dispatched. This is important so re-launching the daemon does not re-emit
 * every previously-seen transcript record. (The `jinn capture import` CLI
 * uses `parser.parseFull` for one-shot history ingest.)
 *
 * ## Cursor SQLite quirk — fail loudly
 *
 * The Cursor parser's `parseChunk` is a no-op: SQLite isn't streaming, and
 * watching the `.vscdb` file via chokidar would miss WAL deltas. Polling-
 * based Cursor support is a Phase 3.5+ follow-up. To avoid silently dropping
 * Cursor data, this watcher throws at startup if any source has
 * `tool === 'cursor'`. Operators should run `jinn capture import` for Cursor
 * sessions until polling support lands.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import * as fs from 'node:fs/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import type { TranscriptEvent, TranscriptParser } from './transcript-parsers/types.js';
import { ClaudeCodeJsonlParser } from './transcript-parsers/claude-code-jsonl.js';
import { CodexSessionParser } from './transcript-parsers/codex-session.js';
import { GeminiSessionParser } from './transcript-parsers/gemini-session.js';
import { AiderHistoryParser } from './transcript-parsers/aider-history.js';
import { ContinueDevDataParser } from './transcript-parsers/continue-devdata.js';

export type WatchedTool =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'cursor'
  | 'aider'
  | 'continue';

export interface WatchedSource {
  /** Identity of the source tool — selects the parser. */
  tool: WatchedTool;
  /** Absolute path to the transcript file. */
  path: string;
  /**
   * Operator-assigned session id. Carried through to the dispatched
   * envelope and ultimately into the synthetic span as `session.id`.
   */
  sessionId: string;
}

export interface DispatchEnvelope {
  tool: WatchedTool;
  sessionId: string;
  event: TranscriptEvent;
}

export interface TranscriptWatcherConfig {
  sources: WatchedSource[];
  onEvent: (envelope: DispatchEnvelope) => void;
}

export interface TranscriptWatcher {
  shutdown(): Promise<void>;
}

function makeParser(tool: WatchedTool): TranscriptParser {
  switch (tool) {
    case 'claude-code':
      return new ClaudeCodeJsonlParser();
    case 'codex':
      return new CodexSessionParser();
    case 'gemini-cli':
      return new GeminiSessionParser();
    case 'aider':
      return new AiderHistoryParser();
    case 'continue':
      return new ContinueDevDataParser();
    case 'cursor':
      // See file header. Cursor streaming via chokidar would silently miss
      // WAL deltas; the parser's parseChunk is a deliberate no-op. Polling-
      // based Cursor support is a Phase 3.5+ follow-up; until then operators
      // should use `jinn capture import` for Cursor sessions.
      throw new Error(
        "Cursor SQLite watching not yet supported in v0 — use 'jinn capture import' " +
          'for Cursor sessions or wait for polling support (Phase 3.5+).',
      );
    default: {
      const exhaustive: never = tool;
      throw new Error(`No parser for tool: ${String(exhaustive)}`);
    }
  }
}

interface SourceState {
  source: WatchedSource;
  parser: TranscriptParser;
  /** Byte offset at which the next read begins. Tail-from-end on startup. */
  nextOffset: number;
  /** Serialises change-handling per file so concurrent fs events don't race. */
  inFlight: Promise<void>;
}

export async function startTranscriptWatcher(
  cfg: TranscriptWatcherConfig,
): Promise<TranscriptWatcher> {
  const states = new Map<string, SourceState>();
  for (const source of cfg.sources) {
    // Construct the parser first so a Cursor source fails loudly *before* we
    // open any chokidar handles.
    const parser = makeParser(source.tool);
    let nextOffset = 0;
    try {
      const stats = await fs.stat(source.path);
      nextOffset = stats.size;
    } catch {
      // File doesn't exist yet — start at offset 0; chokidar will fire `add`
      // when it appears.
      nextOffset = 0;
    }
    states.set(source.path, { source, parser, nextOffset, inFlight: Promise.resolve() });
  }

  let shuttingDown = false;

  const watcher: FSWatcher = chokidar.watch(
    cfg.sources.map((s) => s.path),
    {
      persistent: true,
      // Wait for writers to settle before reading; cheap insurance against
      // half-written JSONL lines.
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
      // Tail-from-end: on startup, current contents are the baseline. Only
      // mutations *after* startup should dispatch.
      ignoreInitial: true,
    },
  );

  const enqueue = (filepath: string): void => {
    if (shuttingDown) return;
    const state = states.get(filepath);
    if (!state) return;
    state.inFlight = state.inFlight.then(() => handleChange(state));
  };

  watcher.on('add', enqueue);
  watcher.on('change', enqueue);

  async function handleChange(state: SourceState): Promise<void> {
    if (shuttingDown) return;
    let size: number;
    try {
      const stats = await fs.stat(state.source.path);
      size = stats.size;
    } catch {
      return;
    }
    // Truncation or stale event — skip. (We deliberately do not reset
    // nextOffset on truncation; if the file is rotated we'd need explicit
    // operator intervention. Phase 3.5+ may add inode-change detection.)
    if (size <= state.nextOffset) return;

    const handle = await fs.open(state.source.path, 'r');
    try {
      const length = size - state.nextOffset;
      const buf = Buffer.alloc(length);
      await handle.read({ buffer: buf, position: state.nextOffset, length });
      state.nextOffset = size;

      const events = state.parser.parseChunk({
        sessionId: state.source.sessionId,
        chunk: buf,
      });
      if (shuttingDown) return;
      for (const event of events) {
        cfg.onEvent({
          tool: state.source.tool,
          sessionId: state.source.sessionId,
          event,
        });
      }
    } finally {
      await handle.close();
    }
  }

  return {
    async shutdown() {
      shuttingDown = true;
      await watcher.close();
      // Drain any in-flight per-source handlers so post-shutdown the map is
      // settled. Errors here are intentionally swallowed — we're tearing down.
      await Promise.allSettled(
        Array.from(states.values(), (state) => state.inFlight),
      );
    },
  };
}
