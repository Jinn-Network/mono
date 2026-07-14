/**
 * `yarn autopilot sessions` — surface live and recently-finished Claude Code
 * sessions spawned by the dispatcher.
 *
 * Spec: docs/superpowers/specs/2026-05-26-eng-loop-sessions-subcommand.md
 * Plan: docs/superpowers/plans/2026-05-26-eng-loop-sessions-subcommand-plan.md
 *
 * Issue: jinn-mono#587
 */

import { basename, join as pathJoin } from 'node:path';
import { Transform } from 'node:stream';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { WORKTREES_BASE } from '../dispatcher/dispatch.js';

export interface SessionRecord {
  issueNumber: number;
  status: 'alive' | 'done' | 'stale';
  pid: number | null;
  worktreePath: string;
  transcriptPath: string;
  sessionId: string;
  lastActivity: string;           // ISO-8601
  lastSummary: string | null;     // truncated to 200 chars
  prUrl: string | null;
}

export interface SessionsDeps {
  worktreesBase: string;
  claudeProjectsDir: string;
  now: () => number;
  listProjectDirs: (dir: string) => Promise<string[]>;
  listJsonlFiles: (dir: string) => Promise<Array<{ name: string; mtimeMs: number }>>;
  readJsonl: (path: string) => Promise<string>;
  listClaudeProcesses: () => Promise<Array<{ pid: number }>>;
  resolveProcessCwd: (pid: number) => Promise<string | null>;
  spawnTail: (path: string) => { stdout: NodeJS.ReadableStream; kill: (sig: NodeJS.Signals) => void };
  sendSignal: (pid: number, sig: NodeJS.Signals) => void;
  confirm: (prompt: string) => Promise<boolean>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  onSigint?: (handler: () => void) => void;
}

export interface KillOptions { force: boolean; }
export interface TailOptions { tailLines: number; /* default 50 */ }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Encode an absolute worktree path the way Claude Code does when it persists a
 * session transcript under `~/.claude/projects/<dir>/`: every non-alphanumeric
 * character becomes a single `-`, runs of `-` collapse, and any trailing `-`
 * (e.g. from a trailing slash) is trimmed. The leading `-` (from the leading
 * `/` on an absolute path) is preserved — it is load-bearing for round-trips.
 */
export function encodeWorktreePathToProjectDir(path: string): string {
  return path
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// JSONL extractors
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL transcript body. Blank lines and lines that fail JSON.parse are
 * dropped silently — Claude Code transcripts are append-only and occasionally
 * contain a partial-write tail.
 */
export function parseJsonlLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // drop malformed line
    }
  }
  return out;
}

interface MaybeTimestamped { timestamp?: unknown }
interface MaybeMessage { type?: unknown; message?: { content?: unknown } }
interface ContentBlock { type?: unknown; text?: unknown }
interface PrLinkRecord { type?: unknown; prNumber?: unknown; prUrl?: unknown }

/**
 * Return the latest parseable ISO-8601 timestamp across `records`. Returns
 * `null` if no record has a parseable timestamp.
 */
export function lastTimestamp(records: unknown[]): number | null {
  let max: number | null = null;
  for (const r of records) {
    const ts = (r as MaybeTimestamped | null | undefined)?.timestamp;
    if (typeof ts !== 'string') continue;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    if (max == null || ms > max) max = ms;
  }
  return max;
}

/**
 * Walk `records` in order; for each `assistant` record scan its message
 * content for `text` blocks; return the `.text` of the most recent such
 * block (trimmed), or `null` if no assistant text exists.
 */
export function lastAssistantText(records: unknown[]): string | null {
  let last: string | null = null;
  for (const r of records) {
    const rec = r as MaybeMessage | null | undefined;
    if (rec?.type !== 'assistant') continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as ContentBlock[]) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        last = block.text.trim();
      }
    }
  }
  return last;
}

/**
 * Return the most-recent `pr-link` record's `{ prNumber, prUrl }`, or `null`.
 */
export function prLinkRecord(records: unknown[]): { prNumber: number; prUrl: string } | null {
  let last: { prNumber: number; prUrl: string } | null = null;
  for (const r of records) {
    const rec = r as PrLinkRecord | null | undefined;
    if (rec?.type !== 'pr-link') continue;
    if (typeof rec.prNumber === 'number' && typeof rec.prUrl === 'string') {
      last = { prNumber: rec.prNumber, prUrl: rec.prUrl };
    }
  }
  return last;
}

