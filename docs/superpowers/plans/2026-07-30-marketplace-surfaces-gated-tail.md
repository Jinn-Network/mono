# Marketplace Surfaces — Gated Tail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the gated follow-ups of the 2026-07-30 marketplace-surfaces design (§10 rows 4, 5, 6, 8, 9-step-2, 10, 11, 12) — the work client and CLI convergence, the `sdk` R2/R3 retirement, the physical explorer separation, and the DevX docs — each firing when its gate lands.

**Architecture:** Five phases, one per gate. A phase is not a dependency chain between phases; it is a *release valve*. Phase A opens when daemon cutover stage 3 lands and #2293 ships canaries: the operator's `src/requester/` module is packaged (not rewritten) as `@jinn-network/marketplace-work-client`, the CLI re-platforms onto it, and the two-posting-stacks risk closes. Phase B opens per daemon stage: each `sdk` subpath is removed as its `client/` consumers retire, one coordinated minor bump each. Phase C opens when the standalone Autopilot repository migrates to TEP Submission posting. Phase D opens at daemon stage 4: the explorer physically separates from the Ponder process. Phase E is documentation, gated on #2293 stable and the profile-URI hosting of follow-up 1, with three start-anytime tasks.

**Tech Stack:** TypeScript / Node 22 / Yarn 4.13.0 workspaces with `portal:` resolution; viem; vitest (package tests); `node --test` (guard scripts under `.github/scripts/`); GitHub Actions; Ponder + Vite/React (Phase D); Railway.

**Design authority:** [`docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md`](../specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md) (v0.2). The operator-daemon composition design and program supply the gates and the `src/requester/` seam. **The designs are law.** Discovering a design is wrong is a finding with a proposed disposition on the PR — never a silent patch. This plan already carries four such findings (see "Findings against the design", below); do not re-litigate them, do not silently work around new ones.

## Global Constraints

