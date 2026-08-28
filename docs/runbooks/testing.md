# Testing — standard operating procedure

This runbook is the canonical guide for writing tests in the Jinn monorepo.
Design rationale lives in `docs/superpowers/specs/2026-04-24-test-architecture-design.md`.

## The pyramid

Four tiers. Most tests belong in the **integration** tier.

1. **Unit** — pure logic, no I/O, no DI needed. Examples: `canonical-json.test.ts`,
   zod schema validators, pure helpers.
2. **Integration** — orchestration; real target module against **fake** external
   boundaries from `test/_support/`. This is the default tier for CLI commands,
   engine state-machine logic, API builders, harnesses, and daemon loops.
3. **E2E** — real anvil fork, real IPFS, real or mocked Claude. One file per
   protocol scenario in `operator/test/e2e/`.
4. **Manual acceptance** — `yarn release:testnet-acceptance`. Out of scope for
   this runbook.

## Which tier does my test belong in?

- Pure function with no external dependencies → **unit**
- CLI command, HTTP builder, state machine, bootstrap flow → **integration**
- Full protocol scenario against real EVM → **e2e**

## Where does the file go?

Tests mirror `src/`:
- `operator/src/cli/commands/doctor.ts` → `operator/test/cli/commands/doctor.test.ts`

When a single test file grows past ~400 LOC, split by aspect:
- `test/cli/commands/foo/a.test.ts`, `test/cli/commands/foo/b.test.ts`

E2E scripts live in `operator/test/e2e/<scenario>.ts` and are invoked via
`yarn e2e`, `yarn e2e-prediction-apy-v0`, etc. — not vitest.

## What do I mock?

**Default: nothing.** Wire a fake from `test/_support/`:

| Boundary | Fake |
|---|---|
| Claude subprocess | `createFakeClaudeRunner()` from `@test/claude.js` |
| Chain RPC (integration) | `spawnAnvilFork()` from `@test/chain/anvil.js` |
| IPFS | `createFakeIPFS()` from `@test/ipfs.js` |
| Time | `new FakeClock()` from `@test/time.js` |
| SQLite store | `withTempStore(fn)` from `@test/store.js` |
| `process.exit` | `makeCommandCtx()` from `@test/cli.js` captures it |

Only boundaries are legitimate targets for `vi.mock`. Every `vi.mock` call
requires a `// MOCK_JUSTIFICATION:` comment on the preceding line.

**Bad** — mocks an internal module:
```ts
vi.mock('../../src/config.js', () => ({ loadConfig: () => ({ ... }) }));
```

**Good** — inject the dep instead:
```ts
const cmd = createDoctorCommand({ loadConfig: () => ({ ... }), /* … */ });
```

**Legit vi.mock** — external boundary, DI infeasible:
```ts
// MOCK_JUSTIFICATION: child_process.spawn is a leaf syscall; cannot DI without a shim module we don't own.
vi.mock('node:child_process', () => ({ /* … */ }));
```

## Skeletons

### Unit test

```ts
import { describe, it, expect } from 'vitest';
import { canonicalizeJson } from '@/lib/canonical-json.js';

describe('canonicalizeJson', () => {
  it('sorts keys recursively', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
```

### Integration test — CLI command

```ts
import { describe, it, expect } from 'vitest';
import { createDoctorCommand } from '@/cli/commands/doctor.js';
import { runCommand } from '@test/cli.js';

describe('doctor command', () => {
  it('emits ok envelope on green path', async () => {
    const cmd = createDoctorCommand({
      loadConfig: () => ({ /* fake config */ } as any),
      checkRpcNetwork: async () => ({ ok: true, /* … */ }),
      /* other deps */
    });
    const { envelopes } = await runCommand(cmd);
    expect((envelopes[0] as { ok: boolean }).ok).toBe(true);
  });
});
```

### Integration test — engine / state machine

