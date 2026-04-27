# Test architecture — design spec

**Version:** 1.0
**Date:** 2026-04-24
**Author:** adrianobradley + Claude
**Tracks:** `jinn-mono-cnp` (Refactor tests)

This spec defines the test architecture for the monorepo. It replaces the ad‑hoc test conventions that have accumulated in `client/test/` and `client/scripts/`. It is a **structural** spec — not a migration plan. Migration is intentionally incremental (§9).

---

## 1. Problem

The client test suite has grown from a small number of tests into **142 files / 1087 tests** with no codified conventions. Three concrete pains prompted this work:

**A. Velocity.** Adding a new test costs more than it should. Every CLI test redefines `makeCtx`; every engine test redefines `makeOpts`, `makeInput`, and a spy engine subclass. `writer: { write: (s) => { writes.push(s); return true; } }` appears **37 times**. 15 CLI tests define `makeCtx` with **drifted signatures** (some take `argv`, some `env`, some `Partial<CommandContext>`, some `(argv, tty)`).

**C. Coherence.** There is no `TESTING.md`, no runbook, no convention doc. `CONTRIBUTING.md` says *"test/ mirrors src/ structure"* and that the suite has *"267 tests"* — it actually has 1087. New contributors (human or AI) cannot tell the "right way" to add a test, so they invent one.

**D. Trust.** 27 of 142 files use module-level `vi.mock`. A CLI test like `doctor.test.ts` mocks `loadConfig` + `checkRpcNetwork` and asserts the mocks were called correctly. This is fast but proves little about whether real code works. Tests of this shape fail at all three jobs a test should do: catch regressions, document contracts, enable refactoring.

There is also a parallel problem in `scripts/`: ~6,400 LOC of e2e harnesses (`e2e-validate.ts` = 2,967 LOC alone), each copy‑pasting its own `jsonRpc`, `BASE_RPC_URL`, `ANVIL_PORT`, anvil‑spawn, and OLAS‑whale‑impersonation logic. Ports are hand‑assigned with comments like *"Separate port from e2e-validate.ts (8546) to avoid conflicts"* — a smell that parallel runs will collide.

**Non‑goals.**

- We are **not** migrating all 1087 existing tests in this work.
- We are **not** designing a conformance suite (that's Plan F's track).
- We are **not** changing the contracts test harness (Hardhat tests are fine as they are).

---

## 2. First principles

The job of a test, in priority order:

1. **Catch regressions.** When the production path breaks, a test fails.
2. **Document contracts.** Reading a test tells you how to use the module.
3. **Enable refactoring.** You can change internals without breaking consumers.

A test that mocks `loadConfig` and asserts `loadConfig` was called fails at all three.

From this flow four rules that guide everything below:

1. **Mock at the architectural boundary, not the module boundary.** A boundary is code you don't own: network, subprocess, filesystem outside tempdir, the clock. Internal module seams are not boundaries.
2. **Prefer fakes over mocks.** A mock verifies interaction (`was called with X`). A **fake** implements the contract (in‑memory SQLite, in‑memory EVM, scripted subprocess). Fakes let tests exercise real behavior against a controllable substrate.
3. **Prefer dependency injection over module mocking.** `vi.mock` is a last resort for legacy code that isn't DI‑friendly. It fights ESM, creates hoisting bugs, and couples tests to import paths.
4. **Test at the right grain, and be honest about it.** "Unit" tests that pull in the world via module mocks are not unit tests. Call them what they are.

---

## 3. The pyramid

```
[ Manual / Docker acceptance ]            already exists (release:testnet-acceptance)
            ▲
[ E2E: real anvil fork ]                  test/e2e/*.ts (moved from scripts/)
            ▲
[ Integration: real modules + fakes ]     NEW tier; most CLI/engine/api tests live here
            ▲
[ Unit: pure logic, no I/O ]              canonical-json, zod validators, pure helpers
```

**Unit.** Pure functions, no I/O, no DI needed. Examples: `canonical-json.test.ts`, `errors/envelope.test.ts`, zod schema tests. Typically small files, high count.

**Integration.** The default tier for anything that coordinates modules: CLI commands, engine state machine, API builders, restorer impls, daemon loops. Tests wire the **real** target module against **fake** external boundaries (chain, claude subprocess, IPFS, HTTP). No `vi.mock` needed.

