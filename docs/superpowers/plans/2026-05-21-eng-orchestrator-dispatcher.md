# `eng-orchestrator` Dispatcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. This is a **TDD code plan** — tests before implementation. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build `eng-orchestrator`, the local dispatcher — a thin TypeScript conductor (`yarn eng:loop`) that polls the triaged issue queue and runs each automatable issue through the `implement-issue` pipeline to a draft PR, throttled to the human's pace.

**Architecture:** A new module tree `packages/eng-loop/src/dispatcher/`. The dispatcher is a *conductor*: it shells out to `gh`, `git`, and the `claude` CLI (invoking the `implement-issue` skill) — it reimplements nothing. State lives in GitHub (the Project `Status` field is the state machine); the dispatcher re-derives state each cycle, so a crash simply resumes. Two seams — `IssueSource` and `DeliverySink` — isolate every `gh` call, so the loop can later be re-homed as a Jinn SolverNet by swapping in on-chain implementations.

**Tech Stack:** TypeScript (Node 22, ESM), vitest, the `gh` / `git` / `claude` CLIs. Reuses `packages/eng-loop`'s `src/headless.ts` (`buildHeadlessPrompt`) and `headless-override.md`.

**Depends on:**
- `docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md` — §2 (the dispatcher), §8 Phase 2, §9 (the SolverNet seam), §4 (the wall-clock breaker), Appendix (the `-p`-canon and zero-commit gotchas).
- The `implement-issue` skill (`.claude/skills/implement-issue/`) — what the dispatcher spawns per issue.
- DR-2026-05-20-b — the taxonomy fields the ready-filter reads.

**Out of scope:** the three skills (`file-issue`, `implement-issue`, `merge-batch`) — separate plans, already built. Effort-tiered agent-selection routing and concurrency/backpressure auto-tuning — spec §"Open questions", Phase 3. Stacked dispatch is included as a thin design accommodation (Task 3) but its full mechanics are a Phase-3 follow-on.

---

## File structure

```
packages/eng-loop/src/dispatcher/
  types.ts          core types — the taxonomy enums, PolledIssue, ReadyIssue, InFlightSession, SessionResult, DispatcherConfig
  issue-source.ts   IssueSource seam interface + GhIssueSource (poll gh issues + Project board)
  delivery-sink.ts  DeliverySink seam interface + GhPrSink (verify + record finished work)
  ready-filter.ts   selectReady() — pure: filter to dispatchable issues, order by Priority then FIFO
  throttles.ts      concurrencyOk() + backpressureOk() — pure
  state.ts          deriveInFlight() — re-derive in-flight sessions from gh + git worktree list
  dispatch.ts       dispatchIssue() — create worktree, build the session prompt, spawn implement-issue
  wall-clock.ts     WallClock — per-session generous ceiling; on expiry, pause (not kill)
  loop.ts           runCycle() — poll → filter → throttle → dispatch → collect
packages/eng-loop/scripts/run-eng-loop.ts   the `yarn eng:loop` entry point (+ --dry-run)
packages/eng-loop/test/dispatcher/          vitest tests
```

Each `gh` call lives inside `GhIssueSource`, `GhPrSink`, or `state.ts` — never threaded through `loop.ts`. That isolation is the §9 discipline that buys the SolverNet swap.

---

### Task 1: Core types and the two seam interfaces

**Files:**
- Create: `packages/eng-loop/src/dispatcher/types.ts`
- Create: `packages/eng-loop/src/dispatcher/issue-source.ts`
- Create: `packages/eng-loop/src/dispatcher/delivery-sink.ts`

- [ ] **Step 1: Write `types.ts`**