- Node 22; `corepack enable` so Yarn matches each package's `packageManager` (`yarn@4.13.0`).
- **Branch targets differ by phase.** Phases B and C target `next` — `packages/sdk` and the release train live there, and the immediate tranche established this split with evidence (its Task 1 went to `next`; Tasks 2–3 went to `integration/evidence-v1`). Phases A and D target `integration/evidence-v1` — the operator runtime, the marketplace tree's new packages, and the indexer's post-step-1 shape exist only there. Phase E is documentation: `next`.
- PRs never target `main` (AI workflow rule 10). One branch + PR per task; `Closes #<issue>` in the body, except where a task is one step of a multi-step issue (`Part of #2296`).
- **Assumed merged before any task here:** PRs #2306 (sdk R1 — `./benchmarking` dropped, `npm-publish.yml` sdk version parameterized, sdk at `0.2.0`), #2307 (custody tripwire guard `.github/scripts/custody-boundaries.test.mjs` + docs key guard `.github/scripts/docs-key-guard.test.mjs`), #2308 (#2296 step 1 — the swe-rebench-v2 held-out slate re-homed to `@jinn-network/benchmarking-records`, the indexer re-pointed, `.github/scripts/indexer-boundaries.test.mjs` guarding the edge). Verify with `git log --oneline origin/next -20` and `git log --oneline origin/integration/evidence-v1 -20` before starting a task; if a PR is not in, stop and report.
- **0.x semver (design §8.2): minor = breaking** (removal or rename of an exported surface, or an acceptance-behavior change — always changelogged with a migration note); **patch = additive or fix**. Types follow the same rule as runtime surface; no type exemption.
- **Every `sdk` export removal is a coordinated minor bump with a changelog migration note, never a silent break** (design §6). The standalone [`Jinn-Network/autopilot`](https://github.com/Jinn-Network/autopilot) pins `sdk@0.1.1` + `client@0.2.2` exactly, so a removal cannot reach it by drift — but the bump must still be announced in that repository before the sdk publishes.
- **Custody law (design §4.1) binds every package this plan creates:** C1 no key material; C2 no ambient authority acquisition (no `process.env`, no filesystem, no keystore reads, no ambient chain selection); C3 write capability enters only through injected signer objects — **no API parameter anywhere accepts a private-key string, mnemonic, or seed**; C4 verification profiles fail closed; C5 trusted-publisher provenance.
- **Guard trio ships with each new tree, not after:** package inventory, source boundaries, packed types — plus the CI workflow wiring.
- American English throughout (`distill`, never `distil`). No emoji anywhere. No product names in tier-1–3 package code.
- Docs guard: no raw private keys in documentation or examples; the only permitted literals are the standard Anvil dev-account key set (design §8.3, as amended 2026-07-30 during execution).
- Worktrees: create one per task via superpowers:using-git-worktrees at execution time, branched from the task's stated target after `git fetch origin` — a pre-created worktree can predate its dependency merges.

---

## Gate map

| Phase | Gate | Branch target | Design rows |
| --- | --- | --- | --- |
| A | daemon cutover stage 3 landed **and** #2293 canary packages published | `integration/evidence-v1` | §10 rows 4, 5, 6, 12; §8.3 quickstart 3 |
| B | daemon cutover stages 1–4, per stage | `next` | §10 row 8 (R2) |
| C | standalone Autopilot repository migrates to TEP Submission posting | `next` | §10 row 8 (R3) |
| D | daemon cutover stage 4 (discovery serving) | `integration/evidence-v1` | §10 row 10 (#2296 step 2) |
| E | #2293 stable + follow-up 1's profile-URI hosting (tasks E1–E3 are start-anytime) | `next` | §10 row 11 |

## Findings against the design (raise these on the PRs; do not silently work around)

These came out of the evidence-gathering for this plan and are recorded here so an implementer does not rediscover them mid-task.

1. **F1 — R2's "each as its `client/` consumers retire per stage" does not hold for five subpaths.** Grep evidence is in Task B5. `./harness`, `./checkpoint`, `./solvernets/prediction-v1`, `./solvernets/swe-rebench-v2` and the root `.` export all have consumers that **no cutover stage retires** (the external harness-authoring templates and `client/docs/path-2/`, the eval/training orchestrator, the shipped harness implementations, the payload types). *Proposed disposition:* split R2 into **R2a** — retires with the cutover (`./plugins`, the held-out-slate subpath, `./solvernets`, `./solvernets/jinn-repo`), executed as Tasks B1–B4 — and **R2b** — *re-homes* rather than retires, tracked as its own follow-up issue (Task B5). R3's end state is unchanged; it is reached later than the design implies.
2. **F2 — `./plugins` has zero in-repo importers today** (only the sdk's own README, smoke test, and self-test). It is an R1-shaped removal (like `./benchmarking`), not an R2 one. *Proposed disposition:* remove it in Task B1 at the first Phase-B bump, subject to the plugin session's word on plugin content; no consumer migration is required.
3. **F3 — `packages/task-execution/profiles` mentions `@jinn-network/sdk/solvernets/jinn-repo` in prose only** (`src/documents/repository-work-1.0.ts:72`, a doc comment), not as an import. There is no tier-law violation, but the comment must be updated in the same change that removes the subpath (Task B3) or it becomes a dangling reference in a published tier-2 package.
4. **F4 — the design's §5.1 "packaging, not rewriting" is testable, and the test is the acceptance criterion.** If the requester module cannot be moved into a package without editing its logic, the extraction boundary was violated upstream in daemon stage 3. Task A3 states this explicitly: a required edit is a finding filed against the stage-3 work, not a workaround in this plan.

---

# Phase A — the work client (gate: daemon stage 3 + #2293 canaries)

Branch target: `integration/evidence-v1`. Order is strict: **A1 before A2** (kit before packaging is the standing rule, design §4.3 step 1 and §5.1), then A2 → A3 → A4 → A5 → A6. A7 and A8 may run in parallel with A5/A6.

### Task A1: Preflight-behavior golden fixtures (design §10 row 4)

Kit-first, authored against the stage-3 posting flow, pinning today's CLI behavior as the reference. These are the drift alarm until Task A6 makes parity a code fact.

**Files:**
- Create: `packages/marketplace/testing/src/requester-preflight-conformance.ts`
- Create: `packages/marketplace/testing/src/requester-preflight-conformance.test.ts`
- Create: `packages/marketplace/testing/fixtures/requester-preflight/*.json` (six fixtures, listed in Step 1)
- Create: `packages/marketplace/testing/fixtures/requester-preflight/manifest.json` (SHA-256 manifest)
- Modify: `packages/marketplace/testing/src/index.ts` (re-export)
- Modify: `packages/marketplace/testing/package.json` (add `./requester-preflight-conformance` export)
- Modify: `.github/scripts/marketplace-source-boundaries.test.mjs:290` (add the subpath to the `testing` export allowlist)

**Interfaces:**
- Produces: `runRequesterPreflightConformance(harness: RequesterPreflightHarness): Promise<void>` and `interface RequesterPreflightHarness { preflight(input: PreflightInput): Promise<PreflightOutcome> }` — Tasks A4 and A6 both drive this kit.
- Consumes: the stage-3 posting flow's exported preflight surface at `client/src/requester/` (stage-3 deliverable). The behavior it pins comes from `client/src/tasks/submit-preflight.ts` (`assertMarketplaceTaskRequestFreshness`, `assertMarketplaceTaskFunding`, `selectMarketplaceTaskSolverNet`, `runMarketplaceTaskSubmitPreflight`, `MarketplaceTaskSubmitPreflightError`, the `MARKETPLACE_TASK_SUBMIT_PREFLIGHT_CATEGORIES` taxonomy) and `client/src/tasks/posting-service.ts` (`TaskPostOwnershipLostError`, `TaskPostBroadcastUncertainError`, `TaskPostRecoveryOnlyError`).

- [ ] **Step 1: Author the six fixtures from the shipped CLI behavior**

Read `client/src/tasks/submit-preflight.ts` end to end and transcribe the actual thresholds — do not invent them. Write one JSON fixture per named behavior into `packages/marketplace/testing/fixtures/requester-preflight/`:

- `01-fresh-request-accepted.json` — a request whose deadline is beyond `MARKETPLACE_TASK_FRESHNESS_RESERVE_MS` (60_000) from `now`; expected `{ outcome: "accepted" }`.
- `02-stale-request-rejected.json` — deadline inside the reserve; expected `{ outcome: "rejected", error: "MarketplaceTaskRequestExpiredError" }`.
- `03-insufficient-funds-rejected.json` — Safe balance below the escrow amount; expected `{ outcome: "rejected", error: "MarketplaceTaskSubmitPreflightError", category: "funding" }`.
- `04-no-live-solvernet-rejected.json` — an empty live-target set; expected `{ outcome: "rejected", error: "MarketplaceTaskSubmitPreflightError", category: "target" }`.
- `05-duplicate-intent-not-reposted.json` — a durable intent already recorded for the same idempotency key; expected `{ outcome: "recovered", posted: false }`.
- `06-taskcreated-recovery.json` — a broadcast whose receipt was lost but whose `TaskCreated` log exists; expected `{ outcome: "recovered", posted: true }`.

Each fixture's shape:

```json
{
  "name": "stale request rejected",
  "input": { "nowMs": 1769800000000, "deadlineMs": 1769800030000, "escrowWei": "1000000000000000", "safeBalanceWei": "5000000000000000", "liveTargets": ["0xabc…"], "recordedIntents": [] },
  "expected": { "outcome": "rejected", "error": "MarketplaceTaskRequestExpiredError" }
}
```

Copy the real category strings from `MARKETPLACE_TASK_SUBMIT_PREFLIGHT_CATEGORIES`; if a category you need is absent, that is a finding, not a fixture invention.

- [ ] **Step 2: Write the SHA-256 manifest**

```bash
cd packages/marketplace/testing/fixtures/requester-preflight
node -e '
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const entries = readdirSync(".").filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();
const digests = Object.fromEntries(entries.map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]));
writeFileSync("manifest.json", JSON.stringify({ version: 1, digests }, null, 2) + "\n");
'
```

The manifest is the compatibility contract (design §8.1): fixtures are append-only, never edited; a wrong fixture is superseded plus a dated errata record, never corrected in place.

- [ ] **Step 3: Write the kit**

`packages/marketplace/testing/src/requester-preflight-conformance.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

export interface PreflightInput {
  nowMs: number;
  deadlineMs: number;
  escrowWei: string;
  safeBalanceWei: string;
  liveTargets: readonly string[];
  recordedIntents: readonly string[];
}

export type PreflightOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; error: string; category?: string }
  | { outcome: 'recovered'; posted: boolean };

export interface RequesterPreflightHarness {
  readonly name: string;
  preflight(input: PreflightInput): Promise<PreflightOutcome>;
}

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'requester-preflight');

function loadFixtures(): { name: string; input: PreflightInput; expected: PreflightOutcome }[] {
  const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8')) as {
    digests: Record<string, string>;
  };
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  return files.map((file) => {
    const bytes = readFileSync(join(fixtureDir, file));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (manifest.digests[file] !== digest) {
      throw new Error(`fixture ${file} does not match its manifest digest — fixtures are immutable (design 8.1)`);
    }
    return JSON.parse(bytes.toString('utf8'));
  });
}

export function runRequesterPreflightConformance(harness: RequesterPreflightHarness): void {
  describe(`requester preflight conformance (${harness.name})`, () => {
    for (const fixture of loadFixtures()) {
      it(fixture.name, async () => {
        await expect(harness.preflight(fixture.input)).resolves.toEqual(fixture.expected);
      });
    }
  });
}
```

- [ ] **Step 4: Write the kit's own self-test**

`packages/marketplace/testing/src/requester-preflight-conformance.test.ts` — drive the kit with an in-memory harness that reimplements the six behaviors from the fixtures, proving the kit itself is sound before any real implementation exists:

```ts
import { runRequesterPreflightConformance, type PreflightInput, type PreflightOutcome } from './requester-preflight-conformance.js';

const reference = {
  name: 'reference',
  async preflight(input: PreflightInput): Promise<PreflightOutcome> {
    if (input.recordedIntents.length > 0) return { outcome: 'recovered', posted: false };
    if (input.deadlineMs - input.nowMs < 60_000) {
      return { outcome: 'rejected', error: 'MarketplaceTaskRequestExpiredError' };
    }
    if (BigInt(input.safeBalanceWei) < BigInt(input.escrowWei)) {
      return { outcome: 'rejected', error: 'MarketplaceTaskSubmitPreflightError', category: 'funding' };
    }
    if (input.liveTargets.length === 0) {
      return { outcome: 'rejected', error: 'MarketplaceTaskSubmitPreflightError', category: 'target' };
    }
    return { outcome: 'accepted' };
  },
};

runRequesterPreflightConformance(reference);
```

Fixture `06-taskcreated-recovery.json` needs a discriminator the reference can act on; use a `recordedIntents` entry carrying the broadcast marker you chose in Step 1, and mirror that choice here. If the reference cannot express a fixture, the fixture is under-specified — fix the fixture in Step 1 (it is not yet published, so it is not yet immutable) and regenerate the manifest.

- [ ] **Step 5: Wire the export and the boundary allowlist**

In `packages/marketplace/testing/package.json`, add to `exports`:

```json
"./requester-preflight-conformance": {
  "import": "./dist/requester-preflight-conformance.js",
  "types": "./dist/requester-preflight-conformance.d.ts"
}
```

Re-export from `src/index.ts`. In `.github/scripts/marketplace-source-boundaries.test.mjs` add `'./requester-preflight-conformance'` to the `testing` entry's subpath list (around line 290).

- [ ] **Step 6: Run it**

```bash
cd packages/marketplace/testing && yarn install --immutable && yarn typecheck && yarn test
cd ../../.. && node --test .github/scripts/marketplace-source-boundaries.test.mjs
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/testing .github/scripts/marketplace-source-boundaries.test.mjs
git commit -m "test(marketplace): preflight-behavior golden fixtures + conformance kit

Pins today's CLI preflight behavior as the reference before the work
client packages the requester module (design 4.3 step 1, 10 row 4).
Fixtures are digest-manifested and append-only per 8.1."
```

---

### Task A2: Scaffold `packages/marketplace/work-client` with its guard trio

Empty package, real guards. The custody guard from #2307 already lists `work-client` and picks it up by directory existence — this task makes that entry live.

**Files:**
- Create: `packages/marketplace/work-client/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `README.md`, `src/index.ts`, `scripts/pack-smoke.mjs`, `scripts/build.mjs`
- Modify: `.github/scripts/marketplace-package-inventory.test.mjs` (add to `MARKETPLACE_PACKAGES` and `JINN_DEPENDENCY_GRAPH`)
- Modify: `.github/scripts/marketplace-source-boundaries.test.mjs:286-291` (add the package + its `['.']` export list)
- Modify: `.github/scripts/marketplace-packed-types.test.mjs:15-17` (add the package)
- Modify: `.github/workflows/marketplace-ci.yml` (add a `work-client` job after `binding`)

**Interfaces:**
- Produces: package `@jinn-network/marketplace-work-client` at `0.1.0`, single `.` export, `dist/` + `README.md` in `files`, `publishConfig.access: public`. Task A3 fills `src/`.
- Consumes: `@jinn-network/marketplace-binding`, `@jinn-network/marketplace-venue-base`, `@jinn-network/task-execution-protocol`, `@jinn-network/task-execution-profiles` (portal in-repo; version-pinned for publish) — mirror `packages/marketplace/binding/package.json`'s shape exactly.

- [ ] **Step 1: Copy the binding's package skeleton**

```bash
cd packages/marketplace
mkdir -p work-client/src work-client/scripts
cp binding/tsconfig.json binding/tsconfig.build.json binding/vitest.config.ts work-client/
cp binding/scripts/build.mjs binding/scripts/pack-smoke.mjs work-client/scripts/
```

Then write `work-client/package.json` modeled on `binding/package.json`: name `@jinn-network/marketplace-work-client`, version `0.1.0`, `"type": "module"`, `"packageManager": "yarn@4.13.0"`, `"engines": { "node": ">=22" }`, `repository.directory` `packages/marketplace/work-client`, one `.` export pointing at `./dist/index.js` / `./dist/index.d.ts`, `"files": ["dist/", "README.md"]`, `publishConfig.access` `public`, and the same `scripts` block (`build`, `typecheck`, `test`, `pack:smoke`, `prepack`).

- [ ] **Step 2: Write a placeholder `src/index.ts` that compiles**

```ts
/**
 * The Request Work application-layer client for the marketplace venue.
 *
 * Custody law (marketplace-surfaces design 4.1): signer objects only — this
 * package never reads a keystore, never touches process.env, and no API
 * parameter accepts a private key, mnemonic, or seed. Chain selection is
 * always passed explicitly by the host; there is no default.
 */
export const WORK_CLIENT_PACKAGE = '@jinn-network/marketplace-work-client';
```

- [ ] **Step 3: Register in the three guards**

`marketplace-package-inventory.test.mjs`: add `['work-client', '@jinn-network/marketplace-work-client'],` to `MARKETPLACE_PACKAGES`, and a `JINN_DEPENDENCY_GRAPH` entry declaring the dependencies from the Interfaces block. `marketplace-source-boundaries.test.mjs`: add `['work-client', '@jinn-network/marketplace-work-client', ['.']],` beside the `pipeline` entry (~line 287). `marketplace-packed-types.test.mjs`: add `['work-client', '@jinn-network/marketplace-work-client'],`.

- [ ] **Step 4: Wire CI**

In `.github/workflows/marketplace-ci.yml`, add a job modeled on the `binding` job:

```yaml
  work-client:
    needs: [binding]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Enable Yarn 4.13.0
        run: |
          corepack enable
          corepack prepare yarn@4.13.0 --activate
      - name: Verify Marketplace Work Client
        working-directory: packages/marketplace/work-client
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn pack:smoke
```

Mirror the `binding` job's cross-tree portal build steps (`task-execution/protocol`, `backend`, `profiles`, `trust/core`, `trust/resolve`, plus `marketplace/venue-base`) before the verify step.

- [ ] **Step 5: Run the guards and the package**

```bash
cd packages/marketplace/work-client && yarn install && yarn typecheck && yarn build && yarn pack:smoke
cd ../../.. && node --test .github/scripts/marketplace-package-inventory.test.mjs \
  .github/scripts/marketplace-source-boundaries.test.mjs \
  .github/scripts/marketplace-packed-types.test.mjs \
  .github/scripts/custody-boundaries.test.mjs
```
Expected: all green. The custody guard now scans a real `work-client/src` (it filtered the directory out by non-existence before).

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/work-client .github/scripts .github/workflows/marketplace-ci.yml
git commit -m "feat(marketplace): scaffold work-client package with guard trio

Empty tier-3 package + inventory/boundaries/packed-types guards + CI job,
so the custody tripwire covers it from the first line of source
(design 5.1, 10 row 5)."
```

---

### Task A3: Move the requester module into the package — packaging, not rewriting

**This task's acceptance criterion is that no logic changes.** Per finding F4: if the module cannot move without an edit to its behavior, that is a violation of the stage-3 extraction boundary — file it as a finding against the stage-3 work and stop; do not patch here.

**Files:**
- Create: `packages/marketplace/work-client/src/**` (the moved module)
- Delete: `client/src/requester/**`
- Modify: `packages/marketplace/work-client/src/index.ts` (real exports)
- Modify: `packages/marketplace/work-client/package.json` (real dependencies)

**Interfaces:**
- Produces: the module's public surface, re-exported from `.` unchanged. Whatever `client/src/requester/index.ts` exported at stage 3 is what this package exports — same names, same signatures. Task A5 imports them.
- Consumes: nothing new.

- [ ] **Step 1: Record the pre-move surface**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -rn "^export " client/src/requester/index.ts > /tmp/requester-surface-before.txt
cat /tmp/requester-surface-before.txt
```
Keep this file — Step 5 diffs against it.

- [ ] **Step 2: Verify the module has no host imports**

```bash
grep -rn "from '\.\./\|from '@/\|from 'client/" client/src/requester/ || echo "clean — no imports outside the module"
```
Expected: `clean`. The stage-3 design deliverable is "no imports from the rest of the host". Any hit is finding F4 realized — stop and file it.

- [ ] **Step 3: Move the files with git, preserving history**

```bash
git mv client/src/requester/* packages/marketplace/work-client/src/
rmdir client/src/requester
```

- [ ] **Step 4: Fix only import specifiers and package deps — nothing else**

The only permitted edits are: (a) bare-specifier imports of stack packages that were portal-resolved through `client/package.json` now resolving through `work-client/package.json` — no source change, just add each to `dependencies` at the same version the binding pins; (b) relative extensions if the module used a different `moduleResolution`. Run:

```bash
cd packages/marketplace/work-client && yarn install && yarn typecheck
```
Every error must be resolvable by adding a dependency or by a `.js` extension on a relative import. **A type error that requires changing a function body, a signature, or a control-flow branch is finding F4 — stop.**

- [ ] **Step 5: Prove the surface is unchanged**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -rn "^export " packages/marketplace/work-client/src/index.ts | sed 's|packages/marketplace/work-client|client|' > /tmp/requester-surface-after.txt
diff <(cut -d: -f3- /tmp/requester-surface-before.txt) <(cut -d: -f3- /tmp/requester-surface-after.txt)
```
Expected: empty diff.

- [ ] **Step 6: Run the package and the custody guard**

```bash
cd packages/marketplace/work-client && yarn test && yarn build && yarn pack:smoke
cd ../../.. && node --test .github/scripts/custody-boundaries.test.mjs .github/scripts/marketplace-package-inventory.test.mjs
```
Expected: green. If the custody guard fires on `process.env` or a filesystem import inside the moved module, that is a real C2 violation carried in from the host — file it as a finding; do not widen the guard.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/work-client client/src
git commit -m "feat(marketplace): package the operator requester module as work-client

Moved from client/src/requester/ unchanged (git mv; export surface diffed
empty). Packaging, not rewriting — design 5.1. Closes #<work-client issue>."
```

---

### Task A4: Drive the preflight kit against the packaged work client

**Files:**
- Create: `packages/marketplace/work-client/test/preflight-conformance.test.ts`
- Modify: `packages/marketplace/work-client/package.json` (devDependency on `@jinn-network/marketplace-testing`)

**Interfaces:**
- Consumes: `runRequesterPreflightConformance` and `RequesterPreflightHarness` from Task A1; the work client's exported preflight entry point from Task A3.
- Produces: the drift alarm becomes a gate on the package.

- [ ] **Step 1: Write the harness adapter**

```ts
import { runRequesterPreflightConformance, type PreflightInput, type PreflightOutcome }
  from '@jinn-network/marketplace-testing/requester-preflight-conformance';
import { runSubmitPreflight } from '../src/index.js';

runRequesterPreflightConformance({
  name: '@jinn-network/marketplace-work-client',
  async preflight(input: PreflightInput): Promise<PreflightOutcome> {
    try {
      const result = await runSubmitPreflight({
        now: input.nowMs,
        deadlineMs: input.deadlineMs,
        escrowWei: BigInt(input.escrowWei),
        safeBalanceWei: BigInt(input.safeBalanceWei),
        liveTargets: input.liveTargets,
        recordedIntents: input.recordedIntents,
      });
      return result.recovered
        ? { outcome: 'recovered', posted: result.posted }
        : { outcome: 'accepted' };
    } catch (error) {
      const err = error as { name: string; category?: string };
      return err.category
        ? { outcome: 'rejected', error: err.name, category: err.category }
        : { outcome: 'rejected', error: err.name };
    }
  },
});
```

Replace `runSubmitPreflight` and its option names with the module's **actual** exported entry point from `/tmp/requester-surface-after.txt` — do not rename anything in the package to fit this adapter; the adapter bends, the package does not.

- [ ] **Step 2: Run it**

```bash
cd packages/marketplace/work-client && yarn install && yarn test
```
Expected: six passing conformance cases. **A failing case is the real finding this kit exists to raise:** the packaged module's behavior differs from the CLI reference. Report which fixture, with both outcomes, before changing anything.

- [ ] **Step 3: Commit**

```bash
git add packages/marketplace/work-client
git commit -m "test(marketplace): work client passes the preflight conformance kit

Parity with the CLI reference is now a gate on the package, not a
convention (design 4.3)."
```

---

### Task A5: Re-point the operator posting loop at the package

**Files:**
- Modify: `client/package.json` (add `"@jinn-network/marketplace-work-client": "portal:../packages/marketplace/work-client"`)
- Modify: `client/src/daemon/posting-loop.ts` (imports)
- Modify: any `client/` file that imported `../requester/` (find them in Step 1)

**Interfaces:**
- Consumes: the package's `.` export (Task A3).
- Produces: the operator runtime as the work client's reference consumer — the design's §5.1 claim becomes a code fact.

- [ ] **Step 1: Find every host import of the old module path**

```bash
grep -rn "requester/" client/src client/test client/scripts | grep -v node_modules
```

- [ ] **Step 2: Add the portal dependency**

```bash
cd client && yarn add "@jinn-network/marketplace-work-client@portal:../packages/marketplace/work-client"
```

- [ ] **Step 3: Rewrite the import specifiers**

Every hit from Step 1 becomes `from '@jinn-network/marketplace-work-client'`. Only the specifier changes; imported names are identical (Task A3 Step 5 proved it).

- [ ] **Step 4: Run the operator suites**

```bash
cd client && yarn typecheck && yarn vitest run test/daemon test/tasks test/cli
```
Expected: green, with no test edits. A test that needs editing means the surface moved — that is finding F4.

- [ ] **Step 5: Commit**

```bash
git add client
git commit -m "refactor(operator): consume the work client from the package

The posting loop is now the work client's reference consumer
(design 5.1 consumers-and-layers check)."
```

---

### Task A6: CLI convergence — one validation stack, two skins (design §10 row 6)

Strictly after A3–A5. This is where the two-posting-stacks risk (design §2.5, §4.3) closes.

**Files:**
- Modify: `client/src/cli/commands/tasks.ts` (1057 lines — the posting path only)
- Delete: `client/src/tasks/submit-preflight.ts`, `client/src/tasks/submit-selection.ts`, `client/src/tasks/posting-service.ts`
- Modify: `client/src/tasks/submit-request.ts` (keep — it is the `./autopilot` schema alias, Phase C's concern)
- Modify/Delete: `client/test/tasks/*` tests covering the deleted modules
- Create: `client/test/cli/commands/tasks-convergence.test.ts`

**Interfaces:**
- Consumes: `@jinn-network/marketplace-work-client`'s posting entry point (Task A3).
- Produces: `jinn tasks submit` posting through the work client. No new exported surface.

- [ ] **Step 1: Write the failing convergence test**

`client/test/cli/commands/tasks-convergence.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI posting converges on the work client', () => {
  it('the tasks command imports no private preflight or posting module', () => {
    const source = readFileSync(resolve(__dirname, '../../../src/cli/commands/tasks.ts'), 'utf8');
    // Design 4.3 step 4: one validation stack, two skins. A private copy
    // of the preflight core is exactly the drift the convergence closes.
    expect(source).not.toMatch(/from '.*tasks\/submit-preflight/);
    expect(source).not.toMatch(/from '.*tasks\/submit-selection/);
    expect(source).not.toMatch(/from '.*tasks\/posting-service/);
    expect(source).toMatch(/from '@jinn-network\/marketplace-work-client'/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/cli/commands/tasks-convergence.test.ts`
Expected: FAIL — the private imports are still there.

- [ ] **Step 3: Re-platform the posting path**

In `client/src/cli/commands/tasks.ts`, replace the private preflight/selection/posting calls with the work client's entry point. The CLI keeps everything that is genuinely a *skin*: argument parsing, `--spec-file` handling, human-readable output, exit codes, and its keystore-backed signer construction (key loading stays in the CLI — tier-4 product, design §4.4). It hands the work client a constructed signer object and an explicit chain config; it hands it nothing key-shaped (C3).

- [ ] **Step 4: Delete the private copy**

```bash
cd client
git rm src/tasks/submit-preflight.ts src/tasks/submit-selection.ts src/tasks/posting-service.ts
git rm test/tasks/submit-preflight.test.ts test/tasks/posting-service.test.ts 2>/dev/null || true
```

Then `grep -rn "submit-preflight\|submit-selection\|posting-service" client/src client/test client/scripts` and clear every remaining reference.

- [ ] **Step 5: Run the CLI suites and the conformance kit**

```bash
cd client && yarn typecheck && yarn vitest run test/cli test/tasks
cd ../packages/marketplace/work-client && yarn test
```
Expected: green in both. Behavioral test cases that lived in the deleted modules' tests and are not already covered by the Task A1 fixtures **move into the kit as new appended fixtures** (a minor bump of `marketplace-testing` with a changelog note, design §8.1) — they are not deleted.

- [ ] **Step 6: Commit**

```bash
git add client packages/marketplace
git commit -m "refactor(cli): converge jinn tasks onto the work client

One validation stack, two skins — the CLI's private preflight/selection/
posting copy is deleted (design 4.3 step 4, 10 row 6). The two-posting-
stacks risk of 2.5 closes here. Closes #<CLI convergence issue>."
```

---

### Task A7: Class-3 quickstart and the custody page (design §8.3 items 3, §10 row 11 partial)

**Files:**
- Create: `docs/quickstarts/class-3-work-client.md`
- Create: `docs/quickstarts/custody.md`
- Modify: `.github/workflows/repository-structure.yml` (ensure `docs/quickstarts` is in the docs-guard scan roots — check `SCAN_ROOTS` in `.github/scripts/docs-key-guard.test.mjs`; `docs` is already a root, so verify rather than add)

**Interfaces:**
- Consumes: the work client's public API (Task A3), the marketplace-binding chain constants (`BASE_SEPOLIA_TODAY`-style named exports).
- Produces: documentation only.

- [ ] **Step 1: Write the class-3 quickstart**

`docs/quickstarts/class-3-work-client.md` — the external production requester path. It must show: constructing a viem `LocalAccount` **outside** the example's control flow (the reader's KMS/HSM adapter is a black box that returns an account), passing it plus an explicit chain config into the work client, posting one Submission, awaiting delivery, adopting, settling, and reading the evidence back. Every key literal in the file must come from the Anvil dev-account set. Open with one line pointing at `custody.md` as mandatory reading.

- [ ] **Step 2: Write the custody page**

`docs/quickstarts/custody.md` — the one marked custody page mandated by the consumer-class table row 3. Three requirements, stated plainly (this is a money page; drop the metaphor per BRAND.md):

1. **A dedicated signer** — never the operator's or a treasury's key; a signer used for nothing but posting.
2. **A dedicated posting Safe** — all writes are Safe-routed, so blast radius is capped at this Safe's balance (design §3 H3).
3. **Capped funds** — keep only the working balance the posting cadence needs.

Then the blessed-package rule verbatim from §8.4 (a package is blessed if and only if it is in the `@jinn-network` npm scope **and** carries trusted-publisher provenance attesting a `Jinn-Network` repository), with the `npm audit signatures` / provenance-verification command a reader can actually run, and the explicit note that a list page is a rendering of that rule, never the rule itself.

- [ ] **Step 3: Run the docs guard**

```bash
node --test .github/scripts/docs-key-guard.test.mjs
```
Expected: PASS. A hit means a key literal outside the Anvil set — replace it; never allowlist.

- [ ] **Step 4: Commit**

```bash
git add docs/quickstarts
git commit -m "docs: class-3 work-client quickstart and the custody page

The consumer-class table's row-3 surface gets its documented on-ramp
(design 8.3 item 3, 8.4 blessed-package rule)."
```

---

### Task A8: File the benchmarking posting-core finding (design §10 row 12)

A hand-off, not a modification. **Do not touch `packages/benchmarking/`.**

**Files:**
- None in this repository beyond the issue body drafted below.

- [ ] **Step 1: Confirm the exposure is still real**

```bash
grep -rn "submit" packages/benchmarking/marketplace/src --include=*.ts | grep -v test | head -20
grep -rn "perCell\|hardCap" packages/benchmarking/**/src --include=*.ts | head -10
```
Record what the marketplace venue's `submit` does today and what budget validation it already has — the issue body must be accurate, not a restatement of the design.

- [ ] **Step 2: File the issue against the benchmarking program**

```bash
gh issue create --repo Jinn-Network/mono \
  --title "Benchmarking marketplace venue adopts the work client's posting core" \
  --body "$(cat <<'EOF'
## Context

Benchmarking's marketplace mode posts escrow-bearing tasks through the
`TaskExecutionBackend.submit` seam. It stays on the backend contract for
execution — correctly; comparing backends through the uniform interface is
its job — but its `submit` posts escrow today without the requester
preflight core's protections: funds preflight, live-target selection,
durable-intent (outbox) posting, `TaskCreated` recovery.

That exposure is partially compensated by benchmarking's own budget
validation (`perCell` / `hardCap`), and is named as a residual in the
marketplace-surfaces design §5.1.

## Proposed disposition (from the design, §10 follow-up 12)

At work-client mint, **benchmarking's marketplace venue adopts the work
client's posting core beneath its backend-contract surface** — same code,
no fork. The backend-contract surface is unchanged; only what sits under
`submit` changes.

The work client is now published as `@jinn-network/marketplace-work-client`.

## Impact

Without this, two posting stacks exist again — the exact drift the CLI
convergence just closed on the operator side.

## Acceptance criteria

- benchmarking's marketplace venue `submit` posts through the work client's
  posting core;
- no fork of the preflight logic exists in `packages/benchmarking/`;
- the marketplace venue passes the requester preflight conformance kit
  (`@jinn-network/marketplace-testing/requester-preflight-conformance`);
- `TaskExecutionBackend.submit`'s signature and semantics are unchanged.

This is a finding with a proposed disposition handed to the benchmarking
program, per the designs-are-law rule — not a patch applied from outside.
EOF
)"
```

- [ ] **Step 3: Set the issue type and link it**

```bash
gh issue comment <the marketplace-surfaces tracking issue> \
  --body "Follow-up 12 filed as #<new issue> (finding hand-off to the benchmarking program)."
```
Set the Issue Type to `refactor` via GraphQL (`gh issue edit --type` does not exist).

---

# Phase B — `sdk` R2 (gate: daemon cutover stages 1–4, per stage)

Branch target: `next`. Each task is one coordinated minor bump of `@jinn-network/sdk` with a changelog migration note. The starting version is `0.2.0` (PR #2306).

## Evidence: subpath → consumer → retiring stage

Produced by grepping `client/`, `packages/`, and `.github/` on `claude/marketplace-consumption-boundary-ca5071` (2026-07-30), excluding `node_modules` and `dist`. Reproduce with:

```bash
for p in "sdk'" "sdk/harness" "sdk/plugins" "sdk/checkpoint" "sdk/solvernets'" \
         "sdk/solvernets/prediction-v1" "sdk/solvernets/swe-rebench-v2'" \
         "sdk/solvernets/jinn-repo" "sdk/solvernets/swe-rebench-v2-held-out-slate" \
         "sdk/autopilot" "sdk/fixtures"; do
  echo "===== @jinn-network/$p"
  grep -rn "@jinn-network/$p" client packages .github 2>/dev/null \
    | grep -v node_modules | grep -v "/dist/" | cut -d: -f1 | sort -u
done
```

| sdk subpath | Live consumers (files, excluding the sdk's own tests/README/smoke) | Retiring stage | Task |
| --- | --- | --- | --- |
| `./plugins` | **none** | now (F2) | B1 |
| `./solvernets/swe-rebench-v2-held-out-slate` | `packages/indexer/src/api/explorer.ts` — re-pointed at `@jinn-network/benchmarking-records` by #2308 | now | B1 |
| `./solvernets/jinn-repo` | `client/src/adapters/mech/{adapter,types}.ts`; `client/src/harnesses/engine/{engine,persistence}.ts`; `client/src/harnesses/impls/jinn-repo-evaluator/*` (4); `client/src/autopilot/{autopilot-evaluation-context-resolver,github-adoption-receipt-observer}.ts`; `client/src/solver-types/jinn-repo.ts`; `client/src/types/payloads/index.ts`; `client/scripts/external-consumer-acceptance.mjs`; 9 test files; **prose-only mention** at `packages/task-execution/profiles/src/documents/repository-work-1.0.ts:72` (F3) | **stage 2** — the mech adapter's evaluation machinery and the legacy TaskEngine retire entirely at stage 2 | B3 |
| `./solvernets` (root) | `client/src/solvernets/{registry-client,registry-client-erc8004,store,launch-state-machine,manifest}.ts`; `client/src/api/{solvernets-endpoints,launcher-tasks}.ts`; `client/src/solver-nets/contracts.ts`; `client/src/harnesses/engine/engine.ts`; `client/src/solver-types/{jinn-repo-auto,swe-rebench-v2}.ts`; 7 test files; `client/docs/launch-solvernet.md` | **stage 4** — the registry client is the last consumer out (daemon design §9 retirement table) | B4 |
| `./harness` | `client/src/harnesses/{types.ts, manifest/types.ts, external-impls/loader.ts}`; **`client/templates/harnesses/**` (16 template files) and `client/docs/path-2/**` (6 docs)** — the external harness-authoring surface | **no stage retires these** (F1) | B5 |
| `./checkpoint` | `client/src/eval/orchestrator.ts`; `client/src/cli/commands/{checkpoint,eval}.ts`; `client/scripts/efficacy-probe.ts`; 5 test/e2e files | **no stage retires these** (F1) | B5 |
| `./solvernets/prediction-v1` | `client/src/harnesses/impls/{prediction-v1-baseline/index.ts, learner/harvest.ts}`; `client/src/solver-nets/prediction-operator-ux.ts`; `client/src/types/{payloads/prediction-v1.ts, prediction-v1.ts}` | **no stage retires these** (F1) | B5 |
| `./solvernets/swe-rebench-v2` | `client/src/eval/{attribution-verdict-evidence,resolve-slate-tasks}.ts`; `client/src/harnesses/impls/swe-rebench-v2-evaluator/*`; `client/src/solver-types/*`; `client/src/types/payloads/index.ts`; 7 test files | **no stage retires these** (F1) | B5 |
| root `.` | `client/src/solver-types/{session-derived.ts, _session-derived-distill.ts}` | **no stage retires these** (F1) | B5 |
| `./autopilot`, `./fixtures/autopilot/*` | `client/src/{autopilot/*, cli/commands/tasks*.ts, tasks/submit-request.ts, types/task-run.ts}`; `packages/autopilot/src/lifecycle/*` (8); `client/scripts/external-consumer-acceptance.mjs`; the standalone Autopilot repository | R3 | Phase C |

### Task B1: sdk 0.3.0 — remove `./plugins` and the held-out-slate subpath

**Gate:** none beyond #2308 being merged. Run this as soon as Phase B opens.

**Files:**
- Delete: `packages/sdk/src/plugins.ts`, `packages/sdk/test/plugins.test.ts`, `packages/sdk/src/solvernets/swe-rebench-v2-held-out-slate.ts`
- Modify: `packages/sdk/package.json` (drop two exports; version `0.2.0` → `0.3.0`)
- Modify: `packages/sdk/scripts/smoke-test-pack.mjs` (drop both import probes)
- Modify: `packages/sdk/test/surface.test.ts` (drop the held-out-slate assertions)
- Modify: `packages/sdk/README.md` (changelog entry + migration note)

**Interfaces:**
- Produces: sdk `0.3.0`. No other task consumes it; Tasks B3/B4 bump from it.

- [ ] **Step 1: Write the failing removal test**

Append to `packages/sdk/test/surface.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it('no longer exports the plugins or held-out-slate subpaths', () => {
  // R2a (marketplace-surfaces design 6): ./plugins has zero in-repo
  // importers (finding F2) and the held-out slate re-homed to
  // @jinn-network/benchmarking-records in #2296 step 1.
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { exports: Record<string, unknown>; version: string };
  expect(manifest.exports['./plugins']).toBeUndefined();
  expect(manifest.exports['./solvernets/swe-rebench-v2-held-out-slate']).toBeUndefined();
  expect(manifest.version).toBe('0.3.0');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/surface.test.ts`
Expected: FAIL on `./plugins` being defined.

- [ ] **Step 3: Confirm zero live consumers before removing**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -rn "@jinn-network/sdk/plugins\|@jinn-network/sdk/solvernets/swe-rebench-v2-held-out-slate" \
  client packages .github | grep -v node_modules | grep -v "/dist/" | grep -v "^packages/sdk/"
```
Expected: no output. Any hit outside `packages/sdk/` blocks this task — report it.

- [ ] **Step 4: Remove**

```bash
cd packages/sdk
git rm src/plugins.ts test/plugins.test.ts src/solvernets/swe-rebench-v2-held-out-slate.ts
```
Delete the two `exports` entries in `package.json`, set `"version": "0.3.0"`, and delete the matching probes in `scripts/smoke-test-pack.mjs`.

- [ ] **Step 5: Add the README changelog entry**

```markdown
## 0.3.0

**Breaking (0.x: minor = breaking).** Two subpaths removed:

- `@jinn-network/sdk/plugins` — removed. It had no importers. The plugin
  content surface is the plugin session's to place; this package is not it.
- `@jinn-network/sdk/solvernets/swe-rebench-v2-held-out-slate` — removed.
  **Migration:** import `loadHeldOutSlate` from
  `@jinn-network/benchmarking-records`, the single canonical home for the
  held-out boundary (the boundary must not fork).

Part of the `sdk` retirement map (marketplace-surfaces design 6, R2a).
The standalone Autopilot repository consumes neither subpath and is
unaffected.
```

- [ ] **Step 6: Run everything**

```bash
cd packages/sdk && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd ../.. && node --test .github/scripts/npm-publish-workflow.test.mjs
cd client && yarn vitest run test/scripts/release-client.test.ts test/scripts/pack-workflows.test.ts
```
Expected: all green. The last two prove #2306's parameterization actually tracks the bump instead of red-lining on it.

- [ ] **Step 7: Commit and PR to `next`**

```bash
git add packages/sdk
git commit -m "chore(sdk): 0.3.0 — remove ./plugins and the held-out-slate subpath

R2a of the retirement map: ./plugins has zero importers; the slate's
canonical home is @jinn-network/benchmarking-records (#2296 step 1).
Part of #<sdk R2/R3 issue>."
```

PR body: name the sdk version bump, the two removals, the migration line, and state that the standalone Autopilot repository is unaffected (it pins `sdk@0.1.1` and imports neither subpath).

---

### Task B2: Announce the coordination contract to the standalone Autopilot repository

A one-time coordination artifact that every later sdk bump reuses. Cheap, and the design's §6 constraint ("never a silent break") has no other mechanism.

**Files:**
- Create: `docs/engineering/sdk-retirement-coordination.md`

- [ ] **Step 1: Write the coordination checklist**

`docs/engineering/sdk-retirement-coordination.md` — a short operational page, not a design restatement:

- the retirement map's current position (which subpaths remain, which task removes each);
- the standing rule: **before publishing any sdk minor, open or update a tracking issue on `Jinn-Network/autopilot`** naming the removed subpaths, the new sdk version, and the migration line from the README changelog;
- the pins that make this necessary: the standalone repository pins `sdk@0.1.1` and `client@0.2.2` exactly, so nothing reaches it by drift — but nothing tells it either;
- the class-4 invariant: the standalone repository's surface (`./autopilot` + `./fixtures/autopilot/*` + the `jinn` CLI subprocess) **does not break at any phase**;
- who closes the loop: the sdk PR is not merged until the tracking issue exists.

- [ ] **Step 2: Open the tracking issue on the standalone repository**

```bash
gh issue create --repo Jinn-Network/autopilot \
  --title "sdk retirement map: subpath removals through R3" \
  --body "$(cat <<'EOF'
`@jinn-network/sdk` is retiring to a narrow, product-owned wire-schema
package. This issue tracks every removal so the exact pins here
(`sdk@0.1.1`, `client@0.2.2`) never break by surprise.

**Your surface is `@jinn-network/sdk/autopilot` + `./fixtures/autopilot/*`
plus the `jinn` CLI subprocess. It does not break at any phase.**

Removals landing in mono (each a coordinated minor bump with a changelog
migration note):

- 0.3.0 — `./plugins`, `./solvernets/swe-rebench-v2-held-out-slate` (you
  import neither)
- later — `./solvernets/jinn-repo`, `./solvernets` (you import neither)

**The one change that will reach you:** `TaskSubmitRequestV1` (exported
from `./autopilot`) sunsets after this repository migrates to TEP
Submission posting. That migration is coordinated separately and is
gated on the operator daemon's posting-flow stage plus the published
work client. Nothing here forces it.

Reference: `docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md` §6.
EOF
)"
```

- [ ] **Step 3: Commit**

```bash
git add docs/engineering/sdk-retirement-coordination.md
git commit -m "docs(engineering): sdk retirement coordination checklist

The design's never-a-silent-break constraint (6) gets a mechanism:
a tracking issue on the standalone repository before every sdk minor."
```

---

### Task B3: sdk 0.4.0 — remove `./solvernets/jinn-repo` (gate: daemon stage 2)

**Gate: daemon cutover stage 2 has deployed** (delivery-watcher, the mech adapter's evaluation machinery, and the legacy TaskEngine all retired). Verify before starting:

```bash
git log --oneline origin/integration/evidence-v1 | grep -i "stage 2\|evaluator flow"
test -f client/src/adapters/mech/adapter.ts && echo "STOP: mech adapter still present — stage 2 has not landed"
```

**This task owns the publish-gate acceptance-script migration** (design §6 R2, "in the same change that removes the subpath").

**Files:**
- Delete: `packages/sdk/src/solvernets/jinn-repo.ts`
- Modify: `packages/sdk/package.json` (drop the export; `0.3.0` → `0.4.0`)
- Modify: `client/scripts/external-consumer-acceptance.mjs:177` (the `jinnRepo` import probe)
- Modify: `packages/sdk/scripts/smoke-test-pack.mjs`, `packages/sdk/README.md`
- Modify: `packages/task-execution/profiles/src/documents/repository-work-1.0.ts:72` (the prose reference — F3)
- Modify: `client/src/solver-types/jinn-repo.ts` and any survivors found in Step 2

**Interfaces:**
- Consumes: sdk `0.3.0` from Task B1.
- Produces: sdk `0.4.0`; an acceptance script whose publish gate no longer names a retired subpath.

- [ ] **Step 1: Write the failing acceptance-script test**

Append to `client/test/scripts/release-client.test.ts` (or the acceptance script's own test file if one exists — check `client/test/scripts/`):

```ts
it('the external-consumer acceptance script names no retired sdk subpath', () => {
  const source = readFileSync(
    resolve(__dirname, '../../scripts/external-consumer-acceptance.mjs'),
    'utf8',
  );
  // Design 6 R2: the publish gate must not import a subpath the same
  // change removes, or the next client release red-lines on a 404.
  expect(source).not.toMatch(/@jinn-network\/sdk\/solvernets\//);
  // The class-4 surface stays: ./autopilot + fixtures.
  expect(source).toMatch(/@jinn-network\/sdk\/autopilot/);
});
```

- [ ] **Step 2: Run it and enumerate the survivors**

```bash
cd client && yarn vitest run test/scripts/release-client.test.ts
cd .. && grep -rn "@jinn-network/sdk/solvernets/jinn-repo" client packages .github \
  | grep -v node_modules | grep -v "/dist/" | grep -v "^packages/sdk/"
```
Expected: the test FAILS, and the grep lists exactly the residue stage 2 did not retire. Everything listed must be resolved in Step 3 — a survivor that still needs the schema is a finding (stage 2 did not retire what the map assumed).

- [ ] **Step 3: Migrate the survivors and remove**

For the acceptance script, replace the `jinnRepo` probe with a probe of a surviving subpath — the script's job is proving the packed sdk resolves from an external consumer's perspective, and `./autopilot` (already imported at line 176) plus the fixtures at lines 184/191 carry that. Delete lines 177 and the `jinnRepo` assertions.

For `packages/task-execution/profiles/src/documents/repository-work-1.0.ts:72`, rewrite the comment to name the profile's own document type rather than the retired sdk path (F3).

Then:

```bash
cd packages/sdk && git rm src/solvernets/jinn-repo.ts
```
Drop the export entry, set `"version": "0.4.0"`, clear the smoke-test probe.

- [ ] **Step 4: Add the README changelog entry**

```markdown
## 0.4.0

**Breaking.** `@jinn-network/sdk/solvernets/jinn-repo` removed — the
SolverNet-specific content dies with SolverNets; the task-typing role is
carried by the task-execution profiles. No successor export.

Part of the `sdk` retirement map (marketplace-surfaces design 6, R2a),
riding the operator daemon's evaluator-flow stage. The standalone
Autopilot repository does not import this subpath.
```

- [ ] **Step 5: Run everything, including the publish gates**

```bash
cd packages/sdk && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd ../.. && node --test .github/scripts/npm-publish-workflow.test.mjs
cd client && yarn typecheck && yarn vitest run test/scripts
```
Expected: green.

- [ ] **Step 6: Update the coordination issue, then commit**

Comment the 0.4.0 removal on the `Jinn-Network/autopilot` tracking issue from Task B2 **before** merging.

```bash
git add packages/sdk client packages/task-execution/profiles
git commit -m "chore(sdk): 0.4.0 — remove ./solvernets/jinn-repo; migrate the publish gate

The subpath's last consumers retired with the daemon's evaluator-flow
stage. The external-consumer acceptance script drops its jinn-repo probe
in the same change (design 6 R2). Part of #<sdk R2/R3 issue>."
```

---

### Task B4: sdk 0.5.0 — remove `./solvernets` (gate: daemon stage 4)

**Gate: daemon cutover stage 4 has deployed** — the registry client and `client/src/discovery/` are retired. Verify:

```bash
test -d client/src/discovery && echo "STOP: stage 4 has not landed"
test -f client/src/solvernets/registry-client.ts && echo "STOP: registry client still present"
```

**Files:**
- Delete: `packages/sdk/src/solvernets/index.ts` (and any sibling the root subpath owns)
- Modify: `packages/sdk/package.json` (drop the `./solvernets` export; `0.4.0` → `0.5.0`)
- Modify: `packages/sdk/scripts/smoke-test-pack.mjs`, `packages/sdk/test/surface.test.ts`, `packages/sdk/README.md`
- Modify: survivors enumerated in Step 2

**Interfaces:**
- Consumes: sdk `0.4.0` from Task B3.
- Produces: sdk `0.5.0`. After this, the remaining exports are root `.`, `./harness`, `./checkpoint`, `./solvernets/prediction-v1`, `./solvernets/swe-rebench-v2`, `./autopilot`, `./fixtures/autopilot/*` — the first five are Task B5's re-homing scope, the last two are Phase C's.

- [ ] **Step 1: Enumerate the survivors**

```bash
grep -rn "@jinn-network/sdk/solvernets'" client packages .github \
  | grep -v node_modules | grep -v "/dist/" | grep -v "^packages/sdk/"
grep -rn 'from "@jinn-network/sdk/solvernets"' client packages \
  | grep -v node_modules | grep -v "/dist/"
```
The evidence table predicts `client/src/solvernets/*`, `client/src/api/solvernets-endpoints.ts`, `client/src/api/launcher-tasks.ts`, `client/src/solver-nets/contracts.ts`, `client/src/harnesses/engine/engine.ts` all gone at stage 4. Anything still listed is a survivor that must be migrated or is a finding.

- [ ] **Step 2: Write the failing removal test**

Append to `packages/sdk/test/surface.test.ts`:

```ts
it('no longer exports the ./solvernets root subpath', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { exports: Record<string, unknown>; version: string };
  expect(manifest.exports['./solvernets']).toBeUndefined();
  expect(manifest.version).toBe('0.5.0');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/surface.test.ts`
Expected: FAIL.

- [ ] **Step 4: Remove and clear the residue**

```bash
cd packages/sdk && git rm src/solvernets/index.ts
```
Drop the export entry, set `"version": "0.5.0"`, clear the smoke probes and `surface.test.ts`'s `./solvernets` assertions. Update `client/docs/launch-solvernet.md` — if the doc's subject retired at stage 4, delete the doc rather than editing dead prose (say so in the commit message).

- [ ] **Step 5: README changelog and full run**

Changelog entry: `## 0.5.0 — Breaking. @jinn-network/sdk/solvernets removed; SolverNet-specific content dies with SolverNets (design §6, R2a). No successor export. The standalone Autopilot repository does not import this subpath.`

```bash
cd packages/sdk && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd ../.. && node --test .github/scripts/npm-publish-workflow.test.mjs
cd client && yarn typecheck && yarn test
```

- [ ] **Step 6: Update the coordination issue, then commit**

```bash
git add packages/sdk client
git commit -m "chore(sdk): 0.5.0 — remove ./solvernets

Last consumer (the registry client) retired with the daemon's
discovery-serving stage. Part of #<sdk R2/R3 issue>."
```

---

### Task B5: File the R2b re-homing finding (finding F1)

The design's R2 assumed every remaining subpath retires with the cutover. Five do not. This task files that as its own gated follow-up rather than forcing a removal that would break live surfaces.

**Files:**
- None in this repository beyond the issue body.

- [ ] **Step 1: Regenerate the evidence at filing time**

Run the Phase-B evidence loop from the top of this phase and paste the current output into the issue — the stage that consumed the interim tasks may have moved consumers around.

- [ ] **Step 2: File the issue**

```bash
gh issue create --repo Jinn-Network/mono \
  --title "sdk R2b: five subpaths re-home rather than retire" \
  --body "$(cat <<'EOF'
## Context

The marketplace-surfaces design §6 R2 says the sdk's remaining subpaths
retire "each as its `client/` consumers retire per stage." Grep evidence
says that holds for `./solvernets` and `./solvernets/jinn-repo` (removed in
sdk 0.4.0 / 0.5.0), and not for five others:

| Subpath | Live consumers no cutover stage retires |
| --- | --- |
| `./harness` | `client/templates/harnesses/**` (16 files) and `client/docs/path-2/**` (6 docs) — the documented external harness-authoring surface — plus `client/src/harnesses/{types,manifest/types,external-impls/loader}.ts` |
| `./checkpoint` | `client/src/eval/orchestrator.ts`, `client/src/cli/commands/{checkpoint,eval}.ts`, `client/scripts/efficacy-probe.ts` |
| `./solvernets/prediction-v1` | the shipped `prediction-v1-baseline` harness, the learner harvest path, the payload types |
| `./solvernets/swe-rebench-v2` | the eval slate resolver, the swe-rebench-v2 evaluator harness, the payload types |
| root `.` | `client/src/solver-types/{session-derived,_session-derived-distill}.ts` (session-derived payloads + the pinned distill prompt) |

Removing any of these on a cutover gate would break a live surface — most
sharply `./harness`, which external harness authors consume through the
shipped templates.

## Proposed disposition

Split R2 into **R2a** (retires with the cutover — done: sdk 0.3.0/0.4.0/0.5.0)
and **R2b** (re-homes rather than retires), and give R2b its own gates:

- `./harness` → a harness-authoring package, or the operator tree, depending
  on the plugin session's disposition of harness content. **Blocked on:**
  the plugin session.
- `./checkpoint` + `./solvernets/swe-rebench-v2` + `./solvernets/prediction-v1`
  + root `.` → the evaluation/benchmarking tree, alongside
  `@jinn-network/benchmarking-records`. **Blocked on:** the benchmarking
  program's records boundary.

R3's end state (`sdk` narrows to `./autopilot` + fixtures) is unchanged;
it is reached after R2b, later than the design implies.

## Impact

Without this, either the R2 gates fire and break the external harness path
and the eval orchestrator, or they silently do not fire and the retirement
map stalls with no owner.

## Acceptance criteria

- the design §6 carries a dated amendment recording the R2a/R2b split;
- each R2b subpath has a named destination tree and a gate;
- no R2b subpath is removed before its destination exists.
EOF
)"
```

- [ ] **Step 3: Amend the design in the same PR as the issue link**

Add a dated line to §6's coordination constraints in
`docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md`:

```markdown
- *(Amended 2026-07-30 during execution: R2 splits into **R2a** — `./plugins`,
  the held-out-slate subpath, `./solvernets/jinn-repo`, `./solvernets` —
  which retire with the cutover, and **R2b** — `./harness`, `./checkpoint`,
  `./solvernets/prediction-v1`, `./solvernets/swe-rebench-v2`, root `.` —
  whose consumers no cutover stage retires and which therefore re-home
  rather than retire. Grep evidence and destinations: issue #<new>. R3's
  end state is unchanged; it is reached after R2b.)*
```

```bash
git add docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md
git commit -m "docs(design): amend sdk R2 into R2a/R2b per grep evidence

Five subpaths have live consumers no cutover stage retires; they re-home
rather than retire. Finding filed as #<new>."
```

---

# Phase C — `sdk` R3 (gate: standalone Autopilot repository migrates to TEP Submission posting)

Branch target: `next`. **Coordinate, do not own.** The migration itself happens in `Jinn-Network/autopilot`; these are the mono-side halves.

### Task C1: Publish the TEP-Submission migration contract for the standalone repository

**Files:**
- Modify: `docs/engineering/sdk-retirement-coordination.md` (add the R3 section)

**Interfaces:**
- Consumes: the work client's Submission-posting surface (Task A3) and the CLI's converged `jinn tasks submit` (Task A6).
- Produces: the migration contract the standalone repository implements against.

- [ ] **Step 1: Write the migration contract section**

Append to `docs/engineering/sdk-retirement-coordination.md` an **R3 — TEP Submission migration** section stating, concretely:

- what replaces `TaskSubmitRequestV1`: a sealed TEP Submission document, posted through `jinn tasks submit` (unchanged CLI verb — the standalone repository's process-invocation posture is preserved) or through `@jinn-network/marketplace-work-client` if that repository ever wants in-process posting;
- the exact CLI invocation the standalone repository should target after migration, copied from `client/src/cli/commands/tasks.ts`'s post-convergence argument surface;
- what the standalone repository keeps: `./autopilot`'s capsule / adoption / observation schemas and `./fixtures/autopilot/*`;
- the sequencing: **the standalone repository migrates first; `TaskSubmitRequestV1` sunsets after**, in a final coordinated bump (Task C3);
- the CLI's `tasks submit` accepts **both** shapes during the migration window (Task C2), so the two repositories never have to land simultaneously.

- [ ] **Step 2: Open the migration issue on the standalone repository**

```bash
gh issue create --repo Jinn-Network/autopilot \
  --title "Migrate task posting from TaskSubmitRequestV1 to TEP Submission" \
  --body "The mono-side surface is ready: \`jinn tasks submit\` accepts a sealed TEP Submission document, and accepts TaskSubmitRequestV1 in parallel for the whole migration window. Contract and exact invocation: \`docs/engineering/sdk-retirement-coordination.md\` in Jinn-Network/mono, section R3. After this lands here, mono sunsets TaskSubmitRequestV1 in a final coordinated sdk bump. Nothing here is time-boxed by mono."
```

- [ ] **Step 3: Commit**

```bash
git add docs/engineering/sdk-retirement-coordination.md
git commit -m "docs(engineering): R3 TEP Submission migration contract

The mono-side half of the standalone repository's migration off
TaskSubmitRequestV1 (design 6, R3)."
```

---

### Task C2: Accept both posting shapes during the migration window

**Files:**
- Modify: `client/src/cli/commands/tasks.ts` (the submit path's input parsing)
- Modify: `client/src/tasks/submit-request.ts`
- Create: `client/test/cli/commands/tasks-dual-shape.test.ts`

**Interfaces:**
- Consumes: `TaskSubmitRequestV1Schema` (from `@jinn-network/sdk/autopilot`, still exported), and the work client's Submission-posting entry point.
- Produces: `jinn tasks submit --spec-file` accepting either a `TaskSubmitRequestV1` document or a sealed TEP Submission, with the former normalized into the latter before it reaches the work client.

- [ ] **Step 1: Write the failing dual-shape test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeSubmitInput } from '../../../src/tasks/submit-request.js';

describe('jinn tasks submit accepts both posting shapes', () => {
  it('normalizes a TaskSubmitRequestV1 document into a Submission', () => {
    const legacy = { version: 1, /* fill from the real TaskSubmitRequestV1 fixture */ };
    const result = normalizeSubmitInput(legacy);
    expect(result.kind).toBe('submission');
    expect(result.source).toBe('task-submit-request-v1');
  });

  it('passes a sealed Submission through untouched', () => {
    const submission = { /* fill from a real sealed Submission fixture */ };
    const result = normalizeSubmitInput(submission);
    expect(result.kind).toBe('submission');
    expect(result.source).toBe('submission');
  });
});
```

Fill both literals from real fixtures — `packages/sdk/fixtures/autopilot/` for the legacy shape, the marketplace profile fixtures for the sealed one. Do not invent document shapes.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/cli/commands/tasks-dual-shape.test.ts`
Expected: FAIL with `normalizeSubmitInput is not a function`.

