# Evaluator Adapters — `packages/task-execution/evaluator-adapters/`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Do not improvise an execution order — the
> tasks below are dependency-ordered and each ends in a verified commit.

**Goal:** implement §1 row 3 of
[`2026-07-30-operator-daemon-composition-program.md`](./2026-07-30-operator-daemon-composition-program.md)
— the tier-3 package that re-homes the swe-rebench and prediction result parsers into the
evaluation harness's deployment allowlist, per
[`../specs/2026-07-30-operator-daemon-composition-design.md`](../specs/2026-07-30-operator-daemon-composition-design.md)
§6.3 and standards ruling §7.5.

**Architecture:** the package ships two `EvaluatorAdapter` implementations plus the
deployment-allowlist entries that let `runEvaluationHarness` resolve them. Each adapter is a
thin composition of one **pure ingestion parser** (raw grader report or raw solver Result →
a normalized outcome, or a typed ungradeable classification) with one **injected execution
provider** (evaluation-runner design §5.4/§11: "the adapter receives method-specific
execution providers when the host constructs it"). No adapter reinterprets scores, invents
thresholds, or emits a record format: the verdict leaves as a `CompletedEvaluation` in Jinn's
sealed-record grammar, which the harness runtime turns into the signed Result Evaluation.

**Tech stack:** TypeScript 5.9 / Node 22 / Yarn 4.13.0 with `portal:` resolution; vitest 4;
`node --test` for the repository guard scripts; the existing task-execution CI workflow.

## Global constraints

Copied verbatim from the program plan's §Global constraints, then extended:

- Branch target: `integration/evidence-v1` (stacked PR trains; the integration branch is
  not yet in `next`). Nothing here publishes to npm — #2293 runs in parallel.
- Kits and fixtures **before** implementations; a layer's kit green before dependents build.
- Guard trio (package inventory, source-boundary, packed-types + CI workflow) ships **with**
  each new tree, not after.
- Every task ends with typecheck + tests + relevant kit + guards run locally, outputs shown.
- Independent per-component review when a component completes, findings resolved before
  dependents build on it (program discipline, principles §13.2).
- American English throughout; no product names in tier-3 code.
- The spec's §6.1 placement notes and §10 bridge-era/drain/standing rules are binding
  cross-plan contracts (§6 below).

Plan-specific additions:

- **Package name is settled** (program §5): npm `@jinn-network/task-execution-evaluator-adapters`,
  directory `packages/task-execution/evaluator-adapters/`. Do not rename.
- **Fresh rewrite, legacy as fixtures** (program §6 contract 12): every behavior in
  `client/src/harnesses/impls/swe-rebench-v2-evaluator/` and
  `client/src/harnesses/impls/prediction-v*-evaluator/` enters this package **as test
  fixtures and assertions only**. No file is ported, copied, or adapted as code. Fixture
  tasks precede implementation tasks.
- **No new interchange format** (spec §7 ruling 5). SARIF / JUnit XML / TAP / benchmark-local
  JSON are ingestion formats parsed at the adapter edge. The only outward shape is
  `CompletedEvaluation` (already defined by
  `packages/task-execution/evaluation-harness/src/adapter.ts`).
- **Unscorable is never a silent zero.** An evaluation that could not grade the solution
  raises `EvaluationOperationalError` — the harness runtime returns exit
  `EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE` (70), which the evaluation launcher maps to
  `blame: "infrastructure"`, and **no verdict is written**. A `fail` verdict is reserved for
  a graded solution that did not satisfy the spec's `verdictRule`.
- **Never patch the harness runtime.** If a task discovers that
  `packages/task-execution/evaluation-harness/src/{runtime,adapter,registration,launcher}.ts`
  is wrong or insufficient, stop and record a finding with a proposed disposition in the PR
  description. Do not edit those files in this train.
- **American English**; tier-3 code names no product (no "operator app", no "Autopilot", no
  "daemon"). "swe-rebench" and "prediction" are benchmark/work-kind names, not products.

## What this plan does NOT do

- **No evaluator loop.** Observing deliveries, deriving the evaluation Submission, claiming
  the verdict attempt, and dispatching the evaluation-profile Attempt are stage 2
  (`2026-07-30-cutover-stage-2-evaluator-flow.md`). This package is called by that loop's
  deployment module; it never runs one.
- **No new record formats and no protocol semantics.** No new `EvaluationSpec` family, no new
  grader family, no verdict document. `CompletedEvaluation`, `EvaluationSpec`, and the
  Result Evaluation envelope are all owned elsewhere.
- **No changes to the harness runtime**, the registration contract, the launcher, or
  `profiles`. Findings there are surfaced with proposed dispositions, never patched silently.
- **No container/Docker driver and no live venue client.** Both are execution providers under
  the runner design's §5.4 ownership line; this package defines the injected ports and ships
  only hermetic, in-package providers. See Findings A and B below.
- **No `client/` changes.** The legacy evaluators keep running until stage 2 retires them.

## Findings carried into this plan (surface, do not paper over)

Record these verbatim in the component PR description. Each has a proposed disposition; the
plan executes under the proposed disposition and does not wait on a ruling.

**Finding A — nothing in the merged stack executes a `deterministic-process` grader.**
`runEvaluationHarness` (`runtime.ts:683`) resolves exact material, validates the spec,
enforces the parser allowlist, and calls `registration.adapter.evaluate(...)`. It never runs
a container. The evaluation-runner design assigns "the environment in which method-specific
work occurs … process, container, remote-worker" to the **execution provider** (§5.4) and
says the adapter "receives method-specific execution providers when the host constructs it"
(§11) — but the local-execution-backend design §10.4 lists "the execution-provider
abstraction (§5.4, §13)" among the *superseded* halves, on the ground that the backend
already performs that generic job once. Between those two, no package owns "run the pinned
swe-rebench image inside the evaluation Attempt". Composition design §6.3 scopes *this*
package to "the concrete result parsers", so a container driver is out of scope here.
*Proposed disposition:* this package defines the injected port
`GraderReportSource` and ships one in-package implementation — `contextGraderReportSource`,
which reads an already-produced grader report from the harness-supplied evaluation context
(the runner design's §8.3 "supporting context", surfaced by `runtime.ts:757`
`optionalContext`). A container-executing `GraderReportSource` is stage-2 host work or a
separately chartered tree; the coordinator picks. This plan neither writes nor assumes one.

**Finding B — the prediction evaluator's ground truth is a live venue read, and the four
grader families are frozen.** `client/src/harnesses/impls/prediction-v1-evaluator/index.ts:133`
resolves the market through `venues/polymarket/client.ts` at evaluation time. None of
`deterministic-process` / `model-graded` / `human-review` / `composite`
(`profiles/src/evaluation-spec/schema.ts:9`) describes "deterministic scorer over an external
observation". *Proposed disposition:* model prediction evaluation as `deterministic-process`
whose `parser` identity is the scorer's semantic commitment, with the resolution snapshot
arriving as **supporting context** through the same §8.3 channel (injected port
`ResolutionSnapshotSource`, in-package implementation `contextResolutionSnapshotSource`). The
live venue read is stage-2 host work. If the coordinator prefers a fifth family, that is a
`profiles` protocol change and this package's parser is unaffected — only the fixture spec
moves.

**Finding C — `runtime.ts` never forwards a declared unscorable class to the
verdict-consistency check.** `validateCompletedDetails` calls `checkVerdictConsistency({spec,
delivered, measurements})` (`runtime.ts:505`) with `declaredUnscorableClass` left `undefined`,
so the `recorded-inconclusive` branch of
`profiles/src/evaluation-spec/verdict-consistency.ts:27` is unreachable from the harness. An
adapter can therefore deliver `inconclusive` **only** when the spec's `verdictRule` recomputes
to `inconclusive` — i.e. only under a declared `inconclusiveWhen` predicate over delivered
measurements. *Proposed disposition:* this plan lives within the constraint — the prediction
fixture spec carries an explicit `inconclusiveWhen`, and swe-rebench (whose canonical spec
from `profiles/src/documents/swe-rebench.ts:70` declares only a `retryable-infrastructure`
class) never returns `inconclusive`. The harness gap is reported, not patched.

**Finding D — the canonical swe-rebench spec declares exactly one measurement.**
`sweRebenchRowToTaskAndSpec` (`profiles/src/documents/swe-rebench.ts:68`) emits
`measurements: [{ name: "passed", type: "boolean", required: true }]` and
`verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } }`. The runtime
rejects any *undeclared* delivered measurement (`runtime.ts:465`). So the legacy verdict
payload's `score` / `passedCount` / `totalCount` / `evaluator_cost_usd`
(`client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts:1426`) **cannot** ride as
measurements. *Proposed disposition:* they ride in `detailedOutcome` (unconstrained, and the
runner design §16.2's home for rich findings). If the coordinator wants them measurable
(comparable across cells), that is a change to `profiles/src/documents/swe-rebench.ts` owned
by the profiles design, filed as a follow-up — not made here.

---

## Task 1 — Package scaffold, guard trio extension, CI wiring

**Files**

- `packages/task-execution/evaluator-adapters/package.json` (new)
- `packages/task-execution/evaluator-adapters/tsconfig.json` (new)
- `packages/task-execution/evaluator-adapters/tsconfig.build.json` (new)
- `packages/task-execution/evaluator-adapters/README.md` (new)
- `packages/task-execution/evaluator-adapters/src/index.ts` (new)
- `packages/task-execution/evaluator-adapters/scripts/pack-smoke.mjs` (new)
- `.github/scripts/task-execution-package-inventory.test.mjs` (edit)
- `.github/scripts/task-execution-source-boundaries.test.mjs` (edit)
- `.github/scripts/task-execution-packed-types.test.mjs` (edit)
- `.github/workflows/task-execution-ci.yml` (edit)

**Interfaces**

- Consumes: `@jinn-network/task-execution-evaluation-harness` (`EvaluatorAdapter`,
  `EvaluatorRegistration`, `EvaluationOperationalError`, `CompletedEvaluation`,
  `ExactEvaluationMaterial`, `EvaluationContext`, `ResourceDescriptor`,
  `defineEvaluatorRegistration`); `@jinn-network/task-execution-profiles`
  (`EvaluationSpec`, `DeterministicProcessBlock`, `ParserIdentity`, `parserAllowlistKey`);
  `@jinn-network/task-execution-supervisor` (`AttemptIdentity`).
- Produces: the package identity `@jinn-network/task-execution-evaluator-adapters` with a
  single `"."` export entry resolving to `./dist/index.js`.

### Steps

- [ ] **Failing test first — extend the package-inventory guard.** In
      `.github/scripts/task-execution-package-inventory.test.mjs`, add the row to
      `TASK_EXECUTION_PACKAGES` (after the `evaluation-harness` entry):

      ```js
        ['evaluator-adapters', '@jinn-network/task-execution-evaluator-adapters'],
      ```

      bump the documented live count from `9` to `10`:

      ```js
        assert.equal(TASK_EXECUTION_PACKAGES.length, 10);
      ```

      and add the approved dependency graph entry to `JINN_DEPENDENCY_GRAPH`:

      ```js
        // evaluator-adapters (composition design §6.3): concrete result parsers plugged into
        // the evaluation harness's deployment allowlist. Production surface is the adapter
        // contract (evaluation-harness), the EvaluationSpec vocabulary (profiles), and the
        // Attempt identity (supervisor). Nothing else — no evidence package, no backend.
        ['evaluator-adapters', {
          dependencies: [
            '@jinn-network/task-execution-evaluation-harness',
            '@jinn-network/task-execution-profiles',
            '@jinn-network/task-execution-supervisor',
          ],
          devDependencies: [
            '@jinn-network/attestation-issuer', '@jinn-network/evidence-protocol',
            '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-protocol',
            '@jinn-network/task-execution-workspace',
          ],
          optionalDependencies: [], peerDependencies: [],
        }],
      ```

      (The devDependencies are transitive gap-fills so the standalone project's local install
      resolves the harness's own production chain from portals instead of the unpublished
      registry, plus `task-execution-protocol` for the Task 10 integration fixture's
      `sealTask` / `sealDelivery` / `documentDigest`.)

- [ ] **Run to verify fail.**
      `node --test .github/scripts/task-execution-package-inventory.test.mjs`
      Expected failure: `missing package manifest: …/packages/task-execution/evaluator-adapters/package.json`.

- [ ] **Minimal implementation — the manifest.** Create
      `packages/task-execution/evaluator-adapters/package.json`:

      ```json
      {
        "name": "@jinn-network/task-execution-evaluator-adapters",
        "version": "0.1.0",
        "description": "Concrete evaluator adapters for the Jinn evaluation harness: the swe-rebench grader-report parser and the prediction scorer, plugged into a deployment parser allowlist.",
        "type": "module",
        "packageManager": "yarn@4.13.0",
        "engines": { "node": ">=22" },
        "license": "Apache-2.0",
        "repository": {
          "type": "git",
          "url": "https://github.com/Jinn-Network/mono.git",
          "directory": "packages/task-execution/evaluator-adapters"
        },
        "main": "./dist/index.js",
        "types": "./dist/index.d.ts",
        "exports": {
          ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
        },
        "files": ["dist/", "fixtures/", "README.md"],
        "publishConfig": { "access": "public" },
        "scripts": {
          "build": "tsc -p tsconfig.build.json",
          "typecheck": "tsc --noEmit -p tsconfig.json",
          "test": "vitest run",
          "pack:smoke": "node scripts/pack-smoke.mjs",
          "prepack": "yarn build"
        },
        "dependencies": {
          "@jinn-network/task-execution-evaluation-harness": "0.1.0",
          "@jinn-network/task-execution-profiles": "0.1.0",
          "@jinn-network/task-execution-supervisor": "0.1.0"
        },
        "devDependencies": {
          "@jinn-network/attestation-issuer": "0.1.0",
          "@jinn-network/evidence-protocol": "0.1.0",
          "@jinn-network/task-execution-launchers": "0.1.0",
          "@jinn-network/task-execution-protocol": "0.1.0",
          "@jinn-network/task-execution-workspace": "0.1.0",
          "@types/node": "^22.0.0",
          "typescript": "^5.9.3",
          "vitest": "^4.1.8"
        },
        "resolutions": {
          "@jinn-network/attestation-issuer": "portal:../../evidence/attestation-issuer",
          "@jinn-network/evidence-protocol": "portal:../../evidence/protocol",
          "@jinn-network/task-execution-evaluation-harness": "portal:../evaluation-harness",
          "@jinn-network/task-execution-launchers": "portal:../backend-local/launchers",
          "@jinn-network/task-execution-profiles": "portal:../profiles",
          "@jinn-network/task-execution-protocol": "portal:../protocol",
          "@jinn-network/task-execution-supervisor": "portal:../backend-local/supervisor",
          "@jinn-network/task-execution-workspace": "portal:../backend-local/workspace"
        }
      }
      ```

      Create `tsconfig.json` byte-identical to
      `packages/task-execution/evaluation-harness/tsconfig.json`, and `tsconfig.build.json`:

      ```json
      { "extends": "./tsconfig.json", "exclude": ["src/**/*.test.ts"] }
      ```

      Create `src/index.ts` as a placeholder that the later tasks extend:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      export {};
      ```

      Create `scripts/pack-smoke.mjs` by copying
      `packages/task-execution/evaluation-harness/scripts/pack-smoke.mjs` and changing only
      the two package-list constants: append
      `[join(taskExecutionRoot, "evaluation-harness"), "@jinn-network/task-execution-evaluation-harness"]`
      to `packageInputs`, replace the final entry with
      `[packageRoot, "@jinn-network/task-execution-evaluator-adapters"]`, and rename the
      `mkdtemp` prefix to `"jinn-evaluator-adapters-"`. Write `README.md` naming the package,
      its two adapters, the two injected provider ports, and Findings A–D.

- [ ] **Run to verify pass.**
      `node --test .github/scripts/task-execution-package-inventory.test.mjs`
      Expected: 3 passing tests, 0 failing.

- [ ] **Failing test — extend the source-boundary guard.** In
      `.github/scripts/task-execution-source-boundaries.test.mjs`:

      add `'evaluator-adapters'` to `taskExecutionDirectories`; add the forbidden list next to
      the harness lists:

      ```js
      // evaluator-adapters (composition design §6.3) is a leaf: it consumes the adapter
      // contract, the EvaluationSpec vocabulary, and the Attempt identity, and imports no
      // evidence/trust/discovery package and no chain or network client in production.
      const EVALUATOR_ADAPTERS_PRODUCTION_FORBIDDEN = [
        ...TASK_EXECUTION_FOREIGN_PACKAGES,
        '@jinn-network/task-execution-backend',
        '@jinn-network/task-execution-backend-local',
        '@jinn-network/task-execution-launchers',
        '@jinn-network/task-execution-protocol',
        '@jinn-network/task-execution-testing',
        '@jinn-network/task-execution-workspace',
      ];
      // Its tests drive the real harness runtime end-to-end, so they may seal Task/Delivery
      // documents and place workspace paths — but still touch no evidence runtime.
      const EVALUATOR_ADAPTERS_TEST_FORBIDDEN = [
        ...TASK_EXECUTION_FOREIGN_PACKAGES
          .filter((name) => name !== '@jinn-network/evidence-protocol'),
        '@jinn-network/task-execution-backend-local',
        '@jinn-network/task-execution-testing',
      ];
      ```

      and inside `test('task-execution source boundaries remain one-way across the approved graph', …)`,
      after the evaluation-harness block, append:

      ```js
        const adaptersSrc = join(packages, 'evaluator-adapters', 'src');
        const adaptersTests = files(adaptersSrc)
          .filter((file) => /\.test\.[cm]?[jt]sx?$/u.test(file));
        const adaptersProduction = files(adaptersSrc)
          .filter((file) => !adaptersTests.includes(file));
        assert.deepEqual(
          forbiddenImportsInFiles(adaptersProduction, EVALUATOR_ADAPTERS_PRODUCTION_FORBIDDEN),
          [],
          'evaluator-adapters production source crosses its approved contract boundary',
        );
        assert.deepEqual(
          forbiddenImportsInFiles(adaptersTests, EVALUATOR_ADAPTERS_TEST_FORBIDDEN),
          [],
          'evaluator-adapters tests may import only the approved harness-driving surface',
        );
      ```

      In the same file, add `'evaluator-adapters'` to the array iterated by
      `test('Task-execution production source never orders or formats with the host locale', …)`
      if that test enumerates directories explicitly; otherwise it already reads
      `taskExecutionDirectories` and the first edit suffices — verify by reading the test body
      before editing.

- [ ] **Run to verify fail.**
      `node --test .github/scripts/task-execution-source-boundaries.test.mjs`
      Expected failure: the boundary test errors reading `…/evaluator-adapters/src` before the
      import scanner finds any file, or reports an empty-directory assertion. Once `src/index.ts`
      exists from the previous step it passes — so run this guard **before** creating `src/`
      if you want to observe the red; otherwise accept the inventory guard's red as the
      scaffold's failing gate and note it in the commit body.

- [ ] **Run to verify pass.**
      `node --test .github/scripts/task-execution-source-boundaries.test.mjs`
      Expected: 7 passing tests, 0 failing.

- [ ] **Extend the packed-types guard.** In `.github/scripts/task-execution-packed-types.test.mjs`
      append to `packages`:

      ```js
        [join(taskExecutionRoot, 'evaluator-adapters'), '@jinn-network/task-execution-evaluator-adapters'],
      ```

      and to `codeEntrypoints`:

      ```js
        '@jinn-network/task-execution-evaluator-adapters',
      ```

- [ ] **Wire CI.** In `.github/workflows/task-execution-ci.yml` add a job after
      `evaluation-harness`:

      ```yaml
        evaluator-adapters:
          needs: [foundation, backend, profiles, supervisor, workspace, launchers, backend-local, evaluation-harness]
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
            - name: Restore all Task Execution distributions
              uses: actions/download-artifact@v4
              with:
                pattern: task-execution-*-dist
                path: .task-execution-dist
            - name: Place Task Execution distributions
              run: |
                for package in protocol backend profiles evaluation-harness; do
                  mkdir -p "packages/task-execution/${package}/dist"
                  cp -R ".task-execution-dist/task-execution-${package}-dist/." "packages/task-execution/${package}/dist/"
                done
                for package in supervisor workspace launchers; do
                  mkdir -p "packages/task-execution/backend-local/${package}/dist"
                  cp -R ".task-execution-dist/task-execution-${package}-dist/." "packages/task-execution/backend-local/${package}/dist/"
                done
                mkdir -p packages/task-execution/backend-local/assembly/dist
                cp -R ".task-execution-dist/task-execution-backend-local-dist/." packages/task-execution/backend-local/assembly/dist/
            - name: Restore executable bit on native custody binaries
              run: chmod +x packages/task-execution/backend-local/supervisor/dist/native/jinn-attempt-shim*
            - name: Install packed-smoke dependency toolchains
              run: |
                (cd packages/task-execution/protocol && yarn install --immutable)
                (cd packages/task-execution/backend && yarn install --immutable)
                (cd packages/task-execution/profiles && yarn install --immutable)
                (cd packages/task-execution/backend-local/supervisor && yarn install --immutable)
                (cd packages/task-execution/backend-local/workspace && yarn install --immutable)
                (cd packages/task-execution/backend-local/launchers && yarn install --immutable)
                (cd packages/task-execution/evaluation-harness && yarn install --immutable)
            - name: Build evidence contract packages from source
              run: |
                (cd packages/evidence/protocol && yarn install --immutable && yarn build)
                (cd packages/evidence/repository && yarn install --immutable && yarn build)
                (cd packages/evidence/discovery && yarn install --immutable && yarn build)
                (cd packages/evidence/execution-recorder && yarn install --immutable && yarn build)
                (cd packages/evidence/attestation-issuer && yarn install --immutable && yarn build)
            - name: Verify Task Execution Evaluator Adapters
              working-directory: packages/task-execution/evaluator-adapters
              run: |
                yarn install --immutable
                yarn typecheck
                yarn test
                yarn build
                yarn pack:smoke
            - name: Upload Task Execution Evaluator Adapters distribution
              uses: actions/upload-artifact@v4
              with:
                name: task-execution-evaluator-adapters-dist
                path: packages/task-execution/evaluator-adapters/dist
                if-no-files-found: error
                retention-days: 1
      ```

      In the existing `verify` job: add `evaluator-adapters` to `needs`, add
      `EVALUATOR_ADAPTERS_RESULT: ${{ needs.evaluator-adapters.result }}` to `env`, add
      `"$EVALUATOR_ADAPTERS_RESULT" \` to the `for result in` list, and add
      `evaluation-harness evaluator-adapters` to the `for package in protocol backend testing profiles`
      loop in "Place package distributions".

- [ ] **Verify locally.**
      ```
      cd packages/task-execution/evaluator-adapters && yarn install && yarn typecheck && yarn build
      ```
      Expected: install resolves every portal, `tsc --noEmit` prints nothing, `dist/index.js`
      and `dist/index.d.ts` exist.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters .github/scripts .github/workflows/task-execution-ci.yml && \
      git commit -m "feat(task-execution): scaffold evaluator-adapters with the guard trio and CI job"
      ```

---

## Task 2 — Parser semantics documents and pinned parser identities

The `EvaluationSpec`'s `parser` is `{id, version, digest}` and "the digest is the semantic
commitment" (profiles design §7.2). Fabricating a digest would be a lie about what the parser
promises. Instead each parser ships a **semantics document** in `fixtures/parsers/`, and the
exported `ParserIdentity.digest` is the SHA-256 of that file's exact bytes — pinned by a test,
so any edit to the semantics without a version bump breaks CI.

**Files**

- `packages/task-execution/evaluator-adapters/fixtures/parsers/swe-rebench-v2.parser.json` (new)
- `packages/task-execution/evaluator-adapters/fixtures/parsers/prediction-market.parser.json` (new)
- `packages/task-execution/evaluator-adapters/src/parser-identity.ts` (new)
- `packages/task-execution/evaluator-adapters/src/parser-identity.test.ts` (new)

**Interfaces**

- Consumes: `ParserIdentity`, `parserAllowlistKey` from `@jinn-network/task-execution-profiles`.
- Produces:
  ```ts
  export const SWE_REBENCH_PARSER: ParserIdentity;
  export const PREDICTION_PARSER: ParserIdentity;
  export function evaluatorAdaptersParserAllowlist(): ReadonlySet<string>;
  ```

### Steps

- [ ] **Failing test.** Create `src/parser-identity.test.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import { createHash } from "node:crypto";
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      import { fileURLToPath } from "node:url";
      import { parserAllowlistKey } from "@jinn-network/task-execution-profiles";
      import { describe, expect, test } from "vitest";
      import {
        evaluatorAdaptersParserAllowlist,
        PREDICTION_PARSER,
        SWE_REBENCH_PARSER,
      } from "./parser-identity.js";

      const fixtures = fileURLToPath(new URL("../fixtures/parsers/", import.meta.url));

      function fileDigest(name: string): string {
        return `sha256:${createHash("sha256").update(readFileSync(join(fixtures, name))).digest("hex")}`;
      }

      describe("parser identities", () => {
        test("the swe-rebench digest is its semantics document, byte for byte", () => {
          expect(SWE_REBENCH_PARSER.id).toBe("network.jinn.parser.swe-rebench-v2");
          expect(SWE_REBENCH_PARSER.version).toBe("1.0.0");
          expect(SWE_REBENCH_PARSER.digest).toBe(fileDigest("swe-rebench-v2.parser.json"));
        });

        test("the prediction digest is its semantics document, byte for byte", () => {
          expect(PREDICTION_PARSER.id).toBe("network.jinn.parser.prediction-market");
          expect(PREDICTION_PARSER.version).toBe("1.0.0");
          expect(PREDICTION_PARSER.digest).toBe(fileDigest("prediction-market.parser.json"));
        });

        test("the deployment allowlist carries exactly both parser keys", () => {
          expect([...evaluatorAdaptersParserAllowlist()].sort()).toEqual(
            [
              parserAllowlistKey(PREDICTION_PARSER),
              parserAllowlistKey(SWE_REBENCH_PARSER),
            ].sort(),
          );
        });

        test("an unrelated parser identity is not allowlisted", () => {
          expect(
            evaluatorAdaptersParserAllowlist().has(
              parserAllowlistKey({
                id: "network.jinn.parser.swe-rebench-v2",
                version: "1.0.0",
                digest: `sha256:${"0".repeat(64)}`,
              }),
            ),
          ).toBe(false);
        });
      });
      ```

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/parser-identity.test.ts`
      Expected failure: `Failed to resolve import "./parser-identity.js"`.

- [ ] **Write the semantics documents.** `fixtures/parsers/swe-rebench-v2.parser.json` states
      exactly what the parser commits to, transcribed from the legacy oracles
      (`client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:1-27`, `:216-249`,
      `:546-569`). It is data, never code:

      ```json
      {
        "parser": "network.jinn.parser.swe-rebench-v2",
        "version": "1.0.0",
        "input": {
          "report": "one item of the upstream SWE-rebench-V2 scripts/eval report.json items[] array",
          "graded": ["instance_id", "from_fail_to_pass", "failed_from_pass_to_pass", "passed_actual", "failed_actual", "exit_code", "log_path"],
          "setupError": ["instance_id", "error"],
          "log": "the concatenated container log, UTF-8, tail-capped by the caller"
        },
        "resolution": {
          "rule": "resolved iff every declared failToPass transition now passes AND no declared passToPass transition broke",
          "note": "the upstream passed_match field is NOT trusted: it compares the observed passing set to the union of declared transitions, which makes any instance whose test command runs extra tests structurally unscorable and penalises an added passing test"
        },
        "ungradeable": {
          "rule": "a report is ungradeable when the upstream item carries a non-empty error, or lacks a numeric exit_code, or (container exit non-zero AND no declared failToPass passed AND every declared passToPass is reported broken AND the log matches a classified infrastructure signature)",
          "classes": [
            "docker_unavailable", "docker_storage_io_error", "image_pull_failed",
            "docker_credentials_error", "docker_run_failed", "patch_corrupt",
            "patch_does_not_apply", "patch_merge_conflict", "workdir_not_git_repo",
            "test_command_not_found", "install_build_failed", "venv_missing",
            "image_arch_mismatch", "venv_collision", "pytest_missing",
            "requests_dep_mismatch", "conftest_import_error",
            "eval_setup_error", "eval_report_malformed"
          ],
          "note": "an ungradeable report yields no verdict; it is never reported as a failing verdict"
        },
        "measurements": { "passed": "boolean — the resolution rule's outcome" }
      }
      ```

      `fixtures/parsers/prediction-market.parser.json`, transcribed from
      `client/src/harnesses/impls/prediction-v1-evaluator/index.ts:92-146` and
      `client/src/harnesses/impls/prediction-v0-evaluator/score.ts`:

      ```json
      {
        "parser": "network.jinn.parser.prediction-market",
        "version": "1.0.0",
        "input": {
          "result": "the solver Result document: probabilityYes (decimal string in [0,1]), submittedAt (RFC 3339), modelId",
          "context": "the resolution snapshot: status (resolved|unresolved|unavailable), outcome (YES|NO), resolvedAt, marketId, conditionId, sourceUrl, and the consensus snapshot probabilityYes plus the submission window"
        },
        "checks": ["result.schema", "result.window", "market.identity", "market.resolution"],
        "verdict": {
          "fail": "any check other than market.resolution reports FAIL",
          "inconclusive": "the market is not resolved (the spec must declare an inconclusiveWhen predicate over the resolved measurement)",
          "pass": "every check passes and the market resolved"
        },
        "scoring": {
          "basis": "brier-loss.v1",
          "rule": "brier = (probability - target)^2 with target 1 for YES and 0 for NO; spread = solverBrier - consensusBrier",
          "encoding": "fixed six-fraction-digit decimal strings — never JSON numbers, per the I-JSON sealed-numbers rule"
        },
        "measurements": {
          "integrity": "boolean", "resolved": "boolean", "outcomeYes": "boolean",
          "solverBrier": "string", "consensusBrier": "string", "brierSpread": "string"
        }
      }
      ```

- [ ] **Minimal implementation.** Create `src/parser-identity.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import { createHash } from "node:crypto";
      import { readFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      import {
        parserAllowlistKey,
        type ParserIdentity,
      } from "@jinn-network/task-execution-profiles";

      /**
       * A parser's semantic commitment is its digest (profiles design §7.2). The digest here is
       * the SHA-256 of the parser's own semantics document, shipped in `fixtures/parsers/` and
       * pinned by `parser-identity.test.ts` — editing the semantics without bumping `version`
       * breaks the build rather than silently changing what the allowlist key means.
       */
      function semanticsDigest(fileName: string): `sha256:${string}` {
        const path = fileURLToPath(
          new URL(`../fixtures/parsers/${fileName}`, import.meta.url),
        );
        return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
      }

      export const SWE_REBENCH_PARSER: ParserIdentity = Object.freeze({
        id: "network.jinn.parser.swe-rebench-v2",
        version: "1.0.0",
        digest: semanticsDigest("swe-rebench-v2.parser.json"),
      });

      export const PREDICTION_PARSER: ParserIdentity = Object.freeze({
        id: "network.jinn.parser.prediction-market",
        version: "1.0.0",
        digest: semanticsDigest("prediction-market.parser.json"),
      });

      /**
       * The deployment-side execution allowlist this package contributes. A host merges it into
       * `EvaluationHarnessDeployment.parserAllowlist`; a spec naming any other parser identity is
       * refused by the harness runtime before an adapter is selected.
       */
      export function evaluatorAdaptersParserAllowlist(): ReadonlySet<string> {
        return new Set([
          parserAllowlistKey(SWE_REBENCH_PARSER),
          parserAllowlistKey(PREDICTION_PARSER),
        ]);
      }
      ```

      Export it from `src/index.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      export * from "./parser-identity.js";
      ```

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/parser-identity.test.ts`
      Expected: 4 passing tests.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "feat(task-execution): pin evaluator parser identities to their semantics documents"
      ```

---

## Task 3 — swe-rebench golden and adversarial fixtures

Fixtures precede the parser. Every case below is transcribed from a named legacy oracle;
record the provenance comment in the fixture module exactly as written.

**Files**

- `packages/task-execution/evaluator-adapters/fixtures/swe-rebench/README.md` (new)
- `packages/task-execution/evaluator-adapters/fixtures/swe-rebench/*.json` / `*.log` (new)
- `packages/task-execution/evaluator-adapters/src/swe-rebench/fixtures.ts` (new)
- `packages/task-execution/evaluator-adapters/src/swe-rebench/fixtures.test.ts` (new)

**Interfaces**

- Produces:
  ```ts
  export interface SweRebenchFixture {
    readonly name: string;
    readonly provenance: string;
    readonly transitions: { readonly failToPass: readonly string[]; readonly passToPass: readonly string[] };
    readonly report: unknown;            // one upstream report.json items[] entry, or a non-object
    readonly log: string;
    readonly expect:
      | { readonly kind: "graded"; readonly passed: boolean }
      | { readonly kind: "ungradeable"; readonly ungradeableClass: string };
  }
  export const SWE_REBENCH_FIXTURES: readonly SweRebenchFixture[];
  ```

### Steps

- [ ] **Failing test.** Create `src/swe-rebench/fixtures.test.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import { describe, expect, test } from "vitest";
      import { SWE_REBENCH_FIXTURES } from "./fixtures.js";

      describe("swe-rebench fixtures", () => {
        test("every fixture names its legacy provenance", () => {
          expect(SWE_REBENCH_FIXTURES.length).toBeGreaterThanOrEqual(12);
          for (const fixture of SWE_REBENCH_FIXTURES) {
            expect(fixture.provenance).toMatch(/^client\/(src|test)\/.+:\d+/u);
          }
        });

        test("fixture names are unique", () => {
          const names = SWE_REBENCH_FIXTURES.map((fixture) => fixture.name);
          expect(new Set(names).size).toBe(names.length);
        });

        test("both graded outcomes and every ungradeable class appear at least once", () => {
          const graded = SWE_REBENCH_FIXTURES.filter((f) => f.expect.kind === "graded");
          expect(graded.some((f) => f.expect.kind === "graded" && f.expect.passed)).toBe(true);
          expect(graded.some((f) => f.expect.kind === "graded" && !f.expect.passed)).toBe(true);
          const classes = new Set(
            SWE_REBENCH_FIXTURES.flatMap((f) =>
              f.expect.kind === "ungradeable" ? [f.expect.ungradeableClass] : []
            ),
          );
          for (const required of [
            "docker_unavailable",
            "patch_does_not_apply",
            "patch_corrupt",
            "workdir_not_git_repo",
            "venv_collision",
            "pytest_missing",
            "requests_dep_mismatch",
            "conftest_import_error",
            "eval_setup_error",
            "eval_report_malformed",
          ]) {
            expect(classes).toContain(required);
          }
        });
      });
      ```

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/swe-rebench/fixtures.test.ts`
      Expected failure: `Failed to resolve import "./fixtures.js"`.

- [ ] **Minimal implementation.** Create `src/swe-rebench/fixtures.ts`. Provenance for every
      case, from the legacy oracles:

      - report shapes — `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:6-13`
        and the upstream stub `client/test/harnesses/impls/swe-rebench-v2-evaluator/fixtures/eval.py:88-101`;
      - graded / ungradeable cases —
        `client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:257-405`;
      - infrastructure fingerprints —
        `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:216-242` and the
        2026-05-14 triage constants at
        `client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:576-592`.

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      /**
       * Behavioral oracles for the swe-rebench parser. Composition design §6.6: legacy behavior
       * enters as fixtures, never as ported code. Each entry cites the exact legacy file and line
       * range it was transcribed from.
       */

      export interface SweRebenchFixture {
        readonly name: string;
        readonly provenance: string;
        readonly transitions: {
          readonly failToPass: readonly string[];
          readonly passToPass: readonly string[];
        };
        readonly report: unknown;
        readonly log: string;
        readonly expect:
          | { readonly kind: "graded"; readonly passed: boolean }
          | { readonly kind: "ungradeable"; readonly ungradeableClass: string };
      }

      const TRANSITIONS = {
        failToPass: ["tests/test_a.py::test_a"],
        passToPass: ["tests/test_b.py::test_b"],
      } as const;

      const PYTEST_TAIL = [
        "==================================== PASSES ====================================",
        "PASSED tests/test_a.py::test_a",
        "PASSED tests/test_b.py::test_b",
        "======================== 2 passed, 0 failed in 1.20s ==========================",
      ].join("\n");

      export const SWE_REBENCH_FIXTURES: readonly SweRebenchFixture[] = Object.freeze([
        {
          name: "resolved-all-transitions",
          provenance: "client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:555-559",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: ["tests/test_a.py::test_a"],
            failed_from_pass_to_pass: [],
            passed_match: true,
            exit_code: 0,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: PYTEST_TAIL,
          expect: { kind: "graded", passed: true },
        },
        {
          name: "resolved-despite-extra-unlisted-test-failing",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:270-283",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: ["tests/test_a.py::test_a"],
            failed_from_pass_to_pass: [],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: [
            "FAILED tests/test_unlisted.py::test_unlisted",
            "PASSED tests/test_a.py::test_a",
            "PASSED tests/test_b.py::test_b",
            "=================== 2 passed, 1 failed in 2.10s ===============================",
          ].join("\n"),
          expect: { kind: "graded", passed: true },
        },
        {
          name: "unresolved-fail-to-pass-still-failing",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:284-295",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: [],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: [
            "FAILED tests/test_a.py::test_a - AssertionError",
            "PASSED tests/test_b.py::test_b",
            "=================== 1 passed, 1 failed in 1.80s ===============================",
          ].join("\n"),
          expect: { kind: "graded", passed: false },
        },
        {
          name: "unresolved-pass-to-pass-broken",
          provenance: "client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:555-559",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: ["tests/test_a.py::test_a"],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: [
            "PASSED tests/test_a.py::test_a",
            "FAILED tests/test_b.py::test_b - RegressionError",
            "=================== 1 passed, 1 failed in 1.90s ===============================",
          ].join("\n"),
          expect: { kind: "graded", passed: false },
        },
        {
          name: "ungradeable-docker-unavailable",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:318-331",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 125,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
          expect: { kind: "ungradeable", ungradeableClass: "docker_unavailable" },
        },
        {
          name: "ungradeable-patch-corrupt",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:333-346",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: "error: corrupt patch at line 7",
          expect: { kind: "ungradeable", ungradeableClass: "patch_corrupt" },
        },
        {
          name: "ungradeable-patch-does-not-apply",
          provenance: "client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:229",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: "error: patch failed: src/widget.py:14\nerror: patch does not apply",
          expect: { kind: "ungradeable", ungradeableClass: "patch_does_not_apply" },
        },
        {
          name: "ungradeable-workdir-not-git-repo",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:348-361",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 128,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: "fatal: not a git repository (or any of the parent directories): .git",
          expect: { kind: "ungradeable", ungradeableClass: "workdir_not_git_repo" },
        },
        {
          name: "ungradeable-venv-collision",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:576-580",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 2,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: [
            "error: Failed to create virtual environment.",
            "  Caused by: A virtual environment already exists at /testbed/.venv",
            "  Use --clear to replace it",
          ].join("\n"),
          expect: { kind: "ungradeable", ungradeableClass: "venv_collision" },
        },
        {
          name: "ungradeable-pytest-missing",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:582-583",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: "/opt/conda/bin/python: No module named pytest",
          expect: { kind: "ungradeable", ungradeableClass: "pytest_missing" },
        },
        {
          name: "ungradeable-requests-dep-mismatch",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:585-586",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log:
            "requests.exceptions.RequestsDependencyWarning: urllib3 (2.2.2) or "
            + "chardet (7.4.3)/charset_normalizer (3.3.2) doesn't match a supported version!",
          expect: { kind: "ungradeable", ungradeableClass: "requests_dep_mismatch" },
        },
        {
          name: "ungradeable-conftest-import-error",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:588-589",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: "ImportError while loading conftest '/testbed/tests/conftest.py'.",
          expect: { kind: "ungradeable", ungradeableClass: "conftest_import_error" },
        },
        {
          name: "ungradeable-upstream-setup-error",
          provenance: "client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:363-370",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            error: "missing image_name",
          },
          log: "",
          expect: { kind: "ungradeable", ungradeableClass: "eval_setup_error" },
        },
        {
          name: "adversarial-report-lacks-exit-code",
          provenance: "client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:501-507",
          transitions: TRANSITIONS,
          report: { instance_id: "acme__widget-1", from_fail_to_pass: [], failed_from_pass_to_pass: [] },
          log: "",
          expect: { kind: "ungradeable", ungradeableClass: "eval_report_malformed" },
        },
        {
          name: "adversarial-report-is-not-an-object",
          provenance: "client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:478-489",
          transitions: TRANSITIONS,
          report: "the upstream harness crashed before writing a report",
          log: "",
          expect: { kind: "ungradeable", ungradeableClass: "eval_report_malformed" },
        },
        {
          name: "adversarial-transition-arrays-carry-non-strings",
          provenance: "client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:251-253",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [null, 7, "tests/test_a.py::test_a"],
            failed_from_pass_to_pass: [{ nested: true }],
            passed_match: false,
            exit_code: 0,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: PYTEST_TAIL,
          expect: { kind: "graded", passed: true },
        },
        {
          name: "adversarial-truncated-log-with-no-marker",
          provenance: "client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:256-261",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: [],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: "[… 4194304 bytes truncated …]\ncollecting ... ",
          expect: { kind: "graded", passed: false },
        },
        {
          name: "adversarial-empty-log-non-zero-exit-no-signature",
          provenance: "client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:539-553",
          transitions: TRANSITIONS,
          report: {
            instance_id: "acme__widget-1",
            from_fail_to_pass: [],
            failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
            passed_match: false,
            exit_code: 1,
            log_path: "logs/acme__widget-1_log.txt",
            error: "",
          },
          log: "",
          expect: { kind: "graded", passed: false },
        },
      ]);
      ```

      Also write `fixtures/swe-rebench/README.md` naming the two upstream report shapes, the
      resolution rule, and the ungradeable rule, with the same provenance citations.

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/swe-rebench/fixtures.test.ts`
      Expected: 3 passing tests; the fixture count assertion reports 18 entries.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "test(task-execution): land swe-rebench evaluator fixtures from the legacy oracles"
      ```

---

## Task 4 — the swe-rebench ingestion parser (pure)

**Files**

- `packages/task-execution/evaluator-adapters/src/swe-rebench/parse.ts` (new)
- `packages/task-execution/evaluator-adapters/src/swe-rebench/parse.test.ts` (new)

**Interfaces**

- Consumes: `SWE_REBENCH_FIXTURES` from `./fixtures.js`.
- Produces:
  ```ts
  export interface SweRebenchCheck {
    readonly name: string;
    readonly status: "pass" | "fail";
    readonly detail?: string;
  }
  export interface SweRebenchGraded {
    readonly kind: "graded";
    readonly instanceId: string;
    readonly passed: boolean;
    readonly failToPassExpected: number;
    readonly failToPassSatisfied: number;
    readonly passToPassExpected: number;
    readonly passToPassBroken: number;
    readonly containerExitCode: number;
    readonly checks: readonly SweRebenchCheck[];
  }
  export interface SweRebenchUngradeable {
    readonly kind: "ungradeable";
    readonly ungradeableClass: string;
    readonly detail: string;
  }
  export type SweRebenchOutcome = SweRebenchGraded | SweRebenchUngradeable;

  export interface SweRebenchTransitions {
    readonly failToPass: readonly string[];
    readonly passToPass: readonly string[];
  }

  export function classifyInfrastructureSignature(log: string): string | undefined;
  export function parseSweRebenchReport(input: {
    readonly report: unknown;
    readonly log: string;
    readonly transitions: SweRebenchTransitions;
  }): SweRebenchOutcome;
  ```

### Steps

- [ ] **Failing test.** Create `src/swe-rebench/parse.test.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import { describe, expect, test } from "vitest";
      import { SWE_REBENCH_FIXTURES } from "./fixtures.js";
      import {
        classifyInfrastructureSignature,
        parseSweRebenchReport,
      } from "./parse.js";

      describe("parseSweRebenchReport", () => {
        test.each(SWE_REBENCH_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
          "%s reproduces the legacy outcome",
          (_name, fixture) => {
            const outcome = parseSweRebenchReport({
              report: fixture.report,
              log: fixture.log,
              transitions: fixture.transitions,
            });
            if (fixture.expect.kind === "graded") {
              expect(outcome.kind).toBe("graded");
              if (outcome.kind !== "graded") return;
              expect(outcome.passed).toBe(fixture.expect.passed);
            } else {
              expect(outcome.kind).toBe("ungradeable");
              if (outcome.kind !== "ungradeable") return;
              expect(outcome.ungradeableClass).toBe(fixture.expect.ungradeableClass);
            }
          },
        );

        test("a graded outcome carries per-check results, never a bare boolean", () => {
          const outcome = parseSweRebenchReport({
            report: SWE_REBENCH_FIXTURES[3]!.report,
            log: SWE_REBENCH_FIXTURES[3]!.log,
            transitions: SWE_REBENCH_FIXTURES[3]!.transitions,
          });
          expect(outcome.kind).toBe("graded");
          if (outcome.kind !== "graded") return;
          expect(outcome.checks.map((check) => check.name)).toEqual([
            "transitions.fail-to-pass",
            "transitions.pass-to-pass",
          ]);
          expect(outcome.checks[0]!.status).toBe("pass");
          expect(outcome.checks[1]!.status).toBe("fail");
          expect(outcome.passToPassBroken).toBe(1);
        });

        test("the upstream passed_match field is never trusted", () => {
          const outcome = parseSweRebenchReport({
            report: {
              instance_id: "acme__widget-1",
              from_fail_to_pass: ["tests/test_a.py::test_a"],
              failed_from_pass_to_pass: [],
              passed_match: false,
              exit_code: 1,
              error: "",
            },
            log: "PASSED tests/test_a.py::test_a",
            transitions: { failToPass: ["tests/test_a.py::test_a"], passToPass: [] },
          });
          expect(outcome.kind === "graded" && outcome.passed).toBe(true);
        });

        test("a non-UTF-8-decodable log is classified, never crashed on", () => {
          const outcome = parseSweRebenchReport({
            report: {
              instance_id: "acme__widget-1",
              from_fail_to_pass: [],
              failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
              exit_code: 1,
              error: "",
            },
            log: "�� Cannot connect to the Docker daemon �",
            transitions: { failToPass: ["a"], passToPass: ["tests/test_b.py::test_b"] },
          });
          expect(outcome.kind === "ungradeable" && outcome.ungradeableClass)
            .toBe("docker_unavailable");
        });
      });

      describe("classifyInfrastructureSignature", () => {
        test("returns undefined for an ordinary pytest failure report", () => {
          expect(classifyInfrastructureSignature(
            "FAILED tests/test_a.py::test_a - AssertionError\n1 failed in 0.40s",
          )).toBeUndefined();
        });

        test("classifies a docker-CLI abort", () => {
          expect(classifyInfrastructureSignature(
            "docker: Error response from daemon: no such image",
          )).toBe("docker_run_failed");
        });
      });
      ```

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/swe-rebench/parse.test.ts`
      Expected failure: `Failed to resolve import "./parse.js"`.