```typescript
/** The nine work-shape Issue Types (DR-2026-05-20-b). */
export type IssueShape =
  | 'feat' | 'fix' | 'refactor' | 'spike'
  | 'chore' | 'docs' | 'test' | 'incident' | 'design';

export type BlockedOn = 'Nothing' | 'Human' | 'Another issue';
export type Effort = 'Low' | 'Medium' | 'High';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
export type ProjectStatus = 'Todo' | 'In Progress' | 'In Review' | 'Done';

/** An issue as polled from the source, with its taxonomy fields. */
export interface PolledIssue {
  number: number;
  title: string;
  /** null = Issue Type not set — the issue is not triage-complete. */
  shape: IssueShape | null;
  blockedOn: BlockedOn | null;
  /** Set when blockedOn === 'Another issue'. */
  blockedOnIssue: number | null;
  effort: Effort | null;
  priority: Priority | null;
  status: ProjectStatus | null;
  onBoard: boolean;
}

/** An issue that passed the ready-filter — safe to dispatch. */
export interface ReadyIssue extends PolledIssue {
  shape: IssueShape;     // non-null: ready issues are triage-complete
  priority: Priority;    // non-null: needed for ordering
}

/** A session the dispatcher has spawned and is tracking. */
export interface InFlightSession {
  issueNumber: number;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: number;     // epoch ms
}

/** The outcome of a finished implement-issue session. */
export interface SessionResult {
  issueNumber: number;
  outcome: 'pr-opened' | 'escalated';
  prNumber?: number;
  escalationStatus?: 'needs-decision' | 'blocked' | 'stuck';
}

export interface DispatcherConfig {
  /** Max simultaneous sessions. Default 3; practical ceiling ~5–7. */
  concurrencyCap: number;
  /** Stop pulling new issues when open ready PRs exceed this. */
  openPrBackpressure: number;
  /** Per-session wall-clock ceiling, ms. Generous — hours. */
  wallClockMs: number;
  /** v1 default implementer; per-issue label can override. */
  defaultImplementer: 'claude' | 'codex' | 'cursor';
}

export const DEFAULT_CONFIG: DispatcherConfig = {
  concurrencyCap: 3,
  openPrBackpressure: 5,
  wallClockMs: 4 * 60 * 60 * 1000,
  defaultImplementer: 'claude',
};
```

- [ ] **Step 2: Write `issue-source.ts` (the seam interface)**

```typescript
import type { PolledIssue } from './types.js';

/**
 * SEAM: where ready issues come from.
 * Local implementation polls `gh`; the future SolverNet implementation
 * claims on-chain tasks. Nothing above this interface knows which.
 */
export interface IssueSource {
  /** Poll for all candidate issues with their taxonomy fields. */
  poll(): Promise<PolledIssue[]>;
}
```

- [ ] **Step 3: Write `delivery-sink.ts` (the seam interface)**

```typescript
import type { SessionResult } from './types.js';

/**
 * SEAM: what happens to finished work.
 * Local implementation records the GitHub PR / escalation; the future
 * SolverNet implementation submits an on-chain delivery for evaluation.
 */
export interface DeliverySink {
  /** Record a finished session's outcome, verifying external state. */
  collect(result: SessionResult): Promise<void>;
}
```

- [ ] **Step 4: Typecheck**

Run: `(cd packages/eng-loop && yarn typecheck)`. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/dispatcher
git commit -m "feat(eng-loop): dispatcher core types + IssueSource/DeliverySink seams"
```

(End every commit message in this plan with a trailing blank line then `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.)

---

### Task 2: `GhIssueSource` — poll `gh` and the Project board

**Files:**
- Modify: `packages/eng-loop/src/dispatcher/issue-source.ts`
- Test: `packages/eng-loop/test/dispatcher/issue-source.test.ts`

`GhIssueSource` implements `IssueSource` by running `gh` and mapping the JSON to `PolledIssue[]`. It takes an injectable command-runner so it is unit-testable without `gh`.

- [ ] **Step 1: Write the failing test**