- [ ] **Step 3: Implement the normalizer**

In `client/src/tasks/submit-request.ts`, add:

```ts
export type NormalizedSubmitInput = {
  kind: 'submission';
  source: 'submission' | 'task-submit-request-v1';
  document: unknown;
};

export function normalizeSubmitInput(input: unknown): NormalizedSubmitInput {
  // Migration window (design 6, R3): the standalone Autopilot repository
  // posts TaskSubmitRequestV1 until it migrates. Both shapes are accepted
  // so the two repositories never have to land simultaneously.
  const legacy = MarketplaceTaskSubmitRequestSchema.safeParse(input);
  if (legacy.success) {
    return { kind: 'submission', source: 'task-submit-request-v1', document: toSubmission(legacy.data) };
  }
  return { kind: 'submission', source: 'submission', document: input };
}
```

`toSubmission` is the field mapping from `TaskSubmitRequestV1` to the sealed marketplace-profile Submission; write it against the profile package's document type, not by hand-rolled object literal.

- [ ] **Step 4: Route the CLI through it**

In `client/src/cli/commands/tasks.ts`'s submit path, parse the `--spec-file` contents through `normalizeSubmitInput` before handing the document to the work client. Emit one line on the legacy branch: `note: TaskSubmitRequestV1 input accepted (deprecated; see docs/engineering/sdk-retirement-coordination.md).`

