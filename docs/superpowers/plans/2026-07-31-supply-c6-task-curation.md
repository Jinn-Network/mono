# Supply C6 — Task Curation (`@jinn-network/task-curation`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-07-31
**Shape:** `feat`
**Component:** C6 of the verified-environment supply program.
**Program:** [`2026-07-31-supply-program.md`](2026-07-31-supply-program.md) — §1 (C6 row), §3 (branch `supply/c6-task-curation`, base `integration/evidence-v1`, independent lane), §4 (pinned C6 names), §5 (cross-plan contracts, copied verbatim into Global Constraints below), §6 (gates).
**Design (law):** [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md) — §9 in full (the curation projection), §12 (non-goals), §13 F6 (curation-signal integrity, normative for this unit), §14 (per-solver-model breakdown is an extension, out of scope).
**Package:** `@jinn-network/task-curation` at `packages/task-supply/curation`.
**Findings:** see [§Findings](#findings-2026-07-31) — this plan resolves six real spec-vs-repo gaps and plans against the stated dispositions.

## Goal

Ship the pass-rate projection as a **pure, deterministic, re-derivable** library: verdict
observations in → per-task rows carrying `{taskDigest, attempts, verdicts, passRate: {num,
den}, window, inputRefs, bucket}` out. No clock, no I/O, no sealing, no record. The unit's
whole reason for existing is design §13 F6: because sybil/collusion pass-rate manipulation
**cannot** be prevented at the projection layer, the contract makes manipulation *visible in
the inputs* and the projection *re-derivable under any consumer's own filter*. Every design
choice below is downstream of that sentence.

Success criteria (all must hold before the component is claimed done):

1. `projectCuration(observations)` is a pure function — no `Date.now`, no `fetch`, no `fs`,
   no `Math.random`, enforced by a guard that scans the built source.
2. Any permutation of the same observation multiset produces a byte-identical serialization.
3. No float appears anywhere on the output type: `passRate` is always `{num, den}`; the row
   key set is pinned by test; every numeric leaf is `Number.isInteger`.
4. `saturationAt(row, threshold)` never applies a threshold the caller did not supply, and
   `SATURATION_REFERENCE_BAND` is exported as documentation only.
5. The F6 kit proves both derivations: full inputs → rate A with the sybil cohort's refs
   present in `inputRefs`; consumer-filtered inputs → rate B, refs absent.
6. `foldCuration(previous, newObservations)` is idempotent under at-least-once redelivery and
   equals `projectCuration` over the union.

## Architecture

One standalone Yarn package, `packages/task-supply/curation`, with **zero Jinn dependencies**
(`zod` is the only runtime dependency). That is not an accident of scope — it is the custody
posture. The projector must not be able to fetch, resolve, or seal anything, so it must not
be able to *reach* a package that can.

The input type is a **neutral `CurationObservation`** defined in this package with an explicit
adapter boundary, not a reuse of a discovery type. That is forced by repo reality (see
[Findings](#findings-2026-07-31)): no verdict-observation shape exists on
`integration/evidence-v1`, and the three fields curation needs most — the *subject* task
digest, an instant, and an evaluator attribution — are each one join away from what the
marketplace projector actually announces. `CurationObservation` is field-for-field aligned
with the real shapes it mirrors, and a repo-level drift guard re-reads those upstream files on
every CI run so a rename upstream fails this package loudly instead of silently.

Module layout:

| File | Contents |
| --- | --- |
| `src/observation.ts` | `CurationObservation`, `CurationInputRef`, `ObservedVerdict`, `Instant`, `inputRefKey`, `parseCurationObservation`, `CurationInputError` |
| `src/projection.ts` | `CurationProjection`, `CurationRow`, `Ratio`, `CurationWindow`, `CurationBucket`, `projectCuration`, `foldCuration` |
| `src/saturation.ts` | `compareRateTo`, `saturationAt`, `SATURATION_REFERENCE_BAND`, `SATURATION_REFERENCE_BAND_RATIO` |
| `src/serialize.ts` | `CURATION_PROJECTION_FORMAT`, `serializeCurationProjection`, `parseCurationProjection` |
| `src/index.ts` | The whole public surface (re-exports the four above) |
| `fixtures/*.json` | Observation inputs + the golden projection, exported via `./fixtures/*` so a reviewer can re-derive by hand |
| `.github/scripts/task-supply-curation-guards.test.mjs` | This branch's minimal guard file (purity, no-record, no-legacy-import, bounded language, upstream drift, inventory) |
| `.github/workflows/task-supply-curation-ci.yml` | This branch's CI |

**Guard-consolidation note (plan note, not a problem).** Program §1 gives the
`packages/task-supply/` tree scaffolding and the full guard trio
(`task-supply-package-inventory` / `-source-boundaries` / `-packed-types` + `task-supply-ci.yml`)
to **C3**, but C6's branch bases on `integration/evidence-v1`, where neither the tree nor C3's
guards exist. This plan therefore creates the tree directory and **one curation-scoped guard
file plus one curation-scoped workflow**, deliberately named so they cannot collide with C3's
(`task-supply-curation-*` vs `task-supply-*`). At the merge of `supply/c3-task-admission` and
`supply/c6-task-curation` onto integration, the curation guard's assertions fold into C3's
trio and `task-supply-curation-ci.yml` folds into `task-supply-ci.yml` as one more job — that
consolidation is Task 8 Step 7's recorded follow-up, not a defect in either plan.

## Tech Stack

TypeScript 5.9 (`strict`, `moduleResolution: Bundler`, ES2022 target/module), Node 22,
Yarn 4.13.0 via Corepack with `nodeLinker: node-modules` and a standalone `yarn.lock`,
Vitest 4.1.8, `zod` **4.4.3** (exact pin, matching
`packages/discovery/protocol/package.json`). No `@noble/hashes` — this package never hashes
anything, because it never produces a record. No canonical-JSON library — the serialized
projection is host-stored derived state, not sealed bytes.

## Global Constraints

_Every task's requirements implicitly include this section. Items 1–12 are program §5 verbatim;
items 13–18 are this component's own._

1. **Designs are law** — spec `5b0739832`; defects are findings with dispositions.
2. **Kits and fixtures precede implementations**; a layer's kit is green before dependents build.
3. **Sealing is re-implemented per package** (C1) — never shared runtime sealing code. *For C6
   this resolves to: **no sealing at all** (see constraint 14).*
4. **Custody law** — no key material, no ambient authority (incl. no ambient `fetch`), signer
   objects and ports injected, fail closed.
5. **No product names in tiers 1–3**; no unit imports `@jinn-network/core`, `plugin`,
   `jinn-layer`, or `client/`.
6. **Digest discipline:** record-body digests `sha256:`-prefixed; in-toto DigestSet subjects
   bare hex. *C6 only ever carries `sha256:`-prefixed digests, and produces none.*
7. **Admission is attestation-agnostic** (spec §7.1). *No C6 surface.*
8. **Bounded claims:** no API, log line, or doc in any package may say "deterministic" or
   "verified" without the K/controls or trust-policy qualification the spec gives those words.
9. **Guards ship with the packages** (see the guard-consolidation note above).
10. **TDD per task; verification before completion** — typecheck, tests, guards run locally
    with output shown before any task is reported done.
11. **Stop on missing Consumes** — a symbol a task consumes that isn't on the base branch is a
    stop-and-report.
12. **Legacy code is reference only** — read `client/src` freely, import never.
13. **Preflight invariant.** All work sits on top of `origin/integration/evidence-v1` at
    `34a7b3cbd45c7e0760daf733405c9a04d0bb3c0a`. `git merge-base --is-ancestor 34a7b3cbd HEAD`
    MUST pass before any task.
14. **Projection, never record (spec §9, principles §7).** This package MUST NOT seal, sign,
    hash, assign a record kind, or write a "current status" artifact. `serializeCuration
    Projection` produces host-storable derived state whose envelope carries a `format` token
    that is deliberately **not** under `https://jinn.network/records/`. Enforced by guard.
15. **No clock.** The window comes from observation timestamps only. `Date.now`, `new Date()`
    with no argument, `performance.now`, and `Math.random` are banned in production source;
    `Date.parse` is the single allowlisted time primitive (it is pure). Enforced by guard.
16. **Bare-rate-free by construction.** A pass rate is *always* `{num, den}`. No division
    operator produces an output value anywhere; `saturationAt` compares by exact integer
    cross-multiplication. Enforced by a pinned-key-set + integer-leaf test.
17. **Attribution-preservation is normative (design §13 F6).** Every row carries `inputRefs`
    listing every verdict announcement that fed it. A row without complete `inputRefs` is a
    contract violation, not an optimization.
18. **Bounded language for this unit (constraint 8, applied).** The output is an **observed
    pass rate over observed verdicts** — never a "difficulty score", never "task difficulty",
    never "intrinsic". `attempts` means *distinct attempts among the observed verdicts*, not
    attempts posted. Enforced by a banned-phrase guard over `src/**` and `README.md`.

<a id="findings-2026-07-31"></a>
## Findings (2026-07-31) — spec vs. repo reality, with dispositions

Filed per program §5 contract 1. Each is a real gap verified on
`origin/integration/evidence-v1` @ `34a7b3cbd`; the plan below is written **against the
disposition**, not against the spec's implied shape.

### FC6-1 — No verdict-observation type exists. Neutral input + named adapter boundary.

Design §9 says "verdict observations → per-task empirical pass rate" but names no input type,
and none exists on the base branch. The nearest existing shapes are:

- `packages/discovery/protocol/src/item.ts` → `AnnouncedItem` — the query/subscribe-plane
  per-item shape: `{record: RecordRef, facts?: unknown, locations?, provenance: {source,
  entry, announcementId, derivation?}}`. This is what a curation host actually receives from
  `DiscoveryQueryService.search`/`referrers` (discovery design §8).
- `packages/marketplace/projector/src/announce.ts` → the `VerdictDeliveryClaimed` branch,
  which announces the evaluation Delivery record with a facts card = `deliveryRecompute`
  output **plus** the namespaced card
  `"https://jinn.network/facts/marketplace-verdict-correspondence/1.0": {onChainVerdictCode,
  statementVerdict}` where `statementVerdict: "pass" | "fail" | "inconclusive"`.
- `packages/discovery/facts/task-execution/profiles/delivery.1.0.json` → the Delivery facts
  profile fields: `taskDigest` (reference-bearing), `attemptUri`, `outcome`, `benchrun`,
  `benchcell`, `bencharm`.

`AnnouncedItem` cannot be curation's input directly: `facts` is typed `unknown`, it carries no
instant, and (FC6-2/FC6-4/FC6-5 below) three of the five fields curation needs are one join
away. **Disposition:** define a neutral `CurationObservation` in this package, field-for-field
aligned with the above, and name the marketplace→curation adapter as an explicit, deferred
composition task (program §8: "product composition … deferred to a thin ops note once C5-app
lands"). The adapter needs `fetch`/`referrers` capability; curation must not — keeping them in
separate packages is the custody boundary, not a convenience. A **drift guard** (Task 1 Step 5)
re-reads `item.ts` and `delivery.1.0.json` on every CI run so an upstream rename breaks this
package loudly.

### FC6-2 — The verdict's own `taskDigest` is the *evaluation* task, not the subject task.

`packages/marketplace/binding/src/evaluation-derive.ts` calls `deriveEvaluationTask(...)` and
seals a **separate** evaluation Task (profiles design §9.1 "full-document template, slot-fixed
pair"); the evaluation Delivery's `task` field (`packages/task-execution/protocol/src/schemas/
delivery.ts`, `task: Sha256Digest`) therefore holds the *derived evaluation Task* digest. The
subject Task digest lives in the evaluation Task's payload (`subjectTask.digest`) and in the
Result Evaluation Statement's subjects (profiles §9.2) — both behind bytes.

**Disposition:** `CurationObservation.taskDigest` is documented as **the subject Task digest,
adapter-resolved**. Curation fails closed on a malformed digest and never guesses. The
resolution route (fetch the evaluation Task bytes → `subjectTask.digest`, or read the REST
statement subjects, or a `referrers()` walk) is the adapter's contract, recorded in the
package README §Adapter boundary. Keying rows on the *evaluation* task digest would silently
produce a one-verdict-per-row projection — the failure this finding prevents.

### FC6-3 — `AnnouncedItem` carries no timestamp; the entry does.

`AnnouncedItem.provenance` cites the entry digest, not its time. The instant lives on
`AnnouncementEntry.timestamp` (`packages/discovery/protocol/src/entry.ts`), which the
marketplace projector fills from `event.projection.timestamp` — documented in
`packages/marketplace/projector/src/observe.ts` as "Deterministic block timestamp in RFC 3339
form; never projector wall-clock time."

**Disposition:** `CurationObservation.observedAt` is that value, adapter-supplied. It is the
package's **only** time source; there is no clock (constraint 15). This is what makes the
window re-derivable by a third party from the same announcements.

### FC6-4 — Benchmark run pinning lives on the *solution* Delivery, not the verdict.

Benchmarking design §11: "Announcements of cell Submissions and their Deliveries carry
filterable attributes `benchrun` (Run record digest), `benchcell` (cellKey), `bencharm`
(armId), copied from the Submission's benchmarking extension block." Confirmed in
`packages/discovery/facts/task-execution/profiles/{submission,delivery}.1.0.json` and produced
by `packages/discovery/facts/task-execution/src/recompute.ts` (`deliveryRecompute` reads
top-level `run`/`cellKey`/`armId` off the loose Delivery bytes). The *evaluation* delivery is a
different Submission and carries no such guarantee.

**Disposition:** `CurationObservation.benchmarkRun` is the `benchrun` value **of the judged
solution Delivery**, adapter-joined; absent ⇒ organic. The bucket axis is derived from it, so
the axis is grounded in a real, named, CloudEvents-liftable field rather than invented. This
implements design §9's "consumers computing *organic* difficulty SHOULD filter or separately
bucket them" as *separately bucket* — the projection emits one row per `(taskDigest, bucket)`,
so an organic consumer reads the organic row and never has to know benchmarking exists.

### FC6-5 — Evaluator attribution is on-chain but is not carried into the facts card.

`VerdictDeliveryClaimed` carries `evaluator: Address`
(`packages/marketplace/projector/src/events.ts`), and the REST statement predicate carries
`evaluator.id` (profiles §9.2) — but neither reaches the announcement facts card, so a
consumer wanting to filter a cohort today must fetch records.

**Disposition:** `CurationObservation.attribution` is a **required** opaque identity string,
adapter-supplied from either source. It is the field F6's "re-derive under their own solver
filter" runs on, and making it required is the fail-closed choice. Curation itself **never**
buckets, groups, or reports on it (design §9: aggregate across solvers in v1; per-solver-model
breakdown is the §14 extension) — it exists so the consumer's filter is a cheap local predicate
over observations rather than a fetch storm. **Proposed follow-up F6a** (record only, not built
here): an additive optional `evaluator` field on the Delivery facts profile, owned by the
task-execution profiles package, would let the filter run entirely on announcements. Filed
against the design's F6 line at the program review.

### FC6-6 — `SATURATION_REFERENCE_BAND` as decimals conflicts with the float-free discipline.

The band is stated in design §9 as "[2%, 70%]" and in the C6 brief as `{min: 0.02, max: 0.70}`.
`saturationAt` cannot consume a float without reintroducing the bare rate the contract bans.

**Disposition:** export **both**, with a test asserting they agree —
`SATURATION_REFERENCE_BAND = {min: 0.02, max: 0.70}` (documentation/display, matching the
stated numbers verbatim) and `SATURATION_REFERENCE_BAND_RATIO = {min: {num: 2, den: 100}, max:
{num: 70, den: 100}}` (the form `saturationAt` consumes). Neither is a default parameter
anywhere; `saturationAt` has arity 2 and a test asserts it.

### FC6-7 — `passRate` denominator: `inconclusive` excluded, and the exclusion is visible.

Design §9 fixes only that a rate carries numerator and denominator. The observed verdict
vocabulary is three-valued (`pass | fail | inconclusive`, from
`AnnouncementProjectionPorts.verifyVerdictObservation`'s `statementVerdict`).

**Disposition:** `passRate = {num: pass, den: pass + fail}`. Inconclusive verdicts are counted
in `verdicts` but not in `den`, so `verdicts - passRate.den` recovers the inconclusive count
and `passRate.den - passRate.num` recovers the fail count exactly — the full three-way
breakdown is derivable from the four pinned integers with no extra field. Documented in the
README and asserted by test. Recorded here because it is a decision the spec left open, not a
detail.

### FC6-8 — Guard-tree ownership crosses branches.

See the guard-consolidation note in §Architecture. Recorded as a plan note with a named
consolidation step (Task 8 Step 7), not a blocker.

---

## Task 1 — Tree, package scaffolding, guards, CI

**Files**
- `packages/task-supply/curation/package.json` (create)
- `packages/task-supply/curation/.yarnrc.yml` (create)
- `packages/task-supply/curation/tsconfig.json` (create)
- `packages/task-supply/curation/tsconfig.build.json` (create)
- `packages/task-supply/curation/vitest.config.ts` (create)
- `packages/task-supply/curation/scripts/build.mjs` (create)
- `packages/task-supply/curation/scripts/pack-smoke.mjs` (create)
- `packages/task-supply/curation/src/index.ts` (create, placeholder export only)
- `packages/task-supply/curation/yarn.lock` (generated, committed)
- `.github/scripts/task-supply-curation-guards.test.mjs` (create)
- `.github/workflows/task-supply-curation-ci.yml` (create)

**Interfaces**
- **Consumes:** nothing from any Jinn package. Read-only file citations for the drift guard:
  `packages/discovery/protocol/src/item.ts` (symbols `AnnouncedItem`, `SourceIdentity`,
  `RecordRef`) and `packages/discovery/facts/task-execution/profiles/delivery.1.0.json`
  (fields `taskDigest`, `attemptUri`, `benchrun`) — both verified present on
  `origin/integration/evidence-v1` @ `34a7b3cbd`.
- **Produces:** the package skeleton; no pinned C6 name yet.

**Steps**

- [ ] **Step 1 — Preflight.** Run and require success:
  ```bash
  git fetch origin integration/evidence-v1
  git checkout -b supply/c6-task-curation origin/integration/evidence-v1
  git merge-base --is-ancestor 34a7b3cbd45c7e0760daf733405c9a04d0bb3c0a HEAD && echo PREFLIGHT-OK
  ```
  Expected: `PREFLIGHT-OK`. If it fails, stop and report — do not rebase around it.

- [ ] **Step 2 — Write `package.json`.** Zero `@jinn-network/*` entries anywhere; that is the
  point, and the guard in Step 5 asserts it.
  ```json
  {
    "name": "@jinn-network/task-curation",
    "version": "0.1.0",
    "description": "Pure, re-derivable projection of observed verdicts into per-task observed pass rates.",
    "type": "module",
    "packageManager": "yarn@4.13.0",
    "engines": { "node": ">=22" },
    "license": "MIT",
    "repository": {
      "type": "git",
      "url": "https://github.com/Jinn-Network/mono.git",
      "directory": "packages/task-supply/curation"
    },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
      "./fixtures/*": "./fixtures/*"
    },
    "files": ["dist/", "fixtures/", "README.md"],
    "publishConfig": { "access": "public" },
    "scripts": {
      "build": "node scripts/build.mjs",
      "typecheck": "tsc --noEmit -p tsconfig.json",
      "test": "vitest run",
      "pack:smoke": "node scripts/pack-smoke.mjs",
      "prepack": "yarn build"
    },
    "dependencies": { "zod": "4.4.3" },
    "devDependencies": {
      "@types/node": "^22.0.0",
      "typescript": "^5.9.3",
      "vitest": "^4.1.8"
    }
  }
  ```

- [ ] **Step 3 — Copy the standard leaf config.** `.yarnrc.yml` = `nodeLinker: node-modules`.
  `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `scripts/build.mjs` are
  byte-copies of `packages/benchmarking/aggregate/`'s equivalents (that package's
  `tsconfig.json` targets ES2022 / module ES2022 / moduleResolution Bundler / strict /
  declaration / `rootDir: src` / `outDir: dist`). `scripts/pack-smoke.mjs` is the *simplified*
  form — there are no portal dependencies to pack:
  ```js
  import { spawn } from "node:child_process";
  import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { dirname, join } from "node:path";
  import { fileURLToPath } from "node:url";

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-curation-"));
  const consumer = join(temporaryRoot, "consumer");

  function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: "inherit", ...options });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} exited with ${code}`));
      });
    });
  }

  try {
    const archive = join(temporaryRoot, "task-curation.tgz");
    await run("yarn", ["pack", "--out", archive], { cwd: packageRoot });
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "@jinn-network/task-curation": `file:${archive}` },
      }),
    );
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

    const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-curation");
    const smokeScript = join(consumer, "smoke.mjs");
    // The installed root arrives on argv, not interpolated into the script text: no nested
    // template escaping, and the script stays readable.
    await writeFile(
      smokeScript,
      [
        'import { readFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        'import { projectCuration, SATURATION_REFERENCE_BAND_RATIO } from "@jinn-network/task-curation";',
        'if (projectCuration([]).rows.length !== 0) throw new Error("empty projection is not empty");',
        'if (SATURATION_REFERENCE_BAND_RATIO.max.num !== 70) throw new Error("reference band drifted");',
        'const manifest = JSON.parse(await readFile(join(process.argv[2], "package.json"), "utf8"));',
        'const jinn = Object.keys(manifest.dependencies ?? {}).filter((n) => n.startsWith("@jinn-network/"));',
        'if (jinn.length !== 0) throw new Error("unexpected Jinn coupling: " + jinn.join(", "));',
        'console.log("Installed package imports and dependency boundary verified.");',
      ].join("\n"),
    );
    await run(process.execPath, [smokeScript, installedRoot], { cwd: consumer });

    const distFiles = await readdir(join(installedRoot, "dist"));
    if (distFiles.some((name) => name.includes(".test."))) {
      throw new Error("test output leaked into dist");
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  ```
  (`pack:smoke` imports `projectCuration` and `SATURATION_REFERENCE_BAND_RATIO`, so it does not
  pass until Task 7 lands. Step 8 below therefore does **not** run it; Task 8 Step 8 does.)

- [ ] **Step 4 — Placeholder `src/index.ts`** so `typecheck` and `test` have something to chew:
  ```ts
  // Public surface of @jinn-network/task-curation. Filled in by Tasks 2-8.
  export const TASK_CURATION_PACKAGE = "@jinn-network/task-curation" as const;
  ```

- [ ] **Step 5 — Write the guard file** `.github/scripts/task-supply-curation-guards.test.mjs`.
  Six `node --test` cases. Write it, then run it and confirm all six pass:
  ```js
  import assert from 'node:assert/strict';
  import { existsSync, readFileSync, readdirSync } from 'node:fs';
  import { join, resolve } from 'node:path';
  import { test } from 'node:test';

  const root = resolve(import.meta.dirname, '../..');
  const pkg = join(root, 'packages', 'task-supply', 'curation');

  function productionSources() {
    const src = join(pkg, 'src');
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
      }
    };
    walk(src);
    return out;
  }

  test('inventory: standalone leaf with zero Jinn dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@jinn-network/task-curation');
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.packageManager, 'yarn@4.13.0');
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['zod']);
    assert.equal(manifest.resolutions, undefined, 'a portal resolution means a Jinn dependency crept in');
    for (const bag of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(manifest[bag] ?? {})) {
        assert.ok(!name.startsWith('@jinn-network/'), `${bag} must not name ${name}`);
      }
    }
    assert.ok(existsSync(join(pkg, 'yarn.lock')), 'standalone yarn project needs its own lockfile');
    assert.equal(readFileSync(join(pkg, '.yarnrc.yml'), 'utf8').trim(), 'nodeLinker: node-modules');
  });

  // Constraints 4 + 15: pure projector. `Date.parse` is the one allowlisted time primitive.
  test('custody: no ambient authority and no clock in production source', () => {
    const banned = [
      /\bDate\.now\b/, /\bnew Date\s*\(\s*\)/, /\bperformance\.now\b/, /\bMath\.random\b/,
      /\bfetch\s*\(/, /from\s+["']node:(fs|net|http|https|dns|child_process|crypto)/,
      /\brequire\s*\(/, /\bprocess\.env\b/,
    ];
    for (const file of productionSources()) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of banned) {
        assert.ok(!pattern.test(text), `${file} matches banned pattern ${pattern}`);
      }
    }
  });

  // Constraint 14: projection, never record.
  test('no-record: nothing here seals, hashes, or claims a record kind', () => {
    const banned = [
      /\bseal[A-Z]/, /\bputArtifact\b/, /\bRECORD_KINDS\b/, /@noble\/hashes/,
      /\brecordKind\b/, /\bpayloadType\b/, /\bdssePreAuthEncoding\b/,
      /https:\/\/jinn\.network\/records\//,
    ];
    for (const file of productionSources()) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of banned) {
        assert.ok(!pattern.test(text), `${file} matches record-producing pattern ${pattern}`);
      }
    }
  });

  // Program §5 contract 5 + 12.
  test('boundaries: no legacy or product-tier imports', () => {
    const banned = [
      /@jinn-network\/core\b/, /@jinn-network\/plugin\b/, /@jinn-network\/jinn-layer\b/,
      /from\s+["'][^"']*\/client\/src\//,
    ];
    for (const file of productionSources()) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of banned) {
        assert.ok(!pattern.test(text), `${file} matches banned import ${pattern}`);
      }
    }
  });

  // Constraint 18: bounded language.
  test('bounded language: an observed pass rate is never a difficulty score', () => {
    const banned = [
      /difficulty score/i, /task difficulty/i, /intrinsic difficulty/i,
      /how hard the task is/i, /objectively hard/i,
    ];
    const files = [...productionSources()];
    const readme = join(pkg, 'README.md');
    if (existsSync(readme)) files.push(readme);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of banned) {
        assert.ok(!pattern.test(text), `${file} uses unbounded language: ${pattern}`);
      }
    }
  });

  // Findings FC6-1/FC6-4: this package mirrors two upstream shapes it does not import.
  test('drift: the mirrored upstream shapes still carry the fields this package assumes', () => {
    const item = readFileSync(join(root, 'packages/discovery/protocol/src/item.ts'), 'utf8');
    for (const field of ['announcementId', 'entry', 'source', 'agent', 'name', 'digest', 'kind']) {
      assert.ok(item.includes(field), `discovery AnnouncedItem/SourceIdentity lost "${field}"`);
    }
    const profile = JSON.parse(readFileSync(
      join(root, 'packages/discovery/facts/task-execution/profiles/delivery.1.0.json'), 'utf8'));
    const names = profile.fields.map((f) => f.name);
    for (const field of ['taskDigest', 'attemptUri', 'benchrun']) {
      assert.ok(names.includes(field), `delivery facts profile lost "${field}"`);
    }
  });
  ```

- [ ] **Step 6 — Write the CI workflow** `.github/workflows/task-supply-curation-ci.yml`:
  ```yaml
  name: Task Supply Curation CI

  on:
    pull_request:
    push:
      branches: [next]
      paths:
        - "packages/task-supply/curation/**"
        - ".github/scripts/task-supply-curation-guards.test.mjs"
        - ".github/workflows/task-supply-curation-ci.yml"
        - "docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md"

  permissions:
    contents: read

  jobs:
    guards:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
        - name: Verify curation guards
          run: node --test .github/scripts/task-supply-curation-guards.test.mjs

    curation:
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
        - name: Verify Task Curation
          working-directory: packages/task-supply/curation
          run: |
            yarn install --immutable
            yarn typecheck
            yarn test
            yarn build
            yarn pack:smoke
  ```

- [ ] **Step 7 — Install and lock.**
  ```bash
  cd packages/task-supply/curation && corepack enable && yarn install
  ```
  Expected: `yarn.lock` created; `Completed` with no errors. Commit the lockfile.

- [ ] **Step 8 — Verify.**
  ```bash
  cd packages/task-supply/curation && yarn typecheck && yarn test
  node --test .github/scripts/task-supply-curation-guards.test.mjs
  ```
  Expected: typecheck silent (exit 0); vitest reports `No test files found` (acceptable at this
  step only — Task 2 adds the first); `node --test` reports `pass 6  fail 0`.

- [ ] **Step 9 — Commit.**
  ```bash
  git add packages/task-supply/curation .github/scripts/task-supply-curation-guards.test.mjs .github/workflows/task-supply-curation-ci.yml
  git commit -m "feat(task-supply): scaffold @jinn-network/task-curation with purity guards and CI"
  ```

---

## Task 2 — The observation contract

**Files**
- `packages/task-supply/curation/src/observation.ts` (create)
- `packages/task-supply/curation/src/observation.test.ts` (create)
- `packages/task-supply/curation/src/index.ts` (edit)

**Interfaces**
- **Consumes:** `zod` only. Shapes mirrored (not imported) from
  `packages/discovery/protocol/src/item.ts` (`AnnouncedItem.provenance`, `SourceIdentity`,
  `RecordRef.digest`), `packages/discovery/facts/task-execution/profiles/delivery.1.0.json`
  (`taskDigest`, `attemptUri`, `benchrun`),
  `packages/marketplace/projector/src/announce.ts` (`statementVerdict: "pass" | "fail" |
  "inconclusive"`), `packages/discovery/protocol/src/entry.ts` (`AnnouncementEntry.timestamp`),
  `packages/discovery/protocol/src/cloudevents.ts` (`announcementDedupeKey`'s
  `(sourceagent, sourcename, entrydigest, announcementId)` tuple).
- **Produces:** `CurationObservation`, `CurationInputRef`, `ObservedVerdict`, `Instant`,
  `Sha256Digest`, `inputRefKey`, `parseCurationObservation`, `CurationInputError`.

**Steps**

- [ ] **Step 1 — Write the failing tests** in `src/observation.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import {
    CurationInputError,
    inputRefKey,
    parseCurationObservation,
    type CurationObservation,
  } from "./observation.js";

  const ref = {
    source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
    entry: `sha256:${"a".repeat(64)}` as const,
    announcementId: "ann-84532-deadbeef-3-evaluation-delivery-available",
    record: `sha256:${"b".repeat(64)}` as const,
    attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-000000000001",
  };

  const observation: CurationObservation = {
    taskDigest: `sha256:${"c".repeat(64)}`,
    verdict: "pass",
    observedAt: "2026-07-31T09:00:00Z",
    attribution: "urn:jinn:agent:solver-a",
    ref,
  };

  describe("parseCurationObservation", () => {
    it("accepts a well-formed observation", () => {
      expect(parseCurationObservation(observation)).toEqual(observation);
    });

    it("rejects an unprefixed task digest", () => {
      expect(() => parseCurationObservation({ ...observation, taskDigest: "c".repeat(64) }))
        .toThrow(CurationInputError);
    });

    it("rejects an unknown verdict", () => {
      expect(() => parseCurationObservation({ ...observation, verdict: "maybe" }))
        .toThrow(CurationInputError);
    });

    it("rejects a non-RFC-3339 instant", () => {
      expect(() => parseCurationObservation({ ...observation, observedAt: "31 July 2026" }))
        .toThrow(CurationInputError);
    });

    it("requires attribution (F6: the consumer filter runs on it)", () => {
      const { attribution: _dropped, ...without } = observation;
      expect(() => parseCurationObservation(without)).toThrow(CurationInputError);
    });

    it("accepts an optional benchmark run digest", () => {
      const pinned = { ...observation, benchmarkRun: `sha256:${"d".repeat(64)}` };
      expect(parseCurationObservation(pinned).benchmarkRun).toBe(`sha256:${"d".repeat(64)}`);
    });
  });

  describe("inputRefKey", () => {
    it("is the discovery at-least-once dedupe tuple", () => {
      expect(inputRefKey(ref)).toBe(
        ["https://jinn.network/agents/projector", "base-marketplace", ref.entry, ref.announcementId]
          .join("\u001f"),
      );
    });

    it("separates refs that differ only in announcement id", () => {
      expect(inputRefKey(ref)).not.toBe(inputRefKey({ ...ref, announcementId: "ann-other" }));
    });

    it("ignores fields outside the dedupe tuple", () => {
      expect(inputRefKey({ ...ref, attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-000000000002" }))
        .toBe(inputRefKey(ref));
    });
  });
  ```
  Run `yarn test` — expect all nine to fail with "Cannot find module './observation.js'".

- [ ] **Step 2 — Implement `src/observation.ts`:**
  ```ts
  import { z } from "zod";

  /**
   * An RFC 3339 instant. In practice this is the Announcement Entry timestamp
   * (`packages/discovery/protocol/src/entry.ts`), which the marketplace projection source
   * fills from the deterministic block timestamp of the substrate event
   * (`packages/marketplace/projector/src/observe.ts`) -- never a wall clock. It is this
   * package's ONLY time source; there is no clock here.
   */
  export type Instant = string;

  export type Sha256Digest = `sha256:${string}`;

  /**
   * The three-valued verdict vocabulary, as surfaced by the marketplace projection source's
   * verdict-correspondence facts card
   * ("https://jinn.network/facts/marketplace-verdict-correspondence/1.0" in
   * `packages/marketplace/projector/src/announce.ts`), which is itself the evaluator-signed
   * Result Evaluation Statement's `verdict` (task-profiles design section 9.2).
   */
  export type ObservedVerdict = "pass" | "fail" | "inconclusive";

  /** Thrown on any malformed input. This package fails closed and never guesses. */
  export class CurationInputError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
      super(message, options);
      this.name = "CurationInputError";
    }
  }

  /**
   * Provenance of one announced verdict, plus the attempt it judged.
   *
   * The first four fields mirror the discovery query plane's `AnnouncedItem.provenance` and
   * `record.digest` (`packages/discovery/protocol/src/item.ts`) field for field, so a caller
   * can hand one straight in; they are mirrored rather than imported to keep this package
   * dependency-free (see the plan's Finding FC6-1 and the drift guard).
   *
   * `attemptUri` is the Delivery facts card's `attemptUri`
   * (`packages/discovery/facts/task-execution/profiles/delivery.1.0.json`). It rides on the
   * ref rather than beside it so that a row's `attempts` count stays re-derivable from
   * `inputRefs` alone -- which is what makes the projection incrementally foldable.
   */
  export interface CurationInputRef {
    readonly source: { readonly agent: string; readonly name: string };
    readonly entry: Sha256Digest;
    readonly announcementId: string;
    readonly record: Sha256Digest;
    readonly attemptUri: string;
  }

  /**
   * One observed verdict, as the curation adapter hands it over.
   *
   * Three fields require an adapter join and are NOT read off a single announcement (plan
   * Findings FC6-2, FC6-4, FC6-5):
   *  - `taskDigest` is the SUBJECT Task digest. The evaluation Delivery's own `task` field is
   *    the derived evaluation Task (`packages/marketplace/binding/src/evaluation-derive.ts`),
   *    so the adapter resolves the subject through the evaluation Task payload's
   *    `subjectTask.digest` or the Result Evaluation Statement's subjects.
   *  - `benchmarkRun` is the `benchrun` attribute of the JUDGED SOLUTION Delivery
   *    (benchmarking design section 11); absent means organic.
   *  - `attribution` is the evaluator identity (on-chain `VerdictDeliveryClaimed.evaluator` or
   *    the statement's `evaluator.id`). Required, because design finding F6 makes
   *    consumer-side filtering the whole mitigation. This package never groups or reports on
   *    it -- per-solver breakdown is a parked extension (design section 14).
   */
  export interface CurationObservation {
    readonly taskDigest: Sha256Digest;
    readonly verdict: ObservedVerdict;
    readonly observedAt: Instant;
    readonly attribution: string;
    readonly benchmarkRun?: string;
    readonly ref: CurationInputRef;
  }

  const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

  /** RFC 3339 date-time with a mandatory offset (`Z` or +/-HH:MM). */
  const InstantSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
    .refine((value) => !Number.isNaN(Date.parse(value)), "observedAt is not a real instant");

  const CurationInputRefSchema = z.object({
    source: z.object({ agent: z.string().min(1), name: z.string().min(1) }),
    entry: Sha256DigestSchema,
    announcementId: z.string().min(1),
    record: Sha256DigestSchema,
    attemptUri: z.string().min(1),
  });

  const CurationObservationSchema = z.object({
    taskDigest: Sha256DigestSchema,
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    observedAt: InstantSchema,
    attribution: z.string().min(1),
    benchmarkRun: z.string().min(1).optional(),
    ref: CurationInputRefSchema,
  });

  export function parseCurationObservation(value: unknown): CurationObservation {
    const result = CurationObservationSchema.safeParse(value);
    if (!result.success) {
      throw new CurationInputError(
        `malformed curation observation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        { cause: result.error },
      );
    }
    return result.data as CurationObservation;
  }

  /** Unit separator, written as an escape so no raw control byte appears in source. */
  const KEY_SEPARATOR = "\u001f";

  /**
   * The at-least-once dedupe key of the discovery subscribe plane -- the same
   * `(source agent, source name, entry digest, announcementId)` tuple as
   * `announcementDedupeKey` in `packages/discovery/protocol/src/cloudevents.ts`. Folding on
   * this key is what makes redelivery a no-op.
   */
  export function inputRefKey(ref: CurationInputRef): string {
    return [ref.source.agent, ref.source.name, ref.entry, ref.announcementId].join(KEY_SEPARATOR);
  }
  ```

- [ ] **Step 3 — Re-export from `src/index.ts`:** replace the placeholder with
  `export * from "./observation.js";`.

- [ ] **Step 4 — Verify.**
  ```bash
  cd packages/task-supply/curation && yarn typecheck && yarn test
  node --test .github/scripts/task-supply-curation-guards.test.mjs
  ```
  Expected: typecheck exit 0; `Test Files  1 passed (1)` / `Tests  9 passed (9)`; guards
  `pass 6  fail 0`.

- [ ] **Step 5 — Commit.**
  `git commit -am "feat(task-supply): curation observation contract with the discovery dedupe key"`

---

## Task 3 — `projectCuration`: rows, counters, exact ratio, window

**Files**
- `packages/task-supply/curation/src/projection.ts` (create)
- `packages/task-supply/curation/src/projection.test.ts` (create)
- `packages/task-supply/curation/src/index.ts` (edit)

**Interfaces**
- **Consumes:** `./observation.js` (`CurationObservation`, `CurationInputRef`, `Instant`,
  `Sha256Digest`, `inputRefKey`, `CurationInputError`) — produced by Task 2.
- **Produces (program §4 pinned names):** `projectCuration(observations):
  CurationProjection`; `CurationRow` carrying `{taskDigest, attempts, verdicts, passRate:
  {num, den}, window, inputRefs, bucket}`; `CurationProjection`; `Ratio`; `CurationWindow`;
  `CurationBucket`. `foldCuration` is declared here and exercised in Task 6.

**Steps**

- [ ] **Step 1 — Write the failing tests** in `src/projection.test.ts`. Include a local
  `makeObservation` helper and these cases:
  ```ts
  import { describe, expect, it } from "vitest";
  import { projectCuration, type CurationRow } from "./projection.js";
  import type { CurationObservation, ObservedVerdict } from "./observation.js";

  let counter = 0;
  function observation(
    verdict: ObservedVerdict,
    overrides: Partial<CurationObservation> = {},
  ): CurationObservation {
    counter += 1;
    const n = String(counter).padStart(4, "0");
    return {
      taskDigest: `sha256:${"c".repeat(64)}`,
      verdict,
      observedAt: `2026-07-31T0${(counter % 9) + 1}:00:00Z`,
      attribution: "urn:jinn:agent:solver-a",
      ref: {
        source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
        entry: `sha256:${"a".repeat(60)}${n}`,
        announcementId: `ann-${n}`,
        record: `sha256:${"b".repeat(60)}${n}`,
        attemptUri: `urn:uuid:0189d1c2-0000-7000-8000-00000000${n}`,
      },
      ...overrides,
    };
  }

  describe("projectCuration", () => {
    it("returns no rows for no observations", () => {
      expect(projectCuration([])).toEqual({ rows: [] });
    });

    it("counts verdicts and expresses the observed pass rate as num over den", () => {
      const [row] = projectCuration([
        observation("pass"), observation("pass"), observation("fail"),
      ]).rows as CurationRow[];
      expect(row.verdicts).toBe(3);
      expect(row.passRate).toEqual({ num: 2, den: 3 });
    });

    it("excludes inconclusive verdicts from the denominator but not from the count", () => {
      const [row] = projectCuration([
        observation("pass"), observation("fail"), observation("inconclusive"),
      ]).rows;
      expect(row.verdicts).toBe(3);
      expect(row.passRate).toEqual({ num: 1, den: 2 });
      expect(row.verdicts - row.passRate.den).toBe(1); // inconclusive, recovered exactly
      expect(row.passRate.den - row.passRate.num).toBe(1); // fail, recovered exactly
    });

    it("counts distinct attempts, not verdicts", () => {
      const shared = "urn:uuid:0189d1c2-0000-7000-8000-0000000000ff";
      const rows = projectCuration([
        observation("pass", { ref: { ...observation("pass").ref, attemptUri: shared } }),
        observation("fail", { ref: { ...observation("fail").ref, attemptUri: shared } }),
      ]).rows;
      expect(rows[0].verdicts).toBe(2);
      expect(rows[0].attempts).toBe(1);
    });

    it("derives the window from observation timestamps only", () => {
      const rows = projectCuration([
        observation("pass", { observedAt: "2026-07-31T12:00:00Z" }),
        observation("pass", { observedAt: "2026-07-30T08:00:00Z" }),
        observation("fail", { observedAt: "2026-07-31T06:00:00Z" }),
      ]).rows;
      expect(rows[0].window).toEqual({ first: "2026-07-30T08:00:00Z", last: "2026-07-31T12:00:00Z" });
    });

    it("compares instants by value, not by string, across offsets", () => {
      const rows = projectCuration([
        observation("pass", { observedAt: "2026-07-31T10:00:00Z" }),
        observation("pass", { observedAt: "2026-07-31T04:00:00-07:00" }), // == 11:00:00Z
      ]).rows;
      expect(rows[0].window.last).toBe("2026-07-31T04:00:00-07:00");
    });

    it("splits rows by task digest and orders them deterministically", () => {
      const other = `sha256:${"e".repeat(64)}` as const;
      const rows = projectCuration([
        observation("pass", { taskDigest: other }),
        observation("pass"),
      ]).rows;
      expect(rows.map((r) => r.taskDigest)).toEqual([`sha256:${"c".repeat(64)}`, other]);
    });

    it("rejects a malformed observation rather than skipping it", () => {
      expect(() => projectCuration([{ ...observation("pass"), observedAt: "yesterday" } as never]))
        .toThrow(/observation/i);
    });

    // Constraint 16: bare-rate-free by construction.
    it("exposes exactly the pinned keys and no float anywhere", () => {
      const [row] = projectCuration([observation("pass"), observation("fail")]).rows;
      expect(Object.keys(row).sort()).toEqual(
        ["attempts", "bucket", "inputRefs", "passRate", "taskDigest", "verdicts", "window"],
      );
      expect(Object.keys(row.passRate).sort()).toEqual(["den", "num"]);
      expect(Object.keys(row.window).sort()).toEqual(["first", "last"]);
      const numbers: number[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === "number") numbers.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
      };
      walk(row);
      expect(numbers.length).toBeGreaterThan(0);
      expect(numbers.every((n) => Number.isInteger(n))).toBe(true);
    });

    // Success criterion 2.
    it("is order-independent across every permutation of its inputs", () => {
      const input = [
        observation("pass"), observation("fail"), observation("pass"),
        observation("inconclusive"), observation("fail"),
      ];
      const expected = JSON.stringify(projectCuration(input));
      const permute = (rest: CurationObservation[], prefix: CurationObservation[] = []): void => {
        if (rest.length === 0) {
          expect(JSON.stringify(projectCuration(prefix))).toBe(expected);
          return;
        }
        rest.forEach((item, index) => {
          permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...prefix, item]);
        });
      };
      permute(input); // 120 permutations
    });
  });
  ```
  Run `yarn test` — expect the file to fail to resolve `./projection.js`.

- [ ] **Step 2 — Implement `src/projection.ts`.** (`bucketOf` returns `"organic"`
  unconditionally at this step; Task 4 turns it on. Everything else is final.)
  ```ts
  import {
    CurationInputError,
    inputRefKey,
    parseCurationObservation,
    type CurationInputRef,
    type CurationObservation,
    type Instant,
    type Sha256Digest,
  } from "./observation.js";

  /**
   * Which population a row aggregates. Benchmark-pinned attempts are hammered at one task by a
   * deliberate experiment, so they are not market evidence about it (design section 9,
   * "Relation to benchmarking"); they get their own row instead of polluting the organic one.
   */
  export type CurationBucket = "benchmark" | "organic";

  /** An exact rational. There is deliberately no float on any output of this package. */
  export interface Ratio {
    readonly num: number;
    readonly den: number;
  }

  export interface CurationWindow {
    readonly first: Instant;
    readonly last: Instant;
  }

  /**
   * One `(task, bucket)` aggregate.
   *
   * `attempts` is the number of DISTINCT attempts among the observed verdicts -- not attempts
   * posted, claimed, or in flight, none of which this package can see.
   * `verdicts` counts every observed verdict, inconclusive included.
   * `passRate` is the OBSERVED pass rate over decision-grade verdicts: `num` = pass,
   * `den` = pass + fail. `verdicts - den` recovers inconclusive; `den - num` recovers fail.
   * `inputRefs` lists every announcement that fed the row -- mandatory, per design finding F6:
   * manipulation cannot be prevented here, so it is made visible and the row re-derivable.
   */
  export interface CurationRow {
    readonly taskDigest: Sha256Digest;
    readonly bucket: CurationBucket;
    readonly attempts: number;
    readonly verdicts: number;
    readonly passRate: Ratio;
    readonly window: CurationWindow;
    readonly inputRefs: readonly CurationInputRef[];
  }

  /** Host-stored derived state. Not a record: it is never sealed, signed, or digest-addressed. */
  export interface CurationProjection {
    readonly rows: readonly CurationRow[];
  }

  interface RowAccumulator {
    readonly taskDigest: Sha256Digest;
    readonly bucket: CurationBucket;
    pass: number;
    fail: number;
    inconclusive: number;
    first: Instant;
    last: Instant;
    readonly refs: Map<string, CurationInputRef>;
  }

  const ROW_KEY_SEPARATOR = "\u001f";

  function rowKey(taskDigest: string, bucket: CurationBucket): string {
    return `${taskDigest}${ROW_KEY_SEPARATOR}${bucket}`;
  }

  function bucketOf(observation: CurationObservation): CurationBucket {
    return observation.benchmarkRun === undefined ? "organic" : "benchmark";
  }

  /** `Date.parse` is the one time primitive here, and it is pure. */
  function instantValue(value: Instant): number {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new CurationInputError(`observedAt is not an RFC 3339 instant: ${value}`);
    }
    return parsed;
  }

  /** `<` on strings is UTF-16 code-unit order -- the tie-break that keeps equal instants stable. */
  function earlier(a: Instant, b: Instant): Instant {
    const av = instantValue(a);
    const bv = instantValue(b);
    if (av !== bv) return av < bv ? a : b;
    return a < b ? a : b;
  }

  function later(a: Instant, b: Instant): Instant {
    const av = instantValue(a);
    const bv = instantValue(b);
    if (av !== bv) return av > bv ? a : b;
    return a > b ? a : b;
  }

  function apply(accumulator: RowAccumulator, observation: CurationObservation): void {
    const key = inputRefKey(observation.ref);
    if (accumulator.refs.has(key)) return; // at-least-once redelivery is a no-op
    accumulator.refs.set(key, observation.ref);
    if (observation.verdict === "pass") accumulator.pass += 1;
    else if (observation.verdict === "fail") accumulator.fail += 1;
    else accumulator.inconclusive += 1;
    accumulator.first = earlier(accumulator.first, observation.observedAt);
    accumulator.last = later(accumulator.last, observation.observedAt);
  }

  function seed(observation: CurationObservation): RowAccumulator {
    return {
      taskDigest: observation.taskDigest,
      bucket: bucketOf(observation),
      pass: 0,
      fail: 0,
      inconclusive: 0,
      first: observation.observedAt,
      last: observation.observedAt,
      refs: new Map(),
    };
  }

  function finalize(accumulator: RowAccumulator): CurationRow {
    const inputRefs = [...accumulator.refs.values()].sort((a, b) => {
      const left = inputRefKey(a);
      const right = inputRefKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const attempts = new Set(inputRefs.map((ref) => ref.attemptUri)).size;
    return {
      taskDigest: accumulator.taskDigest,
      bucket: accumulator.bucket,
      attempts,
      verdicts: accumulator.pass + accumulator.fail + accumulator.inconclusive,
      passRate: { num: accumulator.pass, den: accumulator.pass + accumulator.fail },
      window: { first: accumulator.first, last: accumulator.last },
      inputRefs,
    };
  }

  function compareRows(a: CurationRow, b: CurationRow): number {
    const left = rowKey(a.taskDigest, a.bucket);
    const right = rowKey(b.taskDigest, b.bucket);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  /**
   * Fold observations into a previous projection. Idempotent: an observation whose
   * `inputRefKey` is already present in the target row is dropped, so the subscribe plane's
   * at-least-once delivery cannot double-count. Task 6 pins that property.
   */
  export function foldCuration(
    previous: CurationProjection | undefined,
    observations: readonly CurationObservation[],
  ): CurationProjection {
    const accumulators = new Map<string, RowAccumulator>();
    for (const row of previous?.rows ?? []) {
      accumulators.set(rowKey(row.taskDigest, row.bucket), {
        taskDigest: row.taskDigest,
        bucket: row.bucket,
        pass: row.passRate.num,
        fail: row.passRate.den - row.passRate.num,
        inconclusive: row.verdicts - row.passRate.den,
        first: row.window.first,
        last: row.window.last,
        refs: new Map(row.inputRefs.map((ref) => [inputRefKey(ref), ref])),
      });
    }
    for (const raw of observations) {
      const observation = parseCurationObservation(raw);
      const key = rowKey(observation.taskDigest, bucketOf(observation));
      let accumulator = accumulators.get(key);
      if (accumulator === undefined) {
        accumulator = seed(observation);
        accumulators.set(key, accumulator);
      }
      apply(accumulator, observation);
    }
    return { rows: [...accumulators.values()].map(finalize).sort(compareRows) };
  }

  /**
   * The projection, from scratch. Pure and re-derivable: the same observation multiset always
   * yields the same projection, in any order, on any machine, with no clock and no I/O.
   * Identical to `foldCuration(undefined, observations)`.
   */
  export function projectCuration(
    observations: readonly CurationObservation[],
  ): CurationProjection {
    return foldCuration(undefined, observations);
  }
  ```

- [ ] **Step 3 — Re-export:** add `export * from "./projection.js";` to `src/index.ts`.

- [ ] **Step 4 — Verify.**
  ```bash
  cd packages/task-supply/curation && yarn typecheck && yarn test
  node --test .github/scripts/task-supply-curation-guards.test.mjs
  ```
  Expected: `Test Files  2 passed (2)`, `Tests  19 passed (19)`; guards `pass 6  fail 0`. The
  permutation case must print no failure across all 120 orderings.

- [ ] **Step 5 — Commit.**
  `git commit -am "feat(task-supply): projectCuration with exact-ratio pass rates and a clock-free window"`

---

## Task 4 — The bucket axis: benchmark-pinned vs. organic

**Files**
- `packages/task-supply/curation/src/projection.ts` (edit — enable `bucketOf`; it is already
  written correctly in Task 3, so this task is the *fixture and test* that pins the behavior)
- `packages/task-supply/curation/fixtures/observations-bucket.json` (create)
- `packages/task-supply/curation/src/bucket.test.ts` (create)

**Interfaces**
- **Consumes:** `./projection.js` (`projectCuration`), `./observation.js`
  (`CurationObservation`). Grounding citation: `benchrun` in
  `packages/discovery/facts/task-execution/profiles/delivery.1.0.json` and
  `packages/discovery/facts/task-execution/src/recompute.ts` (`deliveryRecompute`), per
  benchmarking design §11.
- **Produces:** the `bucket` axis on `CurationRow` (program §4: "a `bucket` axis separating
  benchmark-pinned attempts").

**Steps**

- [ ] **Step 1 — Write `fixtures/observations-bucket.json`:** eight observations on one
  `taskDigest`. Four organic (`pass, pass, fail, fail`, distinct `attemptUri`, attributions
  `urn:jinn:agent:solver-a`/`-b`), four benchmark-pinned carrying
  `"benchmarkRun": "sha256:<64 hex 'f'>"` with `attribution: "urn:jinn:agent:bench-harness"`
  and verdicts `pass, pass, pass, fail`. Distinct `entry`/`announcementId`/`record` per item;
  `observedAt` values `2026-07-31T01:00:00Z` … `2026-07-31T08:00:00Z`.

- [ ] **Step 2 — Write the failing tests** in `src/bucket.test.ts`:
  ```ts
  import { readFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  import { describe, expect, it } from "vitest";
  import { projectCuration } from "./projection.js";
  import type { CurationObservation } from "./observation.js";

  const observations = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/observations-bucket.json", import.meta.url)), "utf8"),
  ) as CurationObservation[];

  describe("bucket axis", () => {
    it("emits one row per (task, bucket), benchmark first by row order", () => {
      const rows = projectCuration(observations).rows;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.bucket)).toEqual(["benchmark", "organic"]);
      expect(new Set(rows.map((r) => r.taskDigest)).size).toBe(1);
    });

    it("keeps benchmark-pinned attempts out of the organic observed pass rate", () => {
      const rows = projectCuration(observations).rows;
      const organic = rows.find((r) => r.bucket === "organic")!;
      const benchmark = rows.find((r) => r.bucket === "benchmark")!;
      expect(organic.passRate).toEqual({ num: 2, den: 4 });
      expect(benchmark.passRate).toEqual({ num: 3, den: 4 });
    });

    it("buckets on the presence of the judged delivery's benchrun attribute", () => {
      const rows = projectCuration(observations).rows;
      const benchmark = rows.find((r) => r.bucket === "benchmark")!;
      const benchmarkRefs = new Set(benchmark.inputRefs.map((r) => r.announcementId));
      for (const observation of observations) {
        const isPinned = observation.benchmarkRun !== undefined;
        expect(benchmarkRefs.has(observation.ref.announcementId)).toBe(isPinned);
      }
    });

    it("keeps each bucket's window independent", () => {
      const rows = projectCuration(observations).rows;
      const organic = rows.find((r) => r.bucket === "organic")!;
      const benchmark = rows.find((r) => r.bucket === "benchmark")!;
      expect(organic.window).not.toEqual(benchmark.window);
    });
  });
  ```

- [ ] **Step 3 — Confirm `bucketOf` already satisfies them.** No production edit should be
  needed; if a test fails, fix `bucketOf`/`rowKey` in `src/projection.ts` and nothing else.

- [ ] **Step 4 — Verify.**
  ```bash
  cd packages/task-supply/curation && yarn typecheck && yarn test
  ```
  Expected: `Test Files  3 passed (3)`, `Tests  23 passed (23)`.

- [ ] **Step 5 — Commit.**
  `git commit -am "feat(task-supply): bucket benchmark-pinned attempts apart from organic ones"`

---

## Task 5 — F6 kit: manipulation visibility and consumer re-derivation

**Files**
- `packages/task-supply/curation/fixtures/observations-manipulation.json` (create)
- `packages/task-supply/curation/src/manipulation.test.ts` (create)

**Interfaces**
- **Consumes:** `./projection.js` (`projectCuration`), `./observation.js`
  (`CurationObservation`, `inputRefKey`).
- **Produces:** the executable proof of design §13 F6 — attribution-preserving inputs, both
  derivations.

**Steps**

- [ ] **Step 1 — Write `fixtures/observations-manipulation.json`:** twelve observations on one
  `taskDigest`, all organic (no `benchmarkRun`), all distinct `attemptUri`.
  - Four honest: `attribution` `urn:jinn:agent:solver-a` and `urn:jinn:agent:solver-b`,
    verdicts `pass, pass, fail, fail`.
  - Eight sybil: `attribution` `urn:jinn:agent:sybil-1` … `urn:jinn:agent:sybil-8`, all
    verdict `pass`.
  So the unfiltered observed rate is `10/12`; excluding the cohort it is `2/4`.

- [ ] **Step 2 — Write the tests** in `src/manipulation.test.ts`:
  ```ts
  import { readFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  import { describe, expect, it } from "vitest";
  import { projectCuration } from "./projection.js";
  import type { CurationObservation } from "./observation.js";

  const observations = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/observations-manipulation.json", import.meta.url)), "utf8"),
  ) as CurationObservation[];

  const isSybil = (o: CurationObservation): boolean => o.attribution.startsWith("urn:jinn:agent:sybil-");

  describe("design F6 -- manipulation is visible in the inputs, and the rate is re-derivable", () => {
    it("derivation 1: the published projection carries the manipulated rate WITH its inputs", () => {
      const [row] = projectCuration(observations).rows;
      expect(row.passRate).toEqual({ num: 10, den: 12 });
      expect(row.verdicts).toBe(12);
      expect(row.attempts).toBe(12);
      const announced = new Set(row.inputRefs.map((r) => r.announcementId));
      for (const sybil of observations.filter(isSybil)) {
        expect(announced.has(sybil.ref.announcementId)).toBe(true);
      }
      expect(row.inputRefs).toHaveLength(12);
    });

    it("derivation 2: a consumer excluding the cohort re-derives a different rate", () => {
      const [row] = projectCuration(observations.filter((o) => !isSybil(o))).rows;
      expect(row.passRate).toEqual({ num: 2, den: 4 });
      expect(row.verdicts).toBe(4);
      const announced = new Set(row.inputRefs.map((r) => r.announcementId));
      for (const sybil of observations.filter(isSybil)) {
        expect(announced.has(sybil.ref.announcementId)).toBe(false);
      }
    });

    it("the two derivations disagree -- which is the whole point of publishing the inputs", () => {
      const manipulated = projectCuration(observations).rows[0].passRate;
      const filtered = projectCuration(observations.filter((o) => !isSybil(o))).rows[0].passRate;
      expect(manipulated.num * filtered.den).not.toBe(filtered.num * manipulated.den);
    });

    it("every row's inputRefs account for every verdict it counted", () => {
      for (const row of projectCuration(observations).rows) {
        expect(row.inputRefs).toHaveLength(row.verdicts);
        expect(new Set(row.inputRefs.map((r) => r.attemptUri)).size).toBe(row.attempts);
      }
    });
  });
  ```

- [ ] **Step 3 — Verify.**
  ```bash
  cd packages/task-supply/curation && yarn test
  ```
  Expected: `Test Files  4 passed (4)`, `Tests  27 passed (27)`.

- [ ] **Step 4 — Commit.**
  `git commit -am "test(task-supply): F6 kit -- manipulation visible in inputs, both derivations"`

---

## Task 6 — Incremental fold

**Files**
- `packages/task-supply/curation/src/fold.test.ts` (create)
- `packages/task-supply/curation/src/projection.ts` (edit only if a test exposes a defect)

**Interfaces**
- **Consumes:** `./projection.js` (`foldCuration`, `projectCuration`, `CurationProjection`).
- **Produces:** the incremental-fold guarantee behind program §4's C6 row.

**Design note (the "justify your choice" item).** The incremental entry point is
`foldCuration(previous, observations)`, a **separate two-argument function**, not an overload
of `projectCuration`. Three reasons: (a) program §4 pins `projectCuration(observations):
CurationProjection` as a one-argument signature, and an overload would make the pinned name
ambiguous at call sites; (b) the previous projection is the *whole* fold state — no side
table, no seen-key set, no cursor — because `inputRefs` already carries the dedupe keys and the
attempt URIs, and `{pass, fail, inconclusive}` is exactly recoverable from `{verdicts,
passRate.num, passRate.den}`, so the projection is closed under folding; (c) that closure is
what makes `projectCuration(a ++ b) === foldCuration(projectCuration(a), b)` an assertable
law rather than an aspiration. The host stores one document and appends to it.

**Steps**

- [ ] **Step 1 — Write the tests** in `src/fold.test.ts`:
  ```ts
  import { readFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  import { describe, expect, it } from "vitest";
  import { foldCuration, projectCuration } from "./projection.js";
  import type { CurationObservation } from "./observation.js";

  const observations = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/observations-bucket.json", import.meta.url)), "utf8"),
  ) as CurationObservation[];

  describe("foldCuration", () => {
    it("with no previous projection equals projectCuration", () => {
      expect(foldCuration(undefined, observations)).toEqual(projectCuration(observations));
    });

    it("folding in two batches equals projecting the union", () => {
      const first = observations.slice(0, 3);
      const rest = observations.slice(3);
      expect(foldCuration(projectCuration(first), rest)).toEqual(projectCuration(observations));
    });

    it("is associative across three batches", () => {
      const [a, b, c] = [observations.slice(0, 2), observations.slice(2, 5), observations.slice(5)];
      const stepwise = foldCuration(foldCuration(projectCuration(a), b), c);
      expect(stepwise).toEqual(projectCuration(observations));
    });

    it("is idempotent under at-least-once redelivery", () => {
      const once = projectCuration(observations);
      expect(foldCuration(once, observations)).toEqual(once);
      expect(foldCuration(once, [...observations, ...observations])).toEqual(once);
    });

    it("round-trips a projection unchanged when nothing new arrives", () => {
      const projection = projectCuration(observations);
      expect(foldCuration(projection, [])).toEqual(projection);
    });

    it("recovers the fail and inconclusive counters from a previous projection", () => {
      const seedBatch = observations.filter((o) => o.benchmarkRun === undefined).slice(0, 3);
      const tail = observations.filter((o) => o.benchmarkRun === undefined).slice(3);
      const folded = foldCuration(projectCuration(seedBatch), tail).rows[0];
      const direct = projectCuration([...seedBatch, ...tail]).rows[0];
      expect(folded).toEqual(direct);
    });

    it("opens a new bucket row mid-fold", () => {
      const organic = observations.filter((o) => o.benchmarkRun === undefined);
      const pinned = observations.filter((o) => o.benchmarkRun !== undefined);
      const folded = foldCuration(projectCuration(organic), pinned);
      expect(folded.rows.map((r) => r.bucket)).toEqual(["benchmark", "organic"]);
      expect(folded).toEqual(projectCuration(observations));
    });
  });
  ```

- [ ] **Step 2 — Run and fix.** `yarn test`. Any failure here is a real defect in `finalize` /
  the accumulator reconstruction in `foldCuration`; fix `src/projection.ts` only.

- [ ] **Step 3 — Verify.**
  ```bash
  cd packages/task-supply/curation && yarn typecheck && yarn test
  ```
  Expected: `Test Files  5 passed (5)`, `Tests  34 passed (34)`.

- [ ] **Step 4 — Commit.**
  `git commit -am "feat(task-supply): incremental, idempotent curation fold"`

---

## Task 7 — Saturation: caller-supplied threshold, reference band as documentation

**Files**
- `packages/task-supply/curation/src/saturation.ts` (create)
- `packages/task-supply/curation/src/saturation.test.ts` (create)
- `packages/task-supply/curation/src/index.ts` (edit)

**Interfaces**
- **Consumes:** `./projection.js` (`CurationRow`, `Ratio`), `./observation.js`
  (`CurationInputError`).
- **Produces:** `saturationAt(row, threshold)`, `compareRateTo(row, threshold)`,
  `SATURATION_REFERENCE_BAND`, `SATURATION_REFERENCE_BAND_RATIO`.

**Steps**

- [ ] **Step 1 — Write the failing tests** in `src/saturation.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import {
    compareRateTo,
    saturationAt,
    SATURATION_REFERENCE_BAND,
    SATURATION_REFERENCE_BAND_RATIO,
  } from "./saturation.js";
  import type { CurationRow } from "./projection.js";

  const row = (num: number, den: number): CurationRow => ({
    taskDigest: `sha256:${"c".repeat(64)}`,
    bucket: "organic",
    attempts: den,
    verdicts: den,
    passRate: { num, den },
    window: { first: "2026-07-31T00:00:00Z", last: "2026-07-31T01:00:00Z" },
    inputRefs: [],
  });

  describe("compareRateTo", () => {
    it("compares by exact cross-multiplication", () => {
      expect(compareRateTo(row(8, 10), { num: 70, den: 100 })).toBe(1);
      expect(compareRateTo(row(7, 10), { num: 70, den: 100 })).toBe(0);
      expect(compareRateTo(row(1, 10), { num: 70, den: 100 })).toBe(-1);
    });

    it("is exact where floating point is not (1/3 vs 0.3333...)", () => {
      expect(compareRateTo(row(1, 3), { num: 3333, den: 10_000 })).toBe(1);
    });

    it("returns undefined when there are no decision-grade verdicts", () => {
      expect(compareRateTo(row(0, 0), { num: 70, den: 100 })).toBeUndefined();
    });

    it("rejects a non-positive or negative threshold rather than guessing", () => {
      expect(() => compareRateTo(row(1, 2), { num: 1, den: 0 })).toThrow(/threshold/i);
      expect(() => compareRateTo(row(1, 2), { num: -1, den: 2 })).toThrow(/threshold/i);
    });
  });

  describe("saturationAt", () => {
    it("is true only strictly above the supplied threshold", () => {
      expect(saturationAt(row(8, 10), { num: 70, den: 100 })).toBe(true);
      expect(saturationAt(row(7, 10), { num: 70, den: 100 })).toBe(false);
      expect(saturationAt(row(1, 10), { num: 70, den: 100 })).toBe(false);
    });

    it("is undefined, never false, when saturation is not observable", () => {
      expect(saturationAt(row(0, 0), { num: 70, den: 100 })).toBeUndefined();
    });

    it("has no default threshold -- the band is never applied silently", () => {
      expect(saturationAt.length).toBe(2);
      // @ts-expect-error the threshold argument is required
      expect(() => saturationAt(row(1, 2))).toThrow();
    });
  });

  describe("SATURATION_REFERENCE_BAND", () => {
    it("states the research band exactly as the design does", () => {
      expect(SATURATION_REFERENCE_BAND).toEqual({ min: 0.02, max: 0.70 });
    });

    it("agrees with the exact-ratio form the comparison consumes", () => {
      expect(SATURATION_REFERENCE_BAND_RATIO.min.num / SATURATION_REFERENCE_BAND_RATIO.min.den)
        .toBeCloseTo(SATURATION_REFERENCE_BAND.min, 10);
      expect(SATURATION_REFERENCE_BAND_RATIO.max.num / SATURATION_REFERENCE_BAND_RATIO.max.den)
        .toBeCloseTo(SATURATION_REFERENCE_BAND.max, 10);
    });

    it("is a reference, not a policy: nothing in the projector reads it", async () => {
      const projection = await import("./projection.js");
      expect(Object.keys(projection)).not.toContain("SATURATION_REFERENCE_BAND");
    });
  });
  ```

- [ ] **Step 2 — Implement `src/saturation.ts`:**
  ```ts
  import { CurationInputError } from "./observation.js";
  import type { CurationRow, Ratio } from "./projection.js";

  /**
   * The research band the design cites as a REFERENCE (section 9): observed pass rates
   * concentrate in [2%, 70%], peaking near 50%, and a task drifting past ~70% is exhausting
   * its signal. Documentation and display only -- no function in this package applies it. The
   * consumer supplies its own threshold, always, explicitly.
   */
  export const SATURATION_REFERENCE_BAND = { min: 0.02, max: 0.70 } as const;

  /**
   * The same band as exact ratios -- the form `compareRateTo`/`saturationAt` consume, because
   * this package never lets a float touch a rate. Pass
   * `SATURATION_REFERENCE_BAND_RATIO.max` to adopt the reference upper bound deliberately.
   */
  export const SATURATION_REFERENCE_BAND_RATIO = {
    min: { num: 2, den: 100 },
    max: { num: 70, den: 100 },
  } as const;

  function assertThreshold(threshold: Ratio): void {
    if (!Number.isSafeInteger(threshold.num) || !Number.isSafeInteger(threshold.den)) {
      throw new CurationInputError("threshold num and den must be exact integers");
    }
    if (threshold.den <= 0 || threshold.num < 0) {
      throw new CurationInputError("threshold must be a non-negative rate with a positive denominator");
    }
  }

  /**
   * Orders a row's observed pass rate against a threshold by exact integer cross-
   * multiplication: `-1` below, `0` equal, `1` above. `undefined` when the row has no
   * decision-grade verdicts (`den === 0`) -- the comparison is not observable, and this
   * function does not guess.
   */
  export function compareRateTo(row: CurationRow, threshold: Ratio): -1 | 0 | 1 | undefined {
    assertThreshold(threshold);
    if (row.passRate.den === 0) return undefined;
    const left = row.passRate.num * threshold.den;
    const right = threshold.num * row.passRate.den;
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
      throw new CurationInputError("rate comparison exceeds the exact integer range");
    }
    return left === right ? 0 : left < right ? -1 : 1;
  }

  /**
   * Whether a row's observed pass rate sits strictly above a CALLER-SUPPLIED threshold.
   * `undefined` when the row has no decision-grade verdicts. There is no default threshold.
   */
  export function saturationAt(row: CurationRow, threshold: Ratio): boolean | undefined {
    const comparison = compareRateTo(row, threshold);
    return comparison === undefined ? undefined : comparison > 0;
  }
  ```

- [ ] **Step 3 — Re-export:** add `export * from "./saturation.js";` to `src/index.ts`.

- [ ] **Step 4 — Verify.**
  ```bash
  cd packages/task-supply/curation && yarn typecheck && yarn test
  node --test .github/scripts/task-supply-curation-guards.test.mjs
  ```
  Expected: `Test Files  6 passed (6)`, `Tests  46 passed (46)`; guards `pass 6  fail 0`.

- [ ] **Step 5 — Commit.**
  `git commit -am "feat(task-supply): exact-ratio saturation with a caller-supplied threshold"`

---

## Task 8 — Serialization, golden projection, README, component gate

**Files**
- `packages/task-supply/curation/src/serialize.ts` (create)
- `packages/task-supply/curation/src/serialize.test.ts` (create)
- `packages/task-supply/curation/fixtures/observations-golden.json` (create)
- `packages/task-supply/curation/fixtures/projection-golden.json` (create)
- `packages/task-supply/curation/src/golden.test.ts` (create)
- `packages/task-supply/curation/README.md` (create)
- `packages/task-supply/curation/src/index.ts` (edit)
- `.github/scripts/task-supply-curation-guards.test.mjs` (edit — add the serialization guard)

**Interfaces**
- **Consumes:** `./projection.js` (`CurationProjection`, `CurationRow`, `projectCuration`),
  `./observation.js` (`CurationInputError`).
- **Produces:** `CURATION_PROJECTION_FORMAT`, `serializeCurationProjection`,
  `parseCurationProjection`; the golden fixtures; the package README with the adapter-boundary
  and bounded-claims sections.

**Steps**

- [ ] **Step 1 — Write the failing tests** in `src/serialize.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import {
    CURATION_PROJECTION_FORMAT,
    parseCurationProjection,
    serializeCurationProjection,
  } from "./serialize.js";
  import { projectCuration } from "./projection.js";
  import type { CurationObservation } from "./observation.js";

  const observation = (verdict: "pass" | "fail", n: string): CurationObservation => ({
    taskDigest: `sha256:${"c".repeat(64)}`,
    verdict,
    observedAt: `2026-07-31T0${n}:00:00Z`,
    attribution: "urn:jinn:agent:solver-a",
    ref: {
      source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
      entry: `sha256:${"a".repeat(63)}${n}`,
      announcementId: `ann-${n}`,
      record: `sha256:${"b".repeat(63)}${n}`,
      attemptUri: `urn:uuid:0189d1c2-0000-7000-8000-00000000000${n}`,
    },
  });

  const projection = projectCuration([observation("pass", "1"), observation("fail", "2")]);

  describe("serializeCurationProjection", () => {
    it("round-trips exactly", () => {
      expect(parseCurationProjection(serializeCurationProjection(projection))).toEqual(projection);
    });

    it("is stable: serializing twice yields identical text", () => {
      expect(serializeCurationProjection(projection)).toBe(serializeCurationProjection(projection));
    });

    it("is independent of input order", () => {
      const reversed = projectCuration([observation("fail", "2"), observation("pass", "1")]);
      expect(serializeCurationProjection(reversed)).toBe(serializeCurationProjection(projection));
    });

    // Constraint 14: projection, never record.
    it("carries no record envelope of any kind", () => {
      const parsed = JSON.parse(serializeCurationProjection(projection)) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["format", "rows"]);
      expect(parsed.format).toBe(CURATION_PROJECTION_FORMAT);
      expect(String(parsed.format).startsWith("https://jinn.network/records/")).toBe(false);
      for (const key of ["kind", "protocol", "digest", "signatures", "payloadType", "mediaType"]) {
        expect(key in parsed).toBe(false);
      }
    });

    it("rejects a foreign or missing format token", () => {
      expect(() => parseCurationProjection(JSON.stringify({ format: "other/1.0", rows: [] })))
        .toThrow(/format/i);
      expect(() => parseCurationProjection("{}")).toThrow(/format/i);
    });

    it("rejects a stored projection whose counters contradict its inputRefs", () => {
      const tampered = JSON.parse(serializeCurationProjection(projection));
      tampered.rows[0].verdicts = 99;
      expect(() => parseCurationProjection(JSON.stringify(tampered))).toThrow(/inputRefs/i);
    });
  });
  ```

- [ ] **Step 2 — Implement `src/serialize.ts`:**
  ```ts
  import { CurationInputError } from "./observation.js";
  import type { CurationProjection, CurationRow } from "./projection.js";

  /**
   * The wire token of this package's serialized derived state. Deliberately NOT under
   * `https://jinn.network/records/`: a curation projection is not a record kind, has no sealed
   * bytes, no digest identity, and no signature. It is host-stored state that anyone can
   * throw away and re-derive from the announcements listed in every row's `inputRefs`.
   */
  export const CURATION_PROJECTION_FORMAT = "network.jinn.task-supply.curation-projection/1.0";

  // Explicit key order everywhere: the serialization is byte-stable so two hosts folding the
  // same announcements can compare their stored state directly. No key here is integer-like,
  // so insertion order is what `JSON.stringify` emits.
  function rowToJson(row: CurationRow): Record<string, unknown> {
    return {
      taskDigest: row.taskDigest,
      bucket: row.bucket,
      attempts: row.attempts,
      verdicts: row.verdicts,
      passRate: { num: row.passRate.num, den: row.passRate.den },
      window: { first: row.window.first, last: row.window.last },
      inputRefs: row.inputRefs.map((ref) => ({
        source: { agent: ref.source.agent, name: ref.source.name },
        entry: ref.entry,
        announcementId: ref.announcementId,
        record: ref.record,
        attemptUri: ref.attemptUri,
      })),
    };
  }

  export function serializeCurationProjection(projection: CurationProjection): string {
    return JSON.stringify({
      format: CURATION_PROJECTION_FORMAT,
      rows: projection.rows.map(rowToJson),
    });
  }

  function assertRow(value: unknown, index: number): CurationRow {
    const row = value as CurationRow | undefined;
    if (row === undefined || typeof row !== "object") {
      throw new CurationInputError(`row ${index} is not an object`);
    }
    const { attempts, verdicts, passRate, inputRefs } = row;
    if (!Array.isArray(inputRefs)) throw new CurationInputError(`row ${index} has no inputRefs`);
    if (inputRefs.length !== verdicts) {
      throw new CurationInputError(
        `row ${index}: verdicts (${verdicts}) does not match inputRefs (${inputRefs.length})`,
      );
    }
    if (new Set(inputRefs.map((ref) => ref.attemptUri)).size !== attempts) {
      throw new CurationInputError(`row ${index}: attempts does not match distinct inputRefs attempts`);
    }
    if (passRate.den > verdicts || passRate.num > passRate.den) {
      throw new CurationInputError(`row ${index}: passRate is not a sub-count of verdicts`);
    }
    for (const n of [attempts, verdicts, passRate.num, passRate.den]) {
      if (!Number.isInteger(n) || n < 0) {
        throw new CurationInputError(`row ${index}: counters must be non-negative integers`);
      }
    }
    return row;
  }

  export function parseCurationProjection(text: string): CurationProjection {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new CurationInputError("stored curation projection is not JSON", { cause });
    }
    const document = parsed as { format?: unknown; rows?: unknown };
    if (document?.format !== CURATION_PROJECTION_FORMAT) {
      throw new CurationInputError(
        `unexpected curation projection format: ${String(document?.format)}`,
      );
    }
    if (!Array.isArray(document.rows)) {
      throw new CurationInputError("stored curation projection has no rows array");
    }
    return { rows: document.rows.map((row, index) => assertRow(row, index)) };
  }
  ```

- [ ] **Step 3 — Re-export:** add `export * from "./serialize.js";` to `src/index.ts`. The final
  file is four re-export lines and nothing else.

- [ ] **Step 4 — Build the golden pair.** Write `fixtures/observations-golden.json`: fourteen
  observations across **two** task digests and **both** buckets, with at least one
  `inconclusive`, one repeated `attemptUri` (two verdicts on one attempt), one instant with a
  non-`Z` offset, and two distinct attributions. Then generate the golden projection once:
  ```bash
  cd packages/task-supply/curation && yarn build && node -e '
  const {projectCuration,serializeCurationProjection}=await import("./dist/index.js");
  const fs=await import("node:fs");
  const obs=JSON.parse(fs.readFileSync("fixtures/observations-golden.json","utf8"));
  fs.writeFileSync("fixtures/projection-golden.json",serializeCurationProjection(projectCuration(obs)));
  ' --input-type=module
  ```
  Then **read the generated file and check it by hand** against the fixture before committing —
  a golden nobody verified is a rubber stamp.

- [ ] **Step 5 — Write `src/golden.test.ts`:**
  ```ts
  import { readFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  import { describe, expect, it } from "vitest";
  import { projectCuration, foldCuration } from "./projection.js";
  import { parseCurationProjection, serializeCurationProjection } from "./serialize.js";
  import type { CurationObservation } from "./observation.js";

  const read = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

  const observations = JSON.parse(read("observations-golden.json")) as CurationObservation[];
  const golden = read("projection-golden.json");

  describe("golden projection", () => {
    it("re-derives byte-for-byte from the fixture observations", () => {
      expect(serializeCurationProjection(projectCuration(observations))).toBe(golden);
    });

    it("re-derives byte-for-byte from the reversed fixture observations", () => {
      expect(serializeCurationProjection(projectCuration([...observations].reverse()))).toBe(golden);
    });

    it("re-derives byte-for-byte through an incremental fold", () => {
      const half = Math.floor(observations.length / 2);
      const folded = foldCuration(projectCuration(observations.slice(0, half)), observations.slice(half));
      expect(serializeCurationProjection(folded)).toBe(golden);
    });

    it("parses back into a projection that re-serializes identically", () => {
      expect(serializeCurationProjection(parseCurationProjection(golden))).toBe(golden);
    });
  });
  ```

- [ ] **Step 6 — Write `README.md`.** Required sections, each load-bearing:
  - *What this is* — "a projection of observed verdicts into per-task **observed pass rates**".
    State plainly that it is a projection, never a record, and that anyone can re-derive it.
  - *Bounded claims* — the constraint-18 paragraph: what `attempts`, `verdicts`, `passRate`,
    and `window` do and do not mean; that this is not a difficulty score and not a property of
    the task; that the pass rate is bounded by *what was observed*.
  - *Adapter boundary* — the FC6-1/FC6-2/FC6-4/FC6-5 table: each `CurationObservation` field,
    where an adapter reads it from, and the exact upstream file. State that the adapter needs
    fetch capability and therefore lives outside this package.
  - *Manipulation, and what this layer can and cannot do* — the design §9 paragraph restated
    against the F6 kit: sybil attempts cannot be prevented here; they are made visible in
    `inputRefs` and any consumer can re-derive under its own filter. Cite `fixtures/
    observations-manipulation.json`.
  - *Saturation* — the reference band is a reference; the threshold is always the caller's.
  - Do **not** write any banned phrase from the guard's list.

- [ ] **Step 7 — Extend the guard file** with a seventh case and record the consolidation:
  ```js
  // Constraint 14, at the wire: the serialized envelope is not a record envelope.
  test('serialization: the projection format token is not a record kind', () => {
    const text = readFileSync(join(pkg, 'src', 'serialize.ts'), 'utf8');
    assert.match(text, /CURATION_PROJECTION_FORMAT = "network\.jinn\.task-supply\.curation-projection\/1\.0"/);
    const golden = JSON.parse(readFileSync(join(pkg, 'fixtures', 'projection-golden.json'), 'utf8'));
    assert.deepEqual(Object.keys(golden).sort(), ['format', 'rows']);
    assert.ok(!String(golden.format).startsWith('https://jinn.network/records/'));
  });

  // Plan Finding FC6-8: at the C3+C6 merge these assertions fold into
  // .github/scripts/task-supply-{package-inventory,source-boundaries,packed-types}.test.mjs and
  // this workflow folds into task-supply-ci.yml as one more job. Until then this file is the
  // curation package's only guard.
  ```

- [ ] **Step 8 — Full component gate.** Run every check and show the output:
  ```bash
  cd packages/task-supply/curation
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke
  cd - && node --test .github/scripts/task-supply-curation-guards.test.mjs
  git status --porcelain   # must be empty except intended files
  ```
  Expected: typecheck exit 0; `Test Files  8 passed (8)`, `Tests  56 passed (56)`; `build`
  emits `dist/` with no `*.test.js`; `pack:smoke` prints "Installed package imports and
  dependency boundary verified."; guards `pass 7  fail 0`.

- [ ] **Step 9 — Commit and open the PR.**
  ```bash
  git add packages/task-supply/curation .github/scripts/task-supply-curation-guards.test.mjs
  git commit -m "feat(task-supply): serialize the curation projection and pin the golden re-derivation"
  git push -u origin supply/c6-task-curation
  gh pr create --base integration/evidence-v1 --title "feat(task-supply): @jinn-network/task-curation — the observed pass-rate projection" --body "…"
  ```
  PR body must state: the pinned C6 surface from program §4; the eight findings and their
  dispositions; that the F6 kit proves both derivations; that the package has zero Jinn
  dependencies; and that guard consolidation with C3 is a named merge-time step.

---

## Self-review

**§9 coverage.** Every clause of design §9 maps to a task:

| §9 clause | Where |
| --- | --- |
| "A projection, never a record" | Constraint 14; guard cases 3 + 7; `CURATION_PROJECTION_FORMAT` |
| "attempts observed, verdicts observed" | Task 3 Steps 1–2 (`attempts` = distinct attempt URIs; `verdicts` = all observations) |
| "`passRate` (with numerator/denominator, never bare)" | Task 3 (`Ratio`), constraint 16, pinned-key-set test |
| "first/last verdict times" | Task 3 (`window`), constraint 15 (no clock) |
| "`saturation` boolean derived from a consumer-supplied threshold" | Task 7 (`saturationAt`, arity-2 test) |
| "default reference: the research band [2%, 70%]" | Task 7 (`SATURATION_REFERENCE_BAND` + `_RATIO`), Finding FC6-6 |
| "Aggregate across solvers in v1" | Task 3 — no attribution axis on any row; `attribution` is input-only |
| "per-solver-model breakdown is an extension (§14)" | Out of scope; stated in Finding FC6-5 |
| "queryable state served by the projector's host, re-derivable from scratch" | Task 8 (serialization + golden re-derivation, three ways) |
| "manipulation is *visible in the inputs*" | Task 5 derivation 1 |
| "re-derivable from scratch under any consumer's own solver filter" | Task 5 derivation 2 |
| "always carries numerator + denominator + input references" | Task 3 + constraint 17 + Task 5 case 4 |
| "benchmark-driven attempts are distinguishable … filter or separately bucket them" | Task 4, grounded in `benchrun` |
| §12 non-goal "no mutable status anywhere" | Constraint 14; nothing here writes a "current" flag |
| §13 F6 (normative) | Constraint 17, Task 5, README |

**Placeholder scan.** No `TODO`, no `…` inside code, no unnamed file, no "TBD". Every command
is runnable as written; every expected outcome is a concrete string or count. The two places a
count could drift — the vitest totals in Tasks 3–8 and the guard `pass N` — are stated as the
value the implementer should see, and a mismatch is a signal to check what changed, not a
licence to hand-wave.

**Signature consistency.** `projectCuration(observations: readonly CurationObservation[]):
CurationProjection` appears identically in program §4, the Architecture table, Task 3 Step 2,
Task 6, Task 8, and the pack-smoke script. `foldCuration(previous: CurationProjection |
undefined, observations: readonly CurationObservation[]): CurationProjection` is consistent
across Tasks 3, 6, 8. `saturationAt(row: CurationRow, threshold: Ratio): boolean | undefined`
is consistent across Task 7 and the README. Row field names match program §4's pinned list
exactly — `{taskDigest, attempts, verdicts, passRate: {num, den}, window, inputRefs}` plus
`bucket` — with no renames and no additions.

**Known residual.** The adapter that turns real announcements into `CurationObservation`s is
not built here (Finding FC6-1) and is not built by any component plan in this program. That is
deliberate — it needs fetch capability, which this unit must not have — but it means the
end-to-end "verdicts in discovery → published pass rate" path is not demonstrated by C6 alone.
It should be named in the program's composition note alongside C5-app rather than discovered
later.