/**
 * Truncate `s` to at most `n` characters. When truncation happens the suffix
 * is `...` and total length is exactly `n`. If `n` is smaller than the
 * ellipsis (`...` = 3 chars), the result is just the leading slice of `s`
 * up to `n` characters of ellipsis (so `truncate('abcd', 3)` → `'...'`).
 */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 3)) + '...';
}

// ---------------------------------------------------------------------------
// discoverSessions — joins JSONL transcripts to live claude pids
// ---------------------------------------------------------------------------

const TWENTY_FOUR_HOURS_MS = 24 * 3600_000;

/**
 * Reconstruct the set of dispatcher-spawned Claude Code sessions from on-disk
 * transcripts under `~/.claude/projects/<dir>/<sessionId>.jsonl` plus the live
 * `claude` process list. A session is **alive** if a running `claude` pid's
 * cwd exactly matches the worktree path we inferred from `<dir>`; otherwise
 * it's **done** if its most-recent activity is within 24h, or **stale**
 * (excluded from output) beyond that.
 *
 * The encoder `encodeWorktreePathToProjectDir` is lossy (apostrophes,
 * underscores, and slashes all collapse to `-`), so we cannot decode `<dir>`
 * directly. Instead we exploit the dispatcher's convention — exactly one
 * worktree per issue at `<WORKTREES_BASE>/<N>` — to enumerate by candidate
 * issue number: peel the encoded base prefix off `<dir>`, treat the remainder
 * as a candidate `<N>`, and verify by round-tripping through the encoder
 * (`encodeWorktreePathToProjectDir(join(base, N)) === dir`). This rejects
 * collisions (e.g. unrelated dirs whose stem decodes to a numeric leaf under
 * a different real path) without ever materialising the inverse encoder.
 */