- [ ] **Step 5: Run**

```bash
cd client && yarn typecheck && yarn vitest run test/cli test/tasks
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add client
git commit -m "feat(cli): accept both TaskSubmitRequestV1 and sealed Submission

The R3 migration window: the standalone Autopilot repository migrates on
its own schedule; mono never forces a simultaneous landing (design 6)."
```

---

### Task C3: sdk R3 final bump — narrow `./autopilot`, transfer ownership

**Gate: the standalone Autopilot repository's migration issue (Task C1 Step 2) is closed.** Verify:

```bash
gh issue view <the migration issue> --repo Jinn-Network/autopilot --json state -q .state
```
Expected: `CLOSED`. Anything else stops this task.

**Files:**
- Modify: `packages/sdk/src/autopilot.ts` (drop `TaskSubmitRequestV1Schema`, `TaskSubmitRequestV1`, `parseTaskSubmitRequestV1`)
- Modify: `packages/sdk/package.json` (version `0.5.0` → `0.6.0`; `description`)
- Modify: `packages/sdk/README.md` (changelog + ownership-transfer note)
- Modify: `client/src/tasks/submit-request.ts` (drop the legacy branch), `client/src/cli/commands/tasks.ts` (drop the deprecation note), `client/test/cli/commands/tasks-dual-shape.test.ts` (drop the legacy case)