```ts
import { describe, it, expect } from 'vitest';
import { withTempStore } from '@test/store.js';
import { makeTaskInput, createStateMachineSpy } from '@test/engine.js';

describe('engine lifecycle', () => {
  it('transitions DISCOVERED → claim', async () => {
    await withTempStore(async (store) => {
      const { engine, calls } = createStateMachineSpy({
        store,
        onClaim: async () => { /* success */ },
      });
      const task = engine.testPersistence.insertDiscovered(makeTaskInput());
      await engine.claim(task);
      expect(calls).toContain('claim');
    });
  });
});
```

### E2E

```ts
import { spawnAnvilFork } from '../_support/chain/anvil.js';
import { fundAddressWithOLAS } from '../_support/chain/olas-funding.js';

const chain = await spawnAnvilFork({ silent: true });
try {
  await fundAddressWithOLAS(chain, someSafeAddress, 5000n * 10n ** 18n);
  // … drive the scenario via real CLI subprocesses, viem clients, etc.
} finally {
  await chain.teardown();
}
```

## How do I run tests?

| Command | Scope | Target time |
|---|---|---|
| `yarn test` | vitest (unit + integration) | < 15 s |
| `yarn test:watch` | vitest in watch mode | — |
| `yarn e2e` | one e2e scenario (validate) | < 2 min |
| `yarn e2e-prediction-apy-v0` | prediction-apy e2e | < 2 min |
| `yarn e2e:prediction` | prediction-v0 e2e (compiles contracts first) | < 3 min |
| `yarn staking` | staking bootstrap e2e | < 2 min |
| `yarn stolas` | stolas bootstrap e2e | < 2 min |
| `yarn e2e:cold-start-builder` | acceptance tier — plug-in builder cold-start | ~90 s |

## Acceptance tier (`test/acceptance/`)

The acceptance tier hosts slow, real-integration tests that require external
binaries and exercise the full CLI dispatch surface. It is **not** run by
default — invoke it explicitly:

```bash
cd operator
yarn e2e:cold-start-builder
```

