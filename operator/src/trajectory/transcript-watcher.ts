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
 * ## Directory watching
 *
 * `directories` watches a session folder for new or growing `*.jsonl` files
 * (e.g. `~/.codex/sessions`, `~/.claude/projects/**`). Existing files are
 * registered at startup with the same tail-from-end baseline; `add` events
 * register files created after startup.
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
import { resolve as resolvePath } from 'node:path';
import { once } from 'node:events';
import chokidar, { type FSWatcher, type ChokidarOptions } from 'chokidar';
import type { TranscriptEvent, TranscriptParser } from './transcript-parsers/types.js';
import { ClaudeCodeJsonlParser } from './transcript-parsers/claude-code-jsonl.js';
import { CodexSessionParser } from './transcript-parsers/codex-session.js';
import { GeminiSessionParser } from './transcript-parsers/gemini-session.js';
import { AiderHistoryParser } from './transcript-parsers/aider-history.js';
import { ContinueDevDataParser } from './transcript-parsers/continue-devdata.js';
import { listSessionJsonlFiles } from './transcript-session-dirs.js';

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

export interface WatchedDirectory {
  tool: WatchedTool;
  /** Absolute path to the directory containing session JSONL files. */
  directory: string;
  /** When true, watch nested .jsonl files recursively (Claude Code projects layout). */
  recursive?: boolean;
  /** Derive the capture session id from an absolute JSONL path. */
  sessionIdFromPath: (absolutePath: string) => string;
}

export interface DispatchEnvelope {
  tool: WatchedTool;
  sessionId: string;
  event: TranscriptEvent;
}

export interface TranscriptWatcherConfig {
  /** Explicit per-file sources (tests, stop-hook safety-net paths). */
  sources?: WatchedSource[];
  /** Standard session directories (Codex, Claude Code, …). */
  directories?: WatchedDirectory[];
  onEvent: (envelope: DispatchEnvelope) => void;
  /**
   * Test/CI seam only. Extra chokidar watch options merged over this module's
   * hardcoded defaults (see the `chokidar.watch` call). Caller-supplied keys
   * override defaults; keys the caller omits keep their operator-critical
   * defaults (`awaitWriteFinish`, `ignoreInitial`, `ignored`, `persistent`).
   *
   * Production callers pass nothing, so the daemon stays on native fs.watch —
   * this preserves the #1422 native-handle minimization. Polling is
   * deliberately NOT the production default: tests pass
   * `{ usePolling: true, interval: 20 }` to make the pre-existing-file `change`
   * (append) path deterministic under CI, where native fs.watch drops appends
   * to files that already existed when the directory watch started (#832).
   */
  watchOptions?: Partial<ChokidarOptions>;
  /**
   * #1422: skip `directories`-mode session files whose mtime is older than
   * this many ms — dormant sessions are done growing and don't need a live
   * OS-level watch handle. On an operator machine with a large accumulated
   * history under `~/.claude/projects` / `~/.codex/sessions`, watching every
   * historical file unbounded creates tens of thousands of native FSWatcher
   * handles, starving the daemon's event loop (confirmed live: 15k+ handles,
   * multiple daemon loops wedged for 70+ minutes; closing the handles
   * in-process immediately unwedged them). Explicit `sources` are always
   * watched regardless — they're operator-supplied, not bulk-enumerated.
   * Default 7 days. `jinn capture import` remains the one-shot path for
   * ingesting older history.
   */
  maxDirectoryFileAgeMs?: number;
}

const DEFAULT_MAX_DIRECTORY_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