export async function discoverSessions(deps: SessionsDeps): Promise<SessionRecord[]> {
  const dirs = await deps.listProjectDirs(deps.claudeProjectsDir);
  const encodedBase = encodeWorktreePathToProjectDir(deps.worktreesBase);
  const basePrefix = encodedBase + '-';

  // First pass: discover { dir, issueNumber, worktreePath } for matching dirs.
  interface Candidate { dir: string; issueNumber: number; worktreePath: string; }
  const candidates: Candidate[] = [];
  for (const dir of dirs) {
    if (!dir.startsWith(basePrefix)) continue;
    const remainder = dir.slice(basePrefix.length);
    if (!/^\d+$/.test(remainder)) continue;
    const candidateWorktree = pathJoin(deps.worktreesBase, remainder);
    // Round-trip guard: only accept if re-encoding the candidate worktree
    // path produces the same project dir name. Rejects collisions where the
    // dispatcher convention does not hold.
    if (encodeWorktreePathToProjectDir(candidateWorktree) !== dir) continue;
    candidates.push({ dir, issueNumber: parseInt(remainder, 10), worktreePath: candidateWorktree });
  }

  if (candidates.length === 0) return [];

  // Resolve the live claude process list and their cwds once per call.
  const procs = await deps.listClaudeProcesses();
  const cwdEntries = await Promise.all(
    procs.map(async (p) => ({ pid: p.pid, cwd: await deps.resolveProcessCwd(p.pid) })),
  );
  const cwdToPid = new Map<string, number>();
  for (const { pid, cwd } of cwdEntries) {
    if (cwd != null) cwdToPid.set(cwd, pid);
  }

  const now = deps.now();
  const records: SessionRecord[] = [];
  for (const c of candidates) {
    const files = await deps.listJsonlFiles(pathJoin(deps.claudeProjectsDir, c.dir));
    if (files.length === 0) continue;
    const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    const transcriptPath = pathJoin(deps.claudeProjectsDir, c.dir, newest.name);
    const text = await deps.readJsonl(transcriptPath);
    const recordsParsed = parseJsonlLines(text);
    const lastActivityMs = lastTimestamp(recordsParsed) ?? newest.mtimeMs;
    const alivePid = cwdToPid.get(c.worktreePath) ?? null;
    let status: SessionRecord['status'];
    if (alivePid != null) status = 'alive';
    else if (now - lastActivityMs <= TWENTY_FOUR_HOURS_MS) status = 'done';
    else status = 'stale';

    const summary = lastAssistantText(recordsParsed);
    const truncated = summary != null ? truncate(summary, 200) : null;
    const pr = prLinkRecord(recordsParsed);
    records.push({
      issueNumber: c.issueNumber,
      status,
      pid: alivePid,
      worktreePath: c.worktreePath,
      transcriptPath,
      sessionId: newest.name.replace(/\.jsonl$/, ''),
      lastActivity: new Date(lastActivityMs).toISOString(),
      lastSummary: truncated != null && truncated.length > 0 ? truncated : null,
      prUrl: pr?.prUrl ?? null,
    });
  }

  // ISO-8601 sorts correctly as a string; reverse comparator → newest first.
  return records
    .filter((r) => r.status !== 'stale')
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * `--json` output. The `SessionRecord` interface is the contract — do not add
 * or rename fields here without updating downstream scripts.
 */
export function renderJson(records: SessionRecord[]): string {
  if (records.length === 0) return '[]';
  return JSON.stringify(records, null, 2);
}

/**
 * Compress an absolute `path` by replacing a leading `home` prefix with `~`.
 * If `path` does not start with `home`, returns `path` unchanged. Used to
 * keep worktree paths short in the human table; `--json` is the structured
 * source and emits the full path.
 */
export function tildeCompress(path: string, home: string): string {
  if (home.length === 0) return path;
  if (path === home) return '~';
  const withSlash = home.endsWith('/') ? home : home + '/';
  if (path.startsWith(withSlash)) {
    return '~/' + path.slice(withSlash.length);
  }
  return path;
}

/**
 * Human-readable table for `yarn autopilot sessions` (default mode). Columns:
 * `ISSUE`, `STATUS`, `PID`, `WORKTREE`, `LAST ACTIVITY`, `SUMMARY`,
 * `TRANSCRIPT`. WORKTREE shows the path with `os.homedir()` collapsed to
 * `~`; TRANSCRIPT shows only the JSONL basename (the sessionId) since the
 * surrounding directory is deterministic from the issue number. `--json` is
 * still the structured source for scripting and emits the full paths.
 * Summary column is clamped to fit terminal width.
 */
export function renderTable(records: SessionRecord[], home: string = homedir()): string {
  const headers = ['ISSUE', 'STATUS', 'PID', 'WORKTREE', 'LAST ACTIVITY', 'SUMMARY', 'TRANSCRIPT'];
  const summaryIdx = headers.indexOf('SUMMARY');

  if (records.length === 0) {
    // Still render the header so downstream scripts grepping for column names
    // get something stable, and an explanatory body line.
    return headers.join('  ') + '\n(no sessions in the last 24h)';
  }

  // Build row strings (data only; we'll pad column widths after measuring).
  const rows = records.map((r) => [
    String(r.issueNumber),
    r.status,
    r.pid != null ? String(r.pid) : '-',
    tildeCompress(r.worktreePath, home),
    r.lastActivity,
    r.lastSummary ?? '(no assistant text)',
    basename(r.transcriptPath),
  ]);

  // Column widths: max(header, max(data)) for the non-summary columns; the
  // summary column is clamped below to fit the terminal.
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));

  // Summary clamping: budget = min(60, terminalWidth - sum(otherCols+gaps)).
  // 60 keeps the row navigable when both paths are present; 20 is the floor.
  const terminalWidth = (process.stdout as { columns?: number }).columns ?? 120;
  const otherWidth = widths.reduce((a, b, i) => (i === summaryIdx ? a : a + b + 2), 0);
  const summaryBudget = Math.max(20, Math.min(60, terminalWidth - otherWidth));
  widths[summaryIdx] = Math.min(widths[summaryIdx]!, summaryBudget);

  // truncate-then-padEnd works for every column: truncate is a no-op for the
  // non-summary columns (widths derived from data) and clamps the summary.
  const renderRow = (cells: string[]): string =>
    cells.map((c, i) => truncate(c, widths[i]!).padEnd(widths[i]!)).join('  ');

  return [headers, ...rows].map(renderRow).join('\n');
}

// ---------------------------------------------------------------------------
// PrettyPrintTransform — JSONL → human lines (for --tail)
// ---------------------------------------------------------------------------

interface JsonlRecord {
  type?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
  prNumber?: unknown;
  prUrl?: unknown;
}

function timeFragment(ts: unknown): string {
  if (typeof ts !== 'string') return '??:??:??';
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return '??:??:??';
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * Line-buffered JSONL → human-readable text stream. Emits one line per:
 *   - `assistant` / `user` text content block → `[hh:mm:ss <type>] <text>`
 *   - `pr-link` record → `[hh:mm:ss pr-link] #<N> <url>`
 *
 * All other record types (`queue-operation`, `attachment`, `last-prompt`,
 * tool-use payloads, thinking-only assistant turns) are dropped at default
 * verbosity. Malformed JSON lines are dropped silently.
 */
export class PrettyPrintTransform extends Transform {
  private buffer = '';

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      this.emitLine(line);
    }
    cb();
  }

  override _flush(cb: (err?: Error | null) => void): void {
    if (this.buffer.length > 0) {
      this.emitLine(this.buffer);
      this.buffer = '';
    }
    cb();
  }

  private emitLine(line: string): void {
    if (line.length === 0) return;
    let record: JsonlRecord;
    try {
      record = JSON.parse(line) as JsonlRecord;
    } catch {
      return;
    }
    const time = timeFragment(record.timestamp);
    const t = record.type;
    if (t === 'assistant' || t === 'user') {
      const content = record.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          this.push(`[${time} ${t}] ${block.text}\n`);
        }
      }
      return;
    }
    if (t === 'pr-link' && typeof record.prNumber === 'number' && typeof record.prUrl === 'string') {
      this.push(`[${time} pr-link] #${record.prNumber} ${record.prUrl}\n`);
    }
    // Everything else is dropped.
  }
}

