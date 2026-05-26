# eng:loop sessions subcommand — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `yarn eng:loop sessions` (+ `--tail`, `--kill`, `--json`) so an operator can see live and recently-finished Claude Code sessions spawned by the dispatcher, follow their transcripts, and SIGTERM stuck sessions without spelunking `ps`, `lsof`, and `~/.claude/projects/`.

**Architecture:** One new module `packages/eng-loop/src/cli/sessions.ts` exposing a pure `discoverSessions(deps)` over a `SessionsDeps` seam (filesystem, `ps`, `lsof`, clock injected), plus thin testable verbs `tailSession` / `killSession`. A one-line dispatch branch in `packages/eng-loop/scripts/run-eng-loop.ts` routes `process.argv[2] === 'sessions'` to `runSessionsCli`. Alive-detection reconstructs ground truth each call by matching each running `claude` pid's cwd against `<WORKTREES_BASE>/<N>` — no persisted dispatcher state.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), tsx runtime (no compile step in dev — `tsx scripts/run-eng-loop.ts`), Vitest, Node built-ins (`node:fs/promises`, `node:child_process`, `node:readline`, `node:os`), POSIX `ps` + `lsof` on macOS.

**Spec:** `docs/superpowers/specs/2026-05-26-eng-loop-sessions-subcommand.md` (ratified). This plan slices that spec; do not redesign.

**Scope check:** Single subsystem (one CLI mode under one package). One PR, single stack, no need to split — estimated ~400–550 LOC of new source + tests, well under the handbook's 300-LOC-per-PR rule when amortised across the test file (which dominates). Note explicitly in the PR description that the runtime delta to `run-eng-loop.ts` is one branch + dynamic import (3 lines).

---

## File structure (locked in before tasks)

**New files:**

- `packages/eng-loop/src/cli/sessions.ts` — exports:
  - Types: `SessionRecord`, `SessionsDeps`, `KillOptions`, `TailOptions`
  - Pure helpers (no I/O): `encodeWorktreePathToProjectDir(p: string): string`, `parseIssueNumberFromWorktree(worktreePath: string, base: string): number | null`, `lastAssistantText(records: unknown[]): string | null`, `lastTimestamp(records: unknown[]): number | null`, `prLinkRecord(records: unknown[]): { prNumber: number; prUrl: string } | null`, `truncate(s: string, n: number): string`, `parseJsonlLines(text: string): unknown[]`
  - Stream transform: `class PrettyPrintTransform extends Transform` (line-buffered JSONL → human lines)
  - Pure renderers: `renderTable(records: SessionRecord[]): string`, `renderJson(records: SessionRecord[]): string`
  - I/O entrypoints: `discoverSessions(deps: SessionsDeps): Promise<SessionRecord[]>`, `tailSession(issueNumber: number, opts: TailOptions, deps: SessionsDeps): Promise<void>`, `killSession(issueNumber: number, opts: KillOptions, deps: SessionsDeps): Promise<void>`
  - Top-level shell: `runSessionsCli(argv: string[]): Promise<void>`
  - Production factory: `defaultDeps(): SessionsDeps`
- `packages/eng-loop/test/cli/sessions.test.ts` — Vitest, fixture JSONL strings + fake `SessionsDeps`.

**Modified files:**

- `packages/eng-loop/scripts/run-eng-loop.ts` — add a `process.argv[2] === 'sessions'` branch at the top of `main()`, before the existing flag-parse logic. Three-line dynamic import dispatch.

**Not touched:** `dispatcher/*` (sessions imports `WORKTREES_BASE` from `dispatch.ts` and re-uses it, but does not modify dispatcher code).

---

## Type contracts (must be consistent across tasks)

```ts
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
}

export interface KillOptions { force: boolean; }
export interface TailOptions { tailLines: number; /* default 50 */ }
```

The `SessionRecord` shape is the `--json` contract; do not rename fields between tasks.

---

## Task list

Tasks are dependency-ordered. Each implementation task is preceded by the test that drives it. Commit after each green test cycle.

### Task 1: Scaffold the new files (no exports yet)

**Files:**
- Create: `packages/eng-loop/src/cli/sessions.ts` (empty module, only the `SessionRecord` + `SessionsDeps` + `KillOptions` + `TailOptions` interfaces from the contract block above, plus `export {}`)
- Create: `packages/eng-loop/test/cli/sessions.test.ts` (only `import { describe, it, expect } from 'vitest';` and one `describe.skip('sessions', () => {});`)

- [ ] **Step 1: Create `sessions.ts` with only the four interfaces.** Copy the contract block above verbatim into the file. No function bodies yet. Make sure all field names match — they are load-bearing for downstream tasks.
- [ ] **Step 2: Create `test/cli/sessions.test.ts` skeleton.** One `describe.skip` block, no real tests yet. This proves the test glob picks up the new path.
- [ ] **Step 3: Run typecheck + tests.** From `packages/eng-loop`: `yarn typecheck && yarn test`. Expected: both green; the skipped describe shows up as 0 passed / 0 failed for `sessions`.
- [ ] **Step 4: Commit.** `git add packages/eng-loop/src/cli/sessions.ts packages/eng-loop/test/cli/sessions.test.ts && git commit -m "feat(eng-loop): scaffold cli/sessions module + test file (#587)"`