The test injects a fake runner returning canned JSON for the two commands `GhIssueSource` issues — `gh issue list ... --json number,title,...` and `gh project item-list 1 --owner Jinn-Network --format json` — and asserts the mapping: an issue on the board with Issue Type `fix`, `Blocked on: Nothing`, `Effort: Low`, `Priority: P2`, `Status: Todo` maps to a `PolledIssue` with those fields and `onBoard: true`; an issue with no Issue Type maps to `shape: null`; an issue not on the board maps to `onBoard: false` with null routing fields. Write canned JSON fixtures that match real `gh` output shape.

- [ ] **Step 2: Run the test — verify it fails** (`GhIssueSource` not exported yet).

- [ ] **Step 3: Implement `GhIssueSource`**

Add to `issue-source.ts`: a `CommandRunner = (cmd: string, args: string[]) => Promise<string>` type; a `class GhIssueSource implements IssueSource` whose constructor takes a `CommandRunner` (defaulting to a real `execFile`-based runner). `poll()`: run `gh issue list --repo Jinn-Network/mono --state open --json number,title,labels` and `gh project item-list 1 --owner Jinn-Network --format json`, join them by issue number, and map each to `PolledIssue`. Issue Type comes from the GraphQL `issueType` field (per `file-issue`'s `references/gh-taxonomy.md` — `gh` exposes Issue Type only via GraphQL, not `--json`); the three routing fields and `Status` come from the Project item's field values. **Pin the exact field-extraction at execution time against live `gh` output** — the `gh project item-list` JSON key names must be confirmed, exactly as Task 2 of the `file-issue` plan did.

- [ ] **Step 4: Run the test — verify it passes.**

- [ ] **Step 5: Commit** — `feat(eng-loop): GhIssueSource polls gh issues + Project board`.

---

### Task 3: The ready-filter and ordering

**Files:**
- Create: `packages/eng-loop/src/dispatcher/ready-filter.ts`
- Test: `packages/eng-loop/test/dispatcher/ready-filter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { selectReady } from '../../src/dispatcher/ready-filter.js';
import type { PolledIssue } from '../../src/dispatcher/types.js';

const base: PolledIssue = {
  number: 1, title: 't', shape: 'fix', blockedOn: 'Nothing',
  blockedOnIssue: null, effort: 'Low', priority: 'P2',
  status: 'Todo', onBoard: true,
};

describe('selectReady', () => {
  it('keeps a triage-complete, unblocked, on-board, Todo issue', () => {
    expect(selectReady([base], new Set()).map((i) => i.number)).toEqual([1]);
  });
  it('drops an issue with no Issue Type', () => {
    expect(selectReady([{ ...base, shape: null }], new Set())).toEqual([]);
  });
  it('drops an issue Blocked on Human', () => {
    expect(selectReady([{ ...base, blockedOn: 'Human' }], new Set())).toEqual([]);
  });
  it('drops an issue not on the board', () => {
    expect(selectReady([{ ...base, onBoard: false }], new Set())).toEqual([]);
  });
  it('drops an issue already in flight', () => {
    expect(selectReady([base], new Set([1]))).toEqual([]);
  });
  it('orders by Priority then FIFO by issue number', () => {
    const a = { ...base, number: 5, priority: 'P3' as const };
    const b = { ...base, number: 9, priority: 'P0' as const };
    const c = { ...base, number: 3, priority: 'P3' as const };
    expect(selectReady([a, b, c], new Set()).map((i) => i.number)).toEqual([9, 3, 5]);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails.**

- [ ] **Step 3: Implement `ready-filter.ts`**

```typescript
import type { PolledIssue, ReadyIssue, Priority } from './types.js';

const PRIORITY_RANK: Record<Priority, number> = {
  P0: 0, P1: 1, P2: 2, P3: 3, P4: 4,
};

/**
 * An issue is **ready** when it is triage-complete (Issue Type set),
 * `Blocked on: Nothing`, on the board, in `Todo`, and not already in flight.
 * Ready issues are ordered by Priority, then FIFO by issue number.
 */
export function selectReady(
  polled: PolledIssue[],
  inFlight: ReadonlySet<number>,
): ReadyIssue[] {
  const ready = polled.filter(
    (i): i is ReadyIssue =>
      i.shape !== null &&
      i.priority !== null &&
      i.blockedOn === 'Nothing' &&
      i.onBoard &&
      i.status === 'Todo' &&
      !inFlight.has(i.number),
  );
  return ready.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.number - b.number,
  );
}
```

- [ ] **Step 4: Run the test — verify it passes (6 tests).**

- [ ] **Step 5: Commit** — `feat(eng-loop): ready-filter selects + orders dispatchable issues`.

> **Stacked dispatch note (design accommodation).** An issue that is `Blocked on: Another issue #A` is correctly *dropped* by `selectReady` (its `blockedOn !== 'Nothing'`). Full stacked dispatch — waiting for A's PR, then dispatching the dependent stacked on A's branch — is a Phase-3 follow-on (spec §2, §"Open questions"); this filter's behaviour (do not dispatch a blocked issue) is already correct for it.