- [ ] **Minimal implementation.** Create `src/swe-rebench/parse.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      /**
       * Ingestion parser for the upstream SWE-rebench-V2 evaluation report. Pure: no process, no
       * filesystem, no clock. The commitment it implements is `fixtures/parsers/swe-rebench-v2.parser.json`,
       * whose digest is this parser's identity.
       */

      export interface SweRebenchCheck {
        readonly name: string;
        readonly status: "pass" | "fail";
        readonly detail?: string;
      }

      export interface SweRebenchGraded {
        readonly kind: "graded";
        readonly instanceId: string;
        readonly passed: boolean;
        readonly failToPassExpected: number;
        readonly failToPassSatisfied: number;
        readonly passToPassExpected: number;
        readonly passToPassBroken: number;
        readonly containerExitCode: number;
        readonly checks: readonly SweRebenchCheck[];
      }

      export interface SweRebenchUngradeable {
        readonly kind: "ungradeable";
        readonly ungradeableClass: string;
        readonly detail: string;
      }

      export type SweRebenchOutcome = SweRebenchGraded | SweRebenchUngradeable;

      export interface SweRebenchTransitions {
        readonly failToPass: readonly string[];
        readonly passToPass: readonly string[];
      }

      /**
       * Container-output signatures meaning the evaluation aborted before grading anything — the
       * environment is the problem, not the solution. Transcribed as data from the legacy
       * classification table (`client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:216-242`);
       * the fixtures in `./fixtures.ts` are its regression suite.
       */
      const INFRASTRUCTURE_SIGNATURES: readonly {
        readonly pattern: RegExp;
        readonly ungradeableClass: string;
      }[] = Object.freeze([
        { pattern: /Cannot connect to the Docker daemon/iu, ungradeableClass: "docker_unavailable" },
        { pattern: /input\/output error/iu, ungradeableClass: "docker_storage_io_error" },
        { pattern: /No such image|manifest unknown|pull access denied/iu, ungradeableClass: "image_pull_failed" },
        { pattern: /error getting credentials/iu, ungradeableClass: "docker_credentials_error" },
        { pattern: /^docker: (?:error|Error response from daemon)/imu, ungradeableClass: "docker_run_failed" },
        { pattern: /error: corrupt patch at line|patch fragment without header/iu, ungradeableClass: "patch_corrupt" },
        { pattern: /patch does not apply|error: patch failed:/iu, ungradeableClass: "patch_does_not_apply" },
        { pattern: /Applied patch to .+ with conflicts|^U \S/mu, ungradeableClass: "patch_merge_conflict" },
        { pattern: /fatal: not a git repository \(or any of the parent directories\): \.git/iu, ungradeableClass: "workdir_not_git_repo" },
        { pattern: /: command not found/iu, ungradeableClass: "test_command_not_found" },
        { pattern: /Failed building editable|Failed to build installable wheels/iu, ungradeableClass: "install_build_failed" },
        { pattern: /No virtual environment found/iu, ungradeableClass: "venv_missing" },
        { pattern: /exec format error|the requested image's platform .* does not match/iu, ungradeableClass: "image_arch_mismatch" },
        { pattern: /Fatal Python error:\s*Illegal instruction|Illegal instruction(?:\s+\(core dumped\))?/iu, ungradeableClass: "image_arch_mismatch" },
        { pattern: /A virtual environment already exists at \S+\.venv\b/iu, ungradeableClass: "venv_collision" },
        { pattern: /No module named pytest\b/iu, ungradeableClass: "pytest_missing" },
        { pattern: /RequestsDependencyWarning/iu, ungradeableClass: "requests_dep_mismatch" },
        { pattern: /ImportError while loading conftest/iu, ungradeableClass: "conftest_import_error" },
      ]);

      export function classifyInfrastructureSignature(log: string): string | undefined {
        for (const { pattern, ungradeableClass } of INFRASTRUCTURE_SIGNATURES) {
          if (pattern.test(log)) return ungradeableClass;
        }
        return undefined;
      }

      function isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
      }

      function stringArray(value: unknown): readonly string[] {
        return Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : [];
      }

      function excerpt(text: string): string {
        return text.length <= 800 ? text : text.slice(-800);
      }

      export function parseSweRebenchReport(input: {
        readonly report: unknown;
        readonly log: string;
        readonly transitions: SweRebenchTransitions;
      }): SweRebenchOutcome {
        const { report, log, transitions } = input;
        if (!isObject(report)) {
          return {
            kind: "ungradeable",
            ungradeableClass: classifyInfrastructureSignature(log) ?? "eval_report_malformed",
            detail: "the evaluation report is not a report item object",
          };
        }
        const declaredError = typeof report["error"] === "string"
          ? report["error"].trim()
          : "";
        if (declaredError.length > 0) {
          return {
            kind: "ungradeable",
            ungradeableClass: "eval_setup_error",
            detail: excerpt(declaredError),
          };
        }
        if (typeof report["exit_code"] !== "number") {
          return {
            kind: "ungradeable",
            ungradeableClass: "eval_report_malformed",
            detail: "the evaluation report item carries no numeric exit_code",
          };
        }

        const containerExitCode = report["exit_code"];
        const satisfied = stringArray(report["from_fail_to_pass"]);
        const broken = stringArray(report["failed_from_pass_to_pass"]);
        const failToPassExpected = transitions.failToPass.length;
        const passToPassExpected = transitions.passToPass.length;

        // Ungradeable iff the container aborted, nothing declared was observed to pass, AND the
        // output matches a classified signature. A wrong-answer run shows an ordinary failing
        // report with no signature; a partially passing run is a real result. Both are verdicts.
        const nothingPassed = satisfied.length === 0 && broken.length >= passToPassExpected;
        if (containerExitCode !== 0 && nothingPassed) {
          const ungradeableClass = classifyInfrastructureSignature(log);
          if (ungradeableClass !== undefined) {
            return { kind: "ungradeable", ungradeableClass, detail: excerpt(log) };
          }
        }

        const failToPassSatisfied = satisfied.length;
        const passToPassBroken = broken.length;
        const failToPassOk = failToPassSatisfied === failToPassExpected;
        const passToPassOk = passToPassBroken === 0;

        return {
          kind: "graded",
          instanceId: typeof report["instance_id"] === "string" ? report["instance_id"] : "",
          passed: failToPassOk && passToPassOk,
          failToPassExpected,
          failToPassSatisfied,
          passToPassExpected,
          passToPassBroken,
          containerExitCode,
          checks: [
            {
              name: "transitions.fail-to-pass",
              status: failToPassOk ? "pass" : "fail",
              detail: `${failToPassSatisfied}/${failToPassExpected} declared fail-to-pass transitions now pass`,
            },
            {
              name: "transitions.pass-to-pass",
              status: passToPassOk ? "pass" : "fail",
              detail: `${passToPassBroken}/${passToPassExpected} declared pass-to-pass transitions broke`,
            },
          ],
        };
      }
      ```

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/swe-rebench/parse.test.ts`
      Expected: 18 parametrized cases plus 5 named tests passing, 0 failing.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "feat(task-execution): parse swe-rebench evaluation reports at the adapter edge"
      ```