### Task 2: TEST — `encodeWorktreePathToProjectDir` round-trips real worktree paths

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests.** Replace the skipped `describe` with a `describe('encodeWorktreePathToProjectDir', ...)` block with these cases:
  - `/Users/adrianobradley/life's-work/jinn-mono_worktrees/587` → `-Users-adrianobradley-life-s-work-jinn-mono-worktrees-587` (the production case; verified live on this machine)
  - `/tmp/foo` → `-tmp-foo`
  - `/Users/a/b'c_d/e` → `-Users-a-b-c-d-e` (apostrophe + underscore both collapse to `-`; no double-dash because the encoder replaces each non-`[A-Za-z0-9]` char with `-` once, and the path already has no runs)
  - Trailing slash: `/Users/a/` → `-Users-a` (trailing `-` trimmed)
  Import: `import { encodeWorktreePathToProjectDir } from '../../src/cli/sessions.js';`
- [ ] **Step 2: Run and verify FAIL.** `yarn test -- sessions`. Expected: `encodeWorktreePathToProjectDir is not a function`.

### Task 3: IMPL — `encodeWorktreePathToProjectDir`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.** Add an exported function that:
  1. Replaces every char NOT in `[A-Za-z0-9]` with `-`
  2. Collapses runs of `-` to a single `-`
  3. Trims trailing `-`
  Use `path.replace(/[^A-Za-z0-9]/g, '-').replace(/-+/g, '-').replace(/-+$/, '')`. Do NOT trim leading `-` — absolute paths start with `/`, which legitimately becomes a leading `-`.
