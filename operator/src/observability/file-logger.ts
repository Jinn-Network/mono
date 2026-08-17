/**
 * Rotating, size-bounded daemon file logger (issue #420 §1).
 *
 * The daemon's logging today is unstructured and ephemeral — `console.*` to
 * stdout/stderr, nothing durable. A support bundle needs durable logs, so
 * this module appends a redacted log line per call to `~/.jinn-client/logs/`,
 * rotates the active file when it crosses a size bound, and prunes both by
 * file count and by age.
 *
 * Hand-rolled rather than pulling in a logging framework: a size-bounded
 * rotator is ~120 lines and self-contained, and the bundle assembler only
 * needs `listLogFiles()` to enumerate the rotation set.
 *
 * Redaction at write time: every line is run through `redactValue`'s string
 * redactor before it hits disk, so the on-disk file is safe by construction
 * and the bundle assembler does not need to re-scan log bytes.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { redactValue } from './redact-secrets.js';
import { resolveDefaultStateDir } from '../state-dir.js';

export interface FileLoggerOptions {
  /** Log directory. Defaults to `~/.jinn-client/logs`. */
  logDir?: string;
  /** Rotate the active file once it crosses this many bytes. Default 5 MiB. */
  maxBytes?: number;
  /** Number of files to keep, including the active `daemon.log`. Default 5. */
  maxFiles?: number;
  /** Delete rotated files older than this many days on startup. Default 14. */
  maxAgeDays?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_AGE_DAYS = 14;
const ACTIVE_FILE = 'daemon.log';

/** Redact a single log line — strips secret-shaped substrings. */
function redactLine(line: string): string {
  return redactValue(line) as string;
}

export class FileLogger {
  private readonly logDir: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxAgeDays: number;
  private readonly activePath: string;
  private bytesWritten = 0;
  private closed = false;

  constructor(opts: FileLoggerOptions = {}) {
    this.logDir = opts.logDir ?? join(resolveDefaultStateDir(), 'logs');
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    this.activePath = join(this.logDir, ACTIVE_FILE);

    mkdirSync(this.logDir, { recursive: true });
    this.sweepStaleFiles();
    this.bytesWritten = existsSync(this.activePath)
      ? statSync(this.activePath).size
      : 0;
  }

  /**
   * Append a single log line. The line is redacted before it hits disk.
   *
   * Writes synchronously (`appendFileSync`) rather than via a `WriteStream`:
   * a daemon emits at most a handful of lines per second, and a synchronous
   * append avoids buffering races on shutdown / rotation.
   */
  write(line: string): void {
    if (this.closed) return;
    const safe = `${redactLine(line)}\n`;
    const size = Buffer.byteLength(safe);
    if (this.bytesWritten > 0 && this.bytesWritten + size > this.maxBytes) {
      this.rotate();
    }
    try {
      appendFileSync(this.activePath, safe);
      this.bytesWritten += size;
    } catch {
      // Logging must never crash the daemon.
    }
  }

  /**
   * Ordered list of log files for the bundle assembler: the active
   * `daemon.log` first, then `daemon.log.1`, `.2`, ... in age order.
   * Only files that exist on disk are returned.
   */
  listLogFiles(): string[] {
    const out: string[] = [];
    if (existsSync(this.activePath)) out.push(this.activePath);
    for (let i = 1; i < this.maxFiles; i++) {
      const p = `${this.activePath}.${i}`;
      if (existsSync(p)) out.push(p);
    }
    return out;
  }

  /** Mark the logger closed for clean daemon shutdown. */
  close(): void {
    this.closed = true;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Rotate: `daemon.log.{N-1}` -> `.N` shift (oldest dropped), then
   * `daemon.log` -> `daemon.log.1`. The next `write` recreates the active
   * file via `appendFileSync`.
   */
  private rotate(): void {
    // Drop the oldest rotated file.
    const oldest = `${this.activePath}.${this.maxFiles - 1}`;
    if (existsSync(oldest)) {
      try {
        unlinkSync(oldest);
      } catch {
        /* ignore */
      }
    }
    // Shift `.i` -> `.i+1` from oldest to newest.
    for (let i = this.maxFiles - 2; i >= 1; i--) {
      const from = `${this.activePath}.${i}`;
      const to = `${this.activePath}.${i + 1}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          /* ignore */
        }
      }
    }
    // Active -> .1.
    if (existsSync(this.activePath)) {
      try {
        renameSync(this.activePath, `${this.activePath}.1`);
      } catch {
        /* ignore */
      }
    }
    this.bytesWritten = 0;
  }

  /** Delete rotated `daemon.log.*` files older than the age bound. */
  private sweepStaleFiles(): void {
    const cutoffMs = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = readdirSync(this.logDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!/^daemon\.log\.\d+$/.test(entry)) continue;
      const p = join(this.logDir, entry);
      try {
        if (statSync(p).mtimeMs < cutoffMs) {
          unlinkSync(p);
        }
      } catch {
        /* ignore */
      }
    }
  }
}

// ── module singleton ─────────────────────────────────────────────────────────

let SINGLETON: FileLogger | null = null;

/**
 * Process-wide file logger singleton. Mirrors `events/emitter.ts`'s
 * `getEventBuffer()` pattern. Lazily constructed on first use so importing
 * this module never touches the filesystem.
 */
export function getFileLogger(): FileLogger {
  if (!SINGLETON) {
    SINGLETON = new FileLogger();
  }
  return SINGLETON;
}

/** Close the singleton logger (daemon shutdown). Safe to call when unset. */
export function closeFileLogger(): void {
  SINGLETON?.close();
  SINGLETON = null;
}