async function tailOffsetForPath(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

function isJsonlSessionFile(filePath: string): boolean {
  return filePath.endsWith('.jsonl');
}

/**
 * #1422: whether a `directories`-mode file is recent enough to warrant an
 * active watch (pre-registration + chokidar's native handle). `stats` is
 * `undefined` on chokidar's path-only pre-check (before it has stat'd the
 * candidate) — always allow through at that stage; it re-checks with stats
 * once available. Directories are always kept so recursion can still
 * discover freshly-active sessions underneath an old-looking parent.
 */
export function shouldWatchDirectoryFile(
  filePath: string,
  stats: { isDirectory(): boolean; mtimeMs: number } | undefined,
  maxAgeMs: number,
): boolean {
  if (!stats) return true;
  if (stats.isDirectory()) return true;
  if (!isJsonlSessionFile(filePath)) return false;
  return Date.now() - stats.mtimeMs <= maxAgeMs;
}

export async function startTranscriptWatcher(
  cfg: TranscriptWatcherConfig,
): Promise<TranscriptWatcher> {
  const sources = cfg.sources ?? [];
  const directories = cfg.directories ?? [];
  if (sources.length === 0 && directories.length === 0) {
    throw new Error('startTranscriptWatcher requires at least one source or directory');
  }

  const states = new Map<string, SourceState>();
  const directoryParsers = new Map<WatchedTool, TranscriptParser>();
  const maxDirectoryFileAgeMs =
    cfg.maxDirectoryFileAgeMs ?? DEFAULT_MAX_DIRECTORY_FILE_AGE_MS;

  const registerSource = async (
    source: WatchedSource,
    opts: { tailFromEnd: boolean; parser?: TranscriptParser },
  ): Promise<void> => {
    const normalizedPath = resolvePath(source.path);
    const nextOffset = opts.tailFromEnd ? await tailOffsetForPath(normalizedPath) : 0;
    const parser = opts.parser ?? makeParser(source.tool);
    states.set(normalizedPath, {
      source: { ...source, path: normalizedPath },
      parser,
      nextOffset,
      inFlight: Promise.resolve(),
    });
  };

  for (const source of sources) {
    await registerSource(source, { tailFromEnd: true });
  }

  for (const dir of directories) {
    const parser = makeParser(dir.tool);
    directoryParsers.set(dir.tool, parser);
    const files = await listSessionJsonlFiles(dir.directory, dir.recursive === true);
    for (const filePath of files) {
      const stats = await fs.stat(filePath).catch(() => undefined);
      if (!shouldWatchDirectoryFile(filePath, stats, maxDirectoryFileAgeMs)) continue;
      await registerSource(
        {
          tool: dir.tool,
          path: filePath,
          sessionId: dir.sessionIdFromPath(filePath),
        },
        { tailFromEnd: true, parser },
      );
    }
  }

  let shuttingDown = false;

  const watchPaths = [
    ...sources.map((s) => s.path),
    ...directories.map((d) => d.directory),
  ];

  // #1422: explicit `sources` are operator-supplied and always watched
  // regardless of extension/age; only `directories`-mode bulk enumeration is
  // bounded (see maxDirectoryFileAgeMs above — this is the other half of the
  // same fix, applied where it actually matters: chokidar's own native watch
  // handles, not just this module's pre-registration).
  const explicitSourcePaths = new Set(sources.map((s) => resolvePath(s.path)));

  const watcher: FSWatcher = chokidar.watch(watchPaths, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    ignoreInitial: true,
    ignored: (candidatePath, stats) => {
      if (explicitSourcePaths.has(resolvePath(candidatePath))) return false;
      return !shouldWatchDirectoryFile(candidatePath, stats, maxDirectoryFileAgeMs);
    },
    ...cfg.watchOptions,
  });

  const resolveDirectoryForPath = (filepath: string): WatchedDirectory | undefined => {
    const normalized = resolvePath(filepath);
    for (const dir of directories) {
      const root = resolvePath(dir.directory);
      const prefix = root.endsWith('/') ? root : `${root}/`;
      if (normalized === root || normalized.startsWith(prefix)) {
        return dir;
      }
    }
    return undefined;
  };

  const ensureStateForPath = async (filepath: string): Promise<SourceState | undefined> => {
    const normalized = resolvePath(filepath);
    const existing = states.get(normalized);
    if (existing) return existing;

    const dir = resolveDirectoryForPath(normalized);
    if (!dir || !isJsonlSessionFile(normalized)) return undefined;

    const parser = directoryParsers.get(dir.tool) ?? makeParser(dir.tool);
    directoryParsers.set(dir.tool, parser);
    const source: WatchedSource = {
      tool: dir.tool,
      path: normalized,
      sessionId: dir.sessionIdFromPath(normalized),
    };
    const state: SourceState = {
      source,
      parser,
      nextOffset: 0,
      inFlight: Promise.resolve(),
    };
    states.set(normalized, state);
    return state;
  };

  const enqueue = (filepath: string): void => {
    if (shuttingDown) return;
    const normalized = resolvePath(filepath);
    void (async () => {
      const state = states.get(normalized) ?? await ensureStateForPath(normalized);
      if (!state) return;
      state.inFlight = state.inFlight.then(() => handleChange(state));
    })();
  };

  watcher.on('add', enqueue);
  watcher.on('change', enqueue);

  // Resolve only once chokidar has finished its initial scan and bound the
  // underlying OS watches. With `awaitWriteFinish` enabled, chokidar does not
  // process `add`/`change` events until `ready` has fired (see chokidar's
  // `_emit` guard on `_readyEmitted`), so returning the watcher before `ready`
  // means appends made immediately after `startTranscriptWatcher` can be
  // silently dropped. Awaiting `ready` makes detection deterministic — the
  // caller is guaranteed a live watcher — instead of racing fs-watch setup
  // latency against a fixed polling budget (the root of #304's CI flake).
  await once(watcher, 'ready');

  async function handleChange(state: SourceState): Promise<void> {
    if (shuttingDown) return;
    let size: number;
    try {
      const stats = await fs.stat(state.source.path);
      size = stats.size;
    } catch {
      return;
    }
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
      await Promise.allSettled(
        Array.from(states.values(), (state) => state.inFlight),
      );
    },
  };
}