---

### Task 4: The two throttles

**Files:**
- Create: `packages/eng-loop/src/dispatcher/throttles.ts`
- Test: `packages/eng-loop/test/dispatcher/throttles.test.ts`

- [ ] **Step 1: Write the failing test**

Test `concurrencyOk(inFlightCount, cap)` — true while `inFlightCount < cap`, false at the cap. Test `backpressureOk(openReadyPrCount, threshold)` — true while `openReadyPrCount <= threshold`, false above it.

- [ ] **Step 2: Run the test — verify it fails.**

- [ ] **Step 3: Implement `throttles.ts`**

```typescript
/** True while another session may be started without exceeding the cap. */
export function concurrencyOk(inFlightCount: number, cap: number): boolean {
  return inFlightCount < cap;
}

/**
 * True while the open-PR queue is within the human's reach. When the count
 * of ready PRs already waiting for batch-merge exceeds the threshold, the
 * dispatcher stops pulling new issues — it self-throttles to the human's
 * pace and cannot outrun them (spec §2, the dominant-failure-mode defence).
 */
export function backpressureOk(openReadyPrCount: number, threshold: number): boolean {
  return openReadyPrCount <= threshold;
}
```

- [ ] **Step 4: Run the test — verify it passes.**

- [ ] **Step 5: Commit** — `feat(eng-loop): concurrency cap + open-PR backpressure throttles`.

---

### Task 5: State re-derivation

**Files:**
- Create: `packages/eng-loop/src/dispatcher/state.ts`
- Test: `packages/eng-loop/test/dispatcher/state.test.ts`

State lives in GitHub, not the dispatcher. `deriveInFlight()` reconstructs the in-flight set each cycle so a crash or restart simply resumes.

- [ ] **Step 1: Write the failing test**

Inject a fake runner; assert `deriveInFlight()` returns one `InFlightSession` per issue whose Project `Status` is `In Progress` *and* which has a matching `cargo/.tasks/<N>` worktree in `git worktree list`. An issue `In Progress` with no worktree, or a worktree with no `In Progress` issue, is surfaced as a **drift warning**, not an in-flight session.

- [ ] **Step 2: Run the test — verify it fails.**

- [ ] **Step 3: Implement `state.ts`**

Export `deriveInFlight(runner: CommandRunner): Promise<{ inFlight: InFlightSession[]; drift: string[] }>`. It reads the Project board (`Status === 'In Progress'`) and `git worktree list --porcelain`, matches them on the `cargo/.tasks/<N>` path convention, and reports mismatches as `drift` strings. The dispatcher logs drift but does not act on it automatically (a human resolves drift). `pid` is `null` after a restart — the dispatcher re-attaches by issue number, not process handle.

- [ ] **Step 4: Run the test — verify it passes.**

- [ ] **Step 5: Commit** — `feat(eng-loop): deriveInFlight re-derives dispatcher state from gh + git`.

---

### Task 6: The dispatch step