// ---------------------------------------------------------------------------
// tailSession — live-follow a session transcript with prettyprint
// ---------------------------------------------------------------------------

/**
 * Find the discovered session for `issueNumber` or throw a clear error.
 * `noun` customises the message (`transcript` for tail, `session` for kill).
 */
async function findSessionForIssue(
  issueNumber: number,
  noun: string,
  deps: SessionsDeps,
): Promise<SessionRecord> {
  const records = await discoverSessions(deps);
  const record = records.find((r) => r.issueNumber === issueNumber);
  if (record == null) {
    throw new Error(`no ${noun} found for issue #${issueNumber}`);
  }
  return record;
}

/**
 * Resolve the transcript for `issueNumber`, spawn `tail -F` against it, pipe
 * through `PrettyPrintTransform`, and write to `deps.stdout`. Forwards
 * `SIGINT` to the tail subprocess via the `onSigint` seam so Ctrl-C exits
 * cleanly. Resolves when the tail stdout closes (normally never — operator
 * Ctrl-Cs to exit).
 */
export async function tailSession(
  issueNumber: number,
  _opts: TailOptions,
  deps: SessionsDeps,
): Promise<void> {
  const record = await findSessionForIssue(issueNumber, 'transcript', deps);

  const tail = deps.spawnTail(record.transcriptPath);
  const pretty = new PrettyPrintTransform();
  tail.stdout.pipe(pretty).pipe(deps.stdout, { end: false });

  if (deps.onSigint != null) {
    deps.onSigint(() => {
      tail.kill('SIGTERM');
    });
  }

  await new Promise<void>((resolve) => {
    tail.stdout.on('end', resolve);
    tail.stdout.on('close', resolve);
  });
}

// ---------------------------------------------------------------------------
// killSession — SIGTERM an alive session after [y/N] confirm
// ---------------------------------------------------------------------------

/**
 * Resolve the session for `issueNumber`, prompt the operator (unless
 * `opts.force`), and send SIGTERM to the matched `claude` pid. The worktree
 * and transcript are preserved — the operator can re-dispatch via the
 * project board or restart the dispatcher.
 */
export async function killSession(
  issueNumber: number,
  opts: KillOptions,
  deps: SessionsDeps,
): Promise<void> {
  const rec = await findSessionForIssue(issueNumber, 'session', deps);
  if (rec.status !== 'alive' || rec.pid == null) {
    throw new Error(`session for issue #${issueNumber} is not alive (status: ${rec.status})`);
  }

  if (!opts.force) {
    const prompt = `Kill claude session for issue #${issueNumber} (pid ${rec.pid}, started ${rec.lastActivity})? [y/N] `;
    const ok = await deps.confirm(prompt);
    if (!ok) {
      deps.stderr.write('aborted (no-op)\n');
      return;
    }
  }

  deps.sendSignal(rec.pid, 'SIGTERM');
  deps.stderr.write(`killed pid ${rec.pid}\n`);
}

// ---------------------------------------------------------------------------
// runSessionsCli — top-level argv parsing + routing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  mode: 'list' | 'tail' | 'kill';
  json: boolean;
  force: boolean;
  issueNumber: number | null;
}

const ISSUE_FLAGS: Record<string, ParsedArgs['mode']> = {
  '--tail': 'tail',
  '--kill': 'kill',
};

function parseArgs(argv: string[]): ParsedArgs {
  let mode: ParsedArgs['mode'] = 'list';
  let json = false;
  let force = false;
  let issueNumber: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--json') {
      json = true;
      continue;
    }
    if (tok === '--yes' || tok === '--force') {
      force = true;
      continue;
    }
    const flagMode = ISSUE_FLAGS[tok];
    if (flagMode != null) {
      const next = argv[i + 1];
      if (next == null || !/^\d+$/.test(next)) {
        throw new Error(`${tok} requires an issue number`);
      }
      mode = flagMode;
      issueNumber = parseInt(next, 10);
      i++;
      continue;
    }
    throw new Error(`unknown flag: ${tok}`);
  }

  return { mode, json, force, issueNumber };
}