---

## Task 5 — the swe-rebench `EvaluatorAdapter`

**Files**

- `packages/task-execution/evaluator-adapters/src/swe-rebench/adapter.ts` (new)
- `packages/task-execution/evaluator-adapters/src/swe-rebench/adapter.test.ts` (new)
- `packages/task-execution/evaluator-adapters/src/index.ts` (edit)

**Interfaces**

- Consumes: `EvaluatorAdapter`, `CompletedEvaluation`, `ExactEvaluationMaterial`,
  `EvaluationContext`, `EvaluationOperationalError` from
  `@jinn-network/task-execution-evaluation-harness`; `EvaluationSpec`,
  `DeterministicProcessBlock` from `@jinn-network/task-execution-profiles`;
  `AttemptIdentity` from `@jinn-network/task-execution-supervisor`;
  `parseSweRebenchReport`, `SweRebenchOutcome` from `./parse.js`.
- Produces:
  ```ts
  export interface GraderReportRequest {
    readonly specification: EvaluationSpec;
    readonly task: ExactEvaluationMaterial;
    readonly results: readonly ExactEvaluationMaterial[];
    readonly context: EvaluationContext;
    readonly attempt: AttemptIdentity;
    readonly deadlineSignal: AbortSignal;
  }
  export interface RawGraderReport {
    readonly report: unknown;
    readonly log: string;
  }
  export interface GraderReportSource {
    read(request: GraderReportRequest): Promise<RawGraderReport>;
  }
  export function contextGraderReportSource(): GraderReportSource;
  export interface SweRebenchAdapterOptions {
    readonly graderReportSource: GraderReportSource;
    readonly now?: () => Date;
    readonly maxTestLogBytes?: number;
  }
  export function createSweRebenchEvaluatorAdapter(
    options: SweRebenchAdapterOptions,
  ): EvaluatorAdapter;
  export const SWE_REBENCH_MEASUREMENT_PASSED = "passed";
  ```

