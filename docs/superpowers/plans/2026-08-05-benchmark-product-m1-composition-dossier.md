# Benchmark Product — M1 Composition Dossier and Shaping Decisions

Companion to `2026-08-05-standalone-benchmarking-product-program.md`. Derived
from repository reconnaissance 2026-08-05 (read-only). Binding on packets
BP-10..BP-14; where this document and package source diverge, the source wins
and the divergence is a reportable finding.

## 1. Composition map (verified symbols and files)

- **Real local backend:** `makeLocalTaskExecutionBackend(config)` from
  `@jinn-network/task-execution-backend-local`
  (`packages/task-execution/backend-local/assembly/src/backend.ts`).
  Required config: `stateRoot`, `source`, `executor`, `profileStore`,
  `launchers[]`, `provisioner`, `provisionerCapabilities`. The backend
  advertises `watch: true` — `launchAndWatch` needs no `AttemptWaitPort`.
  **Template:** `packages/task-execution/evaluation-harness/src/launcher.integration.test.ts`
  (~325–425): real backend + custom provisioner writing named input files +
  `launcherDeployments` + evidence ports + fixed `now`.
- **Launcher selection:** `selectProfileSafeLauncher(launchers, profile, harness?)`
  (`backend-local/launchers/src/routing.ts`). The baseline launcher
  `predictionV1BaselineLauncher` pins `harness ∈ {prediction-v1-baseline}`,
  `isolationPolicy ∈ {unrestricted}`, profile
  `https://spec.jinn.network/task-profiles/prediction-forecast/1.0`.
- **Sample Task shape:** the launcher's runner requires exactly one
  `input/*.json` matching the native prediction-forecast Task contract
  (exact key sets; profile digest
  `e61dc765d1a93b71639cb566d6bd3ca1335cfd53cb415e904ff840670d212937`).
  **Golden fixture to reuse:**
  `packages/task-supply/admission/fixtures/prediction-snapshot-v1/` via
  `loadPredictionSnapshotFixture()`
  (`packages/task-supply/admission/src/prediction-snapshot-fixture.ts`);
  companion `admitPredictionSnapshot` + `sealPredictionSnapshotAdmissionReceipt`
  mint the admission receipt that yields `integrityTier: "re-derivable"`.
- **Evaluation leg:** `deriveEvaluationTask(...)`
  (`profiles/src/documents/evaluation-task-1.0.ts`);
  `makeEvaluationLauncher(options)` from
  `@jinn-network/task-execution-evaluation-harness/launcher`
  (needs `registrations`/`selectRegistration`); prediction scorer via
  `createPredictionEvaluatorRegistration` / `createEvaluatorDeployment`
  (`@jinn-network/task-execution-evaluator-adapters`), context from
  `input/evaluation-context.json`. Verdict lands as an in-toto Result
  Evaluation Statement at `out/verdict`.
- **Run wiring:** `planRun` (schema: arms pairwise-distinct pinning bytes; no
  key collision with `submissionBaseline`; `closeAt` required) → `quoteRun`
  (pure; checks every pinning key against `BackendCapabilities.runPinning`
  inventories + hardCap) → `launchAndWatch(bench, run, backend, opts)` with
  REQUIRED `opts.clock` and `taskBytesFor(taskDigestHex)` →
  `localAssemblyPorts(input)` (REQUIRED `pinning.isolationInventory`;
  `InScopeVerdict` MUST carry `measurements` + `evaluationSpec` or the cell
  fails closed to non-judged) → `assembleMatrix` → `verifyMatrix`.
  **Reference composition:** `packages/policy-optimization/src/execute.ts`;
  worked 2×2 example `packages/benchmarking/local/src/miniature-run.test.ts`.
- **Report leg:** `produceReport(input, signer)` / `verifyReport` from
  `@jinn-network/benchmarking-aggregate`; `DsseSigner` shape in
  `packages/trust/core/src/dsse.ts`; inline test signer pattern at
  `packages/benchmarking/aggregate/src/report.test.ts:310`;
  Ed25519 file signer `makeSecretsSigner` in the evaluation harness.
  **M1 method: `wilson@1`** (`BENCHMARKING_METHOD_IDS.wilson`, parameters `{}`,
  verdictRule merged in by `produceReport`). `paired-mcnemar@1` needs
  replicates=1 + provenance port — not M1.