**E2E.** Full boot against a real anvil fork, real claude CLI (or mock‑agent), real IPFS gateway. Each e2e has a defined **protocol scenario** (e.g., "creator posts → restorer delivers → evaluator scores → rewards paid"). Slow; run via a separate yarn script, not as part of `yarn test`.

**Manual acceptance.** `release:testnet-acceptance` — already exists, untouched by this spec.

Most of what's labeled "unit" today is really integration. Making that explicit — and giving it real fakes instead of module mocks — is the structural fix.

---

## 4. Directory layout

```
client/
  src/                      (production code, unchanged)
  test/
    <area>/...              (existing tests stay here, mirrored from src/ — cli/, daemon/, etc.)
    e2e/                    (← e2e-*.ts moved from scripts/)
      validate.ts           (was scripts/e2e-validate.ts)
      portfolio-v0.ts       (was scripts/e2e-portfolio-v0.ts)
      prediction-v0.ts      (was scripts/e2e-prediction-v0.ts)
      prediction-apy-v0.ts  (was scripts/e2e-prediction-apy-v0.ts)
      staking.ts            (was scripts/staking-validate.ts)
      stolas.ts             (was scripts/stolas-validate.ts)
      legacy-restorer.ts    (was scripts/e2e-legacy-restorer.ts)
    _support/               (shared test infrastructure; both vitest and e2e import)
      cli.ts                (makeCommandCtx, collectWrites, runCommand)
      engine.ts             (withTempStore, createStateMachineSpy, makeIntentInput)
      store.ts              (withTempStore low-level; used by engine.ts)
      claude.ts             (FakeClaudeRunner — scripted JSON outputs)
      ipfs.ts               (FakeIPFS — in-memory CID store)
      chain/
        interface.ts        (ChainTestHarness — common API for fake + anvil)
        fake.ts             (FakeChain — in-memory EVM state; integration tier)
        anvil.ts            (spawnAnvilFork, impersonate, setBalance, jsonRpc; e2e tier)
        port-allocator.ts   (dynamic port allocation; replaces hand-coded 8546/8547/8548)
        olas-funding.ts     (fundSafeWithOLAS via storage-slot manipulation)
      time.ts               (FakeClock — deterministic `now()` and advance())
  scripts/
    lib/                    (stays; holds only Docker-acceptance helpers)
      acceptance-*.mjs
    sync-deployments.sh     (non-test utilities stay here)
    status.ts
    withdraw.ts
```

**Key decisions:**

1. **Tests mirror `src/`; tier is implicit.** Existing `test/cli/`, `test/daemon/`, `test/restorer/` structure stays. The **tier** a test belongs to is communicated by what it imports from `test/_support/`, not by a folder name. A tier‑named top‑level (e.g. `test/integration/`) would force a 1087‑file move for no benefit.
2. **`test/_support/` is the one home for shared test infrastructure.** Both vitest tests and e2e scripts import from it. No duplication between `test/` and `scripts/`.
3. **E2E scripts move under `test/e2e/`.** They are tests with a different runner — their being CLI scripts was an artifact, not a principle. `package.json` scripts are updated: `"e2e": "tsx test/e2e/validate.ts"`, etc.
4. **`scripts/lib/` stays only for Docker-acceptance orchestration** (genuinely shell‑tool‑adjacent, invoked by yarn).
5. **Fakes and the anvil harness share an interface** (`ChainTestHarness`) so an integration test can ask for either depending on what it's verifying.

---

## 5. Shared helper APIs

These are the **stable** APIs `test/_support/` exposes. Test authors are expected to use these; reinventing them is a code-smell caught in review.

### 5.1 `test/_support/cli.ts`

```ts
export function makeCommandCtx(opts?: {
  argv?: string[];
  env?: Record<string, string>;
  tty?: boolean;
}): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
};

/** Runs a command module and returns its captured output as parsed JSON envelopes. */
export async function runCommand(
  cmd: CommandModule,
  opts?: Parameters<typeof makeCommandCtx>[0],
): Promise<{ envelopes: unknown[]; exits: number[]; raw: string[] }>;
```

Replaces **15+** ad-hoc `makeCtx` definitions across `test/cli/`.

### 5.2 `test/_support/engine.ts`

