# Task Creator — real-usage mining + end-to-end loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining gaps in Task Creator v0 (#1485) and add the real-usage mining source, so the full loop runs end to end: operator enables harvest → real work (commits + captured sessions) becomes admitted tasks → tasks post to the marketplace with synthetic guards → solvers produce verified pass/fail pairs → pairs are countable as distillation feedstock.

**Architecture:** Everything stacks on `feat/task-creator-v0` (PR #1485) and reuses its machine: miners emit `BuiltMintCandidate`s → `admitBuiltMintCandidates` → `MintedPoolStore` → generator union → marketplace. This plan adds (a) hygiene closures the review found (retro discrimination, cap-v0 denylist union, AC3 figure, upstream eval durability, AC1 proof), (b) the marketplace-leg e2e that the plumbing proof skipped, and (c) a **session-echo** miner: locally captured sessions (tier-1 consent) minted as tasks at their true base commit. Hunk-subset echo (`base ⊕ S ⊖ H`) is deliberately deferred: a broken state that is not a real commit cannot be represented as a swe-rebench row today (solvers never see `test_patch`, so it cannot carry `S ⊖ H`); it lands with the env-bootstrap follow-on.

**Tech Stack:** TypeScript (client daemon, vitest), Python (jinn-agent consent plugin, pytest), Docker (empirical F2P/P2P + admission), Anvil (marketplace e2e), IPFS (minted-row artifacts).

## Global Constraints

- **Base branch:** every task builds on `feat/task-creator-v0` (stacked PRs; PRs target `next` after #1485 lands, per AI-workflow rule 10). #1485 must first be rebased on `next` (the `eviction-check` loop arrived there) — that rebase is Ritsu's, and is a precondition, not a task here.
- **D5:** only public-repo tasks may publish. Never weaken `assertPublicRepoForPublish`.
- **D2:** tier-1 (`mineableTraceConsent: 'off' | 'retain_local'`, default `'off'`) gates local retention; tier-2 (`publishMinedTasksConsent: boolean`, default `false`) gates publication. Fail closed on both.
- **D3:** discrimination failure ⇒ hard-reject for minted instances, flag + exclude for benchmark instances. Never mass-invalidate the live pool.
- **§7 guards stay intact:** synthetic quota ≤ 25 %, informative-band halt, `syntheticClaimBlocked`, lineage collapse. No task may bypass them.
- **Default-off:** no new daemon behaviour may activate without explicit config. `harvest.enabled` stays `false` by default.
- **TDD:** each code task is test-first. Run tests from `client/` with `corepack yarn vitest run <file>`.
- Spec: `spec/2026-07-08-task-creator-v0.md` (v0.4). Handoff: `docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md`.

---

## Phase 1 — Close rung 1 (hygiene the AC pass found)

### Task 1: Union cap-v0 repos into the mint denylist

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-guards.ts` (`loadMintRepoDenylist`, ~line 19)
- Modify: `client/src/eval/capability-slate.ts` (add a repo-list loader if none exists)
- Test: `client/test/solver-types/task-creator.test.ts`

**Interfaces:**
- Consumes: `parseCapabilitySlate(raw): CapabilitySlateArtifact` (`client/src/eval/capability-slate.ts:91`), `CapabilitySlateInstance` (has a `repo` field), `loadActiveHeldOutSlateIds` (`_swe-rebench-v2-held-out-slate.ts`).
- Produces: `loadMintRepoDenylist(): RepoDenylist` now returns held-out-slate repos ∪ cap-v0 slate repos. Same signature — callers unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// append to the 'task-creator guards' describe block in client/test/solver-types/task-creator.test.ts
it('unions cap-v0 capability-slate repos into the mint denylist (spec §11)', () => {
  const denylist = loadMintRepoDenylist();
  const capRepos = loadCapabilitySlateRepos();
  // The cap-v0 slate may legitimately not be frozen yet; when it exists it MUST be unioned.
  for (const repo of capRepos) {
    expect(denylist.repos.has(repo)).toBe(true);
  }
});
```

Also add the import: `loadCapabilitySlateRepos` from `../../src/eval/capability-slate.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn vitest run test/solver-types/task-creator.test.ts`
Expected: FAIL — `loadCapabilitySlateRepos` is not exported.

- [ ] **Step 3: Implement**

In `client/src/eval/capability-slate.ts`, add a loader that mirrors how held-out slates resolve from disk (JSON sibling under an artifact dir; if the cap-v0 artifact file does not exist yet, return the empty set — the slate is not frozen):

```ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Repos on the frozen cap-v0 slate; empty set until the artifact is frozen. */
export function loadCapabilitySlateRepos(): Set<string> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const file = join(dir, 'slates', 'capability-slate.cap-v0.json');
  if (!existsSync(file)) return new Set();
  const artifact = parseCapabilitySlate(JSON.parse(readFileSync(file, 'utf8')));
  return new Set(artifact.instances.map((i) => i.repo));
}
```

(Adjust the path to wherever the frozen artifact actually lives — check `client/src/eval/` for an existing slates dir before inventing one; if cap-eval PR #1416 defined a location, use that.)

In `_swe-rebench-v2-guards.ts`:

```ts
import { loadCapabilitySlateRepos } from '../eval/capability-slate.js';

export function loadMintRepoDenylist(): RepoDenylist {
  const slateIds = loadActiveHeldOutSlateIds(SWE_REBENCH_V2_SOLVER_TYPE, ACTIVE_HELD_OUT_SLATE_VERSIONS);
  const repos = new Set<string>();
  for (const id of slateIds) {
    const repo = repoFromSweInstanceId(id);
    if (repo) repos.add(repo);
  }
  for (const repo of loadCapabilitySlateRepos()) repos.add(repo);
  return { repos };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack yarn vitest run test/solver-types/task-creator.test.ts`
Expected: PASS (the union test passes vacuously until the slate freezes; the existing non-empty assertion still guards the held-out half).

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-guards.ts client/src/eval/capability-slate.ts client/test/solver-types/task-creator.test.ts
git commit -m "feat(task-creator): union cap-v0 slate repos into mint denylist (spec §11)"
```

### Task 2: Retroactive discrimination re-check + weak-suite rate (D3 second half, AC3)

The shipped check only runs at validation time; entries validated before #1485 keep `discrimination: undefined` forever. Add a re-check pass that runs ONLY the known-bad eval against already-scorable entries (cheap: one Docker run per entry, no gold re-run), flags failures per D3, and reports the weak-suite rate — which re-derives the spec's unanchored 28.5 % figure on our own pool.

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-validated-pool.ts` (new exported function near `runDiscriminationCheck`, ~line 857)
- Modify: `client/src/cli/commands/solver-nets.ts` (new flag on the validate-pool subverb; extend `validate-pool-report` output, ~line 509)
- Test: `client/test/solver-types/task-creator-discrimination.test.ts`

**Interfaces:**
- Consumes: `runDiscriminationCheck({...}): Promise<Pick<ValidatedPoolEntry,'scorable'|'reason'|'discrimination'>>` (`_swe-rebench-v2-validated-pool.ts:857`), `ValidatedPoolStore` entry map, `HfFetcher`, `EvalRunner`.
- Produces: `recheckDiscrimination(opts): Promise<{ checked: number; flagged: string[]; skipped: number }>` — later tasks and the report consume `flagged`.

- [ ] **Step 1: Write the failing test**

```ts
// append to client/test/solver-types/task-creator-discrimination.test.ts
describe('recheckDiscrimination', () => {
  it('flags an unchecked benchmark entry whose known-bad patch passes, and leaves it scorable=true (D3)', async () => {
    const store = makeInMemoryValidatedStore({
      'repo__pkg-1': { scorable: true, reason: 'gold-patch-resolves' /* discrimination: undefined */ },
    });
    const result = await recheckDiscrimination({
      store,
      fetcher: fakeFetcherFor('repo__pkg-1'),
      runner: fakeRunnerWhere({ knownBadPasses: true }),
      upstreamRepoDir: '/tmp/fake',
    });
    expect(result.flagged).toEqual(['repo__pkg-1']);
    const entry = await store.getEntry('repo__pkg-1');
    expect(entry.discrimination).toBe('fail');
    expect(entry.scorable).toBe(true); // benchmark pool: flag, never hard-reject
  });

  it('skips entries that already carry a discrimination verdict', async () => {
    const store = makeInMemoryValidatedStore({
      'repo__pkg-2': { scorable: true, reason: 'gold-patch-resolves', discrimination: 'pass' },
    });
    const result = await recheckDiscrimination({ store, fetcher: fakeFetcherFor('repo__pkg-2'), runner: throwingRunner(), upstreamRepoDir: '/tmp/fake' });
    expect(result.checked).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
```

Reuse this test file's existing fakes for store/fetcher/runner (it already fakes all three for the forward path — match their construction exactly rather than inventing new helpers; the names above are indicative, align them to the file's local helpers).

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn vitest run test/solver-types/task-creator-discrimination.test.ts`
Expected: FAIL — `recheckDiscrimination` not exported.

- [ ] **Step 3: Implement `recheckDiscrimination`**

In `_swe-rebench-v2-validated-pool.ts`, next to `runDiscriminationCheck`:

```ts
export interface RecheckDiscriminationOpts {
  store: ValidatedPoolStore;
  fetcher: HfFetcher;
  runner: EvalRunner;
  upstreamRepoDir: string;
  limit?: number; // optional batch bound for long pools
}

/**
 * D3 second half: run the known-bad discrimination eval against entries
 * validated before the check existed (discrimination === undefined).
 * Benchmark pool ⇒ flag only (scorable stays true); never hard-rejects.
 */
export async function recheckDiscrimination(opts: RecheckDiscriminationOpts): Promise<{
  checked: number; flagged: string[]; skipped: number;
}> {
  const entries = await opts.store.getAllEntries();
  const flagged: string[] = [];
  let checked = 0;
  let skipped = 0;
  for (const [instanceId, entry] of Object.entries(entries)) {
    if (!entry.scorable || entry.discrimination !== undefined) { skipped++; continue; }
    if (opts.limit !== undefined && checked >= opts.limit) { skipped++; continue; }
    const verdict = await runDiscriminationCheck({
      instanceId,
      poolSource: 'benchmark',
      fetcher: opts.fetcher,
      runner: opts.runner,
      upstreamRepoDir: opts.upstreamRepoDir,
    });
    checked++;
    if (verdict.discrimination === 'fail') flagged.push(instanceId);
    await opts.store.updateEntry(instanceId, { ...entry, discrimination: verdict.discrimination });
  }
  return { checked, flagged, skipped };
}
```

Align the exact parameter shape of `runDiscriminationCheck` and the store's update method to what the file actually exposes (read `runDiscriminationCheck`'s signature at line 857 and the store's write path first; add a minimal `updateEntry` if the store only supports whole-file writes).

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack yarn vitest run test/solver-types/task-creator-discrimination.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the CLI + report**

In `client/src/cli/commands/solver-nets.ts`:
- Add `--recheck-discrimination [--limit N]` to the `validate-pool` subverb: constructs the real `HttpHfFetcher` + `PythonEvalRunner` (copy the construction already used by the mint/validate path in this file) and calls `recheckDiscrimination`, printing `checked/flagged/skipped`.
- In the `validate-pool-report` subverb (line 509): add `weakSuite: { checked, flagged, rate }` to the JSON output, where `rate = flagged / (flagged + passes)` over entries with a discrimination verdict, and a human line: `weak-suite rate: X/Y checked (Z%)`.

Test the report shape with a unit test against the report-building function if one is exported; otherwise assert via the JSON path in an integration test in the same file as Step 1.

- [ ] **Step 6: Run the recheck on the real pool (operator step, amd64/Docker host)**

Run: `node dist/bin/jinn.js solver-nets validate-pool swe-rebench-v2 --recheck-discrimination`
Then: `node dist/bin/jinn.js solver-nets validate-pool-report swe-rebench-v2 --json`
Record the measured weak-suite rate.

- [ ] **Step 7: Replace the 28.5 % figure (AC3 closure)**

Update `spec/2026-07-08-task-creator-v0.md` §5.1 and `log/decisions/2026-07-09-swe-smith-spike-task-creator.md` §Weak-suite anchor: replace "~28.5 % — reported, pending anchor" with the measured rate and the report command as its citation.

- [ ] **Step 8: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-validated-pool.ts client/src/cli/commands/solver-nets.ts client/test/solver-types/task-creator-discrimination.test.ts spec/2026-07-08-task-creator-v0.md log/decisions/2026-07-09-swe-smith-spike-task-creator.md
git commit -m "feat(task-creator): retroactive discrimination recheck + measured weak-suite rate (D3, AC3)"
```

### Task 3: Make the upstream `passed_actual` patch durable (handoff WP1)

Empirical F2P/P2P depends on `eval.py`'s `build_report_item` emitting `passed_actual`/`failed_actual`; today that's a hand-patch on the operator's clone. Apply it automatically at harness enable.

**Files:**
- Create: `client/src/harnesses/impls/swe-rebench-v2-evaluator/upstream-patches/passed-actual.patch` (generate with `git diff` from the already-patched operator clone — the handoff says the patch exists locally)
- Modify: `client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts` (`onEnable`)
- Test: `client/test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts` (or the nearest existing harness test file)

**Interfaces:**
- Consumes: the harness's `onEnable` clone step (it already clones/pins `SWE-rebench-V2` into `upstreamRepoDir`).
- Produces: `applyUpstreamPatches(upstreamRepoDir: string): void` — idempotent (checks with `git apply --check --reverse` before applying).

- [ ] **Step 1: Write the failing test**

```ts
it('onEnable applies the passed_actual patch to upstream eval.py, idempotently', async () => {
  const dir = await cloneFixtureUpstream(); // unpatched fixture copy of eval.py in a tmp git repo
  applyUpstreamPatches(dir);
  const evalPy = readFileSync(join(dir, 'scripts/eval.py'), 'utf8');
  expect(evalPy).toContain('passed_actual');
  expect(evalPy).toContain('failed_actual');
  expect(() => applyUpstreamPatches(dir)).not.toThrow(); // second run is a no-op
});
```

- [ ] **Step 2: Run test to verify it fails** — `corepack yarn vitest run test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function applyUpstreamPatches(upstreamRepoDir: string): void {
  const patch = join(dirname(fileURLToPath(import.meta.url)), 'upstream-patches', 'passed-actual.patch');
  const reversed = spawnSync('git', ['apply', '--check', '--reverse', patch], { cwd: upstreamRepoDir });
  if (reversed.status === 0) return; // already applied
  const applied = spawnSync('git', ['apply', patch], { cwd: upstreamRepoDir });
  if (applied.status !== 0) {
    throw new Error(`failed to apply passed-actual.patch to ${upstreamRepoDir}: ${applied.stderr}`);
  }
}
```

Call it at the end of `onEnable` after the clone/pin step. Ensure the patch file ships in the published package (check `client/package.json` `files` globs cover the harness impl dir).

- [ ] **Step 4: Run tests** → PASS. Also run `yarn task-creator:harvest-e2e-live` on the operator machine from a fresh `jinn harnesses enable swe-rebench-v2-evaluator` (the handoff's own AC).

- [ ] **Step 5: Commit** — `git commit -m "fix(task-creator): apply passed_actual upstream patch at harness enable (WP1)"`

### Task 4: Run the AC1 amd64 gold proof and unstick its CI job

Procedural, not TDD — the code exists.

**Files:**
- Modify (if needed): `.github/workflows/ci.yml:149-173` (the `Task Creator AC1` job)
- Evidence: PR #1485 test-plan checkbox + a comment with the proof output

- [ ] **Step 1:** Determine why the job skipped on the last run: `gh run view <run-id> --repo Jinn-Network/mono --json jobs --jq '.jobs[] | select(.name|contains("AC1")) | {name,conclusion}'` and inspect the `needs:` chain — the review found no `if:` in the job, so the skip is inherited (its `needs` includes the failing test job, or branch-protection context). If `needs` includes `Typecheck & Test`, that's correct behaviour — it will run once Phase-1 CI is green; document that in the PR rather than changing the workflow.
- [ ] **Step 2:** On an amd64 host with Docker (the rented rig from cap-v0), run the runbook: `docs/runbooks/task-creator-amd64-gold-proof.md` → `yarn tsx client/scripts/task-creator-amd64-gold-proof.ts`. Expected: exits 0, prints the admitted entry with `discrimination: 'pass'`, matching rowHash, imageDigest present.
- [ ] **Step 3:** Paste the output into a PR comment on #1485 and tick the test-plan checkbox. AC1's "before any mint posts" rule stays procedural for v0 — note in the comment that Phase 2's e2e is the standing enforcement.
- [ ] **Step 4:** Commit any workflow fix: `git commit -m "chore(ci): let AC1 gold-proof job run once test job is green"`

---

## Phase 2 — Marketplace-leg e2e (handoff WP6: the unverified half of the loop)

### Task 5: Harvest → post → guarded-claim → grade → exemplar-pair e2e

The plumbing proof stopped at `minted-pool.json` + IPFS. This task proves the on-chain half on an Anvil fork, reusing the existing settlement-loop e2e rig (`yarn e2e:daemon-harness` — Anvil fork of Base, local JinnRouterV3 stack, mock IPFS, production Daemon).

**Files:**
- Create: `client/scripts/e2e-task-creator-marketplace.ts` (or extend `client/test/solver-types/task-creator-harvest-e2e.test.ts` with a `describe.skipIf(!process.env.JINN_E2E_ANVIL)` block — prefer whichever pattern `e2e:daemon-harness` already uses; read `client/scripts/` for its entry script and mirror it)
- Modify: `client/package.json` (script `e2e:task-creator`)

**Interfaces:**
- Consumes: the minted pool from a seeded `MintedPoolStore` (reuse the synthetic-fix-commit seeding from `task-creator-harvest-e2e.test.ts:198`), generator union (`swe-rebench-v2.ts:671-687`), `syntheticClaimBlocked` (`_swe-rebench-v2-synthetic-claim.ts:11`), `resolveMintedTaskDeliveryRate` → `computeEscrowWei` (`adapters/mech/adapter.ts:602`), `computeExemplarPairYield` (`_swe-rebench-v2-yield.ts`).
- Produces: a repeatable script asserting the five loop properties below; no new runtime code.

- [ ] **Step 1: Write the e2e (it is the test)** — assertions, in order:

```ts
// 1. A minted instance (syntheticProvenance present) is selected by the generator
//    and posted on-chain with the complexity-weighted escrow, not the flat rate.
// 2. A claim attempt by the MINTER operator is refused (syntheticClaimBlocked).
// 3. A claim by a second operator identity succeeds; the mock solver returns
//    (a) the gold patch once and (b) a garbage patch once, across two postings.
// 4. The evaluator grades both: gold ⇒ pass verdict, garbage ⇒ fail verdict.
// 5. computeExemplarPairYield over the two verified trajectories counts exactly
//    one exemplar pair for the minted instance, and the yield-report attributes
//    it to the minted (not baseline) bucket.
```

Build it by copying the harness/operator scaffolding from the `e2e:daemon-harness` script (two operator configs, mock agent as the solver — `client/scripts/mock-agent.ts` replaces Claude). Use the in-memory minted-artifact fetcher from `_swe-rebench-v2-harvest.ts` so IPFS is mocked, exactly as the harvest e2e test does.

- [ ] **Step 2: Run against Anvil**

Run: `corepack yarn e2e:task-creator` (spawns Anvil fork like `yarn e2e` does).
Expected: all five assertions pass; on failure the script prints which loop property broke.

- [ ] **Step 3: Wire as a soft gate** — add the script to CI as a manually-triggered / nightly job (copy the `e2e` job pattern in `.github/workflows/ci.yml`), not a PR-blocking check.

- [ ] **Step 4: Commit** — `git commit -m "test(task-creator): marketplace-leg e2e — post, guarded claim, grade, exemplar pair (WP6)"`

---

## Phase 3 — Real-usage capture + session-echo miner (rung 2, v0 shape)

**Design decision this phase encodes (state it in the PR):** v0 trace mining is **session-echo** — mint the session's accepted diff as a task at the session's real `repo @ baseCommit` — not hunk-subset echo. Hunk-subset's broken state `base ⊕ S ⊖ H` is not a real commit and cannot ride a swe-rebench row (solvers don't receive `test_patch`), so it waits for env bootstrap (Phase 4 follow-on). Session-echo is geometrically valid (the base commit exists upstream), needs no new env mechanics, and the answer key is ours to blind (unlike commit-echo's public gold). Retroactivity note: anything that landed as a *commit* is already minable forever via commit-echo (git is retroactive capture); what this phase preserves is the session-level material git never sees — accepted diffs that were never pushed, in-session test outcomes, intermediate failures, skill events.

### Task 6: `MineableTraceStore` — the five contract fields, typed (AC4 first half)

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-mineable-store.ts`
- Test: `client/test/solver-types/task-creator-mineable-store.test.ts`

**Interfaces:**
- Consumes: nothing new (sibling of `MintedPoolStore` — mirror its stateDir/JSON-file pattern from `_swe-rebench-v2-minted-pool.ts`).
- Produces (Tasks 7–9 rely on these exact names):

```ts
export interface MineableTestRun { cmd: string; exitCode: number; at: string; }
export interface MineableSkillEvent { skill: string; action: 'loaded' | 'invoked'; }
export interface MineableTraceRecord {
  sourceId: string;                       // opaque local id; never published
  kind: 'solvernet-execution' | 'harness-session';
  repo: string;                           // owner/name
  baseCommit: string;
  acceptedDiff: string;                   // candidate gold (spec §10 field 2)
  testRuns: MineableTestRun[];            // verifier seed (field 3)
  intermediateFailureDiffs: string[];     // negative exemplars (field 4)
  skillEvents: MineableSkillEvent[];      // §12 option value (field 5)
  sourceInstanceId?: string;              // set when kind === 'solvernet-execution'
  publishMinedTasksConsent: boolean;      // tier-2, from the capture manifest
  createdAt: string;                      // ISO — injected, never Date.now() in tests
}

export class MineableTraceStore {
  constructor(opts: { stateDir: string });
  /** Fail-closed: throws if tier-1 consent is not 'retain_local'. */
  append(record: MineableTraceRecord, consent: 'off' | 'retain_local'): Promise<void>;
  listUnmined(): Promise<MineableTraceRecord[]>;
  markMined(sourceId: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('MineableTraceStore', () => {
  it('refuses to append without tier-1 consent (fail closed, D2)', async () => {
    const store = new MineableTraceStore({ stateDir: tmpDir() });
    await expect(store.append(record(), 'off')).rejects.toThrow(/consent/);
    expect(await store.listUnmined()).toEqual([]);
  });
  it('appends with consent and round-trips all five contract fields', async () => {
    const store = new MineableTraceStore({ stateDir: tmpDir() });
    const r = record(); // fixture with every field populated
    await store.append(r, 'retain_local');
    const [got] = await store.listUnmined();
    expect(got).toEqual(r);
  });
  it('markMined removes from the unmined list but keeps the record on disk', async () => {
    const store = new MineableTraceStore({ stateDir: tmpDir() });
    await store.append(record({ sourceId: 's1' }), 'retain_local');
    await store.markMined('s1');
    expect(await store.listUnmined()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** → `corepack yarn vitest run test/solver-types/task-creator-mineable-store.test.ts`
- [ ] **Step 3: Implement** — JSON file `mineable-traces.json` under `stateDir`, `{ records: Record<sourceId, MineableTraceRecord & { mined?: boolean }> }`, atomic write via the same tmp-file+rename helper `MintedPoolStore` uses (copy its pattern).
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(task-creator): MineableTraceStore — typed mineable-trace contract fields (AC4)"`

### Task 7: Producers — engine writes records; jinn-agent asks the consent questions

**Files:**
- Modify: `client/src/harnesses/engine/engine.ts` (at the solution-envelope assembly point, ~line 1582 — the one place instance metadata, base commit, patch, and per-attempt failures are all in scope)
- Modify: `client/src/config.ts` (new `mineableTraces: { consent: 'off' | 'retain_local' (default 'off'), publishConsent: boolean (default false) }` block + `JINN_MINEABLE_CONSENT` env)
- Modify: `apps/jinn-agent/plugins/jinn/consent.py` (wire the existing-but-unused `render_mineable_trace_prompt` / `mineable_trace_enabled` into `run_consent_flow`, lines 226-282)
- Test: `client/test/harnesses/engine/mineable-producer.test.ts`, `apps/jinn-agent/tests/test_consent_mineable.py` (mirror the existing consent.py test file's location/naming)

**Interfaces:**
- Consumes: `MineableTraceStore.append` (Task 6), engine task context (instance id, repo, base commit, final patch, failed-attempt patches), `config.mineableTraces`.
- Produces: `recordMineableTrace(store, ctx, consent)` — a small pure assembler exported from `_swe-rebench-v2-mineable-store.ts` so the engine hook is one call:

```ts
export function buildMineableRecord(ctx: {
  sourceId: string; kind: MineableTraceRecord['kind'];
  repo: string; baseCommit: string; acceptedDiff: string;
  testRuns?: MineableTestRun[]; intermediateFailureDiffs?: string[];
  skillEvents?: MineableSkillEvent[]; sourceInstanceId?: string;
  publishMinedTasksConsent: boolean; now: () => string;
}): MineableTraceRecord;
```

- [ ] **Step 1: Failing TS test** — engine-side: with `consent: 'retain_local'`, completing a task execution appends exactly one record whose `acceptedDiff` is the solver patch and whose `intermediateFailureDiffs` carries prior failed attempts; with default config, nothing is appended and no store file is created. Drive it through whatever seam the engine tests already use for post-execution hooks (read `client/test/harnesses/engine/` for the established fake-engine pattern and inject the store as an optional engine dependency — `mineableStore?: MineableTraceStore`).
- [ ] **Step 2: Verify FAIL, implement, verify PASS.** Engine wiring: `main.ts` constructs the store only when `config.mineableTraces.consent === 'retain_local'` and passes it into the engine options; the engine calls `recordMineableTrace` in a `try/catch` that logs and never fails the task on store errors.
- [ ] **Step 3: Python side** — failing pytest: `run_consent_flow` now prompts for the two tiers after contribution consent (default answers decline both) and persists `mineableTraceConsent`/`publishMinedTasksConsent` via the existing `save_state`; `mineable_trace_enabled()` reflects it. Implement by calling the already-written `render_mineable_trace_prompt()` in the flow. Run: `python -m pytest apps/jinn-agent/tests/test_consent_mineable.py`.
- [ ] **Step 4: Note the honest scope in the PR body:** the jinn-agent side records *consent* now; its session-capture producer (writing `MineableTraceRecord`s from Hermes sessions) rides the harness-layer capture bridge and is a follow-on — the engine producer is the live one today.
- [ ] **Step 5: Commit** — `git commit -m "feat(task-creator): mineable-trace producers — engine records under tier-1 consent; jinn-agent consent flow asks both tiers (AC4, D2)"`

### Task 8: Session-echo miner + tier-2 enforcement at publish

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-session-echo.ts`
- Modify: `client/src/solver-types/_swe-rebench-v2-harvest.ts` (export a `buildSessionEchoMintCandidate` sibling of `buildCommitEchoMintCandidate`)
- Test: `client/test/solver-types/task-creator-session-echo.test.ts`

**Interfaces:**
- Consumes: `MineableTraceStore.listUnmined/markMined` (Task 6), `findSourceInstanceForRepo` + `admitBuiltMintCandidates` + `HarvestMintDeps` (`_swe-rebench-v2-harvest.ts:151-166`), `lineageHash` (`_swe-rebench-v2-hunk-echo.ts:29`), `runEmpiricalTestDerivation` (`_swe-rebench-v2-empirical-tests.ts:49`), `SyntheticTaskProvenance` (gets `sourceSolver` from the record's operator).
- Produces: `mineSessionEchoes(deps): Promise<HarvestTickResult>` with the same result shape the harvest tick already returns.

Rules encoded (each is an assertion in Step 1):
1. Candidate = record's `acceptedDiff` as gold at `repo @ baseCommit`; `instance_id = <repo-slug>__session-<lineageHash(sourceId, 'full').slice(0,12)>`; the manifest carries `sourceLineageHash` only — **never** `sourceId` (blinded provenance, §7).
2. Provenance: `{ synthetic: true, minterSafe, sourceSolver: <operator safe> }` so `syntheticClaimBlocked` refuses both minter and source-solver claims.
3. **Tier-2 gate:** `publish` for the candidate = `deps.publish && record.publishMinedTasksConsent`. A record without tier-2 consent still mints locally (tier-1 allows it) but its row is never published and never enters the postable union — assert the minted entry has no published artifact reference.
4. Repo gates unchanged and in order: `assertRepoAllowedForMint` before any Docker spend; `assertPublicRepoForPublish` only on the publish path.
5. F2P/P2P derived empirically (never inherited); a session whose diff flips no test is rejected as a dead mint.
6. Mined-or-rejected records are `markMined` so the miner never reprocesses them.

- [ ] **Step 1: Write the failing tests** — one per rule above, using the harvest e2e test's existing fakes (`publicRepoChecker: { isPublic: async () => true }`, fake runner/fetcher, in-memory stores). Rule 3's test uses `isPublic: async () => true` **and** `publishMinedTasksConsent: false` to prove tier-2 is an independent gate from D5.
- [ ] **Step 2: Verify FAIL** → `corepack yarn vitest run test/solver-types/task-creator-session-echo.test.ts`
- [ ] **Step 3: Implement `mineSessionEchoes`** — structure mirrors `runHarvestTick`'s per-candidate body (`harvest-loop.ts:62-140`): list unmined → per record: denylist gate → find source instance → build candidate → empirical derivation → `admitBuiltMintCandidates` with the per-candidate publish flag → `markMined`.
- [ ] **Step 4: Verify PASS. Commit** — `git commit -m "feat(task-creator): session-echo miner — mint captured sessions with blinded provenance + tier-2 publish gate (rung 2 v0)"`

### Task 9: Harvest loop source union + daemon config

**Files:**
- Modify: `client/src/daemon/harvest-loop.ts` (`runHarvestTick`), `client/src/config.ts` (`harvest.sources: Array<'commits'|'sessions'>`, default `['commits']`), `client/src/main.ts` (pass the mineable store into the loop config when sessions are enabled)
- Test: `client/test/daemon/harvest-loop.test.ts`

**Interfaces:**
- Consumes: `mineSessionEchoes` (Task 8), `MineableTraceStore` (Task 6).
- Produces: `HarvestLoopConfig.sources?: Array<'commits'|'sessions'>` — absent ⇒ `['commits']`, so existing configs behave identically.

- [ ] **Step 1: Failing tests** — (a) default config runs only the commit walker (existing fake assertions unchanged); (b) `sources: ['commits','sessions']` also drains the mineable store and merges both `HarvestTickResult`s; (c) `sources: ['sessions']` with an empty store is a clean no-op tick.
- [ ] **Step 2: Verify FAIL → implement → verify PASS.**
- [ ] **Step 3: Update the operator quick-reference block in `docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md` and `docs/runbooks/harvest-e2e-smoke.md` with the `sources` key.**
- [ ] **Step 4: Commit** — `git commit -m "feat(task-creator): harvest loop mines sessions alongside commits (config harvest.sources)"`

---

## Phase 4 — Any-public-repo environments (spike — ends this plan)

### Task 10: Design spike — on-demand eval image for `repo @ commit`

This is the unlock for mining the Jinn repo itself (and any real public repo), and the prerequisite for true hunk-subset echo (a prepared broken state needs a buildable environment). It is a **spike**: the output is a decision record, not merged code. Writing implementation tasks for it now would be guessing — the handoff itself lists three live options.

- [ ] **Step 1:** File the spike issue (Issue Type `spike`, Effort High) titled "On-demand eval image for arbitrary public repo @ commit" with the handoff's three options as the starting hypothesis set: (a) extend the SWE-rebench image builder; (b) generic python-repo image + inferred `install_config`; (c) fork SWE-smith's env-construction machinery (spec §5.4 allows machinery, not dataset).
- [ ] **Step 2:** Timebox: one session per option, each producing the same artifact — an admitted minted instance for one public repo **not** in the validated pool, with built image + pinned digest (the handoff's own AC), plus wall-clock and image-size cost.
- [ ] **Step 3:** Decision criteria, in order: admission yield on 5 sample fix-commits; solver-side reproducibility (image runs on a second machine); build cost; maintenance surface. Record as a DR (`log/decisions/`), then write the follow-on implementation plan against the winner. Hunk-subset echo (true `base ⊕ S ⊖ H`) gets planned in that same follow-on, since the winner determines how a prepared broken state is realised.

---

## Phase 5 — The full loop, run for real

### Task 11: End-to-end dogfood run + runbook

Not TDD — this is the operator procedure that proves the whole thing, with evidence captured.

- [ ] **Step 1:** Pick the dogfood target: a benchmark-pool public repo the team genuinely touches (constraint until Task 10 lands: the repo must have a scorable pool instance). Keep a maintained clone with `git fetch` current.
- [ ] **Step 2:** Operator A config: `harvest: { enabled: true, sources: ['commits','sessions'], repos: [...] }`, `mineableTraces: { consent: 'retain_local', publishConsent: true }`. Operator B: plain solver config (mock-agent or real harness).
- [ ] **Step 3:** Do a real piece of work in a session on that repo (engine execution or, post-follow-on, a jinn-agent session). Verify: record appears in `mineable-traces.json`; next harvest tick mints it; `minted-pool.json` + published row artifact exist; task appears on-chain with `syntheticProvenance`.
- [ ] **Step 4:** Operator A attempts a claim → refused (`syntheticClaimBlocked`). Operator B claims, solves, is graded. Run until the instance has one verified pass and one verified fail (post twice or wait for organic failure).
- [ ] **Step 5:** `node dist/bin/jinn.js solver-nets yield-report` → the instance counts as one exemplar pair in the minted bucket. That number is the loop's output: distill-admissible pairs per §8 — the feedstock Ritsu's distillation (or the Hermes engine) pulls down.
- [ ] **Step 6:** Write `docs/runbooks/task-creator-e2e-dogfood.md` capturing the exact configs, commands, and observed artifacts (CIDs, tx hashes) from this run, and post the evidence table on #1485's thread (or its successor PR).

---

## Explicitly out of scope (name it so nobody builds it by accident)

- Hunk-subset echo's prepared broken state (waits on Task 10's winner).
- jinn-agent session-capture producer (consent lands in Task 7; the capture bridge is a named follow-on).
- Private-repo publication (D5 deferral stands — image disclosure controls unbuilt).
- Distillation-side consumption (Ritsu's track; the boundary is the yield-report exemplar pairs + published trajectories).
- Daemon-managed repo mirrors, targeted test scoping (handoff WP4/WP5 — ergonomics/performance, not loop correctness).

## Self-review notes

- Spec coverage: AC1→Task 4, AC2→shipped in #1485, AC3→Task 2, AC4→Tasks 6–7 (fields + producers + both tiers; tier-2 enforced in Task 8), AC5→Task 1 (+#1485 fixes already pushed), AC6→already fixed on `review/task-creator-v0-fixes`, AC7→#1482. §7 guards untouched; §8 metric consumed by Tasks 5 & 11. §10.1/D5 preserved in Task 8 rule 4.
- Known deliberate deviations from spec §5.3: session-echo replaces hunk-subset for v0 (representability constraint, documented in Phase 3 preamble); "no second-generation echoes" holds — sessions are non-synthetic sources.
- Types cross-checked: `MineableTraceRecord`/`MineableTraceStore` names match across Tasks 6/7/8/9; `HarvestMintDeps`/`admitBuiltMintCandidates`/`HarvestTickResult` match the branch's real exports.