## 2. Gaps found (repository facts, 2026-08-05)

- **G1 — provisioner mismatch.** `makeDirProvisioner` writes `input/task.sealed`;
  the baseline launcher parses only `*.json` → zero native Tasks → exit 2.
  The product must supply its own `ProvisionerContract` writing the sealed
  Task bytes to `input/task.json` (and must not introduce a second
  parseable native Task).
- **G2 — unsigned verdicts.** The evaluation harness writes the bare
  statement; no shipped path DSSE-signs it. The product host wraps via
  `sealSignedRecord` + `VERDICT_DSSE_PAYLOAD_TYPE`
  (pattern: `client/src/daemon/native-evaluator-composition.ts:309-345`,
  which is marketplace-coupled and NOT reusable directly).

  > **Amended 2026-08-12 (`688bf27ad`, PR #2601): the cited pattern moved and
  > changed shape.** The file is now
  > `operator/src/daemon/native-evaluator-composition.ts` (renamed from
  > `client/` in `5a4b537cf`); cite it by symbol rather than by line, as the
  > `:309-345` span above has drifted. The host no longer re-serializes the
  > statement through `sealSignedRecord`'s compact trust-core canonical form:
  > it checks the producer's own spelling (`canonicalAttestationJsonBytes`)
  > and seals the sandbox's exact bytes with `sealSignedPayload`. G2's finding
  > — the harness writes a bare unsigned statement and the product host must
  > DSSE-wrap it — is unchanged.
- **G3 — no existing test runs `prediction-v1-baseline` through the real
  backend.** M1 is the first real-backend benchmarking composition in the
  repository.
- **G4 — single-launcher 2-arm runs are degenerate.** The baseline launcher's
  inventory admits only one meaningful pinning split, and its output is a
  deterministic echo of consensus — two arms would produce identical
  predictions. Also: id-only harness pins never reach `match` on the pinning
  bridge — pin `version`/`digest` via `launcherDeployments`.
- **G5 — no `predictionSnapshotToTaskAndSpec` helper.** A multi-item benchmark
  requires varying the golden fixture's forecast payload and re-sealing Task +
  EvaluationSpec, re-binding `task.evaluation.digest`.
- **G6 — every existing `launchAndWatch` caller uses the in-memory kit
  backend.** (Confirms M1's novelty; the in-memory backend remains legitimate
  for unit tests, never for the evidence run.)
- **G7 — `AttemptWaitPort` has no shipped implementation** (not needed for the
  local backend).

## 3. M1 shaping decisions (program-level; reversible unless noted)

1. **Two real launchers, two arms.** Arm A pins
   `harness: prediction-v1-baseline` (platform launcher, consensus echo).
   Arm B pins a **product-bundled sample launcher** (`sample-uniform`,
   working id) that genuinely spawns a subprocess and always predicts 0.5 —
   a real coin-flip baseline, honestly labeled as the bundled sample
   configuration for the quickstart. Both are real `LauncherContract`
   implementations executing real processes; neither is a mock, and the
   Brier-score comparison has a true winner. Launchers are host-injected by
   design; the product is the host on the local venue. The sample launcher
   lives in the product tree (product content, not platform code) and both
   register with `launcherDeployments` (executable digests) so the harness
   axis can reach `match`.
2. **Sample benchmark = N≥2 prediction tasks** derived from the golden
   fixture with varied forecast payloads, re-sealed with bound
   EvaluationSpec digests, admission receipts minted
   (`re-derivable` integrity where the receipt supports it).
3. **The product owns:** the custom provisioner (G1), verdict DSSE-wrapping
   with a product-held Ed25519 signing key (G2), evaluation-cell dispatch on
   the local venue (design §13: the application dispatches evaluation cells
   itself), and the wiring of `localAssemblyPorts`
   (`isolationInventory: ["unrestricted"]`).
4. **Unit tests MAY use `createInMemoryBackend`** (kit-sanctioned); the
   walking-skeleton e2e and the recorded M1 evidence run MUST use the real
   local backend. A `claude-code`-launcher repository-work run is optional
   additional evidence, attempted only if the environment supports it, and
   never a gate.
5. **M1 report method: `wilson@1`** with `verdictRule: "sole"` under the
   Direct-check preset (single evaluator identity, `independence:
   disclosed`) — the honest single-operator local posture; the report
   disclosures carry it.