### Steps

- [ ] **Failing test.** Create `src/swe-rebench/adapter.test.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import {
        EvaluationOperationalError,
        type ExactEvaluationMaterial,
      } from "@jinn-network/task-execution-evaluation-harness";
      import {
        EVALUATION_SPEC_FORMAT_URI,
        EVAL_SEMANTICS_VERSION,
        type EvaluationSpec,
      } from "@jinn-network/task-execution-profiles";
      import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
      import { describe, expect, test } from "vitest";
      import { SWE_REBENCH_FIXTURES } from "./fixtures.js";
      import { SWE_REBENCH_PARSER } from "../parser-identity.js";
      import {
        contextGraderReportSource,
        createSweRebenchEvaluatorAdapter,
        type GraderReportSource,
        type RawGraderReport,
      } from "./adapter.js";

      const encoder = new TextEncoder();

      const ATTEMPT: AttemptIdentity = {
        attemptUri: "urn:uuid:22222222-2222-4222-8222-222222222222" as AttemptIdentity["attemptUri"],
        nonce: "evaluation-nonce",
        attemptNumber: 1,
      };

      function material(name: string, text: string): ExactEvaluationMaterial {
        return {
          descriptor: { name, digest: { sha256: "1".repeat(64) } },
          bytes: encoder.encode(text),
        };
      }

      function specification(transitions: {
        failToPass: readonly string[];
        passToPass: readonly string[];
      }): EvaluationSpec {
        return {
          protocol: EVALUATION_SPEC_FORMAT_URI,
          semanticsVersion: EVAL_SEMANTICS_VERSION,
          family: "deterministic-process",
          grader: {
            name: SWE_REBENCH_PARSER.id,
            digest: { sha256: SWE_REBENCH_PARSER.digest.slice("sha256:".length) },
            accessClass: "public",
          },
          familyBlock: {
            image: { name: "grader-image", digest: { sha256: "2".repeat(64) } },
            platform: "linux/amd64",
            workspace: {},
            testMaterial: [],
            parser: SWE_REBENCH_PARSER,
            transitions: {
              failToPass: [...transitions.failToPass],
              passToPass: [...transitions.passToPass],
            },
            timeout: 1800,
          },
          measurements: [{ name: "passed", type: "boolean", required: true }],
          verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
          unscorable: [{
            name: "environment-setup-failure",
            disposition: "retryable-infrastructure",
          }],
          evidenceConventions: { requiredRefs: [] },
        } as EvaluationSpec;
      }

      function source(raw: RawGraderReport): GraderReportSource {
        return { async read() { return raw; } };
      }

      describe("createSweRebenchEvaluatorAdapter", () => {
        test.each(SWE_REBENCH_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
          "%s maps to the harness verdict shape",
          async (_name, fixture) => {
            const adapter = createSweRebenchEvaluatorAdapter({
              graderReportSource: source({ report: fixture.report, log: fixture.log }),
              now: () => new Date("2026-07-30T09:00:00.000Z"),
            });
            const evaluate = adapter.evaluate(
              material("subject-task.json", "{}"),
              [material("result.patch", "diff --git a/a b/a\n")],
              specification(fixture.transitions),
              {},
              ATTEMPT,
              new AbortController().signal,
            );

            if (fixture.expect.kind === "ungradeable") {
              const error = await evaluate.catch((cause: unknown) => cause);
              expect(error).toBeInstanceOf(EvaluationOperationalError);
              const operational = error as EvaluationOperationalError;
              expect(operational.reason).toBe("provider-unavailable");
              expect(operational.recoveryAdvice).toBe("new-attempt-required");
              expect(operational.safeDetail).toContain(fixture.expect.ungradeableClass);
              return;
            }

            const completed = await evaluate;
            expect(completed.verdict).toBe(fixture.expect.passed ? "pass" : "fail");
            expect(completed.evaluatedAt).toBe("2026-07-30T09:00:00.000Z");
            expect(completed.measurements).toEqual([
              { name: "passed", value: fixture.expect.passed },
            ]);
          },
        );

        test("the detailed outcome carries per-check results and the transition counts", async () => {
          const fixture = SWE_REBENCH_FIXTURES.find(
            (entry) => entry.name === "unresolved-pass-to-pass-broken",
          )!;
          const adapter = createSweRebenchEvaluatorAdapter({
            graderReportSource: source({ report: fixture.report, log: fixture.log }),
          });
          const completed = await adapter.evaluate(
            material("subject-task.json", "{}"),
            [material("result.patch", "diff --git a/a b/a\n")],
            specification(fixture.transitions),
            {},
            ATTEMPT,
            new AbortController().signal,
          );
          expect(completed.detailedOutcome).toMatchObject({
            checks: [
              { name: "transitions.fail-to-pass", status: "pass" },
              { name: "transitions.pass-to-pass", status: "fail" },
            ],
            passToPassBroken: 1,
            containerExitCode: 1,
          });
        });

        test("the capped test log rides as claim evidence", async () => {
          const fixture = SWE_REBENCH_FIXTURES[0]!;
          const adapter = createSweRebenchEvaluatorAdapter({
            graderReportSource: source({ report: fixture.report, log: fixture.log }),
          });
          const completed = await adapter.evaluate(
            material("subject-task.json", "{}"),
            [material("result.patch", "diff --git a/a b/a\n")],
            specification(fixture.transitions),
            {},
            ATTEMPT,
            new AbortController().signal,
          );
          expect(completed.claimEvidence).toHaveLength(1);
          const evidence = completed.claimEvidence![0]!;
          expect(evidence.kind).toBe("content");
          if (evidence.kind !== "content") return;
          expect(evidence.name).toBe("test-log.txt");
          expect(evidence.mediaType).toBe("text/plain; charset=utf-8");
        });

        test("an oversize log is tail-capped, never dropped", async () => {
          const adapter = createSweRebenchEvaluatorAdapter({
            graderReportSource: source({
              report: SWE_REBENCH_FIXTURES[0]!.report,
              log: `${"x".repeat(4096)}TAIL`,
            }),
            maxTestLogBytes: 64,
          });
          const completed = await adapter.evaluate(
            material("subject-task.json", "{}"),
            [material("result.patch", "diff --git a/a b/a\n")],
            specification(SWE_REBENCH_FIXTURES[0]!.transitions),
            {},
            ATTEMPT,
            new AbortController().signal,
          );
          const evidence = completed.claimEvidence![0]!;
          if (evidence.kind !== "content") throw new Error("expected content evidence");
          expect(evidence.bytes.byteLength).toBeLessThanOrEqual(64);
          expect(new TextDecoder().decode(evidence.bytes)).toContain("TAIL");
        });

        test("a non-deterministic-process specification is refused", async () => {
          const adapter = createSweRebenchEvaluatorAdapter({
            graderReportSource: source({ report: {}, log: "" }),
          });
          const modelGraded = {
            ...specification({ failToPass: [], passToPass: [] }),
            family: "model-graded",
          } as unknown as EvaluationSpec;
          const error = await adapter.evaluate(
            material("subject-task.json", "{}"),
            [material("result.patch", "")],
            modelGraded,
            {},
            ATTEMPT,
            new AbortController().signal,
          ).catch((cause: unknown) => cause);
          expect(error).toBeInstanceOf(EvaluationOperationalError);
          expect((error as EvaluationOperationalError).reason)
            .toBe("unsupported-specification");
        });

        test("an already-aborted deadline yields the cancellation path, not a verdict", async () => {
          const controller = new AbortController();
          controller.abort();
          const adapter = createSweRebenchEvaluatorAdapter({
            graderReportSource: source({
              report: SWE_REBENCH_FIXTURES[0]!.report,
              log: SWE_REBENCH_FIXTURES[0]!.log,
            }),
          });
          const error = await adapter.evaluate(
            material("subject-task.json", "{}"),
            [material("result.patch", "")],
            specification(SWE_REBENCH_FIXTURES[0]!.transitions),
            {},
            ATTEMPT,
            controller.signal,
          ).catch((cause: unknown) => cause);
          expect(error).toBeInstanceOf(EvaluationOperationalError);
          expect((error as EvaluationOperationalError).canonicalCode).toBe("CANCELLED");
        });
      });

      describe("contextGraderReportSource", () => {
        test("reads the grader report from the harness-supplied evaluation context", async () => {
          const raw = await contextGraderReportSource().read({
            specification: specification({ failToPass: [], passToPass: [] }),
            task: material("subject-task.json", "{}"),
            results: [],
            context: {
              graderReport: { instance_id: "acme__widget-1", exit_code: 0, error: "" },
              graderLog: "PASSED",
            },
            attempt: ATTEMPT,
            deadlineSignal: new AbortController().signal,
          });
          expect(raw).toEqual({
            report: { instance_id: "acme__widget-1", exit_code: 0, error: "" },
            log: "PASSED",
          });
        });

        test("a context without a grader report is an operational failure, not a fail verdict", async () => {
          const error = await contextGraderReportSource().read({
            specification: specification({ failToPass: [], passToPass: [] }),
            task: material("subject-task.json", "{}"),
            results: [],
            context: {},
            attempt: ATTEMPT,
            deadlineSignal: new AbortController().signal,
          }).catch((cause: unknown) => cause);
          expect(error).toBeInstanceOf(EvaluationOperationalError);
          expect((error as EvaluationOperationalError).reason).toBe("provider-unavailable");
        });
      });
      ```

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/swe-rebench/adapter.test.ts`
      Expected failure: `Failed to resolve import "./adapter.js"`.

- [ ] **Minimal implementation.** Create `src/swe-rebench/adapter.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import {
        EvaluationOperationalError,
        type CompletedEvaluation,
        type EvaluationContext,
        type EvaluatorAdapter,
        type ExactEvaluationMaterial,
      } from "@jinn-network/task-execution-evaluation-harness";
      import type {
        DeterministicProcessBlock,
        EvaluationSpec,
      } from "@jinn-network/task-execution-profiles";
      import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
      import { parseSweRebenchReport } from "./parse.js";

      /** The one measurement the canonical swe-rebench EvaluationSpec declares (Finding D). */
      export const SWE_REBENCH_MEASUREMENT_PASSED = "passed";

      /** Legacy tail cap: the pytest summary and last failures live at the end of the log. */
      const DEFAULT_MAX_TEST_LOG_BYTES = 1024 * 1024;

      const encoder = new TextEncoder();

      export interface GraderReportRequest {
        readonly specification: EvaluationSpec;
        readonly task: ExactEvaluationMaterial;
        readonly results: readonly ExactEvaluationMaterial[];
        readonly context: EvaluationContext;
        readonly attempt: AttemptIdentity;
        readonly deadlineSignal: AbortSignal;
      }

      export interface RawGraderReport {
        readonly report: unknown;
        readonly log: string;
      }

      /**
       * The method-specific execution provider the adapter is constructed with (evaluation-runner
       * design §5.4/§11). This package ships only the hermetic context-backed implementation;
       * a container-executing source is host or separately-chartered work (Finding A).
       */
      export interface GraderReportSource {
        read(request: GraderReportRequest): Promise<RawGraderReport>;
      }

      function unavailable(detail: string, cause?: unknown): never {
        throw new EvaluationOperationalError({
          canonicalCode: "UNAVAILABLE",
          reason: "provider-unavailable",
          recoveryAdvice: "new-attempt-required",
          safeDetail: detail,
          cause,
        });
      }

      /** Reads an already-produced grader report from the harness-supplied evaluation context. */
      export function contextGraderReportSource(): GraderReportSource {
        return {
          async read({ context }) {
            const report = context["graderReport"];
            if (report === undefined) {
              unavailable(
                "the evaluation context carries no graderReport for the swe-rebench parser",
              );
            }
            const log = context["graderLog"];
            if (log !== undefined && typeof log !== "string") {
              unavailable("the evaluation context graderLog is not text");
            }
            return { report, log: typeof log === "string" ? log : "" };
          },
        };
      }

      export interface SweRebenchAdapterOptions {
        readonly graderReportSource: GraderReportSource;
        readonly now?: () => Date;
        readonly maxTestLogBytes?: number;
      }

      function tailCap(log: string, maxBytes: number): Uint8Array {
        const bytes = encoder.encode(log);
        if (bytes.byteLength <= maxBytes) return bytes;
        return bytes.slice(bytes.byteLength - maxBytes);
      }

      export function createSweRebenchEvaluatorAdapter(
        options: SweRebenchAdapterOptions,
      ): EvaluatorAdapter {
        const now = options.now ?? (() => new Date());
        const maxTestLogBytes = options.maxTestLogBytes ?? DEFAULT_MAX_TEST_LOG_BYTES;

        return {
          async evaluate(
            task,
            results,
            specification,
            context,
            attempt,
            deadlineSignal,
          ): Promise<CompletedEvaluation> {
            if (deadlineSignal.aborted) {
              throw new EvaluationOperationalError({
                canonicalCode: "CANCELLED",
                reason: "provider-unavailable",
                recoveryAdvice: "resume-attempt",
                safeDetail: "the evaluation deadline elapsed before grading began",
              });
            }
            if (specification.family !== "deterministic-process") {
              throw new EvaluationOperationalError({
                canonicalCode: "FAILED_PRECONDITION",
                reason: "unsupported-specification",
                recoveryAdvice: "do-not-retry",
                safeDetail:
                  "the swe-rebench evaluator serves deterministic-process specifications only",
              });
            }
            const block = specification.familyBlock as DeterministicProcessBlock;
            const raw = await options.graderReportSource.read({
              specification,
              task,
              results,
              context,
              attempt,
              deadlineSignal,
            });
            const outcome = parseSweRebenchReport({
              report: raw.report,
              log: raw.log,
              transitions: {
                failToPass: block.transitions.failToPass,
                passToPass: block.transitions.passToPass,
              },
            });

            if (outcome.kind === "ungradeable") {
              // Never a failing verdict: nothing was learned about the solution.
              throw new EvaluationOperationalError({
                canonicalCode: "UNAVAILABLE",
                reason: "provider-unavailable",
                recoveryAdvice: "new-attempt-required",
                safeDetail:
                  `the swe-rebench evaluation could not grade the solution (${outcome.ungradeableClass})`,
                cause: undefined,
              });
            }

            return {
              detailedOutcome: {
                instanceId: outcome.instanceId,
                checks: outcome.checks,
                failToPassExpected: outcome.failToPassExpected,
                failToPassSatisfied: outcome.failToPassSatisfied,
                passToPassExpected: outcome.passToPassExpected,
                passToPassBroken: outcome.passToPassBroken,
                containerExitCode: outcome.containerExitCode,
              },
              verdict: outcome.passed ? "pass" : "fail",
              evaluatedAt: now().toISOString(),
              measurements: [
                { name: SWE_REBENCH_MEASUREMENT_PASSED, value: outcome.passed },
              ],
              explanation: outcome.passed
                ? "Every declared fail-to-pass transition now passes and no declared pass-to-pass transition broke."
                : "At least one declared transition did not hold.",
              claimEvidence: [{
                kind: "content",
                name: "test-log.txt",
                bytes: tailCap(raw.log, maxTestLogBytes),
                mediaType: "text/plain; charset=utf-8",
              }],
            };
          },
        };
      }
      ```

      Extend `src/index.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      export * from "./parser-identity.js";
      export * from "./swe-rebench/parse.js";
      export * from "./swe-rebench/adapter.js";
      ```

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/swe-rebench && yarn typecheck`
      Expected: all swe-rebench suites passing; `tsc --noEmit` prints nothing.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "feat(task-execution): add the swe-rebench evaluator adapter"
      ```

---

## Task 6 — prediction fixtures

**Files**

- `packages/task-execution/evaluator-adapters/fixtures/prediction/README.md` (new)
- `packages/task-execution/evaluator-adapters/src/prediction/fixtures.ts` (new)
- `packages/task-execution/evaluator-adapters/src/prediction/fixtures.test.ts` (new)

**Interfaces**

- Produces:
  ```ts
  export interface PredictionResolutionSnapshot {
    readonly status: "resolved" | "unresolved" | "unavailable";
    readonly outcome?: "YES" | "NO";
    readonly resolvedAt?: string;
    readonly marketId: string;
    readonly conditionId: string;
    readonly sourceUrl: string;
  }
  export interface PredictionFixture {
    readonly name: string;
    readonly provenance: string;
    readonly resultBytes: Uint8Array;
    readonly snapshot: unknown;
    readonly market: { readonly marketId: string; readonly conditionId: string };
    readonly window: { readonly startTs: number; readonly endTs: number };
    readonly consensusProbabilityYes: string;
    readonly expect: {
      readonly verdict: "pass" | "fail" | "inconclusive";
      readonly integrity: boolean;
      readonly resolved: boolean;
      readonly solverBrier?: string;
      readonly consensusBrier?: string;
      readonly brierSpread?: string;
    };
  }
  export const PREDICTION_FIXTURES: readonly PredictionFixture[];
  ```

### Steps

- [ ] **Failing test.** Create `src/prediction/fixtures.test.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import { describe, expect, test } from "vitest";
      import { PREDICTION_FIXTURES } from "./fixtures.js";

      describe("prediction fixtures", () => {
        test("every fixture names its legacy provenance", () => {
          expect(PREDICTION_FIXTURES.length).toBeGreaterThanOrEqual(9);
          for (const fixture of PREDICTION_FIXTURES) {
            expect(fixture.provenance).toMatch(/^client\/(src|test)\/.+:\d+/u);
          }
        });

        test("all three protocol verdicts are represented", () => {
          const verdicts = new Set(PREDICTION_FIXTURES.map((f) => f.expect.verdict));
          expect(verdicts).toEqual(new Set(["pass", "fail", "inconclusive"]));
        });

        test("scored fixtures carry six-fraction-digit decimal strings, never JSON numbers", () => {
          for (const fixture of PREDICTION_FIXTURES) {
            for (const value of [
              fixture.expect.solverBrier,
              fixture.expect.consensusBrier,
              fixture.expect.brierSpread,
            ]) {
              if (value === undefined) continue;
              expect(typeof value).toBe("string");
              expect(value).toMatch(/^-?\d+\.\d{6}$/u);
            }
          }
        });
      });
      ```

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/prediction/fixtures.test.ts`
      Expected failure: `Failed to resolve import "./fixtures.js"`.