**Files:**
- Create: `packages/eng-loop/src/dispatcher/dispatch.ts`
- Test: `packages/eng-loop/test/dispatcher/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

`dispatchIssue()` takes an injectable `runner` and an injectable `spawn`. Assert: it runs `git worktree add cargo/.tasks/<N> -b <shape>/<N>-<slug> origin/next`; it sets the issue Project `Status` to `In Progress`; it spawns the session with a prompt that contains (a) the canon (CLAUDE.md + the handbook — concatenated, per the spec Appendix: `-p` mode does not auto-load `CLAUDE.md`), (b) the headless-override block, (c) an instruction to use the `implement-issue` skill on issue `#N`; it returns an `InFlightSession`. Assert the prompt does **not** contain any `--mode plan` / `--permission-mode plan` posture flag (spec Appendix).

- [ ] **Step 2: Run the test — verify it fails.**

- [ ] **Step 3: Implement `dispatch.ts`**

Export `dispatchIssue(issue: ReadyIssue, cfg: DispatcherConfig, deps: { runner; spawn }): Promise<InFlightSession>`. It: derives the branch name; creates the worktree off `origin/next`; sets `Status: In Progress` (single-select — discover the option id via `gh project field-list`, per `file-issue`'s `gh-taxonomy.md`); assembles the session prompt by concatenating the canon files, the contents of `headless-override.md`, and `Use the implement-issue skill on issue #<N>.` — reuse `buildHeadlessPrompt` from `src/headless.ts` for the override+task composition; spawns `claude -p <prompt>` (no plan-posture flags) in the worktree, detached, capturing the pid; returns the `InFlightSession`. The implementer for the inner pipeline is `cfg.defaultImplementer` unless a per-issue `agent:*` label overrides it.

- [ ] **Step 4: Run the test — verify it passes.**

- [ ] **Step 5: Commit** — `feat(eng-loop): dispatchIssue creates a worktree and spawns the pipeline`.

---

### Task 7: The wall-clock circuit-breaker

**Files:**
- Create: `packages/eng-loop/src/dispatcher/wall-clock.ts`
- Test: `packages/eng-loop/test/dispatcher/wall-clock.test.ts`

- [ ] **Step 1: Write the failing test**

`WallClock` is constructed with a `nowFn` (injectable clock). Assert: `expired(session)` is false before `wallClockMs` has elapsed since `session.startedAt`, true after; `softWarningDue(session)` is true in the final 10% of the window (a soft warning before the hard stop, so the session can write its "where I am" note — spec §4).

- [ ] **Step 2: Run the test — verify it fails.**

- [ ] **Step 3: Implement `wall-clock.ts`**

A `WallClock` class wrapping `wallClockMs` and a `nowFn`. `expired()` / `softWarningDue()` as tested. Document in a comment: expiry triggers a **pause**, not a kill — the dispatcher (Task 8) sets the issue `Blocked on: Human` and leaves the worktree + transcript intact and resumable (spec §4). The breaker is a runaway guard for the rare doom-loop, not a retry cap; because escalation is a pause, the exact value needs no precise tuning.

- [ ] **Step 4: Run the test — verify it passes.**

- [ ] **Step 5: Commit** — `feat(eng-loop): wall-clock circuit-breaker (pause, not kill)`.

---

### Task 8: The cycle, the entry point, and a dry run

**Files:**
- Create: `packages/eng-loop/src/dispatcher/loop.ts`
- Create: `packages/eng-loop/scripts/run-eng-loop.ts`
- Modify: `packages/eng-loop/package.json` (add the `eng:loop` script)
- Test: `packages/eng-loop/test/dispatcher/loop.test.ts`

- [ ] **Step 1: Write the failing test for `runCycle`**

`runCycle(deps)` takes injected `source: IssueSource`, `sink: DeliverySink`, `cfg`, and stubs for `deriveInFlight` / `dispatchIssue`. Assert one cycle: it polls the source, derives in-flight, applies `selectReady`, and — respecting `concurrencyOk` and `backpressureOk` — calls `dispatchIssue` for the top-ranked ready issues up to the remaining concurrency budget, and **not at all** when backpressure is tripped. Assert it returns a `CycleReport` (dispatched issue numbers, skipped-for-throttle count, drift warnings).

- [ ] **Step 2: Run the test — verify it fails.**

- [ ] **Step 3: Implement `loop.ts`**

`runCycle()` wires the pure pieces: `source.poll()` → `deriveInFlight()` → `selectReady(polled, inFlightSet)` → gate on `backpressureOk` (count open ready PRs via the sink/`gh`) → dispatch up to `concurrencyCap − inFlight.length` issues via `dispatchIssue` → return a `CycleReport`. Collect (`sink.collect`) runs for any session that finished since the last cycle. `loop.ts` contains **no `gh` calls** — they are all behind `source`, `sink`, and the injected `deriveInFlight` (the §9 discipline).

- [ ] **Step 4: Run the test — verify it passes.**

- [ ] **Step 5: Write `scripts/run-eng-loop.ts`**

The entry point: build `GhIssueSource` + `GhPrSink` + `DEFAULT_CONFIG`, then call `runCycle` on an interval (or once for `--dry-run`). `--dry-run` polls, filters, and prints the `CycleReport` it *would* act on **without** creating worktrees, spawning sessions, or mutating the board. Print the cycle report each tick.

- [ ] **Step 6: Add the `eng:loop` script to `package.json`**

Add to `scripts`: `"eng:loop": "tsx scripts/run-eng-loop.ts"`.

- [ ] **Step 7: Typecheck, then dry-run**

Run `(cd packages/eng-loop && yarn typecheck)` — no errors. Then `(cd packages/eng-loop && yarn eng:loop --dry-run)` — it must print a coherent cycle report against the live issue queue (the ready issues it would dispatch, in Priority order, throttle state) without mutating anything.

- [ ] **Step 8: Commit** — `feat(eng-loop): runCycle dispatcher loop + eng:loop entry point`.

---

## Self-review

- **Spec coverage.** Tasks 1–8 implement spec §2 — poll & filter (Tasks 2–3), the two throttles (Task 4), dispatch with worktree + canon-concatenated session prompt (Task 6), state re-derivation (Task 5), the wall-clock breaker (Task 7, §4), and the cycle wiring (Task 8). The §9 seams (`IssueSource` / `DeliverySink`) are Task 1 and every `gh` call is held behind them. The Appendix gotchas are addressed: canon concatenation (Task 6 Step 3), no plan-posture flags (Task 6 Step 1 asserts it), external verification over self-report (Task 5; `DeliverySink.collect` doc). Phase-2 scope per §8 — concurrency starts at the configurable `DEFAULT_CONFIG` (3); the dry-run gives a safe first validation.
- **Placeholder scan.** Tasks 1, 3, 4, 7 give verbatim code (the architectural core and the small pure functions). Tasks 2, 5, 6, 8 give the exact signatures, the TDD test shape, and the implementation approach, with the `gh`-JSON field extraction explicitly deferred to execution-time ground-truthing against live `gh` output — the same discipline the `file-issue` plan's `gh-taxonomy.md` task used, because `gh` JSON key names must be confirmed live, not guessed.
- **Type consistency.** `PolledIssue` / `ReadyIssue` / `InFlightSession` / `SessionResult` / `DispatcherConfig` and the taxonomy enums are defined once in Task 1 and used unchanged in Tasks 2–8. `selectReady`, `concurrencyOk`, `backpressureOk`, `deriveInFlight`, `dispatchIssue`, `runCycle` keep one signature throughout.
- **Scope.** One module tree, the dispatcher only — the skills it conducts are separate, already-built plans. Stacked dispatch and agent-selection routing are explicitly held to Phase 3. Right-sized for a single plan.