**Interfaces:**
- Consumes: sdk `0.5.0` from Task B4.
- Produces: sdk `0.6.0`, exporting exactly `./autopilot` (capsule / adoption / observation schemas) and `./fixtures/autopilot/*` — the R3 end state.

- [ ] **Step 1: Write the failing end-state test**

Append to `packages/sdk/test/surface.test.ts`:

```ts
it('R3 end state: exactly ./autopilot and the autopilot fixtures', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { exports: Record<string, unknown>; version: string };
  expect(Object.keys(manifest.exports).sort()).toEqual(
    ['./autopilot', './fixtures/autopilot/*'].sort(),
  );
  expect(manifest.version).toBe('0.6.0');
});

it('TaskSubmitRequestV1 is sunset', async () => {
  const autopilot = await import('../src/autopilot.js');
  expect('TaskSubmitRequestV1Schema' in autopilot).toBe(false);
});
```

Note: reaching this end state also requires Task B5's R2b removals to have landed. If `./harness` and friends are still exported, this test fails legitimately — the gate is R2b, not this task; report and stop.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/surface.test.ts`
Expected: FAIL.

- [ ] **Step 3: Remove `TaskSubmitRequestV1` and its mono-side consumers**

Delete the schema, type, and parser from `packages/sdk/src/autopilot.ts`; delete `MarketplaceTaskSubmitRequestSchema`, `MarketplaceTaskSubmitRequest`, `parseMarketplaceTaskSubmitRequest`, and the legacy branch of `normalizeSubmitInput` from `client/src/tasks/submit-request.ts`; drop the deprecation note in the CLI; drop the legacy test case.