```ts
export function withTempStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T>;

export function makeIntentInput(
  overrides?: Partial<PersistedIntentInput>,
): PersistedIntentInput;

/** Canonical spy engine: every lifecycle method is a recording stub. Pass fns to override. */
export function createStateMachineSpy(opts?: {
  onClaim?(intent: PersistedIntent): Promise<void>;
  onPreSnapshot?(intent: PersistedIntent): Promise<void>;
  // … etc for every lifecycle method
}): {
  engine: RestorationEngine;
  calls: string[];                         // ordered list
  callsByIntent: Map<string, string[]>;    // keyed by requestId
};
```

Replaces the `TestEngine` / `SpyEngine` subclasses in 5 engine tests.

### 5.3 `test/_support/chain/interface.ts`

```ts
export interface ChainTestHarness {
  rpcUrl: string;
  impersonate<T>(addr: Address, fn: (client: WalletClient) => Promise<T>): Promise<T>;
  setBalance(addr: Address, wei: bigint): Promise<void>;
  setStorageSlot(contract: Address, slot: Hex, value: Hex): Promise<void>;
  mineBlocks(n: number): Promise<void>;
  now(): Promise<number>;        // block timestamp
  advanceTime(seconds: number): Promise<void>;
  teardown(): Promise<void>;
}
```

### 5.4 `test/_support/chain/fake.ts`

```ts
export function createFakeChain(opts?: {
  chainId?: number;
  initialBlock?: number;
  initialTimestamp?: number;
}): ChainTestHarness & {
  deployContract(bytecode: Hex, ...): Address;
  setTokenBalance(token: Address, holder: Address, amount: bigint): void;
};
```

In‑memory EVM via `@ethereumjs/vm` or a purpose‑built state map — whichever is simpler. Decision deferred to implementation plan.

### 5.5 `test/_support/chain/anvil.ts`

```ts
export async function spawnAnvilFork(opts?: {
  forkUrl?: string;     // default: BASE_RPC_URL env or mainnet.base.org
  forkBlock?: number;
  silent?: boolean;
}): Promise<ChainTestHarness & {
  port: number;
  pid: number;
}>;
```

The returned harness implements the same `ChainTestHarness` interface as the fake. **Port is dynamically allocated** via `port-allocator.ts` — no more hand‑coded 8546/8547/8548.

Replaces the `jsonRpc`, `spawn(anvil, …)`, `anvil_setBalance`, `anvil_impersonate` patterns duplicated across **6 e2e scripts**.

### 5.6 `test/_support/claude.ts`

```ts
export function createFakeClaudeRunner(opts?: {
  script?: (desiredState: DesiredState) => RestorationResult;
  timeoutMs?: number;
}): Runner;
```

Replaces `ClaudeRunner` in integration tests. Fully in‑process, deterministic.

### 5.7 `test/_support/ipfs.ts`

```ts
export function createFakeIPFS(): {
  gatewayUrl: string;   // a URL that resolves via a local in-test handler
  put(payload: Uint8Array): Promise<{ cid: string }>;
  get(cid: string): Uint8Array | undefined;
};
```

### 5.8 `test/_support/time.ts`

```ts
export class FakeClock {
  constructor(initialMs?: number);
  now(): number;
  advance(ms: number): void;
}
```

For tests that touch `Date.now()` or intervals.

---

## 6. The SOP (testing.md)

A new file lives at `docs/runbooks/testing.md` (referenced from `CLAUDE.md` and `client/CONTRIBUTING.md`). It codifies:

1. **Which tier does my test belong in?**
   - Pure logic with no I/O → `unit`
   - Orchestration, module coordination, CLI commands, engine, API, daemon loops → `integration`
   - Full protocol scenarios against real EVM → `e2e`

2. **Where does the file go?**
   - Tests mirror `src/`. `src/cli/commands/doctor.ts` → `test/cli/commands/doctor.test.ts`.
   - When a single test file grows past **~400 LOC**, split by aspect: `foo/a.test.ts`, `foo/b.test.ts`.

3. **What do I mock?**
   - **Default: nothing.** Wire a fake from `test/_support/`.
   - **Only with justification:** external boundaries — subprocess (claude CLI), network (chain RPC, IPFS gateway), filesystem *outside* `mkdtemp`.
   - Any `vi.mock` requires a sibling `// MOCK_JUSTIFICATION: <reason>` comment on the line above. Code review enforces this. A future lint rule will enforce it automatically (§10).