- [ ] **Minimal implementation.** Create `src/prediction/fixtures.ts`. Provenance for the
      cases below, from
      `client/src/harnesses/impls/prediction-v1-evaluator/index.ts:88-146` (checks and verdict
      derivation), `:223-229` (`deriveVerdict`), `:231-250` (`checkResolutionIdentity`),
      `:252-273` (`scoreBrier`), and
      `client/src/harnesses/impls/prediction-v0-evaluator/score.ts:8-22` (a non-PASS verdict
      never carries a score).

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      /**
       * Behavioral oracles for the prediction scorer. Composition design §6.6: legacy behavior
       * enters as fixtures, never as ported code.
       */

      const encoder = new TextEncoder();

      export interface PredictionResolutionSnapshot {
        readonly status: "resolved" | "unresolved" | "unavailable";
        readonly outcome?: "YES" | "NO";
        readonly resolvedAt?: string;
        readonly marketId: string;
        readonly conditionId: string;
        readonly sourceUrl: string;
      }

      export interface PredictionFixture {
        readonly name: string;
        readonly provenance: string;
        readonly resultBytes: Uint8Array;
        readonly snapshot: unknown;
        readonly market: { readonly marketId: string; readonly conditionId: string };
        readonly window: { readonly startTs: number; readonly endTs: number };
        readonly consensusProbabilityYes: string;
        readonly expect: {
          readonly verdict: "pass" | "fail" | "inconclusive";
          readonly integrity: boolean;
          readonly resolved: boolean;
          readonly solverBrier?: string;
          readonly consensusBrier?: string;
          readonly brierSpread?: string;
        };
      }

      const MARKET = { marketId: "0x5150", conditionId: "0xABCDEF" } as const;
      const WINDOW = { startTs: 1_780_000_000_000, endTs: 1_780_086_400_000 } as const;

      function result(payload: Record<string, unknown>): Uint8Array {
        return encoder.encode(JSON.stringify(payload));
      }

      function resolved(outcome: "YES" | "NO"): PredictionResolutionSnapshot {
        return {
          status: "resolved",
          outcome,
          resolvedAt: "2026-06-02T00:00:00.000Z",
          marketId: MARKET.marketId,
          conditionId: MARKET.conditionId,
          sourceUrl: "https://example.invalid/markets/0x5150",
        };
      }

      export const PREDICTION_FIXTURES: readonly PredictionFixture[] = Object.freeze([
        {
          name: "scored-yes-solver-beats-consensus",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:252-273",
          resultBytes: result({
            probabilityYes: "0.900000",
            submittedAt: "2026-06-01T00:00:00.000Z",
            modelId: "model-a",
          }),
          snapshot: resolved("YES"),
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.600000",
          expect: {
            verdict: "pass",
            integrity: true,
            resolved: true,
            solverBrier: "0.010000",
            consensusBrier: "0.160000",
            brierSpread: "-0.150000",
          },
        },
        {
          name: "scored-no-solver-worse-than-consensus",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:252-273",
          resultBytes: result({
            probabilityYes: "0.800000",
            submittedAt: "2026-06-01T00:00:00.000Z",
            modelId: "model-a",
          }),
          snapshot: resolved("NO"),
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.300000",
          expect: {
            verdict: "pass",
            integrity: true,
            resolved: true,
            solverBrier: "0.640000",
            consensusBrier: "0.090000",
            brierSpread: "0.550000",
          },
        },
        {
          name: "inconclusive-market-unresolved",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:136-141",
          resultBytes: result({
            probabilityYes: "0.500000",
            submittedAt: "2026-06-01T00:00:00.000Z",
            modelId: "model-a",
          }),
          snapshot: {
            status: "unresolved",
            marketId: MARKET.marketId,
            conditionId: MARKET.conditionId,
            sourceUrl: "https://example.invalid/markets/0x5150",
          },
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.500000",
          expect: { verdict: "inconclusive", integrity: true, resolved: false },
        },
        {
          name: "rejected-submission-outside-window",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:120-131",
          resultBytes: result({
            probabilityYes: "0.900000",
            submittedAt: "2026-05-01T00:00:00.000Z",
            modelId: "model-a",
          }),
          snapshot: resolved("YES"),
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.600000",
          expect: { verdict: "fail", integrity: false, resolved: true },
        },
        {
          name: "rejected-market-identity-mismatch",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:231-250",
          resultBytes: result({
            probabilityYes: "0.900000",
            submittedAt: "2026-06-01T00:00:00.000Z",
            modelId: "model-a",
          }),
          snapshot: { ...resolved("YES"), marketId: "0x0000" },
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.600000",
          expect: { verdict: "fail", integrity: false, resolved: true },
        },
        {
          name: "market-identity-condition-id-is-case-insensitive",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:236",
          resultBytes: result({
            probabilityYes: "1.000000",
            submittedAt: "2026-06-01T00:00:00.000Z",
            modelId: "model-a",
          }),
          snapshot: { ...resolved("YES"), conditionId: "0xabcdef" },
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.500000",
          expect: {
            verdict: "pass",
            integrity: true,
            resolved: true,
            solverBrier: "0.000000",
            consensusBrier: "0.250000",
            brierSpread: "-0.250000",
          },
        },
        {
          name: "adversarial-result-is-not-json",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:112-118",
          resultBytes: encoder.encode("{ this is not json"),
          snapshot: resolved("YES"),
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.600000",
          expect: { verdict: "fail", integrity: false, resolved: true },
        },
        {
          name: "adversarial-result-is-not-utf8",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:112-118",
          resultBytes: Uint8Array.from([0xff, 0xfe, 0xfd, 0x00]),
          snapshot: resolved("YES"),
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.600000",
          expect: { verdict: "fail", integrity: false, resolved: true },
        },
        {
          name: "adversarial-result-is-empty",
          provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:112-118",
          resultBytes: new Uint8Array(0),
          snapshot: resolved("YES"),
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.600000",
          expect: { verdict: "fail", integrity: false, resolved: true },
        },
        {
          name: "adversarial-probability-out-of-range",
          provenance: "client/src/harnesses/impls/prediction-v0-evaluator/score.ts:8-22",
          resultBytes: result({
            probabilityYes: "1.500000",
            submittedAt: "2026-06-01T00:00:00.000Z",
            modelId: "model-a",
          }),
          snapshot: resolved("YES"),
          market: MARKET,
          window: WINDOW,
          consensusProbabilityYes: "0.600000",
          expect: { verdict: "fail", integrity: false, resolved: true },
        },
      ]);
      ```

      Write `fixtures/prediction/README.md` naming the four checks, the verdict derivation, the
      Brier basis, and the decimal-string encoding rule, with the same citations.

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/prediction/fixtures.test.ts`
      Expected: 3 passing tests over 10 fixtures.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "test(task-execution): land prediction evaluator fixtures from the legacy oracles"
      ```

---

## Task 7 — the prediction ingestion parser (pure)

**Files**

- `packages/task-execution/evaluator-adapters/src/prediction/parse.ts` (new)
- `packages/task-execution/evaluator-adapters/src/prediction/parse.test.ts` (new)

**Interfaces**

- Consumes: `PREDICTION_FIXTURES`, `PredictionResolutionSnapshot` from `./fixtures.js`.
- Produces:
  ```ts
  export interface PredictionCheck {
    readonly name: "result.schema" | "result.window" | "market.identity" | "market.resolution";
    readonly status: "pass" | "fail" | "indeterminate";
    readonly detail?: string;
  }
  export interface PredictionScores {
    readonly scoreBasis: "brier-loss.v1";
    readonly solverBrier: string;
    readonly consensusBrier: string;
    readonly brierSpread: string;
  }
  export interface PredictionOutcome {
    readonly verdict: "pass" | "fail" | "inconclusive";
    readonly integrity: boolean;
    readonly resolved: boolean;
    readonly outcomeYes?: boolean;
    readonly scores?: PredictionScores;
    readonly checks: readonly PredictionCheck[];
  }
  export interface PredictionParseInput {
    readonly resultBytes: Uint8Array;
    readonly snapshot: unknown;
    readonly market: { readonly marketId: string; readonly conditionId: string };
    readonly window: { readonly startTs: number; readonly endTs: number };
    readonly consensusProbabilityYes: string;
  }
  export function parsePredictionResult(input: PredictionParseInput): PredictionOutcome;
  export function brierLoss(probability: string, target: 0 | 1): string;
  ```

### Steps

- [ ] **Failing test.** Create `src/prediction/parse.test.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import { describe, expect, test } from "vitest";
      import { PREDICTION_FIXTURES } from "./fixtures.js";
      import { brierLoss, parsePredictionResult } from "./parse.js";

      describe("parsePredictionResult", () => {
        test.each(PREDICTION_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
          "%s reproduces the legacy outcome",
          (_name, fixture) => {
            const outcome = parsePredictionResult({
              resultBytes: fixture.resultBytes,
              snapshot: fixture.snapshot,
              market: fixture.market,
              window: fixture.window,
              consensusProbabilityYes: fixture.consensusProbabilityYes,
            });
            expect(outcome.verdict).toBe(fixture.expect.verdict);
            expect(outcome.integrity).toBe(fixture.expect.integrity);
            expect(outcome.resolved).toBe(fixture.expect.resolved);
            if (fixture.expect.solverBrier === undefined) {
              expect(outcome.scores).toBeUndefined();
            } else {
              expect(outcome.scores).toEqual({
                scoreBasis: "brier-loss.v1",
                solverBrier: fixture.expect.solverBrier,
                consensusBrier: fixture.expect.consensusBrier,
                brierSpread: fixture.expect.brierSpread,
              });
            }
          },
        );

        test("every outcome reports all four checks", () => {
          for (const fixture of PREDICTION_FIXTURES) {
            const outcome = parsePredictionResult({
              resultBytes: fixture.resultBytes,
              snapshot: fixture.snapshot,
              market: fixture.market,
              window: fixture.window,
              consensusProbabilityYes: fixture.consensusProbabilityYes,
            });
            expect(outcome.checks.map((check) => check.name)).toEqual([
              "result.schema",
              "result.window",
              "market.identity",
              "market.resolution",
            ]);
          }
        });

        test("a failed integrity check is never laundered into inconclusive", () => {
          const outcome = parsePredictionResult({
            resultBytes: new Uint8Array(0),
            snapshot: {
              status: "unresolved",
              marketId: "0x5150",
              conditionId: "0xABCDEF",
              sourceUrl: "https://example.invalid/markets/0x5150",
            },
            market: { marketId: "0x5150", conditionId: "0xABCDEF" },
            window: { startTs: 0, endTs: 1 },
            consensusProbabilityYes: "0.500000",
          });
          expect(outcome.verdict).toBe("fail");
        });

        test("an unrecognizable resolution snapshot fails, never scores", () => {
          const outcome = parsePredictionResult({
            resultBytes: new TextEncoder().encode(JSON.stringify({
              probabilityYes: "0.500000",
              submittedAt: "2026-06-01T00:00:00.000Z",
              modelId: "model-a",
            })),
            snapshot: "not a snapshot",
            market: { marketId: "0x5150", conditionId: "0xABCDEF" },
            window: { startTs: 0, endTs: 4_102_444_800_000 },
            consensusProbabilityYes: "0.500000",
          });
          expect(outcome.verdict).toBe("fail");
          expect(outcome.scores).toBeUndefined();
        });
      });

      describe("brierLoss", () => {
        test("is exact at the endpoints", () => {
          expect(brierLoss("1", 1)).toBe("0.000000");
          expect(brierLoss("0", 1)).toBe("1.000000");
        });

        test("rounds to six fraction digits as a decimal string", () => {
          expect(brierLoss("0.5", 1)).toBe("0.250000");
          expect(brierLoss("0.333333", 0)).toBe("0.111111");
        });
      });
      ```

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/prediction/parse.test.ts`
      Expected failure: `Failed to resolve import "./parse.js"`.