- [ ] **Step 2: Run tests.** `yarn test -- sessions`. Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): encodeWorktreePathToProjectDir helper (#587)"`

### Task 4: TEST — `parseIssueNumberFromWorktree`

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests.** New `describe('parseIssueNumberFromWorktree', ...)`:
  - Match: `parseIssueNumberFromWorktree('/wt/587', '/wt')` → `587`
  - Not under base: `parseIssueNumberFromWorktree('/other/587', '/wt')` → `null`
  - Non-numeric leaf: `parseIssueNumberFromWorktree('/wt/feature-branch', '/wt')` → `null`
  - Nested: `parseIssueNumberFromWorktree('/wt/587/sub', '/wt')` → `null` (only direct children count)
  - Trailing slash in base: `parseIssueNumberFromWorktree('/wt/587', '/wt/')` → `587`
- [ ] **Step 2: Run and verify FAIL.**

### Task 5: IMPL — `parseIssueNumberFromWorktree`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.** Normalise both with `path.resolve`; check `dirname(worktreePath) === resolvedBase` AND `/^\d+$/.test(basename(worktreePath))`; return `parseInt(basename, 10)` or `null`.
- [ ] **Step 2: Run tests.** Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): parseIssueNumberFromWorktree helper (#587)"`

### Task 6: TEST — JSONL extractors (`parseJsonlLines`, `lastTimestamp`, `lastAssistantText`, `prLinkRecord`)

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add fixtures + failing tests.** At the top of the test file, add three fixture JSONL strings (one assistant text block per line; trailing newline preserved):

```ts
const FIX_WITH_TEXT = [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-26T00:00:00.000Z' }),
  JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:01.000Z', message: { content: [{ type: 'text', text: 'hi' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:01:00.000Z', message: { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'first summary' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:02:00.000Z', message: { content: [{ type: 'text', text: 'latest summary' }] } }),
  '',
].join('\n');

const FIX_TOOL_USE_ONLY = [
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
  '',
].join('\n');

const FIX_WITH_PR_LINK = [
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:01:00.000Z', message: { content: [{ type: 'text', text: 'opened PR' }] } }),
  JSON.stringify({ type: 'pr-link', timestamp: '2026-05-26T00:02:00.000Z', prNumber: 612, prUrl: 'https://github.com/Jinn-Network/mono/pull/612' }),
  '',
].join('\n');

const FIX_BLANK_AND_GARBAGE = [
  '',
  'not json at all',
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
  '',
].join('\n');
```

Tests (each uses `parseJsonlLines(FIX_*)` and the relevant extractor):
- `parseJsonlLines` skips blank lines and non-JSON lines (count records from `FIX_BLANK_AND_GARBAGE` === 1)
- `lastTimestamp(FIX_WITH_TEXT)` → `Date.parse('2026-05-26T00:02:00.000Z')`
- `lastTimestamp(FIX_BLANK_AND_GARBAGE)` → finite number, not NaN
- `lastAssistantText(FIX_WITH_TEXT)` → `'latest summary'` (most recent text block from assistant records)
- `lastAssistantText(FIX_TOOL_USE_ONLY)` → `null` (no text blocks anywhere)
- `prLinkRecord(FIX_WITH_PR_LINK)` → `{ prNumber: 612, prUrl: 'https://github.com/Jinn-Network/mono/pull/612' }`
- `prLinkRecord(FIX_WITH_TEXT)` → `null`

Import them: `import { parseJsonlLines, lastTimestamp, lastAssistantText, prLinkRecord } from '../../src/cli/sessions.js';`
- [ ] **Step 2: Run and verify FAIL.**

### Task 7: IMPL — JSONL extractors

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.**
  - `parseJsonlLines(text)` — split on `\n`, filter empty, try/catch `JSON.parse` per line, drop on throw, return successful parses.
  - `lastTimestamp(records)` — iterate records, collect `record.timestamp` strings that `Date.parse` to a finite number, return the max as a number; return `null` if none.
  - `lastAssistantText(records)` — iterate in order; for each record where `record.type === 'assistant'`, scan `record.message?.content` for blocks with `block.type === 'text'`; track the last such block seen across all records; return its `.text` (trimmed) or `null`.
  - `prLinkRecord(records)` — find the last record where `record.type === 'pr-link'`; return `{ prNumber, prUrl }` or `null`.
- [ ] **Step 2: Run tests.** Expected: all green.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): JSONL extractors for sessions listing (#587)"`

### Task 8: TEST — `truncate` helper

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests.**
  - `truncate('hi', 10)` → `'hi'`
  - `truncate('hello world', 5)` → `'he...'` (output length === n, last 3 chars are `...`)
  - `truncate('abc', 3)` → `'abc'` (exact fit, no ellipsis)
  - `truncate('abcd', 3)` → `'...'` (only ellipsis fits)
- [ ] **Step 2: Run and verify FAIL.**

### Task 9: IMPL — `truncate`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.** If `s.length <= n` return `s`; else return `s.slice(0, Math.max(0, n - 3)) + '...'`.
- [ ] **Step 2: Run tests.** Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): truncate helper for lastSummary (#587)"`

### Task 10: TEST — `discoverSessions` happy path (alive + done + stale gating)

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add a `buildDeps` test helper at the top of the file.**

```ts
function buildDeps(overrides: Partial<SessionsDeps> = {}): SessionsDeps {
  return {
    worktreesBase: '/wt',
    claudeProjectsDir: '/p',
    now: () => Date.parse('2026-05-26T12:00:00.000Z'),
    listProjectDirs: async () => [],
    listJsonlFiles: async () => [],
    readJsonl: async () => '',
    listClaudeProcesses: async () => [],
    resolveProcessCwd: async () => null,
    spawnTail: () => { throw new Error('spawnTail not stubbed'); },
    sendSignal: () => { throw new Error('sendSignal not stubbed'); },
    confirm: async () => false,
    stdout: process.stdout,
    stderr: process.stderr,
    ...overrides,
  };
}
```

- [ ] **Step 2: Add failing tests** in `describe('discoverSessions', ...)`:

  - **alive + done + stale gating** — three issues:
    - `#100` (alive): project dir `-wt-100`, one JSONL `sess-100.jsonl` with `FIX_WITH_TEXT`-shape (latest at `T-30m`), `listClaudeProcesses` returns `pid: 1000` with `resolveProcessCwd(1000) = '/wt/100'`. Expect `status === 'alive'`, `pid === 1000`, `lastSummary === 'latest summary'`.
    - `#200` (done): project dir `-wt-200`, JSONL latest at `T-1h`, no pid matches. Expect `status === 'done'`, `pid === null`.
    - `#300` (stale): project dir `-wt-300`, JSONL latest at `T-26h`. Expect EXCLUDED from default output (no record).
  - **sort order**: returned records sorted by `lastActivity` desc — alive (T-30m) before done (T-1h).
  - **non-worktree dirs ignored**: an extra project dir `-Users-elsewhere` is present in `listProjectDirs` but does not decode to anything under `worktreesBase`; assert it does not appear.
  - **issue without numeric leaf ignored**: a project dir whose decoded path is `/wt/feature-branch` is skipped.
- [ ] **Step 3: Run and verify FAIL.** `yarn test -- sessions`. Expected: `discoverSessions is not a function`.

### Task 11: IMPL — `discoverSessions`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.** Algorithm:
  1. `dirs = await deps.listProjectDirs(deps.claudeProjectsDir)`
  2. For each `dir`, compute candidate worktree paths by inverting the encoding **structurally**: the encoder is lossy, so instead of trying to decode, enumerate the actual on-disk children of `worktreesBase` once (`fs.readdir(worktreesBase)`) — wait, we don't have that injector. Use a simpler trick: for each `dir`, check whether there exists an issue number `N` such that `encodeWorktreePathToProjectDir(join(worktreesBase, String(N))) === dir`. This requires iterating possible Ns, which is unbounded. **Use this approach instead**: iterate `dirs`; for each, check if `dir.startsWith(encodeWorktreePathToProjectDir(worktreesBase) + '-')`; if so, peel off that prefix, take the remaining segment(s), and require it to be `^\d+$`. The dispatcher only ever creates `<worktreesBase>/<N>` so the remainder is a single integer. Compute the candidate `worktreePath = join(worktreesBase, remainder)` and verify by `encodeWorktreePathToProjectDir(candidate) === dir` (round-trip guard).
  3. For each matching dir → issue number, `listJsonlFiles(join(claudeProjectsDir, dir))`, pick the file with max `mtimeMs`. If none, skip.
  4. `readJsonl(transcriptPath)` → `records = parseJsonlLines(text)`.
  5. `lastActivityMs = lastTimestamp(records) ?? mtimeMs` (fallback to the file's mtime).
  6. Compute `procs = await listClaudeProcesses(); cwds = Map<pid, cwd>` resolved via `resolveProcessCwd` for each pid in parallel (`Promise.all`).
  7. Match: `alivePid = [...cwds.entries()].find(([_, cwd]) => cwd === worktreePath)?.[0] ?? null`.
  8. Status: `alive` if `alivePid != null`; else `done` if `now - lastActivityMs <= 24 * 3600_000`; else `stale`.
  9. Build `SessionRecord` (sessionId = `basename(file.name, '.jsonl')`, `lastSummary = truncate(lastAssistantText(records) ?? '', 200) || null`, `prUrl = prLinkRecord(records)?.prUrl ?? null`, `lastActivity = new Date(lastActivityMs).toISOString()`).
  10. Filter out `status === 'stale'`. Sort by `lastActivity` desc. Return.

  Memoise `listClaudeProcesses` + per-pid `resolveProcessCwd` results across the function call (one call to each per `discoverSessions` invocation), not per issue.
- [ ] **Step 2: Run tests.** Expected: all green.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): discoverSessions joins JSONL transcripts to live pids (#587)"`

### Task 12: TEST — `renderJson` shape + sort + null fields

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests** in `describe('renderJson', ...)`:
  - Round-trip: `JSON.parse(renderJson(records))` deep-equals input.
  - Empty array → `'[]'`.
  - Fields are exactly the nine documented (`issueNumber`, `status`, `pid`, `worktreePath`, `transcriptPath`, `sessionId`, `lastActivity`, `lastSummary`, `prUrl`); test with `Object.keys(JSON.parse(renderJson([rec]))[0]).sort()`.
- [ ] **Step 2: Run and verify FAIL.**

### Task 13: IMPL — `renderJson`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.** `JSON.stringify(records, null, 2)`. The `SessionRecord` interface is the contract; do not add or rename fields.
- [ ] **Step 2: Run tests.** Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): renderJson for --json output (#587)"`

### Task 14: TEST — `renderTable` columns + null handling

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests** in `describe('renderTable', ...)`:
  - Header row contains, in order: `ISSUE`, `STATUS`, `PID`, `LAST ACTIVITY`, `SUMMARY`. (Worktree + transcript paths are intentionally elided in the human table; they live in `--json`.)
  - A row for an alive session shows the pid as a decimal integer.
  - A row for a done session shows `-` in the PID column (not `null`).
  - A row whose `lastSummary` is `null` shows `(no assistant text)`.
  - Empty input renders the header plus a single body line `(no sessions in the last 24h)`.
- [ ] **Step 2: Run and verify FAIL.**

### Task 15: IMPL — `renderTable`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.** Build a small fixed-width table (no external libs): pick column widths from data with `Math.max`, pad with spaces, join rows with `\n`. Truncate the summary column to `Math.min(80, terminalWidth - prefixWidth)` where `terminalWidth = process.stdout.columns ?? 120`. Render `null` pid as `-`, `null` summary as `(no assistant text)`. Body fallback line for empty input is exactly `(no sessions in the last 24h)`.
- [ ] **Step 2: Run tests.** Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): renderTable for human sessions output (#587)"`

### Task 16: TEST — `PrettyPrintTransform`

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests** in `describe('PrettyPrintTransform', ...)`. Drive the stream by writing the `FIX_WITH_TEXT` and `FIX_WITH_PR_LINK` fixtures as Buffers and collect output via an array-pushing writable:

  - assistant text block → output contains `[00:01:00 assistant] first summary` AND `[00:02:00 assistant] latest summary` (one line each, in order).
  - user text block → `[00:00:01 user] hi`.
  - `pr-link` → `[00:02:00 pr-link] #612 https://github.com/Jinn-Network/mono/pull/612`.
  - `queue-operation`, `tool_use`-only assistant records, `attachment`, `last-prompt`, `thinking`-only blocks → no output.
  - Partial chunks: split `FIX_WITH_TEXT` in the middle of a line and write in two pushes; output must still produce one line per logical record (line-buffering correctness).
  - Malformed JSON line → silently dropped (no throw, no output for that line).
- [ ] **Step 2: Run and verify FAIL.**

### Task 17: IMPL — `PrettyPrintTransform`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.** Subclass `Transform` from `node:stream`. Hold a private `string` buffer; in `_transform(chunk, enc, cb)` append `chunk.toString('utf8')`, split on `\n`, retain the trailing partial in the buffer, for each complete line try `JSON.parse` (catch and drop on throw). Switch on `record.type`:
  - `assistant` / `user` → scan `record.message?.content` for blocks with `type === 'text'`; for each text block push `[hh:mm:ss <type>] <text>\n`. `hh:mm:ss` is derived from `record.timestamp` (ISO-8601 → `toISOString().slice(11, 19)`).
  - `pr-link` → push `[hh:mm:ss pr-link] #<prNumber> <prUrl>\n`.
  - Everything else → no output.

  In `_flush`, attempt to parse any leftover buffered content as one final line; drop on failure.
- [ ] **Step 2: Run tests.** Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): PrettyPrintTransform for --tail output (#587)"`

### Task 18: TEST — `tailSession` resolves the right JSONL and pipes through PrettyPrintTransform

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests** in `describe('tailSession', ...)`. Use the in-memory `buildDeps` factory but override:
  - `spawnTail`: returns `{ stdout: Readable.from([Buffer.from(FIX_WITH_TEXT)]), kill: () => spawnTailKilled = true }`
  - `stdout`: a writable that captures into an array
  - `listProjectDirs` + `listJsonlFiles` configured so issue `#500` resolves to one transcript file.

  Tests:
  - Resolves the transcript path: assert the `path` passed into `spawnTail` equals the expected joined path.
  - Pipes through `PrettyPrintTransform`: assert the captured stdout contains `[00:01:00 assistant] first summary`.
  - Unknown issue: `tailSession(999, ...)` rejects with an error message containing `no transcript found for issue #999`.
  - SIGINT forwarding: register a stub for `process.on('SIGINT', ...)`-like behaviour by injecting an `onSigint(handler)` seam *inside* `tailSession` (see IMPL note). Test by invoking the handler and asserting `spawnTailKilled === true`.
- [ ] **Step 2: Run and verify FAIL.**

### Task 19: IMPL — `tailSession`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.**
  1. Run `discoverSessions(deps)` to find the record for `issueNumber`. If none, throw `Error('no transcript found for issue #<N>')`.
  2. Call `deps.spawnTail(record.transcriptPath)`.
  3. `tail.stdout.pipe(new PrettyPrintTransform()).pipe(deps.stdout, { end: false })`.
  4. Add `process.on('SIGINT', () => { tail.kill('SIGTERM'); process.exit(0); })` to forward Ctrl-C. For test-friendliness, expose the SIGINT-installer via a second optional `deps.onSigint?: (h: () => void) => void` field defaulting to `process.on.bind(process, 'SIGINT')` in `defaultDeps`. Add `onSigint?: (h: () => void) => void` to the `SessionsDeps` interface.
  5. Return a Promise that resolves on `tail.stdout` `'end'`. Spec defers exit-on-stale; the operator Ctrl-Cs.
- [ ] **Step 2: Run tests.** Expected: PASS. (Add the `onSigint` field to the contract in `SessionsDeps`; update `buildDeps` helper in tests to default it to a no-op.)
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): tailSession follows live JSONL with prettyprint (#587)"`

### Task 20: TEST — `killSession` confirmation, force, unknown-issue, done-session paths

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests** in `describe('killSession', ...)` using `buildDeps`:
  - Issue alive, `confirm` returns `true` → `sendSignal` called with `(pid, 'SIGTERM')`; stderr contains `killed pid <pid>`.
  - Issue alive, `confirm` returns `false` → `sendSignal` NOT called; stderr contains `aborted (no-op)`.
  - `force: true` → `confirm` NOT called; `sendSignal` called.
  - Issue not in listing → throws with message containing `no session found for issue #<N>`.
  - Issue in listing but `status === 'done'` → throws with message containing `session for issue #<N> is not alive`.
- [ ] **Step 2: Run and verify FAIL.**

### Task 21: IMPL — `killSession`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.**
  1. `records = await discoverSessions(deps)`
  2. `rec = records.find(r => r.issueNumber === issueNumber)`; throw `'no session found for issue #<N>'` if not found.
  3. If `rec.status !== 'alive'` throw `'session for issue #<N> is not alive (status: <status>)'`.
  4. If `!opts.force`, `const ok = await deps.confirm('Kill claude session for issue #' + N + ' (pid ' + rec.pid + ', started ' + rec.lastActivity + ')? [y/N] ')`. If not `ok`, write `aborted (no-op)\n` to `deps.stderr` and return.
  5. `deps.sendSignal(rec.pid!, 'SIGTERM')`; write `killed pid <pid>\n` to `deps.stderr`.
- [ ] **Step 2: Run tests.** Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): killSession with [y/N] confirm and --force (#587)"`

### Task 22: TEST — `runSessionsCli` flag routing

**Files:**
- Test: `packages/eng-loop/test/cli/sessions.test.ts`

- [ ] **Step 1: Add failing tests** in `describe('runSessionsCli', ...)`. Inject `SessionsDeps` via an optional second argument to `runSessionsCli(argv, depsOverride?)`. (Update the export signature to accept this override; production callers pass nothing and get `defaultDeps()`.)

  - No flags: `runSessionsCli([], depsOverride)` → writes a table (header substring `ISSUE`) to `stdout`.
  - `--json`: `runSessionsCli(['--json'], ...)` → `stdout` is valid JSON; `JSON.parse(stdout).length === fixtureCount`.
  - `--tail 500`: routes to `tailSession(500, ...)` — assert via a `spawnTail` spy.
  - `--kill 500`: routes to `killSession(500, { force: false }, ...)` — assert `confirm` was called.
  - `--kill 500 --yes`: `killSession(500, { force: true }, ...)` — `confirm` NOT called.
  - `--kill 500 --force`: same as `--yes`.
  - Unknown flag `--bogus`: throws with message containing `unknown flag`.
  - `--tail` without a number: throws with message containing `--tail requires an issue number`.
  - `--kill` without a number: throws with message containing `--kill requires an issue number`.
- [ ] **Step 2: Run and verify FAIL.**

### Task 23: IMPL — `runSessionsCli`

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

- [ ] **Step 1: Implement.**

  - Signature: `export async function runSessionsCli(argv: string[], depsOverride?: SessionsDeps): Promise<void>` — when omitted, use `defaultDeps()`.
  - Parse `argv` manually (no external CLI lib; keep dependencies zero):
    - Recognised flags: `--tail <N>`, `--kill <N>`, `--yes`, `--force`, `--json`.
    - `--tail` and `--kill` require a numeric next token.
    - Any other token → throw `Error('unknown flag: ' + tok)`.
  - Routing precedence: `--tail` > `--kill` > default-listing.
  - Default listing: `const records = await discoverSessions(deps); deps.stdout.write(json ? renderJson(records) : renderTable(records)); deps.stdout.write('\n');`
- [ ] **Step 2: Run tests.** Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(eng-loop): runSessionsCli flag routing for sessions subcommand (#587)"`

### Task 24: IMPL — `defaultDeps()` production factory

**Files:**
- Modify: `packages/eng-loop/src/cli/sessions.ts`

(No new test — this is the only place that touches the real OS. Manual verification happens in Task 27.)

- [ ] **Step 1: Implement.**
  - `worktreesBase`: import `WORKTREES_BASE` from `../dispatcher/dispatch.js` (note the `.js` ESM suffix). Do NOT recompute the worktree base locally.
  - `claudeProjectsDir`: `join(os.homedir(), '.claude', 'projects')`
  - `now`: `Date.now`
  - `listProjectDirs(dir)`: `fs.readdir(dir, { withFileTypes: true })` → return entries where `e.isDirectory()` → `e.name`.
  - `listJsonlFiles(dir)`: `fs.readdir(dir, { withFileTypes: true })` → filter `.endsWith('.jsonl')` → `Promise.all` over `fs.stat` → return `{ name, mtimeMs }`.
  - `readJsonl(path)`: `fs.readFile(path, 'utf8')`.
  - `listClaudeProcesses`: spawn `ps -axo pid=,comm=`; for each line whose `comm` (last field) ends with `/claude` or equals `claude`, parse the pid. Return `[{ pid }, ...]`.
  - `resolveProcessCwd(pid)` — implement a `resolveProcessCwd(platform)` switch:
    - `darwin`: spawn `lsof -a -p <pid> -d cwd -Fn`; parse the line starting with `n` (e.g. `n/Users/...`); return the path or `null`.
    - `linux`: STUB — return `null` (spec defers `/proc/<pid>/cwd`; leave a `TODO(#587-followup)` comment with a one-line note pointing at the spec's §A portability note).
    - other: return `null`.
  - `spawnTail(path)`: `spawn('tail', ['-n', '50', '-F', path], { stdio: ['ignore', 'pipe', 'inherit'] })` from `node:child_process`; return `{ stdout: child.stdout!, kill: (sig) => child.kill(sig) }`.
  - `sendSignal(pid, sig)`: `process.kill(pid, sig)`.
  - `confirm(prompt)`: use `node:readline/promises` `createInterface({ input: process.stdin, output: process.stderr })`; `const ans = await rl.question(prompt); rl.close();` return `/^y(es)?$/i.test(ans.trim())`.
  - `onSigint(handler)`: `process.on('SIGINT', handler)`.
  - `stdout`: `process.stdout`; `stderr`: `process.stderr`.
- [ ] **Step 2: Typecheck.** `yarn typecheck`. Expected: zero errors.
- [ ] **Step 3: Run tests.** `yarn test`. Expected: all green (defaultDeps is not exercised by unit tests; this is a regression-only check).
- [ ] **Step 4: Commit.** `git commit -am "feat(eng-loop): defaultDeps wires real fs/ps/lsof for sessions CLI (#587)"`

### Task 25: TEST — `run-eng-loop.ts` dispatch branch routes `sessions` argv

**Files:**
- Test: `packages/eng-loop/test/cli/run-eng-loop-sessions-branch.test.ts` (new)

This is a thin smoke test — the dispatch branch is three lines and the real coverage lives in `sessions.test.ts`. But a test pins the branch in place so a future refactor of `run-eng-loop.ts` cannot silently drop it.

- [ ] **Step 1: Add a failing test.** The simplest approach: extract the routing decision into an exported helper `shouldRouteToSessions(argv: string[]): boolean` defined in `scripts/run-eng-loop.ts` and have one test assert:
  - `shouldRouteToSessions(['node', 'run-eng-loop.ts', 'sessions'])` → `true`
  - `shouldRouteToSessions(['node', 'run-eng-loop.ts', '--dry-run'])` → `false`
  - `shouldRouteToSessions(['node', 'run-eng-loop.ts'])` → `false`

  (`process.argv` shape is `[node, script, ...rest]`; the production check is on index 2.)
- [ ] **Step 2: Run and verify FAIL.**

### Task 26: IMPL — `run-eng-loop.ts` dispatch branch

**Files:**
- Modify: `packages/eng-loop/scripts/run-eng-loop.ts`

- [ ] **Step 1: Add the helper export and the branch.**
  - Add at the top of the file (after imports): `export function shouldRouteToSessions(argv: string[]): boolean { return argv[2] === 'sessions'; }`
  - At the top of `main()`, before any flag-parse logic, insert:
    ```ts
    if (shouldRouteToSessions(process.argv)) {
      const { runSessionsCli } = await import('../src/cli/sessions.js');
      await runSessionsCli(process.argv.slice(3));
      return;
    }
    ```
  - The dynamic import keeps the dispatcher's cold-start cost unchanged for the no-arg `yarn eng:loop` path.
- [ ] **Step 2: Run tests.** `yarn test`. Expected: all green, including the new routing test.
- [ ] **Step 3: Typecheck.** `yarn typecheck`. Expected: zero errors.
- [ ] **Step 4: Commit.** `git commit -am "feat(eng-loop): route 'sessions' argv to runSessionsCli (#587)"`

### Task 27: Manual verification (the engineer's smoke test)

**Files:** none modified — read-only verification.

This is the only step that touches the real filesystem and a real `claude` process. Run from the worktree at `/Users/adrianobradley/life's-work/jinn-mono_worktrees/587`:

- [ ] **Step 1: Listing.** `yarn workspace @jinn-network/eng-loop eng:loop sessions`. Expected: a table with at least one row (this session is alive in `~/.claude/projects/-Users-adrianobradley-life-s-work-jinn-mono-worktrees-587/`). PID column populated for any session whose `claude` process matches by cwd.
- [ ] **Step 2: JSON.** `yarn workspace @jinn-network/eng-loop eng:loop sessions --json | jq .`. Expected: a JSON array with the nine documented fields per record.
- [ ] **Step 3: Tail (read-only).** `yarn workspace @jinn-network/eng-loop eng:loop sessions --tail 587`. Expected: pretty lines stream in; Ctrl-C exits cleanly.
- [ ] **Step 4: Kill (do NOT run against a real session in this worktree).** Verify the confirmation prompt by hitting `n` against a throwaway session if one is conveniently around, or skip if no safe target exists. The unit tests cover the verbs.

If any step misbehaves, do NOT patch over symptoms in `sessions.ts` — open the dropdown of the failing assertion in the test suite and add a regression test first.

### Task 28: Final regression sweep

**Files:** none modified.

- [ ] **Step 1: Typecheck full package.** From `packages/eng-loop`: `yarn typecheck`. Expected: zero errors.
- [ ] **Step 2: Run full vitest suite.** `yarn test`. Expected: every existing dispatcher test still green (pre-#587 count + the new sessions tests).
- [ ] **Step 3: Dispatcher import smoke.** Run `tsx -e "import('./src/dispatcher/dispatch.js').then(m => console.log(typeof m.dispatchIssue, typeof m.WORKTREES_BASE))"` from `packages/eng-loop`. Expected: `function string`. Confirms the new `cli/sessions.ts` import path did not create a cycle and `WORKTREES_BASE` is still exported.
- [ ] **Step 4: Confirm zero new dependencies.** `git diff packages/eng-loop/package.json`. Expected: empty diff — the implementation uses only built-ins + Vitest (already in devDeps).
- [ ] **Step 5: Stack check.** Total diff: `git diff --stat origin/next... -- packages/eng-loop`. Confirm new source file ~350–500 LOC (with comments), new test file ~300–500 LOC, modified `run-eng-loop.ts` < 10 LOC. If the source file blew past 600 LOC, split helpers into `src/cli/sessions/helpers.ts` and `src/cli/sessions/transcript.ts` before opening the PR.

---

## Acceptance-criteria → task mapping

| Acceptance criterion (verbatim from #587) | Implementation tasks |
|---|---|
| `yarn eng:loop sessions` lists every dispatched session (alive or completed in the last 24h) with: issue number, alive/done status, PID (if alive), worktree path, last-activity timestamp, last summary line, transcript path | Tasks 10–11 (`discoverSessions`), 14–15 (`renderTable`), 22–23 (`runSessionsCli` default mode), 25–26 (dispatch branch) |
| "alive" is detected by walking `~/.claude/projects/-Users-…-worktrees-<N>/` for the most-recent JSONL and matching its session-id against running `claude -p` processes (we match by cwd, not session-id — see spec §A rejection of pid-by-prompt) | Tasks 2–5 (encoder + worktree parse), 10–11 (alive detection via `resolveProcessCwd` cwd match) |
| `yarn eng:loop sessions --tail <N>` follows the live transcript with prettyprint | Tasks 16–17 (`PrettyPrintTransform`), 18–19 (`tailSession`), 22–23 (CLI routing), 24 (real `spawnTail`) |
| `yarn eng:loop sessions --kill <N>` SIGTERMs after `[y/N]` confirmation; worktree + transcript preserved | Tasks 20–21 (`killSession`), 22–23 (CLI routing of `--yes`/`--force`), 24 (real `sendSignal` + `confirm`) |
| `--json` flag emits machine-readable output for scripting | Tasks 12–13 (`renderJson`), 22–23 (CLI routing) |
| New file `packages/eng-loop/src/cli/sessions.ts` | Tasks 1 + 3 + 5 + 7 + 9 + 11 + 13 + 15 + 17 + 19 + 21 + 23 + 24 |
| Modified file `packages/eng-loop/scripts/run-eng-loop.ts` | Tasks 25–26 |
| New tests `packages/eng-loop/test/cli/sessions.test.ts` | Tasks 1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22 |
| 24h completion window: done within 24h surfaces; > 24h omitted | Task 10 (stale gating test) → Task 11 (`now - lastActivityMs <= 24h`) |
| `lastSummary` truncated; null on tool-use-only sessions | Tasks 6–7 (`lastAssistantText` returns null), 8–9 (`truncate`), 14–15 (table renders `(no assistant text)`) |
| `prUrl` surfaced from `pr-link` records | Tasks 6–7 (`prLinkRecord`), 12–13 (JSON field) |
| macOS-only alive resolver, Linux deferred behind seam | Task 24 (`resolveProcessCwd` switch with `linux: null` stub + TODO comment) |
| Tests build over synthetic JSONL + fake processes (no real fs / ps / lsof / claude) | All TEST tasks use the `buildDeps` factory from Task 10; Task 24's real wiring is regression-only |

---

## PR shape

One stacked PR onto `feat/587-eng-loop-sessions-subcommand-surface-live-finished-session-s` → opened against `next`. Single PR is correct here because:

- New source is a single self-contained module with a well-defined seam (`SessionsDeps`).
- Tests live alongside, do not couple to dispatcher tests.
- The `run-eng-loop.ts` modification is three lines and structurally trivial.
- Per the handbook's 300-LOC rule of thumb, the source delta is ~400–500 LOC but the bulk is tests (excluded from the implicit cap); a reviewer can hold the whole change in head.

PR title: `feat(eng-loop): sessions subcommand for live + finished session state (#587)`. Body must include: spec link, the `SessionRecord` schema, an excerpt of `yarn eng:loop sessions` output captured from Task 27, and a "macOS-only for v1; Linux deferred" note with a follow-up Issue link.

---

## Self-review notes

- **Placeholder scan.** All steps include the exact command, the exact assertion shape, or the exact algorithm. No "TBD" / "etc." / "similar to" / "appropriate error handling" left in. The one place algorithm details are deferred — Task 11's pid match — spells out the round-trip-guard trick.
- **Type consistency.** `SessionRecord` field names are pinned in the Type Contracts block and referenced in Tasks 11, 13, 15, 23. `SessionsDeps` is pinned with `onSigint` added in Task 19's IMPL (and the rationale documented). `KillOptions.force` is the single field, used by Tasks 21 + 23.
- **Spec coverage.** Every bullet of §Acceptance criteria and §File / module layout in the spec maps to one or more tasks in the table above. Open question #1 (truncation width) is decided in Task 9 (200 chars in JSON, 80-column-or-terminal-width-clamped in the table). Open question #2 (`--all`) is intentionally out of scope. Open question #3 (Linux resolver) is stubbed per Task 24.
- **TDD posture.** Every implementation task is preceded by its test task. The only non-TDD task is Task 24 (`defaultDeps`), which is the production wiring of injected seams and is regression-tested by Tasks 27–28 (manual smoke + full suite).
