/**
 * `yarn eng:loop sessions` — surface live and recently-finished Claude Code
 * sessions spawned by the dispatcher.
 *
 * Spec: docs/superpowers/specs/2026-05-26-eng-loop-sessions-subcommand.md
 * Plan: docs/superpowers/plans/2026-05-26-eng-loop-sessions-subcommand-plan.md
 *
 * Issue: jinn-mono#587
 */

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

import { basename, dirname, join as pathJoin, resolve as pathResolve } from 'node:path';

/**
 * Return the numeric issue id if `worktreePath` is a direct child of `base`
 * whose leaf is `^\d+$`. The dispatcher's convention is one worktree per
 * issue at `<WORKTREES_BASE>/<N>` — anything else (different base, non-numeric
 * leaf, nested subdirectory) returns null.
 */
export function parseIssueNumberFromWorktree(worktreePath: string, base: string): number | null {
  const resolvedBase = pathResolve(base);
  const resolvedWt = pathResolve(worktreePath);
  if (dirname(resolvedWt) !== resolvedBase) return null;
  const leaf = basename(resolvedWt);
  if (!/^\d+$/.test(leaf)) return null;
  return parseInt(leaf, 10);
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
    let newest = files[0]!;
    for (const f of files) {
      if (f.mtimeMs > newest.mtimeMs) newest = f;
    }
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
      lastSummary: truncated == null || truncated.length === 0 ? null : truncated,
      prUrl: pr?.prUrl ?? null,
    });
  }

  return records
    .filter((r) => r.status !== 'stale')
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0));
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
 * Human-readable table for `yarn eng:loop sessions` (default mode). Columns:
 * `ISSUE`, `STATUS`, `PID`, `LAST ACTIVITY`, `SUMMARY`. The worktree and
 * transcript paths are intentionally omitted — they live in `--json` for
 * scripting, but the human-eyed table optimises for "what's running and what
 * did it last say". Summary column is clamped to fit terminal width.
 */
export function renderTable(records: SessionRecord[]): string {
  const headers = ['ISSUE', 'STATUS', 'PID', 'LAST ACTIVITY', 'SUMMARY'];

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
    r.lastActivity,
    r.lastSummary ?? '(no assistant text)',
  ]);

  // Column widths: max(header, max(data)) for the first four; summary is
  // clamped below to fit the terminal.
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));

  // Summary clamping: budget = min(80, terminalWidth - sum(otherCols+gaps)).
  const terminalWidth = (process.stdout as { columns?: number }).columns ?? 120;
  const prefixWidth = widths.slice(0, 4).reduce((a, b) => a + b + 2, 0); // 2-space gutter per column
  const summaryBudget = Math.max(20, Math.min(80, terminalWidth - prefixWidth));
  widths[4] = Math.min(widths[4]!, summaryBudget);

  const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));

  const renderRow = (cells: string[]): string =>
    cells.map((c, i) => (i === 4 ? pad(truncate(c, widths[i]!), widths[i]!) : pad(c, widths[i]!))).join('  ');

  const out: string[] = [];
  out.push(renderRow(headers));
  for (const row of rows) out.push(renderRow(row));
  return out.join('\n');
}