- [ ] **Minimal implementation.** Create `src/prediction/parse.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      /**
       * Ingestion parser for a prediction Result plus its resolution snapshot. Pure: no network, no
       * clock. The commitment it implements is `fixtures/parsers/prediction-market.parser.json`,
       * whose digest is this parser's identity.
       */

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const DECIMAL = /^-?\d+(\.\d+)?$/u;
      const FRACTION_DIGITS = 6;

      export interface PredictionCheck {
        readonly name:
          | "result.schema"
          | "result.window"
          | "market.identity"
          | "market.resolution";
        readonly status: "pass" | "fail" | "indeterminate";
        readonly detail?: string;
      }

      export interface PredictionScores {
        readonly scoreBasis: "brier-loss.v1";
        readonly solverBrier: string;
        readonly consensusBrier: string;
        readonly brierSpread: string;
      }

      export interface PredictionOutcome {
        readonly verdict: "pass" | "fail" | "inconclusive";
        readonly integrity: boolean;
        readonly resolved: boolean;
        readonly outcomeYes?: boolean;
        readonly scores?: PredictionScores;
        readonly checks: readonly PredictionCheck[];
      }

      export interface PredictionParseInput {
        readonly resultBytes: Uint8Array;
        readonly snapshot: unknown;
        readonly market: { readonly marketId: string; readonly conditionId: string };
        readonly window: { readonly startTs: number; readonly endTs: number };
        readonly consensusProbabilityYes: string;
      }

      /**
       * Squared error as a fixed six-fraction-digit decimal string. Sealed bytes admit only I-JSON
       * integers, so every fractional quantity leaves this parser as a decimal string.
       */
      export function brierLoss(probability: string, target: 0 | 1): string {
        const difference = Number(probability) - target;
        return (difference * difference).toFixed(FRACTION_DIGITS);
      }

      function subtract(left: string, right: string): string {
        return (Number(left) - Number(right)).toFixed(FRACTION_DIGITS);
      }

      function isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
      }

      interface PredictionResult {
        readonly probabilityYes: string;
        readonly submittedAt: string;
      }

      function readResult(bytes: Uint8Array): PredictionResult | undefined {
        let text: string;
        try {
          text = decoder.decode(bytes);
        } catch {
          return undefined;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return undefined;
        }
        if (!isObject(parsed)) return undefined;
        const probabilityYes = parsed["probabilityYes"];
        const submittedAt = parsed["submittedAt"];
        if (typeof probabilityYes !== "string" || !DECIMAL.test(probabilityYes)) return undefined;
        const probability = Number(probabilityYes);
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) return undefined;
        if (typeof submittedAt !== "string" || !Number.isFinite(Date.parse(submittedAt))) {
          return undefined;
        }
        return { probabilityYes, submittedAt };
      }

      interface Snapshot {
        readonly status: "resolved" | "unresolved" | "unavailable";
        readonly outcome?: "YES" | "NO";
        readonly marketId: string;
        readonly conditionId: string;
      }

      function readSnapshot(value: unknown): Snapshot | undefined {
        if (!isObject(value)) return undefined;
        const status = value["status"];
        if (status !== "resolved" && status !== "unresolved" && status !== "unavailable") {
          return undefined;
        }
        const marketId = value["marketId"];
        const conditionId = value["conditionId"];
        if (typeof marketId !== "string" || typeof conditionId !== "string") return undefined;
        const outcome = value["outcome"];
        return {
          status,
          ...(outcome === "YES" || outcome === "NO" ? { outcome } : {}),
          marketId,
          conditionId,
        };
      }

      /** Lowercase via a code-unit map — never `toLocaleLowerCase`, which consults host ICU data. */
      function asciiLower(value: string): string {
        let out = "";
        for (const character of value) {
          const code = character.charCodeAt(0);
          out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
        }
        return out;
      }

      export function parsePredictionResult(
        input: PredictionParseInput,
      ): PredictionOutcome {
        const result = readResult(input.resultBytes);
        const snapshot = readSnapshot(input.snapshot);

        const schemaCheck: PredictionCheck = result === undefined
          ? {
            name: "result.schema",
            status: "fail",
            detail: "the Result is not a decodable prediction document in range",
          }
          : { name: "result.schema", status: "pass" };

        const submittedAt = result === undefined ? Number.NaN : Date.parse(result.submittedAt);
        const inWindow = Number.isFinite(submittedAt)
          && submittedAt >= input.window.startTs
          && submittedAt <= input.window.endTs;
        const windowCheck: PredictionCheck = result === undefined
          ? { name: "result.window", status: "fail", detail: "no decodable submission time" }
          : inWindow
          ? { name: "result.window", status: "pass" }
          : {
            name: "result.window",
            status: "fail",
            detail: "the submission time is outside the declared window",
          };

        const identityMatches = snapshot !== undefined
          && snapshot.marketId === input.market.marketId
          && asciiLower(snapshot.conditionId) === asciiLower(input.market.conditionId);
        const identityCheck: PredictionCheck = identityMatches
          ? { name: "market.identity", status: "pass" }
          : {
            name: "market.identity",
            status: "fail",
            detail: "the resolution snapshot does not identify the declared market",
          };

        const resolutionCheck: PredictionCheck = snapshot === undefined
          ? {
            name: "market.resolution",
            status: "fail",
            detail: "the resolution snapshot is unreadable",
          }
          : snapshot.status === "resolved" && snapshot.outcome !== undefined
          ? { name: "market.resolution", status: "pass" }
          : snapshot.status === "unresolved"
          ? { name: "market.resolution", status: "indeterminate" }
          : {
            name: "market.resolution",
            status: "fail",
            detail: `the venue reported ${snapshot.status}`,
          };

        const checks: readonly PredictionCheck[] = [
          schemaCheck,
          windowCheck,
          identityCheck,
          resolutionCheck,
        ];

        // Integrity is every check EXCEPT resolution: an unresolved market says nothing about the
        // solution, so it must not be laundered into a failing verdict — and a broken integrity
        // check must not be laundered into `inconclusive`.
        const integrity = checks
          .filter((check) => check.name !== "market.resolution")
          .every((check) => check.status === "pass");
        const resolved = resolutionCheck.status === "pass";

        if (!integrity || resolutionCheck.status === "fail") {
          return { verdict: "fail", integrity, resolved, checks };
        }
        if (!resolved) {
          return { verdict: "inconclusive", integrity, resolved, checks };
        }

        const outcomeYes = snapshot!.outcome === "YES";
        const target: 0 | 1 = outcomeYes ? 1 : 0;
        const solverBrier = brierLoss(result!.probabilityYes, target);
        const consensusBrier = brierLoss(input.consensusProbabilityYes, target);
        return {
          verdict: "pass",
          integrity,
          resolved,
          outcomeYes,
          scores: {
            scoreBasis: "brier-loss.v1",
            solverBrier,
            consensusBrier,
            brierSpread: subtract(solverBrier, consensusBrier),
          },
          checks,
        };
      }
      ```

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/prediction/parse.test.ts`
      Expected: 10 parametrized cases plus 5 named tests passing.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "feat(task-execution): parse prediction results at the adapter edge"
      ```

---

## Task 8 — the prediction `EvaluatorAdapter`

**Files**

- `packages/task-execution/evaluator-adapters/src/prediction/adapter.ts` (new)
- `packages/task-execution/evaluator-adapters/src/prediction/adapter.test.ts` (new)
- `packages/task-execution/evaluator-adapters/src/index.ts` (edit)

**Interfaces**

- Consumes: the same harness/profiles/supervisor types as Task 5; `parsePredictionResult`,
  `PredictionOutcome` from `./parse.js`.
- Produces:
  ```ts
  export const PREDICTION_MEASUREMENTS: {
    readonly integrity: "integrity";
    readonly resolved: "resolved";
    readonly outcomeYes: "outcomeYes";
    readonly solverBrier: "solverBrier";
    readonly consensusBrier: "consensusBrier";
    readonly brierSpread: "brierSpread";
  };
  export interface ResolutionSnapshotRequest {
    readonly specification: EvaluationSpec;
    readonly task: ExactEvaluationMaterial;
    readonly results: readonly ExactEvaluationMaterial[];
    readonly context: EvaluationContext;
    readonly attempt: AttemptIdentity;
    readonly deadlineSignal: AbortSignal;
  }
  export interface PredictionEvaluationInputs {
    readonly snapshot: unknown;
    readonly market: { readonly marketId: string; readonly conditionId: string };
    readonly window: { readonly startTs: number; readonly endTs: number };
    readonly consensusProbabilityYes: string;
  }
  export interface ResolutionSnapshotSource {
    read(request: ResolutionSnapshotRequest): Promise<PredictionEvaluationInputs>;
  }
  export function contextResolutionSnapshotSource(): ResolutionSnapshotSource;
  export interface PredictionAdapterOptions {
    readonly resolutionSnapshotSource: ResolutionSnapshotSource;
    readonly now?: () => Date;
  }
  export function createPredictionEvaluatorAdapter(
    options: PredictionAdapterOptions,
  ): EvaluatorAdapter;
  export function predictionEvaluationSpecMeasurements(): EvaluationSpec["measurements"];
  export function predictionEvaluationSpecVerdictRule(): EvaluationSpec["verdictRule"];
  ```

  `predictionEvaluationSpecMeasurements()` and `predictionEvaluationSpecVerdictRule()` exist so
  the stage-2 spec author cannot drift from the adapter's delivered vocabulary; they return
  plain data, not a new document format.

### Steps