4. **How do I write the test?** Three concrete recipes with copy‑pasteable skeletons:
   - Unit test skeleton (pure function)
   - Integration test skeleton (CLI command with `makeCommandCtx` + `FakeChain`)
   - E2E skeleton (`spawnAnvilFork` + real bootstrap)

5. **How do I run tests?**
   - `yarn test` — vitest (unit + integration); target: under 15 seconds total.
   - `yarn e2e` — a specific e2e scenario; target: under 2 minutes per scenario.
   - `yarn e2e:all` — all e2e scenarios; runs serially because they each spawn anvil.

6. **CI gates.**
   - `yarn typecheck` + `yarn test` on every PR.
   - `yarn e2e` + `yarn e2e:portfolio` + … in a separate CI job; parallelized via the port allocator.

The SOP document itself is ~300–500 lines and lives next to the other runbooks. It is explicitly a **living document**: it is updated when helpers change, not when tests change.

---

## 7. The mock policy (restated, because it is the load‑bearing rule)

**A test may use `vi.mock` only if it crosses an external boundary AND dependency injection is genuinely infeasible.**

External boundaries, exhaustive list:

| Boundary | Why it's external | Preferred fake |
|---|---|---|
| Claude subprocess (`ClaudeRunner`) | spawns a real CLI | `FakeClaudeRunner` |
| Chain RPC | remote network | `FakeChain` or anvil |
| IPFS gateway | remote HTTP | `FakeIPFS` |
| HTTP outbound (Autonolas, etc.) | remote network | `msw` or in‑test handler |
| `process.exit` | crashes the test runner | injected via `CommandContext.exit` |
| `Date.now` / setTimeout | nondeterministic | `FakeClock` |
| Filesystem outside tempdir | leaks into user home | use `mkdtemp`, inject root |

If a test wants to mock something **not** in this list, it should inject that dep instead. If the target module doesn't accept that dep as an argument, **fix the module** — that's a design smell.

Every `vi.mock` call requires a `// MOCK_JUSTIFICATION: <one-line reason>` comment on the preceding line. Missing comments are rejected in review.

---

## 8. Migration strategy

**We are not migrating all 1087 tests.** A big‑bang refactor would take weeks and produce zero new value over incremental migration.

The plan:

1. **Land infra + SOP** (this spec → implementation plan).
   - `docs/runbooks/testing.md` (SOP)
   - `test/_support/` (all helpers above)
   - `test/e2e/` (moved scripts; anvil helper + port allocator)
   - Vitest path alias (`@/` → `src/`, `@test/` → `test/_support/`)
   - Stale-count fixes in `CLAUDE.md` + `CONTRIBUTING.md`

2. **Land three exemplar migrations** to prove the pattern:
   - **CLI:** migrate `test/cli/commands/doctor.test.ts` from `vi.mock` to `makeCommandCtx` + `FakeChain`.
   - **Engine:** migrate `test/restorer/engine/engine.test.ts` from inline `TestEngine` subclass to `createStateMachineSpy`.
   - **E2E:** migrate `test/e2e/validate.ts` (was `scripts/e2e-validate.ts`) to use `spawnAnvilFork` + the port allocator. Expected line reduction: ~400–600 LOC.

3. **New tests use the new shape.** Enforced in code review. When a PR touches `src/foo/bar.ts`, the test(s) for that file migrate to the new shape — scoped to the file, not the module. No big blast radius.

4. **Old tests migrate opportunistically.** If no one touches a module, its tests stay as-is indefinitely. The suite is allowed to have mixed patterns during the transition; what it is NOT allowed is new tests in the old shape.

5. **Lint enforcement, later.** Once the pattern is mature (~6 weeks post‑merge), add an eslint rule:
   - Forbid `vi.mock` without adjacent `// MOCK_JUSTIFICATION:` comment.
   - Forbid hand‑rolled `writer: { write: …}` stubs (must use `makeCommandCtx`).
   - Forbid `new Store(':memory:')` outside `withTempStore` and `test/_support/store.ts`.

---

## 9. Acceptance criteria

This work is **done** when:

1. ✅ `docs/runbooks/testing.md` exists, is linked from `CLAUDE.md` and `client/CONTRIBUTING.md`, and contains all six SOP sections (§6).
2. ✅ `test/_support/` exists with all modules in §5. Each exports the API documented here; each has its own unit tests where applicable.
3. ✅ `test/e2e/` exists; all 7 former `scripts/e2e-*.ts` and `scripts/*-validate.ts` are moved; `package.json` scripts point to new paths.
4. ✅ `test/_support/chain/port-allocator.ts` replaces every hand-coded anvil port. No regressions in `yarn e2e`.
5. ✅ Three exemplar migrations land and pass:
   - `test/cli/commands/doctor.test.ts` uses `makeCommandCtx` + `FakeChain`; contains zero `vi.mock`.
   - `test/restorer/engine/engine.test.ts` uses `createStateMachineSpy`; the local `TestEngine` subclass is deleted.
   - `test/e2e/validate.ts` uses `spawnAnvilFork`; `jsonRpc`/`anvil_*` boilerplate is deleted.
6. ✅ Vitest path alias (`@/`, `@test/`) configured and documented.
7. ✅ Stale test counts in `CLAUDE.md` ("14 files, 33 tests") and `CONTRIBUTING.md` ("267 tests") are corrected, or removed in favor of "see `yarn test` output".
8. ✅ `yarn test` still passes: **1085 tests** at parity (±2). No regressions.
9. ✅ `yarn e2e` still passes on parity hardware.

The following are **explicitly not acceptance criteria**:

- ✗ Migrating all 1087 tests to DI + fakes.
- ✗ Eliminating every `vi.mock` in the codebase.
- ✗ An eslint rule enforcing the mock policy (tracked as follow-up, §8.5).

---

## 10. Risks

1. **FakeChain complexity.** An in‑memory EVM that faithfully reproduces Base behavior is non‑trivial. If full EVM semantics are needed (storage slots, logs, delegate‑call), we may end up reaching for anvil even in the integration tier. **Mitigation:** the `ChainTestHarness` interface lets a test swap anvil in for one test without breaking others. If `FakeChain` turns out to be more work than value, we fall back to "integration = fast anvil" and keep the interface.

2. **Import cycle from `scripts/` → `test/_support/`.** If tooling treats `test/` as non‑importable from `scripts/`, we need a tsconfig path or a small refactor. **Mitigation:** moving e2e scripts into `test/e2e/` sidesteps this entirely; `scripts/` only has Docker‑acceptance helpers left, which don't need test infra.

3. **Migration drift.** If new tests keep using old patterns despite the SOP, we end up with both conventions in the tree. **Mitigation:** code review is the first line; the eslint rule (§8.5) is the eventual backstop. The SOP doc is the artefact reviewers point to.

4. **Parallelism of e2e.** Today e2e scripts run serially because ports are hand‑coded. With the port allocator, parallelism becomes possible but exposes **shared global state** (e.g., shared `~/.jinn-client` dirs). **Mitigation:** every e2e harness must `mkdtemp` its own jinn home dir. The shared helper does this.

---

## 11. Out of scope

- **Conformance test suite** (Plan F) — different goal (spec adherence across implementations), different stakeholders. The `test/_support/` fakes may be useful to it later, but designing for that now is premature.
- **Hardhat contract tests.** They already have clean conventions in `contracts/test/phase1/`. Not touched.
- **Property-based testing / fuzzing.** Not today. May be worth revisiting once the DI structure is in place.
- **Coverage targets.** Coverage is a lagging indicator of discipline, not a driver. Once the pyramid is real, we can measure it.
- **Test-runner replacement.** Vitest stays.

---

## 12. Summary

- Test suite has grown past its conventions. Today's shape is *mostly* "module-mocked pseudo-unit tests", which produces low regression-catching power and high boilerplate.
- Best practice: mock at architectural boundaries, prefer fakes over mocks, prefer DI over module mocking. Call the tier what it is.
- Four‑tier pyramid. Most CLI/engine/api tests are actually **integration** tests and should be named that way.
- Shared infrastructure lives in `test/_support/`, not `scripts/lib/`. E2E scripts move into `test/e2e/` so they can import from the same place.
- Migration is incremental via three exemplars + opportunistic catch‑up. No big bang.
- The load‑bearing rule is: **every `vi.mock` needs a `// MOCK_JUSTIFICATION:` comment**, enforced in review now, in lint later.