**Prerequisites:**
- `anvil` in PATH (Foundry — `curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- Node 22+

**What it covers:** The cold-start builder loop from spec §6.7 — scaffold →
pack → publish (Stage 1 lazy ensure against a local IdentityRegistry) →
indexer event ingest → Discovery API surface → operator install → stub-Hermes
task run → envelope attribution → SPA panels render. A dual-role test verifies
that a pre-bootstrapped identity is reused without re-minting.

**Fixture files** live under `operator/test/acceptance/_fixtures/`. See
`operator/test/acceptance/ACCEPTANCE.md` for the full fixture inventory.

**CI gating:** The acceptance tier is NOT in the per-PR CI gate (which runs
only `yarn typecheck` + `yarn test`). It is run nightly and as part of the
release gate before a Monday named cut.

## Troubleshooting (client)

### `better-sqlite3` NODE_MODULE_VERSION mismatch

If `yarn test` fails loading SQLite with an ABI mismatch (built for a different Node than the one running), reinstall native deps against the active runtime:

```bash
cd operator
corepack enable   # pin Yarn via packageManager
rm -rf node_modules
yarn install
```

Use **Node 22** where possible (`engines` in `operator/package.json`). CI should match that major version.

## CI gates

- Every PR that touches the operator lane (the `changes` job in `ci.yml` gates
  this): `yarn typecheck` + `yarn lint:no-late-mount` + `yarn lint:no-error-leak`
  + `yarn lint:no-fixed-test-port` + `node --test
  scripts/check-no-fixed-test-port.test.mjs` + `yarn test`.
- Nightly / release: all `yarn e2e*` scenarios serially.
- The default suite already runs in parallel on CI — three forked workers over
  ~850 files. See [Worker parallelism and ports](#worker-parallelism-and-ports)
  for what that shares and the rules that follow from it, including the three
  sanctioned ways to get a port.

## Worker parallelism and ports

`operator/vitest.config.ts` overrides none of `pool`, `isolate`,
`fileParallelism`, or `maxWorkers`, so vitest 4 resolves them to `forks`,
`true`, `true`, and `max(availableParallelism() - 1, 1)`. This repository is
public, so `ubuntu-latest` is a 4-vCPU runner and **CI runs three forked
workers** over ~850 test files.

**What that isolates.** `forks` plus `isolate: true` gives every test *file* a
fresh child process, and `test/_support/isolate-home.ts` gives that process a
fresh `$HOME` and `$TMPDIR`. Module state, globals, `process.env`, and home
directories therefore cannot leak between files — not by discipline, by
construction.

**What it does not.** Four things stay shared across workers: the 127.0.0.1 TCP
port space, filesystem paths outside the isolated home, the repository checkout
itself, and the machine's CPU and memory. Every flake measured under #1627 came
from the last two.

### Never hard-code a port in 32768–65535

That band is the **union** of the two OS defaults this suite runs on: the Linux
`ip_local_port_range` default (32768–60999, the CI runners) and the macOS
ephemeral range (49152–65535, the laptops). Neither contains the other —
32768–49151 is Linux-only and 61000–65535 is macOS-only — so guarding either
one alone leaves a live hole on the other platform. A sibling worker's
`listen(0)` can be handed any port in the band, so a test that hard-codes one
can have it taken mid-run. Three sanctioned forms, in preference order:

| The port is bound by | Use |
|---|---|
| the test itself | `listen(0, '127.0.0.1')`, then read `server.address().port` — the kernel assigns and holds atomically, so there is no allocate-then-rebind window. Always preferred where it is available. |
| a child process (Anvil, Ponder, a spawned daemon) | either a **fixed port below 32768** reserved in the port registry, or `await allocateAnvilPort()` from `@test/chain/port-allocator.js` when a fixed reservation is impractical (many ports, or several instances inside one file). The tradeoff: the allocator has a narrow allocate-then-rebind window, the fixed reservation has none but must be unique repo-wide. |
| nothing — the assertion *is* "nothing is listening here" | a fixed port **below 32768**, with a comment saying why |

The invariant under all three: **never a literal inside 32768–65535 in a
port-shaped position** — a `.listen(` argument, a port-shaped object key, or a
port-ish `const`. Those are the positions the lint can see; a port buried in a
URL string (`fetch('http://127.0.0.1:45020/health')`) is outside it, and so are
the other gaps listed under "What this guard does not catch" in the header of
[`operator/scripts/check-no-fixed-test-port.mjs`](../../operator/scripts/check-no-fixed-test-port.mjs).
The rule still applies to them; only the enforcement stops. The registry of
fixed below-band ports currently in use lives in the header of
[`operator/test/release/tier-1/T1.2-harness-readiness-contract.ts`](../../operator/test/release/tier-1/T1.2-harness-readiness-contract.ts) —
add to it when you reserve one.

`yarn lint:no-fixed-test-port` enforces this. It also fails if
`operator/vitest.config.ts` acquires a parallelism pin or an isolation
opt-out: `isolate: false`, `singleFork` / `singleThread: true`,
`fileParallelism: false`, `maxWorkers` / `maxForks` / `minForks` /
`maxThreads` / `minThreads` pinned to 1, `maxConcurrency: 1`, or a `pool:`
override. Switching parallelism off would make every cross-worker collision
vanish locally and silently retire the reason these rules exist. `isolate:
false` is the worst of the set: it also retires the fresh-process-per-file
property that [the measurement](#the-measurement-1627-2026-08-27) rests on,
and it does so while leaving the suite green.

A line carrying `lint:no-fixed-test-port-allow` is skipped, on all three rules.
For the multi-line array form the marker goes on the **element** line, not on
the `ports: [` header — the header is not where the literal is reported.
Suppressing a parallelism pin is the one use that should give you pause: the
guard's premise is that changing parallelism is a deliberate decision that
edits the guard in the same commit, so a marker there is a note to the next
reader that you chose not to. The guard is seven
regexes over source text and both of its failure modes are expensive on a
required gate, so its behaviour is pinned by a fixture table,
`operator/scripts/check-no-fixed-test-port.test.mjs`, which CI runs under
`node --test` in the same job. Change a rule and change the table with it.

### Beware fixed time and iteration budgets

A `for (let i = 0; i < 200; i++) { await sleep(10) }` poll is a ~2s budget on an
idle laptop and a coin flip on a runner where three workers share four vCPUs.
Two rules:

- Bound a wait by **wall clock**, not by iteration count.
- **Assert on exhaustion.** A loop that falls through silently reports the
  starvation as whatever the next assertion happens to check, which sends the
  reader to the wrong subsystem entirely.

### The measurement (#1627, 2026-08-27)

Two instruments, and only one of them is CI-equivalent.

**The mined CI history is.** Every past `Typecheck & Test` job ran the suite on
the real runner under the real topology, so each is a genuine sample of the
thing under diagnosis: **1176 executed `check` jobs across 70 days**
(2026-06-18 to 2026-08-27; runs where the `changes` gate skipped `check` are
excluded). Every rate below comes from this instrument, so here is how to
re-derive it — the numbers are a point-in-time reading of a moving window, not
a committed artifact, and a later run will not reproduce them exactly:

```bash
gh run list --repo Jinn-Network/mono --workflow ci.yml \
  --created 2026-06-18..2026-08-27 --limit 2000 \
  --json databaseId --jq '.[].databaseId' > runs.txt
# One `check` job per run, skipping runs where the `changes` gate never started it.
while read -r id; do
  gh api "repos/Jinn-Network/mono/actions/runs/$id/jobs?per_page=100" \
    --jq '.jobs[] | select(.name == "Typecheck & Test") | [.id, .conclusion] | @tsv'
done < runs.txt > check-jobs.tsv
# The failure logs the classification below reads.
mkdir -p logs && awk -F'\t' '$2 == "failure" { print $1 }' check-jobs.tsv |
  while read -r job; do
    gh api "repos/Jinn-Network/mono/actions/jobs/$job/logs" > "logs/$job.txt"
  done
grep -rl 'EADDRINUSE' logs/ | wc -l   # the port-collision census: 0
```

**The local runs are a lower-contention approximation.** The full suite was run
at the CI *worker count* — three — but on a 12-core macOS host, so the
contention ratio is 3 workers over 12 cores, not CI's 3 over 4 vCPU. Contention
is the exact variable the diagnosis blames, so a bare local run at
`--maxWorkers=3` is not a CI stand-in — the 3-of-20 single-file reproduction
below needed a separately applied 8-way CPU load on top of it:

```bash
cd operator
yarn build:sdk && yarn build:stack && yarn build:plugin && yarn build:core && yarn build:layer
SKIP_HL_TESTS=1 ./node_modules/.bin/vitest run --maxWorkers=3
```

Results:

- **Zero** EADDRINUSE across all 228 retrieved vitest-step failure logs. Zero
  contact with the real `~/.jinn-client`; every home-related error names an
  isolated `/tmp/jinn-home-*` path. No cross-file global-state leakage, as the
  `forks` + `isolate` topology predicts.
- Failures attributable to cross-worker interference: **70 of 1176 (5.95%)**
  over the window, but bimodal around the fix for #2641 — **6.83% before**,
  **2.22% after**. 64 of those 70 were that one already-fixed cause: two tests
  ran `npm pack --dry-run` in the live checkout, whose prepack swapped
  `node_modules/@jinn-network` symlinks for seconds and killed whichever
  concurrent workers were spawning children through the tree. The remediation
  (`operator/test/_support/pack-probe.ts`, a throwaway-copy pack probe) is in
  the current tree.
- The residual class is load-sensitive budgets, not state leakage. Fixed under
  #1627: `swe-rebench-v2-generator-cooldown.test.ts` (a re-publication gate
  comparing two ISO millisecond timestamps, in a block that needs
  `shouldAdvanceTime: true` — so it required two consecutive awaited writes to
  land in the same millisecond; 1 of 5 local full-suite runs, and 3 of 20
  single-file runs under the added 8-way CPU load, went red before the fix and
  0 of 20 after) and
  `converged-delivery-legacy-evaluator.test.ts` (the 200x10ms poll above,
  independently confirmed by a CI run that failed on attempt 1 and passed on
  attempt 2 of the *same* run — a same-tree flip, which is the only
  pass/fail evidence that proves a flake rather than a moving base).
- **No broad serialization was added**, and none is warranted: nothing measured
  was cross-worker *state* leakage, so `isolate: true` is doing its job.
- **Confirmed after the fixes, 2026-08-28.** Three further full-suite runs at
  `--maxWorkers=3` on the same host: 841 files / 7512 tests passed on each, exit
  0, zero `EADDRINUSE`, and the home stat manifest below unchanged across all
  three.

Named but not fixed here, both load-sensitive budgets with CI evidence and no
local reproduction: `test/cli/native-identity.test.ts` (18 real process boots
against a 60s budget) and `test/_support/chain/anvil.test.ts` /
`olas-funding.test.ts` (a 15s anvil readiness budget while forking Base mainnet
over the network).

**Verifying that no test touched the real home.** The in-suite guards —
`operator/test/config/home-isolation.test.ts`,
`operator/test/config/tmp-isolation.test.ts`, and
`.github/scripts/vitest-tmp-isolation.test.mjs` — pin the wiring from three
angles and no fourth was added. They cannot, however, catch an out-of-band
write (a `process.chdir`, a `'/tmp/…'` literal, a spawned child whose env
allowlist drops `TMPDIR`), so the reproduction runs took an external stat
manifest of `~/.jinn-operator` and `~/.jinn-client` before and after each run:

```bash
snap() {
  for d in "$HOME/.jinn-operator" "$HOME/.jinn-client"; do
    # Exclude ~/.jinn-client/autopilot: a running autopilot writes there
    # concurrently and guarantees a false positive.
    [ -d "$d" ] && find "$d" -path "$HOME/.jinn-client/autopilot" -prune -o -print0 |
      xargs -0 stat -f '%N %m %z'   # GNU: stat -c '%n %Y %s'
  done | sort
}
snap > before.txt && <the suite run> ; snap > after.txt && diff before.txt after.txt
git -C <checkout> status --porcelain   # and nothing written into the tree
```

Across the five original runs and the three confirmation runs: no new entries,
no mtime or size change, and nothing written into the checkout.

### Run `yarn test`, not a bare `vitest run`

`yarn test` is `build:sdk && build:stack && build:plugin && build:core &&
build:layer && vitest run`. A bare `vitest run` on an unbuilt tree produces
hundreds of `Failed to resolve entry for package "@jinn-network/core"`-style
failures — an unbuilt portal `dist/`, not a flake. The same error appears if
anything rebuilds the portal chain *while* vitest is running, because the
rebuild relinks `node_modules/@jinn-network` underneath the live workers. Never
run `yarn typecheck` or `yarn build` concurrently with the suite.

## Temp directories and `$HOME`

No test reaches the real `~`, and no test leaves a directory behind in the user
temp directory. Both come from wiring, not from per-call-site cleanup — which a
failing test skips anyway:

- **Suites under `packages/`** wire the shared seam in
  [`test-support/tmp-isolation/`](../../test-support/tmp-isolation/README.md):
  `setupFiles` points `$TMPDIR` at a managed root per test file, `globalSetup`
  sweeps every root once the workers are gone. Two lines per `vitest.config.ts`.
- **The operator's five configs** wire `operator/test/_support/isolate-home.ts`
  and `global-tmp-root.ts`, which do the same and isolate `$HOME` as well.

`.github/scripts/vitest-tmp-isolation.test.mjs` runs on every PR and fails if a
config is missing either hook — including a config that has just been added.

A `spawn`ed child inherits only what its `env` allowlist names, so an allowlist
that omits `TMPDIR`/`TMP`/`TEMP` puts the child's scratch files outside the
managed root. Name all three, or write `temp-env: <reason>` inline where the
child must not inherit them.

## Adding a new helper to `test/_support/`

1. Write the helper's own unit test under `test/_support/<name>.test.ts`.
2. Implement the helper. Prefer pure TS; lean on existing node APIs for I/O.
3. Document the helper's public API in a comment at the top of the file.
4. Migrate one existing test to use it, as proof that the API fits.

## Migration policy

Existing tests stay as-is until someone touches them. When a PR modifies
`src/foo/bar.ts`, the tests for that file migrate to the new shape in the same PR.
No big-bang refactor. New tests always use the new shape.