- [ ] **Failing test.** Create `src/prediction/adapter.test.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import {
        EvaluationOperationalError,
        type ExactEvaluationMaterial,
      } from "@jinn-network/task-execution-evaluation-harness";
      import {
        checkMeasurementCoverage,
        checkVerdictConsistency,
        EVALUATION_SPEC_FORMAT_URI,
        EVAL_SEMANTICS_VERSION,
        type EvaluationSpec,
        type MeasurementMap,
      } from "@jinn-network/task-execution-profiles";
      import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
      import { describe, expect, test } from "vitest";
      import { PREDICTION_PARSER } from "../parser-identity.js";
      import { PREDICTION_FIXTURES } from "./fixtures.js";
      import {
        contextResolutionSnapshotSource,
        createPredictionEvaluatorAdapter,
        predictionEvaluationSpecMeasurements,
        predictionEvaluationSpecVerdictRule,
        type PredictionEvaluationInputs,
        type ResolutionSnapshotSource,
      } from "./adapter.js";

      const encoder = new TextEncoder();

      const ATTEMPT: AttemptIdentity = {
        attemptUri: "urn:uuid:22222222-2222-4222-8222-222222222222" as AttemptIdentity["attemptUri"],
        nonce: "evaluation-nonce",
        attemptNumber: 1,
      };

      function material(name: string, bytes: Uint8Array): ExactEvaluationMaterial {
        return { descriptor: { name, digest: { sha256: "1".repeat(64) } }, bytes };
      }

      function specification(): EvaluationSpec {
        return {
          protocol: EVALUATION_SPEC_FORMAT_URI,
          semanticsVersion: EVAL_SEMANTICS_VERSION,
          family: "deterministic-process",
          grader: {
            name: PREDICTION_PARSER.id,
            digest: { sha256: PREDICTION_PARSER.digest.slice("sha256:".length) },
            accessClass: "public",
          },
          familyBlock: {
            image: { name: "scorer-image", digest: { sha256: "3".repeat(64) } },
            platform: "linux/amd64",
            workspace: {},
            testMaterial: [],
            parser: PREDICTION_PARSER,
            transitions: { failToPass: [], passToPass: [] },
            timeout: 300,
          },
          measurements: predictionEvaluationSpecMeasurements(),
          verdictRule: predictionEvaluationSpecVerdictRule(),
          unscorable: [
            { name: "market-unresolved", disposition: "recorded-inconclusive" },
            { name: "venue-unavailable", disposition: "retryable-infrastructure" },
          ],
          evidenceConventions: { requiredRefs: [] },
        } as EvaluationSpec;
      }

      function source(inputs: PredictionEvaluationInputs): ResolutionSnapshotSource {
        return { async read() { return inputs; } };
      }

      describe("createPredictionEvaluatorAdapter", () => {
        test.each(PREDICTION_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
          "%s maps to the harness verdict shape and stays verdict-consistent",
          async (_name, fixture) => {
            const adapter = createPredictionEvaluatorAdapter({
              resolutionSnapshotSource: source({
                snapshot: fixture.snapshot,
                market: fixture.market,
                window: fixture.window,
                consensusProbabilityYes: fixture.consensusProbabilityYes,
              }),
              now: () => new Date("2026-07-30T09:00:00.000Z"),
            });
            const spec = specification();
            const completed = await adapter.evaluate(
              material("subject-task.json", encoder.encode("{}")),
              [material("result.json", fixture.resultBytes)],
              spec,
              {},
              ATTEMPT,
              new AbortController().signal,
            );

            expect(completed.verdict).toBe(fixture.expect.verdict);
            expect(completed.evaluatedAt).toBe("2026-07-30T09:00:00.000Z");

            const measurements: MeasurementMap = {};
            for (const measurement of completed.measurements ?? []) {
              measurements[measurement.name] = measurement.value as string | number | boolean;
            }
            expect(checkMeasurementCoverage(spec, measurements).ok).toBe(true);
            expect(checkVerdictConsistency({
              spec,
              delivered: { verdict: completed.verdict },
              measurements,
            })).toEqual({ ok: true });
          },
        );

        test("every delivered measurement is declared by the specification", async () => {
          const spec = specification();
          const declared = new Set(spec.measurements.map((entry) => entry.name));
          for (const fixture of PREDICTION_FIXTURES) {
            const adapter = createPredictionEvaluatorAdapter({
              resolutionSnapshotSource: source({
                snapshot: fixture.snapshot,
                market: fixture.market,
                window: fixture.window,
                consensusProbabilityYes: fixture.consensusProbabilityYes,
              }),
            });
            const completed = await adapter.evaluate(
              material("subject-task.json", encoder.encode("{}")),
              [material("result.json", fixture.resultBytes)],
              spec,
              {},
              ATTEMPT,
              new AbortController().signal,
            );
            for (const measurement of completed.measurements ?? []) {
              expect(declared).toContain(measurement.name);
            }
          }
        });

        test("exactly one Result subject is required", async () => {
          const adapter = createPredictionEvaluatorAdapter({
            resolutionSnapshotSource: source({
              snapshot: PREDICTION_FIXTURES[0]!.snapshot,
              market: PREDICTION_FIXTURES[0]!.market,
              window: PREDICTION_FIXTURES[0]!.window,
              consensusProbabilityYes: "0.500000",
            }),
          });
          const error = await adapter.evaluate(
            material("subject-task.json", encoder.encode("{}")),
            [],
            specification(),
            {},
            ATTEMPT,
            new AbortController().signal,
          ).catch((cause: unknown) => cause);
          expect(error).toBeInstanceOf(EvaluationOperationalError);
          expect((error as EvaluationOperationalError).reason).toBe("subject-not-found");
        });
      });

      describe("contextResolutionSnapshotSource", () => {
        test("reads the snapshot and market frame from the evaluation context", async () => {
          const inputs = await contextResolutionSnapshotSource().read({
            specification: specification(),
            task: material("subject-task.json", encoder.encode("{}")),
            results: [],
            context: {
              resolutionSnapshot: { status: "unresolved", marketId: "m", conditionId: "c" },
              market: { marketId: "m", conditionId: "c" },
              window: { startTs: 1, endTs: 2 },
              consensusProbabilityYes: "0.500000",
            },
            attempt: ATTEMPT,
            deadlineSignal: new AbortController().signal,
          });
          expect(inputs.consensusProbabilityYes).toBe("0.500000");
          expect(inputs.window).toEqual({ startTs: 1, endTs: 2 });
        });

        test("a context missing the snapshot is an operational failure, not a fail verdict", async () => {
          const error = await contextResolutionSnapshotSource().read({
            specification: specification(),
            task: material("subject-task.json", encoder.encode("{}")),
            results: [],
            context: {},
            attempt: ATTEMPT,
            deadlineSignal: new AbortController().signal,
          }).catch((cause: unknown) => cause);
          expect(error).toBeInstanceOf(EvaluationOperationalError);
          expect((error as EvaluationOperationalError).reason).toBe("provider-unavailable");
        });
      });
      ```

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/prediction/adapter.test.ts`
      Expected failure: `Failed to resolve import "./adapter.js"`.

- [ ] **Minimal implementation.** Create `src/prediction/adapter.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import {
        EvaluationOperationalError,
        type CompletedEvaluation,
        type EvaluationContext,
        type EvaluationMeasurement,
        type EvaluatorAdapter,
        type ExactEvaluationMaterial,
      } from "@jinn-network/task-execution-evaluation-harness";
      import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
      import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
      import { parsePredictionResult } from "./parse.js";

      export const PREDICTION_MEASUREMENTS = Object.freeze({
        integrity: "integrity",
        resolved: "resolved",
        outcomeYes: "outcomeYes",
        solverBrier: "solverBrier",
        consensusBrier: "consensusBrier",
        brierSpread: "brierSpread",
      } as const);

      /**
       * The measurement vocabulary this adapter delivers. A specification that declares anything
       * else makes the harness runtime reject the evaluation, so the spec author consumes this.
       */
      export function predictionEvaluationSpecMeasurements(): EvaluationSpec["measurements"] {
        return [
          { name: PREDICTION_MEASUREMENTS.integrity, type: "boolean", required: true },
          { name: PREDICTION_MEASUREMENTS.resolved, type: "boolean", required: true },
          { name: PREDICTION_MEASUREMENTS.outcomeYes, type: "boolean", required: false },
          { name: PREDICTION_MEASUREMENTS.solverBrier, type: "string", direction: "lower-better", required: false },
          { name: PREDICTION_MEASUREMENTS.consensusBrier, type: "string", required: false },
          { name: PREDICTION_MEASUREMENTS.brierSpread, type: "string", direction: "lower-better", required: false },
        ];
      }

      /**
       * The verdict rule the delivered measurements satisfy. The `inconclusiveWhen` predicate is
       * load-bearing: the harness runtime recomputes the rule and never forwards a declared
       * unscorable class (Finding C), so an unresolved market is expressible only this way.
       */
      export function predictionEvaluationSpecVerdictRule(): EvaluationSpec["verdictRule"] {
        return {
          all: [
            { threshold: { measurement: PREDICTION_MEASUREMENTS.integrity, op: "eq", value: true } },
            {
              inconclusiveWhen: {
                threshold: { measurement: PREDICTION_MEASUREMENTS.resolved, op: "eq", value: false },
              },
              class: "market-unresolved",
            },
          ],
        };
      }

      export interface ResolutionSnapshotRequest {
        readonly specification: EvaluationSpec;
        readonly task: ExactEvaluationMaterial;
        readonly results: readonly ExactEvaluationMaterial[];
        readonly context: EvaluationContext;
        readonly attempt: AttemptIdentity;
        readonly deadlineSignal: AbortSignal;
      }

      export interface PredictionEvaluationInputs {
        readonly snapshot: unknown;
        readonly market: { readonly marketId: string; readonly conditionId: string };
        readonly window: { readonly startTs: number; readonly endTs: number };
        readonly consensusProbabilityYes: string;
      }

      /** The injected execution provider (evaluation-runner design §5.4). See Finding B. */
      export interface ResolutionSnapshotSource {
        read(request: ResolutionSnapshotRequest): Promise<PredictionEvaluationInputs>;
      }

      function unavailable(detail: string): never {
        throw new EvaluationOperationalError({
          canonicalCode: "UNAVAILABLE",
          reason: "provider-unavailable",
          recoveryAdvice: "new-attempt-required",
          safeDetail: detail,
        });
      }

      function isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
      }

      export function contextResolutionSnapshotSource(): ResolutionSnapshotSource {
        return {
          async read({ context }) {
            const snapshot = context["resolutionSnapshot"];
            const market = context["market"];
            const window = context["window"];
            const consensusProbabilityYes = context["consensusProbabilityYes"];
            if (snapshot === undefined) {
              unavailable("the evaluation context carries no resolutionSnapshot");
            }
            if (
              !isObject(market) ||
              typeof market["marketId"] !== "string" ||
              typeof market["conditionId"] !== "string"
            ) {
              unavailable("the evaluation context carries no market identity");
            }
            if (
              !isObject(window) ||
              typeof window["startTs"] !== "number" ||
              typeof window["endTs"] !== "number"
            ) {
              unavailable("the evaluation context carries no submission window");
            }
            if (typeof consensusProbabilityYes !== "string") {
              unavailable("the evaluation context carries no consensus probability");
            }
            return {
              snapshot,
              market: {
                marketId: market["marketId"],
                conditionId: market["conditionId"],
              },
              window: { startTs: window["startTs"], endTs: window["endTs"] },
              consensusProbabilityYes,
            };
          },
        };
      }

      export interface PredictionAdapterOptions {
        readonly resolutionSnapshotSource: ResolutionSnapshotSource;
        readonly now?: () => Date;
      }

      export function createPredictionEvaluatorAdapter(
        options: PredictionAdapterOptions,
      ): EvaluatorAdapter {
        const now = options.now ?? (() => new Date());

        return {
          async evaluate(
            task,
            results,
            specification,
            context,
            attempt,
            deadlineSignal,
          ): Promise<CompletedEvaluation> {
            if (deadlineSignal.aborted) {
              throw new EvaluationOperationalError({
                canonicalCode: "CANCELLED",
                reason: "provider-unavailable",
                recoveryAdvice: "resume-attempt",
                safeDetail: "the evaluation deadline elapsed before scoring began",
              });
            }
            if (specification.family !== "deterministic-process") {
              throw new EvaluationOperationalError({
                canonicalCode: "FAILED_PRECONDITION",
                reason: "unsupported-specification",
                recoveryAdvice: "do-not-retry",
                safeDetail:
                  "the prediction evaluator serves deterministic-process specifications only",
              });
            }
            const [subject] = results;
            if (subject === undefined || results.length !== 1) {
              throw new EvaluationOperationalError({
                canonicalCode: "INVALID_ARGUMENT",
                reason: "subject-not-found",
                recoveryAdvice: "do-not-retry",
                safeDetail: "the prediction evaluator requires exactly one Result subject",
              });
            }

            const inputs = await options.resolutionSnapshotSource.read({
              specification,
              task,
              results,
              context,
              attempt,
              deadlineSignal,
            });
            const outcome = parsePredictionResult({
              resultBytes: subject.bytes,
              snapshot: inputs.snapshot,
              market: inputs.market,
              window: inputs.window,
              consensusProbabilityYes: inputs.consensusProbabilityYes,
            });

            const measurements: EvaluationMeasurement[] = [
              { name: PREDICTION_MEASUREMENTS.integrity, value: outcome.integrity },
              { name: PREDICTION_MEASUREMENTS.resolved, value: outcome.resolved },
            ];
            if (outcome.outcomeYes !== undefined) {
              measurements.push({
                name: PREDICTION_MEASUREMENTS.outcomeYes,
                value: outcome.outcomeYes,
              });
            }
            if (outcome.scores !== undefined) {
              measurements.push(
                { name: PREDICTION_MEASUREMENTS.solverBrier, value: outcome.scores.solverBrier },
                { name: PREDICTION_MEASUREMENTS.consensusBrier, value: outcome.scores.consensusBrier },
                { name: PREDICTION_MEASUREMENTS.brierSpread, value: outcome.scores.brierSpread },
              );
            }

            return {
              detailedOutcome: {
                checks: outcome.checks,
                ...(outcome.scores === undefined ? {} : { scores: outcome.scores }),
              },
              verdict: outcome.verdict,
              evaluatedAt: now().toISOString(),
              measurements,
              explanation: outcome.verdict === "inconclusive"
                ? "The market had not resolved when the evaluation ran."
                : outcome.verdict === "pass"
                ? "Every integrity check passed and the market resolved."
                : "At least one integrity check failed.",
              ...(outcome.verdict === "inconclusive"
                ? { limitations: ["market-unresolved"] }
                : {}),
            };
          },
        };
      }
      ```

      Extend `src/index.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      export * from "./parser-identity.js";
      export * from "./swe-rebench/parse.js";
      export * from "./swe-rebench/adapter.js";
      export * from "./prediction/parse.js";
      export * from "./prediction/adapter.js";
      ```

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/prediction && yarn typecheck`
      Expected: all prediction suites passing; `tsc --noEmit` prints nothing.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "feat(task-execution): add the prediction evaluator adapter"
      ```

---

## Task 9 — deployment-allowlist registrations and runtime resolution

**Files**

- `packages/task-execution/evaluator-adapters/src/registrations.ts` (new)
- `packages/task-execution/evaluator-adapters/src/registrations.test.ts` (new)
- `packages/task-execution/evaluator-adapters/src/index.ts` (edit)

**Interfaces**

- Consumes: `defineEvaluatorRegistration`, `validateEvaluatorRegistrationSet`,
  `EvaluatorRegistration`, `ResourceDescriptor` from
  `@jinn-network/task-execution-evaluation-harness`; `DeterministicProcessBlock`,
  `parserAllowlistKey` from `@jinn-network/task-execution-profiles`;
  `SWE_REBENCH_PARSER`, `PREDICTION_PARSER` from `./parser-identity.js`;
  the two `create*EvaluatorAdapter` factories.
- Produces:
  ```ts
  export const SWE_REBENCH_REGISTRATION_ID = "swe-rebench-v2";
  export const PREDICTION_REGISTRATION_ID = "prediction-market";
  export interface EvaluatorRegistrationOptions {
    readonly evaluatorId: string;
    readonly signerHandle: string;
    readonly evaluationMethod: ResourceDescriptor;
  }
  export function createSweRebenchEvaluatorRegistration(
    options: EvaluatorRegistrationOptions & { readonly graderReportSource: GraderReportSource },
  ): EvaluatorRegistration;
  export function createPredictionEvaluatorRegistration(
    options: EvaluatorRegistrationOptions & { readonly resolutionSnapshotSource: ResolutionSnapshotSource },
  ): EvaluatorRegistration;
  ```

### Steps

- [ ] **Failing test.** Create `src/registrations.test.ts`. It drives the real
      `selectRegistration` path by constructing an `EvaluationHarnessDeployment` and calling
      `validateEvaluatorRegistrationSet`, and asserts the allowlist refuses an unlisted parser:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import {
        validateEvaluatorRegistrationSet,
        type EvaluationHarnessDeployment,
      } from "@jinn-network/task-execution-evaluation-harness";
      import {
        EVALUATION_SPEC_FORMAT_URI,
        EVAL_SEMANTICS_VERSION,
        parserAllowlistKey,
        type DeterministicProcessBlock,
        type EvaluationSpec,
        type ParserIdentity,
      } from "@jinn-network/task-execution-profiles";
      import { describe, expect, test } from "vitest";
      import {
        evaluatorAdaptersParserAllowlist,
        PREDICTION_PARSER,
        SWE_REBENCH_PARSER,
      } from "./parser-identity.js";
      import { contextGraderReportSource } from "./swe-rebench/adapter.js";
      import { contextResolutionSnapshotSource } from "./prediction/adapter.js";
      import {
        createPredictionEvaluatorRegistration,
        createSweRebenchEvaluatorRegistration,
        PREDICTION_REGISTRATION_ID,
        SWE_REBENCH_REGISTRATION_ID,
      } from "./registrations.js";

      const method = {
        name: "evaluator-adapters",
        digest: { sha256: "9".repeat(64) },
        uri: "https://jinn.network/software/evaluator-adapters/v1",
      };

      function registrations() {
        return [
          createSweRebenchEvaluatorRegistration({
            evaluatorId: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
            signerHandle: "evaluator-agent-key.pem",
            evaluationMethod: method,
            graderReportSource: contextGraderReportSource(),
          }),
          createPredictionEvaluatorRegistration({
            evaluatorId: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
            signerHandle: "evaluator-agent-key.pem",
            evaluationMethod: method,
            resolutionSnapshotSource: contextResolutionSnapshotSource(),
          }),
        ];
      }

      function specFor(parser: ParserIdentity): EvaluationSpec {
        return {
          protocol: EVALUATION_SPEC_FORMAT_URI,
          semanticsVersion: EVAL_SEMANTICS_VERSION,
          family: "deterministic-process",
          grader: {
            name: parser.id,
            digest: { sha256: parser.digest.slice("sha256:".length) },
            accessClass: "public",
          },
          familyBlock: {
            image: { name: "grader-image", digest: { sha256: "2".repeat(64) } },
            platform: "linux/amd64",
            workspace: {},
            testMaterial: [],
            parser,
            transitions: { failToPass: [], passToPass: [] },
            timeout: 60,
          },
          measurements: [{ name: "passed", type: "boolean", required: true }],
          verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
          unscorable: [],
          evidenceConventions: { requiredRefs: [] },
        } as EvaluationSpec;
      }

      /** Mirrors runtime.ts's own selection: exactly one compatible registration, or refuse. */
      function resolve(
        deployment: EvaluationHarnessDeployment,
        specification: EvaluationSpec,
      ): string {
        const compatible = validateEvaluatorRegistrationSet(deployment.registrations)
          .filter((registration) => registration.specificationCompatibility(specification));
        if (compatible.length !== 1) {
          throw new Error(
            compatible.length === 0
              ? "no host evaluator registration supports the EvaluationSpec"
              : "more than one host evaluator registration supports the EvaluationSpec",
          );
        }
        return compatible[0]!.registrationId;
      }

      const deployment = {
        registrations: registrations(),
        parserAllowlist: evaluatorAdaptersParserAllowlist(),
        maxClaimEvidenceBytes: 1024 * 1024,
        evidenceWriter: {
          async putClaimEvidence({ name }: { name: string }) {
            return { name, digest: { sha256: "4".repeat(64) } };
          },
        },
      } as unknown as EvaluationHarnessDeployment;

      describe("deployment registrations", () => {
        test("the set validates and has unique ids", () => {
          expect(validateEvaluatorRegistrationSet(deployment.registrations)).toHaveLength(2);
        });

        test("the swe-rebench parser identity resolves the swe-rebench registration", () => {
          expect(resolve(deployment, specFor(SWE_REBENCH_PARSER)))
            .toBe(SWE_REBENCH_REGISTRATION_ID);
        });

        test("the prediction parser identity resolves the prediction registration", () => {
          expect(resolve(deployment, specFor(PREDICTION_PARSER)))
            .toBe(PREDICTION_REGISTRATION_ID);
        });

        test("an unlisted parser identity matches no registration", () => {
          const unlisted: ParserIdentity = {
            id: "network.jinn.parser.unlisted",
            version: "1.0.0",
            digest: `sha256:${"7".repeat(64)}`,
          };
          expect(() => resolve(deployment, specFor(unlisted)))
            .toThrow("no host evaluator registration supports the EvaluationSpec");
        });

        test("an unlisted parser identity is also outside the deployment allowlist", () => {
          const spec = specFor({
            id: "network.jinn.parser.unlisted",
            version: "1.0.0",
            digest: `sha256:${"7".repeat(64)}`,
          });
          const key = parserAllowlistKey(
            (spec.familyBlock as DeterministicProcessBlock).parser,
          );
          expect(deployment.parserAllowlist.has(key)).toBe(false);
        });

        test("a matching id at a different digest is refused (the digest is the commitment)", () => {
          const drifted: ParserIdentity = {
            id: SWE_REBENCH_PARSER.id,
            version: SWE_REBENCH_PARSER.version,
            digest: `sha256:${"8".repeat(64)}`,
          };
          expect(() => resolve(deployment, specFor(drifted)))
            .toThrow("no host evaluator registration supports the EvaluationSpec");
          expect(deployment.parserAllowlist.has(parserAllowlistKey(drifted))).toBe(false);
        });

        test("the two registrations never both claim one specification", () => {
          for (const parser of [SWE_REBENCH_PARSER, PREDICTION_PARSER]) {
            const spec = specFor(parser);
            const claimed = deployment.registrations
              .filter((registration) => registration.specificationCompatibility(spec));
            expect(claimed).toHaveLength(1);
          }
        });
      });
      ```

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/registrations.test.ts`
      Expected failure: `Failed to resolve import "./registrations.js"`.

- [ ] **Minimal implementation.** Create `src/registrations.ts`:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import {
        defineEvaluatorRegistration,
        type EvaluatorRegistration,
        type ResourceDescriptor,
      } from "@jinn-network/task-execution-evaluation-harness";
      import type {
        DeterministicProcessBlock,
        EvaluationSpec,
        ParserIdentity,
      } from "@jinn-network/task-execution-profiles";
      import { parserAllowlistKey } from "@jinn-network/task-execution-profiles";
      import { PREDICTION_PARSER, SWE_REBENCH_PARSER } from "./parser-identity.js";
      import {
        createPredictionEvaluatorAdapter,
        type ResolutionSnapshotSource,
      } from "./prediction/adapter.js";
      import {
        createSweRebenchEvaluatorAdapter,
        type GraderReportSource,
      } from "./swe-rebench/adapter.js";

      export const SWE_REBENCH_REGISTRATION_ID = "swe-rebench-v2";
      export const PREDICTION_REGISTRATION_ID = "prediction-market";

      export interface EvaluatorRegistrationOptions {
        readonly evaluatorId: string;
        readonly signerHandle: string;
        readonly evaluationMethod: ResourceDescriptor;
      }

      /**
       * Compatibility is exact parser identity — id, version, and digest together. A drifted digest
       * is a different semantic commitment and must not be served by this adapter.
       */
      function matchesParser(parser: ParserIdentity) {
        const expected = parserAllowlistKey(parser);
        return (specification: EvaluationSpec): boolean => {
          if (specification.family !== "deterministic-process") return false;
          const block = specification.familyBlock as DeterministicProcessBlock;
          return parserAllowlistKey(block.parser) === expected;
        };
      }

      export function createSweRebenchEvaluatorRegistration(
        options: EvaluatorRegistrationOptions & {
          readonly graderReportSource: GraderReportSource;
          readonly maxTestLogBytes?: number;
        },
      ): EvaluatorRegistration {
        return defineEvaluatorRegistration({
          registrationId: SWE_REBENCH_REGISTRATION_ID,
          adapter: createSweRebenchEvaluatorAdapter({
            graderReportSource: options.graderReportSource,
            ...(options.maxTestLogBytes === undefined
              ? {}
              : { maxTestLogBytes: options.maxTestLogBytes }),
          }),
          evaluationMethod: options.evaluationMethod,
          specificationCompatibility: matchesParser(SWE_REBENCH_PARSER),
          evaluatorIdentity: { id: options.evaluatorId },
          signer: { handle: options.signerHandle },
          outcomeValidator: (evaluation) => evaluation,
          interruptionBehavior: "repeatable",
        });
      }

      export function createPredictionEvaluatorRegistration(
        options: EvaluatorRegistrationOptions & {
          readonly resolutionSnapshotSource: ResolutionSnapshotSource;
        },
      ): EvaluatorRegistration {
        return defineEvaluatorRegistration({
          registrationId: PREDICTION_REGISTRATION_ID,
          adapter: createPredictionEvaluatorAdapter({
            resolutionSnapshotSource: options.resolutionSnapshotSource,
          }),
          evaluationMethod: options.evaluationMethod,
          specificationCompatibility: matchesParser(PREDICTION_PARSER),
          evaluatorIdentity: { id: options.evaluatorId },
          signer: { handle: options.signerHandle },
          outcomeValidator: (evaluation) => evaluation,
          interruptionBehavior: "repeatable",
        });
      }
      ```

      Extend `src/index.ts` with `export * from "./registrations.js";`.

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/registrations.test.ts`
      Expected: 7 passing tests.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "feat(task-execution): register both evaluator adapters in the deployment allowlist"
      ```

