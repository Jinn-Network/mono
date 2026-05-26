# eng:loop sessions subcommand — design

**Version:** 0.1 (proposed)
**Date:** 2026-05-26
**Author:** jinn-mono#587 implementer (Stage 1 design subagent)
**Status:** Proposed. Output of Stage 1 of the implement-issue pipeline for issue #587. Not yet ratified.

**Related:**
- Issue [#587](https://github.com/Jinn-Network/mono/issues/587) — *eng:loop sessions subcommand — surface live + finished session state with logs*
- `docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md` — autonomous engineering flow that this subcommand observes
- `packages/eng-loop/src/dispatcher/dispatch.ts` — the canonical worktree-base + branch convention this subcommand parses back out
- `packages/eng-loop/scripts/run-eng-loop.ts` — the existing CLI entrypoint this design extends

---

## Context

The dispatcher (`yarn eng:loop`) spawns `claude -p <prompt>` detached for each ready issue, with the worktree as cwd. Claude Code persists each session to `~/.claude/projects/<dir>/<sessionId>.jsonl` where `<dir>` is the absolute worktree path with `/` and `'` replaced by `-`. Today there is no surface that joins those two facts: operators have to run `ps`, hand-resolve the cwd-encoded directory, find the most-recent JSONL, and `jq` it. After a dispatcher restart this is the only way to know which sessions are still grinding, which finished, and which need cleanup.

Observed today (2026-05-25): #561's session ran for 16 minutes after its implementation phase ended (doing simplify + review + security + verify); the only way to inspect that work was the manual chain above. The session transcripts are already captured — they just aren't surfaced.

## Acceptance criteria

Verbatim from #587:

- `yarn eng:loop sessions` lists every dispatched session (alive or completed in the last 24h) with: issue number, alive/done status, PID (if alive), worktree path, last-activity timestamp, last summary line (text of the most recent assistant text block, truncated), transcript path.
- "alive" is detected by walking `~/.claude/projects/-Users-…-worktrees-<N>/` for the most-recent JSONL and matching its session-id against running `claude -p` processes.
- `yarn eng:loop sessions --tail <N>` follows the live transcript of the session for issue `<N>` (equivalent to `tail -F` on its JSONL with prettyprint).
- `yarn eng:loop sessions --kill <N>` SIGTERMs the session subprocess for issue `<N>` after a `[y/N]` confirmation; worktree + transcript preserved.
- A `--json` flag emits machine-readable output for scripting.

## Approach

### A. Alive-detection — cwd-matching, macOS-only first

For each JSONL under `~/.claude/projects/<dir>/` that decodes to a worktree path of shape `<worktrees-base>/<N>`, parse the issue number `<N>`. Then list running `claude` processes (`ps -axo pid,comm,args`), and for each pid resolve its cwd via `lsof -a -p <pid> -d cwd -Fn` (macOS). Match cwd against `<worktrees-base>/<N>` — if a pid's cwd equals the worktree path, that issue is **alive** and its pid is the matched pid. The session-id is the JSONL filename's stem; we surface it for the `--json` consumer but don't need it for alive-detection because cwd uniquely identifies the dispatcher-spawned session (the dispatcher creates exactly one worktree per issue).

Portability note: production operator machines run macOS today (`darwin`), so we ship a macOS resolver (`lsof -Fn`) and gate the implementation on `process.platform === 'darwin'`. A Linux resolver (`readlink /proc/<pid>/cwd`) is a one-function extension; we leave a `resolveProcessCwd(platform)` seam so it lands as a follow-up rather than a refactor. Windows is out of scope (no operator runs the dispatcher there).

### B. 24h completion window

A JSONL whose dir decodes to a known worktree path but whose owning pid is no longer alive is **done** if its newest record's timestamp (or its `mtime` as a fallback when no timestamped records exist) is within `Date.now() - 24h`; otherwise it is **stale** and omitted from default output. The 24h floor is the issue's stated window, applied to last-activity, not start-time — a session that finished 23h ago still surfaces; one that finished 25h ago does not. `--all` is reserved for a follow-up if operators want to lift the cap.

### C. `--tail <N>` — spawn `tail -F`, prettyprint via stdin pipe

Resolve the most-recent JSONL for issue `<N>` from the worktree-path-encoded dir. Spawn `tail -n 50 -F <path>` as a subprocess and pipe its stdout through a line-buffered formatter that JSON-parses each line and renders one of three forms:

- `assistant` text blocks → `[hh:mm:ss assistant] <text>` (wrap-trimmed at terminal width)
- `user` text blocks → `[hh:mm:ss user] <text>`
- `pr-link` records → `[hh:mm:ss pr-link] #<prNumber> <prUrl>`

All other record types (`queue-operation`, `attachment`, `last-prompt`, tool-use payloads) are skipped at default verbosity. Forwarding `SIGINT` to the `tail` subprocess gives the operator the expected Ctrl-C exit. We pick `tail -F` over `fs.watch` + position-tracking because `tail -F` is universally available on macOS/Linux, handles JSONL rotation/truncation correctly, and is one fewer state machine to test. The pretty-printer is a pure stream transform (`Transform` subclass) that's trivially unit-testable on fixed input.

### D. `--kill <N>` confirmation

Resolve the pid via the same cwd-match used by the listing path. Print:

```
Kill claude session for issue #<N> (pid <pid>, started <ts>)? [y/N]
```

Read a line from stdin via `readline`; accept `y`/`Y`/`yes`. Anything else aborts with `aborted (no-op)`. `--yes` (or `--force`) skips the prompt — standard CLI idiom, useful for scripts. On confirm, send `SIGTERM` (not `SIGKILL`) so the session subprocess shuts down cleanly. The worktree and transcript are preserved; the operator can re-dispatch via `gh project item-edit` or re-trigger the dispatcher.

### E. `--json` schema

```ts
interface SessionRecord {
  issueNumber: number;
  status: 'alive' | 'done' | 'stale';   // stale omitted unless --all
  pid: number | null;                   // null when status !== 'alive'
  worktreePath: string;
  transcriptPath: string;                // absolute path to the JSONL
  sessionId: string;                     // JSONL filename stem
  lastActivity: string;                  // ISO-8601
  lastSummary: string | null;            // truncated to 200 chars, null if no assistant text seen
  prUrl: string | null;                  // from pr-link record if present
}
```

`yarn eng:loop sessions --json` emits `SessionRecord[]` sorted by `lastActivity` descending. Schema is documented inline in the CLI source's JSDoc — the JSON shape is the contract for downstream scripts.

### F. CLI routing — extend the existing entrypoint

`scripts/run-eng-loop.ts` already owns all `yarn eng:loop ...` invocations. We dispatch on `process.argv[2] === 'sessions'` before the existing flag-parse logic and delegate to a new entrypoint:

```ts
if (process.argv[2] === 'sessions') {
  const { runSessionsCli } = await import('../src/cli/sessions.js');
  await runSessionsCli(process.argv.slice(3));
  return;
}
```

Zero new `package.json` scripts; preserves the `yarn eng:loop sessions ...` UX from the issue's acceptance criteria. The dynamic import keeps the dispatcher's cold-start cost unchanged when operators run `yarn eng:loop` without arguments.

### G. Test seam

The pure function is `discoverSessions(deps: SessionsDeps): Promise<SessionRecord[]>`, where `SessionsDeps` injects every shell-out and filesystem read:

```ts
interface SessionsDeps {
  worktreesBase: string;
  claudeProjectsDir: string;             // default: ~/.claude/projects
  now: () => number;
  listProjectDirs: (dir: string) => Promise<string[]>;
  listJsonlFiles: (dir: string) => Promise<Array<{ name: string; mtimeMs: number }>>;
  readJsonl: (path: string) => Promise<string>;
  listClaudeProcesses: () => Promise<Array<{ pid: number }>>;
  resolveProcessCwd: (pid: number) => Promise<string | null>;
}
```

The production wiring lives in `src/cli/sessions.ts` (`defaultDeps()` factory) and uses `node:fs/promises`, `node:child_process` (`ps`, `lsof`), and `os.homedir()`. Tests in `test/cli/sessions.test.ts` build a `SessionsDeps` over synthetic JSONL strings and a fake process list — no real fs, no real ps, no real claude processes. The `--tail` and `--kill` paths get their own thin seams (`spawnTail`, `sendSignal`, `confirm`) so the CLI shell is also testable end-to-end without spawning anything.

## Alternatives rejected

- **JSONL-mtime alone for alive-detection.** Rejected because a finished session leaves a fresh-looking JSONL: the last assistant message arrived seconds before exit. The issue explicitly calls this out. We need a process-presence signal, and cwd-match is the cheapest one that doesn't require touching the dispatcher.
- **Persisting `InFlightSession` to disk from the dispatcher.** Tempting (the dispatcher already knows the pid + worktree) but adds a write path on the hot dispatch loop and introduces a staleness problem when sessions crash without updating the store. The cwd-match approach is *reconstructive* — it reads ground truth from the OS each call, so there is no state to keep coherent. Worth revisiting if we ever lose the worktree-per-issue convention.
- **Matching `claude` pids by argv-substring of the prompt.** The dispatcher passes the full prompt as a single argv element; matching that argv string against issue numbers would work but is fragile (prompt content drifts; argv truncation in `ps` on long prompts). cwd is structurally tied to the dispatcher's worktree convention.
- **`fs.watch` + position-tracking for `--tail`.** More code, no portability win over `tail -F`, and we'd have to re-implement JSONL rotation handling. Rejected.
- **New `package.json` script (`yarn eng:loop:sessions`).** Splits the CLI surface for no benefit; the issue's wording (`yarn eng:loop sessions`) is the expected UX.
- **Killing via the dispatcher itself (RPC / signal file).** Out of scope and breaks the "dispatcher may be stopped" use case the issue centres on. Direct `kill` on the resolved pid is the simpler model.

## File / module layout

**New files:**

- `packages/eng-loop/src/cli/sessions.ts` — entrypoint + pure functions:
  - `runSessionsCli(argv: string[]): Promise<void>` — top-level CLI shell, handles flag parsing (`--tail <N>`, `--kill <N>`, `--yes`, `--json`, `--all`) and routes to one of the modes below.
  - `discoverSessions(deps: SessionsDeps): Promise<SessionRecord[]>` — pure listing function (tested directly).
  - `renderTable(records: SessionRecord[]): string` — pretty human output.
  - `renderJson(records: SessionRecord[]): string` — JSON output (`JSON.stringify(records, null, 2)`).
  - `tailSession(issueNumber: number, deps): Promise<void>` — spawns `tail -F`, wires the prettyprinter, forwards SIGINT.
  - `killSession(issueNumber: number, opts: { force: boolean }, deps): Promise<void>` — resolves pid, confirms, sends SIGTERM.
  - `defaultDeps(): SessionsDeps` — production factory.
  - Internal helpers: `encodeWorktreePathToProjectDir(p)`, `decodeProjectDirToWorktreePath(d)`, `parseIssueNumberFromWorktree(p, base)`, `lastAssistantText(jsonl)`, `lastTimestamp(jsonl)`, `prLinkRecord(jsonl)`.

**Modified files:**

- `packages/eng-loop/scripts/run-eng-loop.ts` — add the `process.argv[2] === 'sessions'` branch at the top of `main()`, before the existing flag-parse.

**New tests:**

- `packages/eng-loop/test/cli/sessions.test.ts` — Vitest, with synthetic JSONL fixtures + injected `SessionsDeps`. Covers:
  - listing combines alive + done within 24h; excludes stale > 24h
  - alive detection picks the cwd-matched pid; falls back to `done` when no pid matches
  - `lastSummary` reads the most-recent assistant text block; handles tool-use-only sessions (null)
  - `prUrl` surfaces from `pr-link` records
  - `--json` emits the documented shape, sorted by `lastActivity` desc
  - `--kill` aborts on non-`y` input; sends SIGTERM on `y`; honours `--yes`
  - `--tail` resolves the right JSONL for an issue number and rejects unknown issues
  - `encodeWorktreePathToProjectDir` round-trips the dispatcher's own worktree paths (includes the apostrophe edge case in `/Users/adrianobradley/life's-work/...`)

## Acceptance-criteria mapping

| AC bullet | Implementation site |
|---|---|
| `yarn eng:loop sessions` lists all dispatched sessions (alive + done-in-24h) with the seven fields | `runSessionsCli` (default mode) → `discoverSessions` → `renderTable` |
| Alive detection via JSONL-path → cwd-match against `claude` pids | `discoverSessions` using `listClaudeProcesses` + `resolveProcessCwd` |
| `--tail <N>` follows live transcript | `tailSession` — `tail -F` subprocess + prettyprint transform |
| `--kill <N>` SIGTERMs after `[y/N]` confirm | `killSession` — `readline` confirm + `process.kill(pid, 'SIGTERM')` |
| `--json` machine-readable output | `renderJson` — `SessionRecord[]` schema documented inline |
| New: `packages/eng-loop/src/cli/sessions.ts` | per §File layout |
| Modified: `packages/eng-loop/scripts/run-eng-loop.ts` | one-line dispatch branch |
| Tests: `packages/eng-loop/test/cli/sessions.test.ts` | synthetic JSONL + ps-mock per §Test seam |

## Open questions

1. **Truncation width for `lastSummary`** — proposing 200 chars in the JSON and `min(terminal-width - prefix, 200)` in the table. If operators want full text, `--tail` is the right tool. Open to feedback in implementation.
2. **`--all`** to lift the 24h floor — not in the acceptance criteria; defer to a follow-up if operators ask for it.
3. **Linux `/proc/<pid>/cwd` resolver** — left as a future extension behind the `resolveProcessCwd(platform)` seam; not required for v1 since the dispatcher runs on macOS today.