- [ ] **Step 4: README changelog and ownership-transfer note**

```markdown
## 0.6.0

**Breaking.** `TaskSubmitRequestV1Schema` / `TaskSubmitRequestV1` /
`parseTaskSubmitRequestV1` removed from `@jinn-network/sdk/autopilot`.
**Migration:** post a sealed TEP Submission through `jinn tasks submit`.
The standalone Autopilot repository migrated before this bump.

`@jinn-network/sdk` is now exactly what it should have been: the
Autopilot ↔ operator-CLI wire contract — `./autopilot` (capsule,
adoption, observation) plus `./fixtures/autopilot/*`. This is the R3 end
state of the retirement map (marketplace-surfaces design §6).

**Ownership transfers to the Autopilot product.** Whether this package
renames (for example `@jinn-network/autopilot-wire`) is that
repository's call, not mono's.
```

Update `package.json`'s `description` to match — the current text still says "SolverNets, Harnesses, plugins, and typed payloads", none of which survive.

- [ ] **Step 5: Run everything**

```bash
cd packages/sdk && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd ../.. && node --test .github/scripts/npm-publish-workflow.test.mjs
cd client && yarn typecheck && yarn test && node scripts/external-consumer-acceptance.mjs --help
```

- [ ] **Step 6: Close the coordination loop and commit**

Comment the 0.6.0 publish on the `Jinn-Network/autopilot` tracking issue (Task B2) and close it.

```bash
git add packages/sdk client
git commit -m "chore(sdk): 0.6.0 — R3 end state; TaskSubmitRequestV1 sunset

The sdk narrows to the Autopilot wire contract (./autopilot + fixtures).
Ownership transfers to the Autopilot product. Closes #<sdk R2/R3 issue>."
```

---

# Phase D — #2296 step 2: physical explorer separation (gate: daemon stage 4)

Branch target: `integration/evidence-v1`. **Gate: daemon cutover stage 4 has deployed** — the discovery-serving surface is live, so the explorer re-points once, not twice.

Current layout, read at plan time:

- `packages/indexer/` — Ponder project: `ponder.config.ts`, `ponder.schema.ts`, `src/handlers.ts` (projector role, being replaced by `packages/marketplace/projector`), `src/api/` (13 modules: the query plane — `explorer.ts`, `routes.ts`, `slice.ts`, `active-operators.ts`, `task-coverage*.ts`, `freshness.ts`, `metrics.ts`, `chain-head.ts`, `next-task-id.ts`, `rpc-cache.ts`, `placeholder.ts`, `index.ts`), `deploy/` (Dockerfile, railway.toml, derive-schema.mjs), `explorer/` (the Vite/React SPA, `@jinn-network/explorer-spa`, private).
- `packages/indexer/package.json` runs `build: ponder codegen && yarn build:explorer` — the two roles are welded at the build script.

### Task D1: Move the explorer SPA to its own tier-4 tree

**Files:**
- Move: `packages/indexer/explorer/**` → `packages/explorer/**` (git mv)
- Modify: `packages/indexer/package.json` (drop `build:explorer`; `build` becomes `ponder codegen`)
- Modify: `packages/explorer/package.json` (name stays `@jinn-network/explorer-spa`; drop `private` only if it is to be published — it should stay private, it is a hosted product)
- Modify: `packages/explorer/vite.config.ts`, `tsconfig.json`, `playwright.config.ts` (any path that assumed the nested location)
- Modify: `.github/workflows/indexer-ci.yml` (split the explorer steps into their own job / workflow paths)

**Interfaces:**
- Produces: `packages/explorer/` as a standalone tier-4 product tree. Task D2 re-scopes what remains; Task D3 re-points deployment.

- [ ] **Step 1: Record the current green state**

```bash
cd packages/indexer && yarn install --immutable && yarn typecheck && yarn test
cd explorer && yarn install --immutable && yarn typecheck && yarn test && yarn build
```
Both must be green before moving anything. Keep the output.

- [ ] **Step 2: Move**

```bash
cd "$(git rev-parse --show-toplevel)"
git mv packages/indexer/explorer packages/explorer
```

- [ ] **Step 3: Fix the paths the move broke**

```bash
grep -rn "indexer/explorer\|\.\./\.\./indexer\|\.\./indexer" packages/explorer --include=*.ts --include=*.json --include=*.yml \
  | grep -v node_modules
grep -rn "explorer" packages/indexer/package.json .github/workflows/indexer-ci.yml
```
Resolve each hit. In `packages/indexer/package.json`, delete the `build:explorer` script and change `"build"` to `"ponder codegen"`.

- [ ] **Step 4: Split the CI**

In `.github/workflows/indexer-ci.yml`, move the explorer's install/typecheck/test/build/e2e steps into their own job with `working-directory: packages/explorer`, and add `packages/explorer/**` to the workflow's `paths` (or create `.github/workflows/explorer-ci.yml` if the indexer workflow's triggers no longer make sense for it — prefer the separate workflow; the trees are separate products now).

- [ ] **Step 5: Verify both trees independently**

```bash
cd packages/indexer && yarn install --immutable && yarn typecheck && yarn test && yarn build
cd ../explorer && yarn install --immutable && yarn typecheck && yarn test && yarn build
```
Expected: green, and the indexer build no longer builds the SPA.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer packages/explorer .github/workflows
git commit -m "refactor(explorer): separate the SPA into its own tier-4 tree

#2296 step 2, first half: the explorer is a product, not a subdirectory of
the Ponder process (design 7). Part of #2296."
```

---

### Task D2: Re-scope the Ponder process to hosted archive + query plane

**Files:**
- Modify: `packages/indexer/package.json` (`description`, `name` if renamed)
- Modify: `packages/indexer/README.md` (replace the tier map from #2296 step 1)
- Modify: `packages/indexer/src/handlers.ts` (retire the handlers the stack projector replaces — enumerate in Step 1)
- Modify: `.github/scripts/indexer-boundaries.test.mjs` (extend the guard to pin the new role boundary)
- Modify: `packages/indexer/src/api/explorer.ts` (it stays — the query plane serves the explorer over HTTP, it does not import the SPA)

**Interfaces:**
- Consumes: Task D1's separation.
- Produces: an indexer package whose declared role is hosted archive + query plane, with the projector role's dead handlers removed.

- [ ] **Step 1: Enumerate what the stack projector replaced**

```bash
grep -n "ponder.on(" packages/indexer/src/handlers.ts
grep -rn "ponder.on(\|export function" packages/marketplace/projector/src --include=*.ts | head -30
```
Produce a two-column list: each Ponder event handler, and whether `packages/marketplace/projector` now derives the same facts. Handlers with a projector equivalent are dead; handlers without one are the archive/query-plane role and stay. **A handler you cannot classify is a finding** — report it rather than guessing.

- [ ] **Step 2: Write the failing role-boundary test**

Append to `.github/scripts/indexer-boundaries.test.mjs`:

```js
test('the indexer declares the archive + query-plane role, not the projector role', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/indexer/package.json'), 'utf8'));
  // #2296 step 2 (design 7): the stack projector replaced this process's
  // projector role. What remains is hosted archive + query plane.
  assert.match(manifest.description, /archive/i);
  assert.doesNotMatch(manifest.description, /indexer for the Jinn protocol/i);
  // The SPA left in step 2's first half; nothing here may reach into it.
  const handlers = readFileSync(join(root, 'packages/indexer/src/handlers.ts'), 'utf8');
  assert.doesNotMatch(handlers, /explorer\//);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test .github/scripts/indexer-boundaries.test.mjs`
Expected: FAIL on the description.

- [ ] **Step 4: Re-scope**

Delete the dead handlers from Step 1. Rewrite `package.json`'s `description` to name the surviving role, for example: `Hosted archive and query plane over the Jinn discovery projection — the explorer's read backend. The projector role is served by @jinn-network/marketplace-projector.`

Replace the README's tier map (added by #2296 step 1) with the post-split statement:

```markdown
## Role (post #2296 step 2)

This process is the **hosted archive + query plane**. It serves the
discovery projection per the discovery design's projection rules and backs
the explorer over HTTP.

The **projector role is served by `packages/marketplace/projector`**
(projector #1) — replaced by the stack, not moved. The **explorer SPA** is
its own tier-4 product tree at `packages/explorer/`.
```

- [ ] **Step 5: Run**

```bash
node --test .github/scripts/indexer-boundaries.test.mjs
cd packages/indexer && yarn typecheck && yarn test && yarn build
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer .github/scripts/indexer-boundaries.test.mjs
git commit -m "refactor(indexer): re-scope to hosted archive + query plane

The stack projector replaced the projector role; the dead handlers go and
the declared role follows (design 7, #2296 step 2). Part of #2296."
```

---

### Task D3: Re-point the Railway deployment once

**Files:**
- Modify: `packages/indexer/deploy/Dockerfile` (drop the explorer build stage)
- Modify: `packages/indexer/deploy/railway.toml` (watchPatterns, build command, healthcheck)
- Create: `packages/explorer/deploy/` (Dockerfile + railway.toml for the explorer service)
- Modify: `packages/indexer/deploy/README.md`

**Interfaces:**
- Consumes: Tasks D1 and D2.
- Produces: two deployable services with independent watch patterns.

- [ ] **Step 1: Read the current deploy config**

```bash
cat packages/indexer/deploy/Dockerfile packages/indexer/deploy/railway.toml packages/indexer/deploy/README.md
```
Note every reference to `explorer/` and every `watchPatterns` entry that would now fire the wrong service. Schema-changing indexer deploys crash-loop on Ponder `MigrationError` until `DATABASE_SCHEMA` is bumped — if this change alters the schema, the PR body must say so and name the env-var bump.

- [ ] **Step 2: Strip the explorer from the indexer image**

Remove the SPA build stage and any `COPY packages/indexer/explorer` line from `packages/indexer/deploy/Dockerfile`. In `railway.toml`, drop `packages/indexer/explorer/**` from `watchPatterns`.

- [ ] **Step 3: Write the explorer's own deploy config**

`packages/explorer/deploy/Dockerfile` — a static build (`yarn install --immutable && yarn build`) served from the `dist/` output; `packages/explorer/deploy/railway.toml` — `watchPatterns = ["packages/explorer/**"]`, the build command, and the healthcheck path. Model both on the indexer's existing files rather than inventing a new pattern.

- [ ] **Step 4: Build both images locally**

```bash
docker build -f packages/indexer/deploy/Dockerfile -t jinn-indexer-check .
docker build -f packages/explorer/deploy/Dockerfile -t jinn-explorer-check .
```
Expected: both succeed. The indexer image must build without the SPA toolchain present.

- [ ] **Step 5: Document the one-time re-point**

In `packages/indexer/deploy/README.md`, add the operator steps: the explorer service is created from `packages/explorer/deploy/`, the indexer service's watch patterns narrow, and the explorer's API base URL points at the indexer service's public URL. Name it as a **one-time** re-point — the whole reason this task is gated on stage 4.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/deploy packages/explorer/deploy
git commit -m "chore(deploy): split the indexer and explorer Railway services

The explorer re-points once, at stage 4, not twice (design 7 step 2).
Closes #2296."
```

---

# Phase E — the DevX docs (gate: #2293 stable + follow-up 1's hosting; E1–E3 start anytime)

Branch target: `next`. **Tasks E1, E2, and E3 are ungated — start them any time.** Only E4 waits, because a conformance claim cannot be made until the profile URIs resolve (design §8.4 clause 1).

### Task E1: Class-1 quickstart — post a task with the `jinn` CLI (start anytime)

**Files:**
- Create: `docs/quickstarts/class-1-cli.md`
- Create: `docs/quickstarts/README.md` (index of the four quickstarts + the custody page)

- [ ] **Step 1: Check whether it already exists**

```bash
ls docs/quickstarts/ 2>/dev/null
grep -rln "jinn tasks submit" docs/ client/docs/ | head
```
If a class-1 quickstart already landed (Task A7 created the directory), extend the index rather than duplicating.

- [ ] **Step 2: Write it against the real CLI**

Read `client/src/cli/commands/tasks.ts`'s argument surface and transcribe the actual flags. Cover: install (`npm install -g @jinn-network/client@latest`), first run (`jinn run` — the keystore password is auto-generated at `~/.jinn-client/keystore-password`), funding, `jinn tasks submit --spec-file`, and observing the delivery. State plainly that the CLI holds the keys in a machine-local keystore, and that an organization with a KMS custody policy is **class 3, not class 1** — point at `class-3-work-client.md`.

- [ ] **Step 3: Write the index**

`docs/quickstarts/README.md` — a table: consumer class, what it is, which quickstart, what custody it implies. Four rows plus the custody page. No narration beyond the table (frontend rules apply to docs surfaces too: show, do not narrate).

- [ ] **Step 4: Verify every command actually runs**

Run each command in the quickstart against a local daemon or an Anvil fork. A command that does not run as written is a bug in the quickstart, not a caveat to add.

- [ ] **Step 5: Run the docs guard and commit**

```bash
node --test .github/scripts/docs-key-guard.test.mjs
git add docs/quickstarts
git commit -m "docs: class-1 CLI quickstart and the quickstart index (design 8.3)"
```

---

### Task E2: Class-2 quickstart — implement a backend against the kits (start anytime)

**Files:**
- Create: `docs/quickstarts/class-2-platform-implementer.md`
- Modify: `docs/quickstarts/README.md` (index row)

- [ ] **Step 1: Inventory the conformance kits and fixtures**

```bash
ls packages/marketplace/testing/src packages/task-execution/testing/src packages/discovery/testing/src packages/trust/testing/src
node -e "console.log(Object.keys(require('./packages/marketplace/testing/package.json').exports))"
```
The quickstart names real kit entry points and real fixture directories — nothing invented.

- [ ] **Step 2: Write the "you never run Jinn code" path**

Cover, in order: the record schemas and their profile URIs; producing a record and sealing it; verifying someone else's record; running the relevant conformance kit against your implementation; where the golden and adversarial fixtures live and why they are immutable (design §8.1 — append-only, superseded-never-edited, errata records). Show one worked example: a minimal backend implementing `TaskExecutionBackend` and passing `@jinn-network/marketplace-testing/backend-conformance`.

- [ ] **Step 3: Verify the worked example compiles and the kit passes**

Write the example into a scratch directory, install the packed packages, and run the kit. If it does not pass, the example is wrong — fix it before shipping the doc.

- [ ] **Step 4: Commit**

```bash
git add docs/quickstarts
git commit -m "docs: class-2 platform-implementer quickstart (design 8.3)"
```

---

### Task E3: Read-side quickstart — compose the discovery and retrieval primitives (start anytime)

The design mints no read-side package (§5.2); this quickstart *is* the read side's surface, so it carries more weight than a normal doc.

**Files:**
- Create: `docs/quickstarts/read-side.md`
- Modify: `docs/quickstarts/README.md` (index row)

- [ ] **Step 1: Read the two packages' actual surfaces**

```bash
grep -n "^export " packages/discovery/client/src/index.ts
grep -n "^export " packages/evidence/retrieval/src/index.ts
```
`@jinn-network/record-discovery-client` (sync, subscribe, verify) and `@jinn-network/evidence-retrieval` (bounded exact-byte retrieval, federation, candidates).

- [ ] **Step 2: Write the composition, end to end**

One runnable example: point at an archive URL, sync heads, verify, subscribe to the tail, resolve a record's evidence candidates, retrieve the exact bytes, verify the digest. Say plainly why there is no facade package: bare read composition costs convenience, not money (§5.2's risk asymmetry) — and record the facade trigger so a reader who finds this painful knows the escalation path (a first external read consumer or the public hosted archive demonstrating genuine pain, or the daemon's evidence driver turning out generic).

- [ ] **Step 3: Run the example**

Against the operator's local archive (daemon stage 4's surface) or a fixture-backed transport. Every line must execute.

- [ ] **Step 4: Commit**

```bash
git add docs/quickstarts
git commit -m "docs: read-side quickstart — discovery client + evidence retrieval

The read plane ships primitives, not a facade (design 5.2); this
composition is its documented surface."
```

---

### Task E4: Conformance-claim checklist (gate: follow-up 1's profile URIs resolve)

**Gate:** the reserved `https://jinn.network/profiles/…` URIs serve their schema and profile documents under the DSSE-signed SHA-256 manifest (design §8.4 clause 1). Verify:

```bash
curl -sSI https://jinn.network/profiles/task-execution/1.0 | head -1
curl -sS https://jinn.network/profiles/manifest.json | head -20
```
Expected: `200` and a signed manifest. Anything else stops this task — the checklist would be uncheckable.

**Files:**
- Create: `docs/conformance/claim-checklist.md`
- Modify: `docs/quickstarts/README.md` (link it from the class-2 row)

- [ ] **Step 1: Write the three clauses as a literal checklist**

`docs/conformance/claim-checklist.md`, stating up front that enforcement is **honor system plus published vectors** — there is no trademark program and no certification body, and policing would be theater. Then the three clauses as checkboxes a claimant fills in:

1. **The profile URIs resolve.** Name each profile URI you claim conformance to, and confirm each serves its document under the signed manifest.
2. **Name versions and cite digests.** The kit version, the package versions you passed against, and the **profile-document SHA-256 digests** — not bare URIs. The URI is the name; the bytes are pinned, so a hosting compromise or a quiet redeploy is detectable.
3. **Publish the results artifact.** The kit's output, published where a reader can fetch it.

- [ ] **Step 2: Add the blessed-package rule and the OCI upgrade path**

State §8.4's rule mechanically: a package is blessed **if and only if** it is in the `@jinn-network` npm scope **and** carries trusted-publisher provenance attesting a `Jinn-Network` repository — machine-checkable. Give the verification command. State that any list page is a rendering of that rule and never the rule itself, so a lookalike page proves nothing.

Then the reserved upgrade path: claims filed by PR to a conformance directory with a reviewed evidence bundle (the OCI shape), triggered by the first genuine third-party claim.

- [ ] **Step 3: Verify a claim can actually be made**

Walk the checklist yourself for one profile end to end: fetch the profile document, compute its digest, run the relevant kit, and confirm every field the checklist asks for is obtainable. A field you cannot fill is a defect in the checklist or in follow-up 1's hosting — report which.

- [ ] **Step 4: Run the docs guard and commit**

```bash
node --test .github/scripts/docs-key-guard.test.mjs
git add docs/conformance docs/quickstarts
git commit -m "docs: conformance-claim checklist (honor system, digest-citing)

Design 8.4: three clauses, the mechanical blessed-package rule, and the
reserved OCI upgrade path. Closes #<quickstarts/DevX issue>."
```

---

## Self-review

**Spec coverage.** §10 row 4 → A1. Row 5 → A2/A3/A4/A5. Row 6 → A6. Row 8 (R2) → B1/B3/B4 plus B2's coordination mechanism and B5's re-homing finding; row 8 (R3) → C1/C2/C3. Row 9 step 2 → D1/D2/D3. Row 11 → A7 (class 3 + custody), E1 (class 1), E2 (class 2), E3 (read side), E4 (checklist). Row 12 → A8. §4.3's four-step sequence → A1 (step 1), A3 (steps 2–3), A6 (step 4). §4.4's "packed external-consumer acceptance discipline extends to the work client" → A2 Step 1's `pack:smoke` + A2 Step 4's CI job. §8.1's fixture immutability → A1 Steps 2–3 (digest manifest, append-only) and A6 Step 5 (new cases append, never replace). §8.2 semver → the Global Constraints line, applied at every sdk bump. §8.3's docs guard → A7 Step 3, E1 Step 5, E4 Step 4. §4.1 C2/C3 custody → A2 Step 5, A3 Step 6, A6 Step 3, A7 Step 2. Not covered by design, deliberately: follow-ups 1, 2, 3, 7, 9, 13 — 3/7/9/13 are the immediate tranche (assumed merged); 1 and 2 are their own issues gating Phase E and riding #2293's publish path, and are named as gates rather than implemented.

**Placeholder scan.** Every `<...>` in this plan is an issue number an implementer fills from `gh issue list` at execution time, or a fixture literal a step explicitly instructs to copy from real files with a named path — never a "TBD". Three steps deliberately require reading real code before writing (A1 Step 1's thresholds, D2 Step 1's handler classification, C2 Step 1's document fixtures); each states what to read and what to do when the read contradicts the plan.

**Type consistency.** `RequesterPreflightHarness` / `PreflightInput` / `PreflightOutcome` / `runRequesterPreflightConformance` are defined in A1 Step 3 and consumed identically in A1 Step 4 and A4 Step 1. `normalizeSubmitInput` / `NormalizedSubmitInput` are defined in C2 Step 3 and removed in C3 Step 3. The package name `@jinn-network/marketplace-work-client` is identical in A2, A3, A4, A5, A6, A8, and A7. sdk versions chain without gaps: `0.2.0` (assumed, #2306) → `0.3.0` (B1) → `0.4.0` (B3) → `0.5.0` (B4) → `0.6.0` (C3), each asserted in that task's test.

**Task count:** 23 (A: 8, B: 5, C: 3, D: 3, E: 4), 116 checkbox steps.