/**
 * Top-level `yarn autopilot sessions` CLI shell. Parses `argv` (the slice
 * after the subcommand name), routes to one of `tailSession` / `killSession`
 * / default listing, and writes output via the injected `deps.stdout` /
 * `deps.stderr`.
 *
 * Production callers omit `depsOverride` and get `defaultDeps()`. Tests
 * inject a synthetic `SessionsDeps` to avoid touching the real filesystem
 * or process table.
 */
export async function runSessionsCli(argv: string[], depsOverride?: SessionsDeps): Promise<void> {
  const args = parseArgs(argv);
  const deps = depsOverride ?? defaultDeps();

  if (args.mode === 'tail') {
    await tailSession(args.issueNumber!, { tailLines: 50 }, deps);
    return;
  }
  if (args.mode === 'kill') {
    await killSession(args.issueNumber!, { force: args.force }, deps);
    return;
  }

  const records = await discoverSessions(deps);
  deps.stdout.write(args.json ? renderJson(records) : renderTable(records));
  deps.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// defaultDeps — production wiring (real fs / ps / lsof / claude)
// ---------------------------------------------------------------------------

/**
 * Production wiring of `SessionsDeps`. Resolves real fs paths, shells out
 * to `ps` and `lsof` (macOS), spawns `tail -F`, and uses `readline/promises`
 * for the `[y/N]` prompt. Linux's `/proc/<pid>/cwd` resolver is left as a
 * follow-up — the spec (§A portability) gates the v1 ship on macOS, which
 * is what every operator runs today.
 */
export function defaultDeps(): SessionsDeps {
  const claudeProjectsDir = pathJoin(homedir(), '.claude', 'projects');

  return {
    worktreesBase: WORKTREES_BASE,
    claudeProjectsDir,
    now: () => Date.now(),
    listProjectDirs: async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    },
    listJsonlFiles: async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const jsonl = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
      const stats = await Promise.all(
        jsonl.map(async (e) => {
          const st = await fsp.stat(pathJoin(dir, e.name));
          return { name: e.name, mtimeMs: st.mtimeMs };
        }),
      );
      return stats;
    },
    readJsonl: (path) => fsp.readFile(path, 'utf8'),
    listClaudeProcesses: async () => {
      // `ps -axo pid=,comm=` — pid + the basename of the executable.
      // The dispatcher spawns the absolute path to `claude`, so we match
      // either `claude` (just the basename) or any path ending in `/claude`.
      const out = await runCommand('ps', ['-axo', 'pid=,comm=']);
      const pids: Array<{ pid: number }> = [];
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        // First whitespace-delimited token is pid; the rest is the comm.
        const m = trimmed.match(/^(\d+)\s+(.+)$/);
        if (m == null) continue;
        const pid = parseInt(m[1]!, 10);
        const comm = m[2]!.trim();
        if (comm === 'claude' || comm.endsWith('/claude')) {
          pids.push({ pid });
        }
      }
      return pids;
    },
    resolveProcessCwd: (pid) => resolveProcessCwdForPlatform(process.platform, pid),
    spawnTail: (path) => {
      const child = spawn('tail', ['-n', '50', '-F', path], { stdio: ['ignore', 'pipe', 'inherit'] });
      return {
        stdout: child.stdout!,
        kill: (sig) => { child.kill(sig); },
      };
    },
    sendSignal: (pid, sig) => { process.kill(pid, sig); },
    confirm: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const ans = await rl.question(prompt);
        return /^y(es)?$/i.test(ans.trim());
      } finally {
        rl.close();
      }
    },
    onSigint: (handler) => { process.on('SIGINT', handler); },
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

/** Run a shell command and return its stdout. Throws on non-zero exit. */
async function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString('utf8').trim();
        reject(new Error(`${cmd} exited with code ${code}: ${err}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function resolveProcessCwdForPlatform(platform: NodeJS.Platform, pid: number): Promise<string | null> {
  // Linux (`readlink /proc/<pid>/cwd`) is a TODO(#587-followup) — the spec
  // (§A portability) gates v1 on macOS since every operator runs darwin.
  if (platform !== 'darwin') return null;
  try {
    // `lsof -a -p <pid> -d cwd -Fn` emits records of the form:
    //   p<pid>
    //   fcwd
    //   n<path>
    const out = await runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) {
        return line.slice(1).trim() || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