---

## Task 10 — conformance against the real evaluation harness

This is the kit slice for this component: the adapters run inside the actual
`runEvaluationHarness`, over a real workspace layout, with a real Ed25519 signer, and produce
a real `out/verdict` DSSE envelope. It is the gate the program's stage-0 review reads.

**Files**

- `packages/task-execution/evaluator-adapters/src/conformance.integration.test.ts` (new)

**Interfaces**

- Consumes: `runEvaluationHarness`, `EVALUATION_HARNESS_EXIT_INVALID_INPUT`,
  `EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE`, `EvaluationHarnessDeployment` from
  `@jinn-network/task-execution-evaluation-harness`;
  `deriveEvaluationTask`, `sealEvaluationSpec`, `EVAL_SEMANTICS_VERSION`,
  `EVALUATION_SPEC_FORMAT_URI` from `@jinn-network/task-execution-profiles`;
  `sealTask`, `sealDelivery`, `documentDigest` from `@jinn-network/task-execution-protocol`;
  `WorkspacePaths` from `@jinn-network/task-execution-workspace`.
- Produces: no exports — a test module only.

### Steps

- [ ] **Failing test.** Create `src/conformance.integration.test.ts`. Build the Attempt input
      directory exactly as `evaluation-harness/src/runtime.test.ts:110-236` does (same file
      names: `task.sealed`, `subject-task.json`, `subject-delivery.json`, the Result subject,
      `evaluation-spec.json`, `evaluation-context.json`, `dispatch-context.json`, plus an
      Ed25519 PKCS#8 PEM at `secrets/evaluator-agent-key.pem`), then:

      ```ts
      // SPDX-License-Identifier: Apache-2.0

      import { createHash, generateKeyPairSync } from "node:crypto";
      import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import {
        EVALUATION_HARNESS_EXIT_INVALID_INPUT,
        EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE,
        runEvaluationHarness,
        type EvaluationHarnessDeployment,
      } from "@jinn-network/task-execution-evaluation-harness";
      import {
        deriveEvaluationTask,
        EVAL_SEMANTICS_VERSION,
        EVALUATION_SPEC_FORMAT_URI,
        sealEvaluationSpec,
        type EvaluationSpec,
      } from "@jinn-network/task-execution-profiles";
      import {
        documentDigest,
        sealDelivery,
        sealTask,
      } from "@jinn-network/task-execution-protocol";
      import type { WorkspacePaths } from "@jinn-network/task-execution-workspace";
      import { afterEach, describe, expect, test } from "vitest";
      import { evaluatorAdaptersParserAllowlist, PREDICTION_PARSER, SWE_REBENCH_PARSER } from "./parser-identity.js";
      import { PREDICTION_FIXTURES } from "./prediction/fixtures.js";
      import { SWE_REBENCH_FIXTURES } from "./swe-rebench/fixtures.js";
      import { contextGraderReportSource } from "./swe-rebench/adapter.js";
      import {
        contextResolutionSnapshotSource,
        predictionEvaluationSpecMeasurements,
        predictionEvaluationSpecVerdictRule,
      } from "./prediction/adapter.js";
      import {
        createPredictionEvaluatorRegistration,
        createSweRebenchEvaluatorRegistration,
      } from "./registrations.js";
      ```

      The suite must assert exactly these outcomes:

      1. **swe-rebench pass** — fixture `resolved-all-transitions` with its report and log placed
         in `evaluation-context.json` as `{ graderReport, graderLog }`; `runEvaluationHarness`
         returns `0`; `out/verdict` exists and its DSSE payload decodes to an in-toto Statement
         whose `predicateType` is
         `"https://jinn.network/attestations/result-evaluation/v1"` and whose predicate carries
         `verdict: "pass"`.
      2. **swe-rebench fail** — fixture `unresolved-fail-to-pass-still-failing`; exit `0`;
         predicate `verdict: "fail"`.
      3. **swe-rebench ungradeable** — fixture `ungradeable-docker-unavailable`; exit
         `EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE`; `out/verdict` **does not exist**. This is
         the "unscorable is never a silent zero" gate.
      4. **prediction pass / fail / inconclusive** — fixtures
         `scored-yes-solver-beats-consensus`, `rejected-submission-outside-window`,
         `inconclusive-market-unresolved`, with the prediction spec built from
         `predictionEvaluationSpecMeasurements()` / `predictionEvaluationSpecVerdictRule()`;
         each returns exit `0` and the matching predicate verdict.
      5. **unlisted parser** — a spec identical to (1) but with a drifted parser digest, deployed
         with the same `evaluatorAdaptersParserAllowlist()`; `runEvaluationHarness` returns
         `EVALUATION_HARNESS_EXIT_INVALID_INPUT` and writes no verdict.
      6. **verdict written exactly once** — running (1) twice against the same workspace: the
         second run returns `EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE` because
         `atomicExclusiveWrite` refuses an existing `out/verdict` (seal-once).

      Each case builds its own `mkdtemp` root, registered in an `afterEach` cleanup array.

- [ ] **Run to verify fail.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/conformance.integration.test.ts`
      Expected failure: the first case — `runEvaluationHarness` returns a non-zero exit until
      the deployment is assembled correctly (typically `65`, invalid input, while the sealed
      crosswalk digests are still being wired). Iterate until the six cases hold.

- [ ] **Run to verify pass.**
      `cd packages/task-execution/evaluator-adapters && yarn vitest run src/conformance.integration.test.ts`
      Expected: 6+ passing tests, 0 failing.

- [ ] **Run the upstream harness suite unchanged** to prove nothing here perturbed it:
      ```
      cd packages/task-execution/evaluation-harness && yarn install --immutable && yarn typecheck && yarn test
      ```
      Expected: the harness's own suites pass with no edits to that package (`git status` shows
      no modification under `packages/task-execution/evaluation-harness/`).

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters && \
      git commit -m "test(task-execution): drive both evaluator adapters through the real evaluation harness"
      ```

---

## Task 11 — full-tree verification and completion checklist

**Files**

- `packages/task-execution/evaluator-adapters/README.md` (edit — final content)

### Steps

- [ ] **Run the guard trio.**
      ```
      node --test .github/scripts/task-execution-package-inventory.test.mjs
      node --test .github/scripts/task-execution-source-boundaries.test.mjs
      ```
      Expected: 3 and 7 passing tests respectively, 0 failing.

- [ ] **Run the package gates.**
      ```
      cd packages/task-execution/evaluator-adapters && \
      yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke
      ```
      Expected: `tsc --noEmit` silent; every vitest suite green; `dist/` populated; the pack
      smoke's synthetic consumer compiles against the packed tarball.

- [ ] **Run the packed-types guard** (requires every upstream `dist/` present — build them
      first if the worktree is clean):
      ```
      for p in protocol backend profiles; do (cd packages/task-execution/$p && yarn install --immutable && yarn build); done
      for p in supervisor workspace launchers assembly; do (cd packages/task-execution/backend-local/$p && yarn install --immutable && yarn build); done
      for p in protocol repository discovery execution-recorder attestation-issuer; do (cd packages/evidence/$p && yarn install --immutable && yarn build); done
      (cd packages/task-execution/evaluation-harness && yarn install --immutable && yarn build)
      node .github/scripts/task-execution-packed-types.test.mjs
      ```
      Expected: the synthetic consumer compiles every entrypoint including
      `@jinn-network/task-execution-evaluator-adapters`.

- [ ] **Confirm no out-of-scope file changed.**
      ```
      git diff --name-only origin/integration/evidence-v1...HEAD
      ```
      Expected: only `packages/task-execution/evaluator-adapters/**`,
      `.github/scripts/task-execution-*.test.mjs`,
      `.github/workflows/task-execution-ci.yml`, and this plan file. **No** file under
      `client/`, `packages/task-execution/evaluation-harness/`, or
      `packages/task-execution/profiles/`.

- [ ] **Write the completion checklist into the PR description**, mapping each spec clause to
      its task:

      | Spec clause | Where it is satisfied |
      | --- | --- |
      | §6.3 "fresh re-homing of the concrete result parsers (swe-rebench, prediction)" | Tasks 4 and 7 — pure parsers written fresh; Tasks 3 and 6 — legacy behavior enters only as fixtures |
      | §6.3 "into the evaluation harness's deployment allowlist" | Task 2 (`evaluatorAdaptersParserAllowlist`), Task 9 (registrations), Task 10 case 5 (an unlisted parser is refused) |
      | §6.3 "parsers ingest … at the adapter edge" | Tasks 5 and 8 — the raw report / raw Result never leaves the adapter; only `CompletedEvaluation` does |
      | §7.5 "bespoke verdict document, deliberately" | No new format anywhere: the outward shape is `CompletedEvaluation`, and the harness composes the Result Evaluation |
      | §7.5 "all are parsed at the adapter edge as ingestion formats" | Task 4 (upstream report JSON + test log), Task 7 (Result JSON + resolution snapshot) |
      | §6 "conformance kits precede implementations" | Tasks 3 and 6 land before Tasks 4/5 and 7/8 |
      | §6 "guard trio with the packages, not after" | Task 1 |
      | §7.4 unscorable taxonomy (`retryable-infrastructure`) | Task 5 (`EvaluationOperationalError`, never a `fail`), Task 10 case 3 |
      | Program §6 contract 12 (fresh rewrite, legacy as fixtures) | Task 11's `git diff` check: no legacy file is read at runtime and none is modified |

- [ ] **Record Findings A–D in the PR description** with their proposed dispositions, verbatim
      from this plan's Findings section. Request the program's independent per-component review
      (program §Global constraints) before any dependent stage builds on this tree.

- [ ] **Commit.**
      ```
      git add packages/task-execution/evaluator-adapters/README.md && \
      git commit -m "docs(task-execution): finalize the evaluator-adapters README and findings"
      ```

## Coordinator amendments (2026-07-30, binding on execution)

Findings A–D ratified as proposed. A: this package defines the injected
`GraderReportSource` port and ships the hermetic `contextGraderReportSource` only; the
container driver for `deterministic-process` graders is **assigned to the stage-2 plan** as
a host deliverable (recorded in the program plan). B: prediction models as
`deterministic-process` with the resolution snapshot via the supporting-context channel. C:
the unreachable `recorded-inconclusive` path in the harness runtime is recorded as a
program follow-up (finding against a merged stack package — dispositioned upstream, not
patched here). D: legacy score/count/cost fields ride `detailedOutcome`; measurable status
is a profiles-owned follow-up.
