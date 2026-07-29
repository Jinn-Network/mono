# Jinn Marketplace Binding v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-07-28
**Status:** draft (pending program-extension approval — code for the marketplace components starts **only on explicit operator yes** at the next phase boundary, per program §9)
**Shape:** `feat`
**Implements:** `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md` ("the design" below — read it in full first). Consumes, without redefining: the six stack designs (2026-07-23 → 2026-07-27), and honors as-pinned `docs/superpowers/specs/2026-07-24-marketplace-external-consumer-boundary-design.md` (CLI-only external boundary) and `docs/superpowers/specs/2026-07-24-task-post-broadcast-intent-design.md` (posting crash-safety).

**Dependencies on sibling 2026-07-28 plans** (must be green before the milestone that consumes them — see Cross-plan dependencies):
- `2026-07-28-task-execution-protocol.md` — `@jinn-network/task-execution-{protocol,backend,testing}`: the frozen `TaskExecutionBackend` interface, `TEP_ATTEMPT_NAMESPACE` + `deriveAttemptUri`, `mergeRequirements`/`EffectiveRequirements`, the Delivery/Task/Submission sealers, the observation vocabulary + `foldObservations`, the 16-category error enum, and the `describeTaskExecutionBackendContract` conformance kit. **(Phase 2 — COMPLETE and merged on this branch.)**
- `2026-07-28-task-execution-profiles.md` — `@jinn-network/task-execution-profiles`: the marketplace deployment-profile document, the `attested` run-pinning posture data, `deriveEvaluationTask`, `checkVerdictConsistency`, `checkAdmissionReceipt`, `sealEvaluationSpec`. **(Phase 3 — in flight.)**
- `2026-07-28-record-discovery.md` — `@jinn-network/record-discovery-{protocol,serve,client,testing}` + `facts/task-execution`: the Announcement Entry / Source Head sealed shapes, `DISCOVERY_SIGNING_SCOPE`, the facts-profile contract + per-kind recompute functions, and — as **building blocks** for the projector suite this plan authors natively (M4.5) — the discovery conformance kit's `runSourceConformance` `reorged` correction-by-append discipline + its `derivation-consistency` conformance vectors (the kit exports **no** "projector-determinism" describe-function; the marketplace projector is a new machine, design §8 "projector #1"). Plus **Addendum 2026-07-28-c** (ruling §7.21) — the derivation annotation is unknown-field-tolerant and `blockHash`/`finalityTier`/`contractGeneration` are ratified standard additions (M4.1 hard-gates on it). **(Phase 3 — in flight.)**
- `2026-07-28-trust-layer.md` — `@jinn-network/trust-{core,resolve,testing}`: `settlementJoinCheck` (§7.5a), `authenticateRequester` (§7.5b), `verifyEnvelopeBinding`, and the injected `BindingResolver`/`AnchorResolver`/`WitnessVerifier`/`ChainFactResolver` interfaces (implemented by `trust-resolve`). **(Phase 3 — in flight.)**
- `2026-07-28-local-execution-backend.md` — `@jinn-network/task-execution-backend-local` (the assembly): the embedded backend consumed as a peer through the standard `TaskExecutionBackend` interface (ruling §7.18), and the **two-party engagement entry** (Addendum 2026-07-28-b) whose exact surface **this plan names** (Milestone M1, Finding F1). **(Phase 4 — not started.)**

**Goal:** Build the second production binding of the Task Execution Protocol — the chain-venue binding that maps sealed Task / Submission / Delivery documents onto the deployed OLAS-native Base substrate (TaskCoordinator + JinnRouterV3 + OLAS Mech Marketplace), behind a two-contract-generation seam (today-mode over the deployed contracts unchanged; revised-mode behind it), plus projector #1 (chain events → protocol observations + signed discovery announcements), the operator-sovereign claim pipeline, and the specified contract-revision Solidity code + its test kit. Every on-chain deploy is a human-gated runbook item, never a plan task.

**Architecture:** A new package tree `packages/marketplace/{binding,projector,pipeline}` (design §12; names proposed in Finding F7, consistent with program §6) plus a marketplace-tree conformance package `@jinn-network/marketplace-testing` (Finding F6 — the design's "kit slice lives with the stack's testing package" is realized as a marketplace-tree testing package that *consumes* the TEP + record-discovery kits, to avoid inverting the foundation trees' dependencies). `binding` implements the requester-facing `TaskExecutionBackend` (submit→post, observe→projector, deliveries/fetchDelivery→IPFS+chain, cancel→closeTask/releaseAttempt, recover→broadcast-intent scan) AND exposes operator-facing venue verbs (discover/claim/deliver/settle); it re-homes the mech venue surfaces from `client/src/adapters/mech/*`, consumes the protocol sealers (never re-seals TEP documents), and runs the named-check gate. `projector` is the one chain-reading machine emitting TEP observations + signed announcements from the same events (§8), sealing announcements via `record-discovery-serve`. `pipeline` is the daemon marketplace application (LIBRARY) composing the binding venue verbs with an embedded local backend through the two-party engagement entry (ruling §7.18). Each package is a standalone yarn project (own `yarn.lock`, `portal:` resolutions). The two contract generations live behind a single frozen configuration seam (§5.4). The contract revision is Solidity code + Hardhat tests in `contracts/`; deploys are runbook-only.

**Tech Stack:** TypeScript 5.9 (NodeNext strict), Node 22, Yarn 4.13.0 (Corepack) standalone projects with `portal:` resolutions, Vitest 4, `@noble/hashes` (sha256 + keccak256 for the today-mode evidence-hash correspondence), `viem` (chain reads/writes, `fallback` transport, `safe`/`finalized` block tags), `node:test` for `.mjs` guard scripts. Anvil (Foundry) fork of Base for the escrow-lifecycle fixtures. The contract revision is Solidity under Hardhat (`contracts/`). Sealing follows the stack discipline: TEP documents sealed via the protocol package; announcements via `record-discovery-serve`; per-package `order.ts` + JCS serializer only for the binding's backend-internal canonical bytes (broadcast-intent record, correspondence-assertion payload), never a re-seal of a TEP or discovery family.

## Global Constraints

_Every task's requirements implicitly include this section. Values copied verbatim from the design + program doc._

- **Preflight invariant.** All work sits on top of `1200b5842` (the ledger-update integration head, program §9). `git merge-base --is-ancestor 1200b5842 HEAD` MUST pass before any task (Preflight below).
- **Standalone yarn projects.** Each package has its own `package.json` (`"packageManager": "yarn@4.13.0"`, `"type": "module"`, `"version": "0.1.0"`, `"engines": { "node": ">=22" }`, `"license": "MIT"`, `"repository.directory"` set), its own `.yarnrc.yml` (`nodeLinker: node-modules`), its own `yarn.lock`. No repo-root workspace. In-tree Jinn deps are declared as `"0.1.0"` semver **and** pinned in `"resolutions"` as `portal:<relative-path>` (evidence precedent; enforced by the inventory guard). Match `packages/evidence/execution-recorder/package.json` field-for-field for scripts (`build`/`typecheck`/`test`/`pack:smoke`/`prepack`), `tsconfig.json` + `tsconfig.build.json`, and `scripts/pack-smoke.mjs`.
- **Two-generation seam is the spine (§5.4, §6.1, §6.3, §6.4, frozen interface §11.1/§11.6).** Every leg is written for **both** generations behind one `ContractGeneration = "today" | "revised"` config value; today-mode targets the DEPLOYED contracts unchanged, revised-mode targets the §5 revision. Flipping is configuration, not rewrite. Every divergence point is marked in code and carries a `contractGeneration` tag into the derivation annotation (§8, N4). Selecting a generation NEVER re-derives the Attempt-URI rule (below).
- **Attempt URIs are consumed, never re-derived (must #2; program §7.2; design §6.2/§11.6).** The deterministic Attempt URI is computed **only** by calling the protocol package's exported `deriveAttemptUri(MARKETPLACE_BINDING_NAME, tuple)` over `TEP_ATTEMPT_NAMESPACE`. The marketplace tree imports the export; it MUST NOT reimplement UUIDv5. A cross-package fixture asserts byte-identity against the protocol package's own pinned value (Milestone M1).
- **Canonical sealed bytes, consumed not re-invented (program §7.1/§7.4/§7.14).** TEP Task/Submission/Delivery sealed bytes come from `@jinn-network/task-execution-protocol`; announcement sealed bytes come from `@jinn-network/record-discovery-serve`/`-protocol`. The marketplace tree re-implements a per-package `order.ts` (`compareCodeUnitStrings`, UTF-16 code-unit) + JCS serializer **only** for its own backend-internal canonical bytes (broadcast-intent WAL record; correspondence-assertion payload), with a pinned-digest equivalence fixture including one object-key-sort-sensitive record and one integer-like-key record (`{"10":…,"2":…}`). A fixture documents that the tree produces **no** new sealed TEP/discovery family, so nobody later adds a duplicate serializer (mirrors program §7.15's absent-export discipline).
- **Locale ban.** `localeCompare`, `toLocale*`, and `Intl` are banned in all production source under `packages/marketplace/` (source-boundaries guard). `.test.ts` and `.mjs` guard scripts are exempt.
- **No raw control bytes in source.** The Attempt-URI name delimiter and any control characters are written as escapes (`""`), never literal bytes (program directive; §7.14 discipline).
- **Honor-or-reject is symmetric at the binding (§6.1, frozen §11.12; TEP §8 forbids silent degradation).** In today-mode, `capabilities()` declares the today-mode bounds (`maxConcurrent == maxTotal`, first-verdict finalization); a Submission with `minVerdicts > 1` OR `maxConcurrent > maxTotal` OR a `closeAt` requirement (today-mode has no on-chain claim window and therefore cannot enforce a close deadline) is rejected with `unsupported-requirement`, never silently client-honored and never weakly/partially "approximated" (ruling §7.20 adjudication: TEP §8 forbids weak/partial honoring; a chain-direct claim can still land after `closeAt` regardless of a withdrawn announcement, so the former approximation path is dropped — today-mode behaves identically to backend-local C1). Revised-mode adds the on-chain concurrency parameter, multi-verdict finalization, and **honors `closeAt` via the on-chain claim window**.
- **Marketplace deployment-profile requirements (TEP §16.2, must #8).** Signed Tasks and signed Submissions (DSSE over exact sealed bytes); executor-signed Deliveries; `executionIds` and `evidenceRecords` REQUIRED on Deliveries; the `dispatch-binding` check (the referenced Execution Evidence crate's captured inputs include the per-Attempt dispatch-context artifact §9.3); evaluation per the sealed spec with the Evidence `evaluationSpecification` digest equal to the Task's sealed `evaluation` descriptor digest. These §16.2 profile checks are **authored natively in `@jinn-network/marketplace-testing`** (M2.5) — consuming the profiles signed-doc / evidence / dispatch-binding assertions + the trust verification procedures — **not** by profile-parameterizing `describeTaskExecutionBackendContract` (ruling §7.19): the TEP core kit stays profile-agnostic and un-parameterized (TEP §24 places binding-integration checks at Layer 3, outside the shipped core kit); any backend put under the core kit implements its `TestableBackend` seam explicitly.
- **Consumption rule (ruling §7.18, must #5).** The pipeline composes the embedded local backend **as a peer, only through the assembly's standard `TaskExecutionBackend` interface** (`@jinn-network/task-execution-backend-local`) — venue verbs discover/claim/deliver/settle on one side, sealed bytes handed to the two-party engagement entry on the other. It NEVER imports or reaches into `supervisor`/`workspace`/`launchers`.
- **The chain proves; documents mean (tenet 1).** On-chain: fingerprints, sequence, escrow, uniqueness, self-eval enforcement, activity credit. Off-chain: sealed documents + signatures. The binding never stores documents on-chain and never computes judgments on-chain.
- **Checks gate off-chain observation, NOT on-chain settlement, in today-mode (§6.4, frozen §11.8).** Today-mode on-chain finalization/activity-credit is **advisory-only**; the named checks (derivation byte-equality, admission-receipt validity, `verdict-consistency`, evaluator ≠ solver, §7.5a settlement join, verdict-code correspondence) decide whether a verdict is treated as *decision-grade* by any consumer. Never present the today-mode on-chain default-Pass as a settlement guarantee. The revision makes the on-chain code derive from the signed Statement.
- **No deploy is a plan task (must #1; program §9).** The contract-revision Solidity code + Hardhat test kit are in scope (Milestone M7); every deploy (Base Sepolia redeploy, generation flip) is a human-gated runbook item (Milestone M8), never an executing task.
- **Rule 3 (surgical).** Create only the files this plan names. The marketplace guard trio + CI workflow are created here (M0); no edits to the task-execution / trust / discovery guard files.
- **Verification gate per task.** `yarn typecheck` + `yarn test` in the touched package, the relevant conformance kit run, the marketplace guard scripts (`node --test .github/scripts/marketplace-*.test.mjs`), and (at milestone close) the packed-types guard — all green locally, evidence-style, before the task is done.

## Preflight

- [ ] **Assert the branch base.** Run:

```bash
git merge-base --is-ancestor 1200b5842 HEAD && echo "OK: 1200b5842 is an ancestor of HEAD"
```

Expected: prints `OK: …`. If it fails, stop — the worktree is not on `integration/evidence-v1`'s ledger-update lineage and the stack packages this plan consumes may be absent.

- [ ] **Confirm the marketplace tree is absent.** Run `ls packages/marketplace 2>&1` — expected `No such file or directory`. This plan creates it from scratch.

- [ ] **Confirm the guard-clone precedent is present.** Run `ls .github/scripts/evidence-package-inventory.test.mjs .github/scripts/task-execution-source-boundaries.test.mjs` — both exist (models for the marketplace guard clone).

- [ ] **Confirm the deployed today-mode substrate facts.** Run `cat contracts/deployment-task-coordinator-router-v3-baseSepolia.json` — expected: `taskCoordinator 0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98`, `jinnRouterV3 0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247`, `mechMarketplace 0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7`, `activityChecker 0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70`, `chainId 84532`. These are the today-mode config defaults (M2).

## Cross-plan dependencies (what must be green before each milestone)

This plan is the **program extension after** TEP kit + trust + discovery serve/client green (program §9 sequencing: "marketplace binding after TEP kit + trust + discovery serve/client green"). Concretely:

- **M0 (scaffold)** — depends only on the guard-clone precedent (present now).
- **M1 (Attempt-URI agreement)** — depends on `@jinn-network/task-execution-protocol` exporting `deriveAttemptUri` + `TEP_ATTEMPT_NAMESPACE` (Phase 2, present) and the local-backend two-party engagement entry surface being declared (the local-backend plan Addendum 2026-07-28-b; this plan names its exact shape — Finding F1).
- **M2/M3 (binding legs)** — depend on `@jinn-network/task-execution-{protocol,backend,testing}` (present) + `@jinn-network/task-execution-profiles` (marketplace deployment profile, honor-or-reject, `attested` posture).
- **M4 (projector)** — depends on `@jinn-network/record-discovery-{protocol,serve,client,testing}` + `facts/task-execution` (Phase 3). **Hard gate (ruling §7.21):** M4.1's derivation annotation carries `blockHash`/`finalityTier`/`contractGeneration` — ratified standard additions per record-discovery **Addendum 2026-07-28-c**; M4 hard-gates on verifying at the Phase-3 merge that the discovery plan's implemented annotation schema tolerates them (M4.1 Step 4). M4.5 authors the projector-determinism + reorg suite natively, reusing the discovery kit's `reorged` + `derivation-consistency` vectors as building blocks (no "projector-determinism" export exists to import).
- **M5 (evaluation leg + named checks)** — depends on `@jinn-network/trust-{core,resolve}` (`settlementJoinCheck`, `authenticateRequester`, resolvers) + profiles (`deriveEvaluationTask`, `checkVerdictConsistency`, `checkAdmissionReceipt`). Design §15 step 5: today-mode fallback runs the checks on whatever binding statements exist and is advisory where identity cannot resolve.
- **M6 (pipeline)** — depends on `@jinn-network/task-execution-backend-local` (the assembly + two-party engagement entry, Phase 4). **Also requires the TEP-tree engagement widening** — the `TaskExecutionBackend` interface's optional third `engagement` parameter on `submit` (`@jinn-network/task-execution-backend`) AND the `@jinn-network/task-execution-testing` in-memory fake honoring that 3rd `engagement` param (M6.2 tests against the fake) — per **TEP Addendum 2026-07-28-b** (authorized widening), landed in the TEP tree at Phase-4 start, before backend-local Milestone C. This widening is **not** in merged Phase 2 (the line-11 dependency block marks Phase 2 "COMPLETE and merged" for the 2-arg `submit`); M6 must not assume the merged Phase-2 fake already honors the 3rd param.
- **M7 (contract revision)** — depends only on the `contracts/` Hardhat toolchain (confirm the Hardhat 3 migration PR #996 has merged before starting — MEMORY: contracts-hardhat3-migration).

If a consumed symbol is renamed by a sibling plan at implementation, update the affected task's Consumes block and re-run the guard.

## Package and file structure

```text
packages/marketplace/                      (working names settled here — Finding F7)
  binding/                                 @jinn-network/marketplace-binding
    package.json  tsconfig.json  tsconfig.build.json  yarn.lock  README.md
    scripts/pack-smoke.mjs
    fixtures/                              pinned-digest goldens (broadcast-intent record, correspondence payload, Attempt-URI agreement)
    src/
      order.ts  canonical-json.ts          per-package sealing for backend-internal canonical bytes only (§7.1)
      generation.ts                        ContractGeneration seam + per-generation config (§5.4)
      addresses.ts                         deployed today-mode addresses + chain config (base sepolia)
      attempt-uri.ts                       MARKETPLACE_BINDING_NAME + tuple normalization → deriveAttemptUri (consumes protocol export)
      abis/                                 today-mode ABIs (JinnRouterV3, TaskCoordinator, MechMarketplace) — re-homed
      venue/                               re-homed mech venue verbs (from client/src/adapters/mech/*)
        ipfs.ts  ipfs-pinfile.ts  safe.ts  safe-revert.ts  digest.ts  verdict-code.ts
      posting.ts                           document translation + posting (broadcast-intent) §6.1
      broadcast-intent.ts                  intent WAL + recovery scan (honors 2026-07-24 design)
      claim.ts                             claim leg + pre-claim capability/preflight §6.2
      delivery.ts                          envelope convergence + correspondence check §6.3
      settlement.ts                        delivery-claim / fee-release / activity-credit / race-loss mapping §6.3
      honor-or-reject.ts                   today-mode symmetric honor-or-reject §6.1
      named-checks.ts                      the §6.4 named-check gate (invokes trust + profiles primitives)
      backend.ts                           the requester-facing TaskExecutionBackend impl (submit/observe/…)
      capabilities.ts                      capabilities() incl. runPinning attested posture + today-mode bounds §7
      index.ts                             public surface
  projector/                               @jinn-network/marketplace-projector
    package.json … src/
      order.ts  canonical-json.ts          (if any projector-internal canonical bytes)
      events.ts                            chain log decoding (both generations) §8
      derivation.ts                        derivation annotation {chainId,contract,event,blockNumber,blockHash,txHash,logIndex,finalityTier,contractGeneration} §8
      observe.ts                           chain events → TEP observations §8
      announce.ts                          chain events → signed announcements (via record-discovery-serve) §8
      finality.ts                          safe/finalized policy + reorg corrections §8
      censorship-crosscheck.ts             single-projector on-chain TaskCreated cross-check §8
      index.ts
  pipeline/                                @jinn-network/marketplace-pipeline (daemon marketplace application; LIBRARY)
    package.json … src/
      claim-predicate.ts                   pluggable operator predicate over (facts, capabilities, caps) §7
      execution-wiring.ts                  work-kind → (harness, model, plugins, credential) config shape §7
      caps.ts                              spend / AI-unit self-protection caps §7
      engage.ts                            two-party engagement: mint URI + build dispatch-context, call assembly entry §6.2
      pipeline.ts                          compose binding venue verbs + embedded backend (peer, §7.18)
      carve.ts                             §9 disposition map (documentation-as-code: state→owner table asserted by test)
      index.ts
  testing/                                 @jinn-network/marketplace-testing (conformance; consumes TEP + discovery kits)
    package.json … src/
      index.ts
      backend-conformance.ts               un-parameterized core-kit sanity + native §16.2 profile conformance vs the requester-facing binding
      projector-conformance.ts             native projector-determinism + reorg suite (reuses discovery's reorged + derivation-consistency vectors)
      escrow-lifecycle.ts                  anvil-fork escrow-lifecycle fixtures (both generations) §13
      attempt-uri-agreement.ts             requester/operator/third-party independent URI agreement §13
      named-check-fixtures.ts              §7.5a/§7.5b (reused from trust kit) + derivation/verdict-mapping §13
    fixtures/                              golden events, reorg scenarios, escrow scenarios

contracts/                                 (the §5 revision — Solidity code + Hardhat tests; NO deploy)
  src/tasks/TaskCoordinatorV4.sol          revised recorder (attemptIndex split, reservation escrow, closeTask/releaseAttempt/addAttempts) §5
  src/staking/JinnRouterV4.sol             revised router (reservation-not-claim-spend, event completeness, verdict-from-Statement) §5
  test/marketplace-revision/*.t.ts         Hardhat tests for the §13 escrow-lifecycle invariants

.github/scripts/                           (created here:)
  marketplace-package-inventory.test.mjs
  marketplace-source-boundaries.test.mjs
  marketplace-packed-types.test.mjs
.github/workflows/marketplace-ci.yml
```

## Out of scope

Named so no task drifts into them (design §16 "Explicit non-goals"; §14 declared impact; program §9):

- **Live daemon TaskEngine cutover / consumption swap.** The design §9 carve is the disposition (built as `pipeline/src/carve.ts` documentation-as-code), but wiring the pipeline into the running `client/src/daemon/*` + migrating the live `TaskEngine` states **waits on the migration-mechanics / operator-daemon-composition design session** (program §9 remaining pending session). This plan builds `pipeline` as a composition LIBRARY, proven by tests, not a live cutover.
- **Any on-chain deployment.** The contract-revision Solidity + Hardhat kit are M7; the Base Sepolia redeploy and the generation flip are the human-gated M8 runbook — never an executing task (program §9).
- **Settlement economics, challenge mechanism, evaluator incentives (Phase B.2).** The design defers consequence-channel selection, evaluator economics, and the assert/dispute/settle challenge shape (design §16/§17). No token mechanics (DR-2026-06-30).
- **Reputation scoring policy; benchmarking (next design session); knowledge pricing; operator-app UI detail** (design §16; spec impact declared only).
- **The discovery query-plane service and subscribe relay.** NOT pulled into scope by the design (Finding F5); the projector produces announcements consumed by the query layer above, which this plan does not build.
- **The trust adoption-authorization object.** NOT pulled into scope (Finding F5); adoption maps to the Application (Autopilot) layer (§9 carve); this plan surfaces delivery + receipt observations only.
- **The two spun-off drift-bug tasks** (stale revert-classifier; unreachable-refund) — already separate issues (design §14); referenced, not re-done here.
- **`x402` resource-serving edges** (design §3 audit: out of scope at the binding layer).
- **Live `jinn` CLI + daemon wiring.** The design §9/§14 declares that new consumer surfaces land as **SDK schemas + `jinn` CLI commands** honoring the pinned CLI-only external-consumer boundary (`2026-07-24-marketplace-external-consumer-boundary-design.md` — no key material or tx client in the SDK; Safe/keystore stays CLI-side; verification profiles fail closed). The marketplace **packages ARE the SDK** (built here); wiring the posting/observe/lifecycle CLI commands into the live `client/` daemon is part of the daemon consumption swap and **waits on the migration-mechanics session** (same deferral as the TaskEngine cutover). Nothing in this plan puts key material or a tx client into an SDK surface.

---

# Milestone M0 — Marketplace tree scaffold + guard clone + generation seam

Delivers the four standalone package skeletons (`binding`, `projector`, `pipeline`, `testing`), the marketplace guard trio + CI workflow (enumerating the four packages), per-package sealing utilities for the binding's backend-internal canonical bytes, and the frozen `ContractGeneration` seam + deployed-address config. Frozen interfaces exercised: §5.4 generation seam; §12 package layout.

## Task M0.1: Four package skeletons + guard clone

**Files:**
- Create `binding` project: `packages/marketplace/binding/{package.json,.yarnrc.yml,tsconfig.json,tsconfig.build.json,vitest.config.ts,scripts/build.mjs,scripts/pack-smoke.mjs,README.md}` + `src/index.ts` (stub `export {};`)
- Create `projector` project: `packages/marketplace/projector/{…}` + `src/index.ts` (stub)
- Create `pipeline` project: `packages/marketplace/pipeline/{…}` + `src/index.ts` (stub)
- Create `testing` project: `packages/marketplace/testing/{…}` + `src/index.ts` (stub)
- Create: `.github/scripts/marketplace-package-inventory.test.mjs`
- Create: `.github/scripts/marketplace-source-boundaries.test.mjs`
- Create: `.github/scripts/marketplace-packed-types.test.mjs`
- Create: `.github/workflows/marketplace-ci.yml`

**Interfaces:**
- Produces: the four package directories + the guard files later M0.x/M1–M6 tasks extend as they register modules; the four npm names `@jinn-network/marketplace-{binding,projector,pipeline,testing}`.

- [ ] **Step 1: Write each `package.json`.** Model on `packages/evidence/execution-recorder/package.json` field-for-field. Names + dependency edges (declared `0.1.0` semver + mirrored `portal:` resolutions):
  - **binding** — `@jinn-network/marketplace-binding`; deps `@jinn-network/task-execution-protocol`, `@jinn-network/task-execution-backend`, `@jinn-network/task-execution-profiles`, `@jinn-network/trust-core`, `@jinn-network/trust-resolve`, `viem`, `@noble/hashes`, `zod`; devDep `@jinn-network/marketplace-testing`.
  - **projector** — `@jinn-network/marketplace-projector`; deps `@jinn-network/task-execution-protocol`, `@jinn-network/record-discovery-protocol`, `@jinn-network/record-discovery-serve`, `@jinn-network/marketplace-binding` (for the shared ABIs/event decoders + generation seam), `viem`, `@noble/hashes`; devDep `@jinn-network/marketplace-testing`, `@jinn-network/record-discovery-testing`.
  - **pipeline** — `@jinn-network/marketplace-pipeline`; deps `@jinn-network/task-execution-protocol`, `@jinn-network/task-execution-backend`, `@jinn-network/task-execution-backend-local`, `@jinn-network/marketplace-binding`; devDep `@jinn-network/marketplace-testing`.
  - **testing** — `@jinn-network/marketplace-testing`; production deps `@jinn-network/marketplace-binding`, `@jinn-network/marketplace-projector` (the kit runs against them), `@jinn-network/task-execution-testing` (runs the TEP core kit `describeTaskExecutionBackendContract` **un-parameterized** as a sanity suite, ruling §7.19), `@jinn-network/record-discovery-testing` (reuses its `reorged` + `derivation-consistency` conformance vectors as **building blocks** for the natively-authored §16.2 profile + projector-determinism suites), `viem`; devDep none. Component packages consume `testing` as devDependency only — no production cycle (evidence `local-runtime` precedent; program §7.5 shape).
- [ ] **Step 2: Copy `.yarnrc.yml`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `scripts/build.mjs`** verbatim from `packages/evidence/execution-recorder/` (package-generic). Rewrite each `scripts/pack-smoke.mjs` to pack that package + its portal deps into a synthetic consumer.
- [ ] **Step 3: Write each `src/index.ts` stub** (`export {};`) so typecheck/build succeed.
- [ ] **Step 4: Clone the inventory guard** to `.github/scripts/marketplace-package-inventory.test.mjs`. Copy `.github/scripts/evidence-package-inventory.test.mjs` verbatim, swap the constant blocks: `packageRoot` → `join(root,'packages','marketplace')`; `MARKETPLACE_PACKAGES = [['binding','@jinn-network/marketplace-binding'],['projector','@jinn-network/marketplace-projector'],['pipeline','@jinn-network/marketplace-pipeline'],['testing','@jinn-network/marketplace-testing']]`; the `JINN_DEPENDENCY_GRAPH` with each package's declared deps/devDeps from Step 1; the count assertion `assert.equal(MARKETPLACE_PACKAGES.length, 4)`; the tree-scan regex `/^@jinn-network\/marketplace-/`. **Extend `expectedPortal` to permit cross-tree portals** for `@jinn-network/task-execution-*`, `@jinn-network/trust-*`, `@jinn-network/record-discovery-*` (compute the relative path from each marketplace package to the sibling tree). Drop the evidence-specific optional-peer test.
- [ ] **Step 5: Clone the source-boundaries guard** to `.github/scripts/marketplace-source-boundaries.test.mjs`. Copy `.github/scripts/task-execution-source-boundaries.test.mjs` verbatim (the generic scanner helpers + the two scanner self-tests + the locale-sensitive-API self-test transfer unchanged). Then set: `packages` → `join(root,'packages','marketplace')`; `marketplaceDirectories = ['binding','projector','pipeline','testing']`. Keep `APPLICATION_AND_LEGACY_ROOTS`. Fill the **per-package one-way import allowlist** (the tree's dependency DAG — enforces §12 + ruling §7.18):
  - `binding` may import `@jinn-network/task-execution-{protocol,backend,profiles}`, `@jinn-network/trust-{core,resolve}`, `viem`, `@noble/hashes`, `zod`, `node:*`, and its own `./…`. It may NOT import `@jinn-network/task-execution-{supervisor,workspace,launchers,backend-local}` (ruling §7.18 — the binding is a peer, not an embedder), NOT `@jinn-network/marketplace-{projector,pipeline}`, NOT any `@jinn-network/record-discovery-*`, NOT any application tree.
  - `projector` may import `@jinn-network/task-execution-protocol`, `@jinn-network/record-discovery-{protocol,serve}`, `@jinn-network/marketplace-binding`, `viem`, `@noble/hashes`; NOT `@jinn-network/marketplace-pipeline`, NOT `trust-*`, NOT the local-backend packages.
  - `pipeline` may import `@jinn-network/task-execution-{protocol,backend,backend-local}`, `@jinn-network/marketplace-binding`, `node:*`; NOT `@jinn-network/task-execution-{supervisor,workspace,launchers}` (ruling §7.18 — assembly only), NOT `@jinn-network/marketplace-projector`, NOT `trust-*`/`record-discovery-*` directly.
  - `testing` may import `@jinn-network/marketplace-{binding,projector}`, `@jinn-network/task-execution-testing`, `@jinn-network/record-discovery-testing`, `viem`.
  - Add the cross-tree assertion (ruling §7.18): assert no marketplace package imports `@jinn-network/task-execution-{supervisor,workspace,launchers}` (only `-backend-local` [the assembly] is permitted, and only in `pipeline`). Assert each package's `exports` map is a single `.` entry.
- [ ] **Step 6: Clone the packed-types guard** to `.github/scripts/marketplace-packed-types.test.mjs`. Copy `.github/scripts/task-execution-packed-types.test.mjs`, swap `evidenceRoot`/`packages` → `packages/marketplace` + the four `[dir,name]` pairs; `codeEntrypoints` → the four package names; update the final log line.
- [ ] **Step 7: Clone the CI workflow** to `.github/workflows/marketplace-ci.yml`. `name: Marketplace CI`; `paths` triggers `packages/marketplace/**`, `.github/scripts/marketplace-*.test.mjs`, `.github/workflows/marketplace-ci.yml`, and `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md`. An `architecture` job running both guard scripts; four package jobs mirroring the DAG (`binding` needs the cross-tree portal builds of task-execution/trust; `projector` needs record-discovery + binding; `pipeline` needs backend-local + binding; `testing` needs all). **Cross-tree portal build (ruling §7.8):** each job builds its cross-tree portal dependencies from source before install (e.g. `(cd packages/task-execution/protocol && corepack yarn install --immutable && corepack yarn build)` for every portal dep). A `verify` job (`needs:` all, `if: always()`) asserts all succeeded, then runs the packed-types guard.
- [ ] **Step 8: Run the guards.** `node --test .github/scripts/marketplace-package-inventory.test.mjs .github/scripts/marketplace-source-boundaries.test.mjs` → both pass (inventory sees exactly four; boundary self-tests pass; stubs import nothing).
- [ ] **Step 9: Typecheck + build each skeleton.** In each package: `yarn install && yarn typecheck && yarn build` → zero errors.
- [ ] **Step 10: Commit.** `git add packages/marketplace .github/scripts/marketplace-*.test.mjs .github/workflows/marketplace-ci.yml && git commit -m "feat(marketplace): scaffold binding/projector/pipeline/testing + tree guard clone"`

## Task M0.2: Per-package sealing utilities (binding backend-internal canonical bytes)

**Files:**
- Create: `packages/marketplace/binding/src/order.ts`, `src/order.test.ts`
- Create: `packages/marketplace/binding/src/canonical-json.ts`, `src/canonical-json.test.ts`
- Create: `packages/marketplace/binding/fixtures/canonical-equivalence.json`, `src/canonical-equivalence.test.ts`

**Interfaces:**
- Produces: `compareCodeUnitStrings(l,r): -1|0|1` (verbatim copy of `packages/evidence/execution-recorder/src/order.ts`); `serializeCanonical(value: unknown): string` (JCS-style deterministic JSON via `compareCodeUnitStrings` for object-key order; explicit sorted-key iteration — never `JSON.stringify` insertion order; rejects non-I-JSON-integer numbers).

- [ ] **Step 1: Write the failing `order.test.ts` + `canonical-json.test.ts`** (mirror the local-backend A1 tests): `compareCodeUnitStrings("Z","a") === -1`; `serializeCanonical({b:1,a:2,Z:3}) === '{"Z":3,"a":2,"b":1}'`; integer-like keys ordered by code unit (`serializeCanonical({"10":1,"2":2}) === '{"10":1,"2":2}'`); byte-identical across structurally-equal objects.
- [ ] **Step 2: Run → FAIL** (modules not found).
- [ ] **Step 3: Copy `order.ts` verbatim** from `packages/evidence/execution-recorder/src/order.ts`; write `canonical-json.ts` using `compareCodeUnitStrings` for key order, explicit sorted-key emission, and a safe-integer guard on every number (program §7.14). No `localeCompare`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Write the equivalence fixture + test.** `canonical-equivalence.json` holds one object-key-sort-sensitive record (keys out of source order) and one integer-like-key record, each with its pinned sha256 (`sha256Hex(new TextEncoder().encode(serializeCanonical(record)))`). `canonical-equivalence.test.ts` asserts the pinned digests. Add a comment + a documented assertion that the marketplace tree produces **no new sealed TEP/discovery family** — TEP documents are sealed by `@jinn-network/task-execution-protocol`, announcements by `@jinn-network/record-discovery-serve` — so no one adds a duplicate serializer (program §7.15 discipline). Fill the pinned digests after the first run.
- [ ] **Step 6: Run the locale-ban guard** from repo root → PASS. Commit: `git commit -m "feat(marketplace): binding backend-internal sealing utils + equivalence fixture"`

## Task M0.3: The ContractGeneration seam + deployed-address config

**Files:**
- Create: `packages/marketplace/binding/src/generation.ts`, `src/generation.test.ts`
- Create: `packages/marketplace/binding/src/addresses.ts`, `src/addresses.test.ts`

**Interfaces:**
- Produces:
  - `type ContractGeneration = "today" | "revised"` (§5.4, frozen §11.1/§11.6).
  - `type MarketplaceChainConfig = { chainId: number; taskCoordinator: \`0x${string}\`; jinnRouter: \`0x${string}\`; mechMarketplace: \`0x${string}\`; activityChecker: \`0x${string}\`; generation: ContractGeneration }`.
  - `BASE_SEPOLIA_TODAY: MarketplaceChainConfig` — the deployed today-mode addresses (Preflight-confirmed), `generation: "today"`.
  - `selectGeneration(config): ContractGeneration` (a total function; the seam is a single config read, not a branch scattered through the code — §5.4 "flip is config, not rewrite").

- [ ] **Step 1: Write the failing `generation.test.ts` + `addresses.test.ts`.** Assert `ContractGeneration` has exactly the two literals; `BASE_SEPOLIA_TODAY` carries the four Preflight-confirmed addresses + `chainId 84532` + `generation "today"`; `selectGeneration(BASE_SEPOLIA_TODAY) === "today"`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `generation.ts` + `addresses.ts`.** Freeze the two literals; embed the deployed addresses from `contracts/deployment-task-coordinator-router-v3-baseSepolia.json` (do not read the file at runtime — pin the constants). `selectGeneration` returns `config.generation`.
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): ContractGeneration seam + deployed today-mode address config"`

---

# Milestone M1 — Attempt-URI two-party agreement + the two-party engagement entry (companion amendment, named)

Delivers the marketplace binding-name constant, the frozen tuple-normalization rule, the fixture asserting **byte-identical** Attempt URIs against the protocol export (must #2), and the **named exact surface** of the two-party engagement entry the pipeline consumes from the assembly (must #4). This milestone is small but load-bearing: it pins the seam that makes third-party deterministic Attempt identity work, and it surfaces Finding F1 (frozen-interface touch) to the coordinator before the pipeline (M6) freezes.

## Task M1.1: Marketplace Attempt-URI derivation (consumes the protocol export)

**Files:**
- Create: `packages/marketplace/binding/src/attempt-uri.ts`, `src/attempt-uri.test.ts`
- Create: `packages/marketplace/binding/fixtures/attempt-uri-agreement.json`

**Interfaces:**
- Consumes: `deriveAttemptUri`, `TEP_ATTEMPT_NAMESPACE`, `isValidUrnUuid` from `@jinn-network/task-execution-protocol` (program §7.2).
- Produces:
  - `MARKETPLACE_BINDING_NAME = "jinn:marketplace"` (frozen; matches the protocol package's own `identifiers.test.ts` pin, TEP plan Task 1.3 Step 2).
  - `normalizeAttemptTuple(input: { chainId: number; coordinator: \`0x${string}\`; taskId: bigint; attemptIndex: number }): readonly (string | number)[]` — the **frozen tuple-normalization rule**: `[chainId (number), coordinator.toLowerCase() (0x-hex string), taskId.toString() (decimal), attemptIndex.toString() (decimal)]`. Lowercasing + decimal stringification is frozen so requester, operator, and any third party produce byte-identical name bytes (design §6.2/§16.2).
  - `deriveMarketplaceAttemptUri(input): \`urn:uuid:${string}\`` = `deriveAttemptUri(MARKETPLACE_BINDING_NAME, normalizeAttemptTuple(input))` — a thin call into the protocol export; **no UUIDv5 code here**.

- [ ] **Step 1: Write the failing `attempt-uri.test.ts`.** Cases: (a) `deriveMarketplaceAttemptUri({chainId:84532, coordinator:"0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98", taskId:1n, attemptIndex:0})` equals `deriveAttemptUri("jinn:marketplace", [84532, "0x8a34793e10595c89b7e41cc7ff0f76850f44ad98", "1", "0"])` **byte-for-byte** (proves the binding calls the protocol export, never re-derives — must #2); (b) it is a valid `urn:uuid` via `isValidUrnUuid`; (c) checksum vs lowercase coordinator produce the **same** URI (normalization freeze); (d) `attemptIndex` 0 vs 1 → distinct URIs (never colliding across a released/re-claimed slot, §5.2). Load the pinned value from `attempt-uri-agreement.json`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `attempt-uri.ts`** as above — a thin adapter over the protocol export. Assert (in a comment + a type-level check) that no `sha1`/UUID construction appears here.
- [ ] **Step 4: Populate `attempt-uri-agreement.json`** with the pinned URI for the canonical marketplace tuple `(84532, taskCoordinator, taskId=1, attemptIndex=0)`, computed once via the implementation. The marketplace tuple `(84532, taskCoordinator, 1, 0)` is **distinct** from the protocol package's illustrative `identifiers` fixture tuple (a mainnet-shaped placeholder) — they never coincide — so byte-identity is proven **only** by test case (a): `deriveMarketplaceAttemptUri` equals `deriveAttemptUri` over the normalized marketplace tuple, which is sufficient. Re-run → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(marketplace): marketplace Attempt-URI derivation via protocol export + agreement fixture"`

## Task M1.2: Name the two-party engagement entry + surface the frozen-interface finding

**Files:**
- Create: `packages/marketplace/binding/src/two-party-engagement.ts` (the consumed surface, type-only re-declaration for the binding side), `src/two-party-engagement.test.ts`
- Create: `docs/superpowers/plans/2026-07-28-marketplace-binding.md` **already this file** — record Finding F1 in the Findings section below (no code).

**Interfaces:**
- Consumes: `AttemptUri` from `@jinn-network/task-execution-backend` (`backend/src/types.ts` — the `AttemptUri`/`SubmissionUri`/`DeliveryRef` URI types live in the backend package, NOT protocol); `DispatchContext` from `@jinn-network/task-execution-protocol` (a protocol type, TEP §9.3). The binding depends on `-backend` so both imports resolve.
- Produces (the **exact named surface** the pipeline hands to the assembly, must #4):
  - `type TwoPartyEngagement = { attemptUri: AttemptUri; dispatchContext: DispatchContext }` where `AttemptUri` is the `@jinn-network/task-execution-backend` type and `DispatchContext` is the `@jinn-network/task-execution-protocol` type. `attemptUri` is the caller-minted deterministic URI (M1.1); `dispatchContext` is the caller-built `{ taskDigest, submission, nonce, attempt }` (TEP §9.3).
  - The **consumption contract**: the assembly's engagement entry is `submit(taskBytes, submissionBytes, engagement?: TwoPartyEngagement): Promise<SubmissionAck>` — a THIRD optional parameter on the standard `TaskExecutionBackend.submit`. When `engagement` is present the backend **adopts** `engagement.attemptUri` (validating format via `isValidUrnUuid`) and records `engagement.dispatchContext` verbatim instead of minting a random `urn:uuid`; when absent it mints as today (single-party path). This is the entry the local-backend plan Addendum 2026-07-28-b builds into Milestone C from day one.

- [ ] **Step 1: Write a type-shape test** `two-party-engagement.test.ts` asserting `TwoPartyEngagement` carries exactly `{ attemptUri, dispatchContext }` and that a constructed value with a `deriveMarketplaceAttemptUri` URI + a `{taskDigest,submission,nonce,attempt}` dispatch-context typechecks against the `AttemptUri` type (from `@jinn-network/task-execution-backend`) and the `DispatchContext` type (from `@jinn-network/task-execution-protocol`). (No backend call here — that is M6; this task pins the SHAPE and surfaces the finding.)
- [ ] **Step 2: Run → FAIL** (types absent).
- [ ] **Step 3: Write `two-party-engagement.ts`** as the type-only binding-side declaration of the consumed surface. Document in a doc-comment: this shape is the companion-amendment surface; the CONCRETE entry lives on the assembly's `submit` third parameter (local-backend Milestone C); this module is the binding's consumed view, not a re-implementation.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Confirm the finding is recorded.** Verify Finding F1 (below) states: the two-party entry **touches the already-implemented frozen `TaskExecutionBackend` interface** (`packages/task-execution/backend/src/backend.ts:37`, `submit(taskBytes, submissionBytes): Promise<SubmissionAck>`) by adding an optional third `engagement` parameter; because that interface is frozen-and-merged (Phase 2) and ruling §7.18 pins that the binding consumes **only** through the standard interface and hands bytes to `submit` (so a separate `engage()` method is disallowed), the widening is the only faithful realization and MUST be dispositioned by the coordinator as a dated addendum to the TEP plan/design — never silently widened. Do not edit `backend/src/backend.ts` in this plan.
- [ ] **Step 6: Commit.** `git commit -m "feat(marketplace): name the two-party engagement entry surface (companion amendment)"`

---

# Milestone M2 — Binding document layer + posting (today-mode) + requester-facing TaskExecutionBackend

Delivers the requester side of the binding: document translation (consuming the protocol sealers), IPFS upload as raw-codec CIDs with the digest-join enforcement (§6.1), posting one transaction with anchors + escrow honoring the broadcast-intent protocol (§6.1), today-mode symmetric honor-or-reject (§6.1), `capabilities()` with the `attested` run-pinning posture + today-mode bounds (§7), and the `submit`/`recover`/`observe`/`deliveries`/`fetchDelivery` verbs of the requester-facing `TaskExecutionBackend`. Re-homes the mech venue verbs from `client/src/adapters/mech/*`. Frozen interfaces: §6.1 posting + digest-join; §11.12 honor-or-reject symmetry.

## Task M2.1: Re-home the mech venue verbs

**Files:**
- Create: `packages/marketplace/binding/src/venue/{ipfs.ts,ipfs-pinfile.ts,safe.ts,safe-revert.ts,digest.ts,verdict-code.ts}` + `src/venue/*.test.ts`
- Create: `packages/marketplace/binding/src/abis/{jinn-router-v3.ts,task-coordinator.ts,mech-marketplace.ts}` (today-mode ABIs)

**Interfaces:**
- Consumes: the source surfaces at `client/src/adapters/mech/{ipfs.ts,ipfs-pinfile.ts,safe.ts,safe-revert.ts,digest.ts,verdict-code.ts,contracts.ts,types.ts}` — copied and adapted, NOT imported (the marketplace tree is standalone; the client copies are legacy).
- Produces:
  - `uploadRawCodecCid(bytes): Promise<{ cid: string; sha256Digest: \`sha256:${string}\` }>` — raw-codec CIDv1 where the CID digest **equals** sha256 of the exact bytes (design §3 audit "CIDv1 raw-codec convention"; the Autonolas dag-pb hashing is the cautionary counterexample — assert the equality in a fixture).
  - `keccakEvidenceHash(sealedBytes): \`0x${string}\`` — keccak256 over the exact sealed Delivery bytes (the deployed router's today-mode evidence-hash scheme, §6.3); a binding-internal digest, not a stack seal.
  - the Safe-routed tx helpers (`buildSafeTx`, inner-revert classification) and the today-mode ABIs for `JinnRouterV3`/`TaskCoordinator`/`MechMarketplace`.

- [ ] **Step 1: Write the failing `ipfs.test.ts`** asserting `uploadRawCodecCid(bytes)` returns a CID whose multihash digest equals `sha256Hex(bytes)` (raw codec, no dag-pb wrapping) — the identity-equals-CID-digest invariant (§3 audit). Use a fixture byte string; stub the gateway upload.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Copy + adapt the venue modules** from `client/src/adapters/mech/*` into `src/venue/`, replacing client-config coupling with the `MarketplaceChainConfig` (M0.3). Extract the today-mode ABIs into `src/abis/` (from `client/src/adapters/mech/types.ts` / `contracts/deployment-*.json`). Keep the zero-evidence-hash guard from the source (survives verbatim, §6.3).
- [ ] **Step 4: Run → PASS.** Add a `digest.test.ts` asserting `keccakEvidenceHash(sealed)` matches the deployed router's expectation for a golden envelope (pin the keccak).
- [ ] **Step 5: Run the source-boundaries guard** (`viem`/`@noble/hashes`/`node:*` are allowed in `binding`; no `record-discovery-*` import). Commit: `git commit -m "feat(marketplace): re-home mech venue verbs + today-mode ABIs into binding"`

## Task M2.2: Today-mode symmetric honor-or-reject

**Files:**
- Create: `packages/marketplace/binding/src/honor-or-reject.ts`, `src/honor-or-reject.test.ts`

**Interfaces:**
- Consumes: `mergeRequirements`, `EffectiveRequirements`, the error-category enum + `TaskExecutionError` from `@jinn-network/task-execution-{protocol,backend}`; the resolved marketplace deployment profile + `requirementKeys` classes from `@jinn-network/task-execution-profiles`.
- Produces: `honorOrRejectToday(submission: SubmissionRecord, effective: EffectiveRequirements, capabilities: BackendCapabilities): { ok: true } | { ok: false; category: "unsupported-requirement"; key: string }` — the today-mode gate. Rejects (§6.1, frozen §11.12): `minVerdicts > 1` (today finalizes on first verdict); `maxConcurrent > maxTotal` (today enforces only `maxClaims == maxTotal`); and a **`closeAt` requirement** — today-mode has no on-chain claim window and therefore cannot genuinely enforce a close deadline, so `closeAt` is rejected with `unsupported-requirement` (ruling §7.20 adjudication; the former budget-refund + announcement-withdrawal "approximation" is DROPPED — it is weak/partial honoring, which TEP §8 forbids, and a chain-direct claim can still land after `closeAt`). This makes today-mode behave identically to backend-local C1. `closeAt` is honored only in revised-mode (the on-chain claim window, M7.3).

- [ ] **Step 1: Write the failing test.** `minVerdicts:2` → `{ok:false, key:"evaluationRequirements.minVerdicts"}`; `attempts:{maxTotal:2,maxConcurrent:3}` → `{ok:false, key:"attempts.maxConcurrent"}`; `attempts:{maxTotal:3,maxConcurrent:1}` → `{ok:true}`; a Submission carrying a `closeAt` requirement → `{ok:false, key:"closeAt"}` (today-mode cannot enforce a close deadline — ruling §7.20; symmetric with backend-local C1); a Submission whose run-pinning key is absent from `capabilities().runPinning` inventory → `{ok:false, key:"<pin key>"}` (delegated to the capability check per program §7.3 — this pure gate raises the finalization/concurrency/`closeAt` mismatches, and the capability check raises pin-inventory misses; keep the two producers distinct).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `honor-or-reject.ts`** exactly per §6.1. It reads today-mode bounds from `capabilities()` (M2.4). It never silently client-honors a stricter `maxConcurrent`.
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): today-mode symmetric honor-or-reject (§6.1)"`

## Task M2.3: Broadcast-intent WAL + posting

**Files:**
- Create: `packages/marketplace/binding/src/broadcast-intent.ts`, `src/broadcast-intent.test.ts`
- Create: `packages/marketplace/binding/src/posting.ts`, `src/posting.test.ts`

**Interfaces:**
- Consumes: the protocol Task/Submission sealers + `documentDigest` (`@jinn-network/task-execution-protocol`); `uploadRawCodecCid`, the Safe-routed tx helpers, `JinnRouterV3` ABI (M2.1); `serializeCanonical` (M0.2) for the intent record; `honorOrRejectToday` (M2.2).
- Produces:
  - `type PostingIntent = { creatorSafe: \`0x${string}\`; taskCidDigest: \`sha256:${string}\`; submissionDigest: \`sha256:${string}\`; idempotencyKey: string; createdAt: string }` — the broadcast-intent record persisted **before** broadcast (honors `2026-07-24-task-post-broadcast-intent-design.md`; at-most-once).
  - `recoverPostingIntents(scan): Promise<PostingIntent[]>` — the recovery scan re-keyed by SolverNet dissolution onto `(creator Safe, Task CID digest, Submission digest)` in place of the retired manifest-digest leg (§6.1 — at-most-once preserved and strengthened).
  - `postTask(task: SealedDoc, submission: SealedDoc, config: MarketplaceChainConfig, ports): Promise<{ taskId: bigint; txHash: \`0x${string}\` }>` — today-mode: uploads both as raw-codec CIDs, persists the intent, posts one tx with the task-digest anchor + two-rail escrow (`msg.value == (solutionRate + verdictRate) × maxClaims`), enforcing the digest-join `Submission.referencedTaskDigest == taskCidDigest == sha256(task bytes)` before broadcast (§6.1). Today-mode divergence marked: only the task digest is anchored on-chain; the Submission's terms ride in the signed announcement (M4) verified off-chain.

- [ ] **Step 1: Write the failing `broadcast-intent.test.ts`.** Intent is persisted before the (stubbed) broadcast; a crash between persist and broadcast leaves exactly one recoverable intent keyed `(creatorSafe, taskCidDigest, submissionDigest)`; a completed post clears it; re-running `postTask` with the same idempotency key does not double-post (at-most-once).
- [ ] **Step 2: Write the failing `posting.test.ts`.** `postTask` uploads both docs as raw-codec CIDs (CID digest == sha256 of bytes); enforces the digest-join (a Submission referencing a different task digest → rejects `invalid-document` before broadcast); today-mode anchors only the task digest; escrow value equals `(solutionRate + verdictRate) × maxClaims`.
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Write `broadcast-intent.ts` + `posting.ts`** per §6.1, honoring the 2026-07-24 broadcast-intent design (intent persisted before broadcast; recovery scan after; at-most-once). Mark the today-mode divergence in code comments (only task digest anchored; Submission terms via announcement + off-chain verification).
- [ ] **Step 5: Run → PASS. Commit.** `git commit -m "feat(marketplace): broadcast-intent WAL + today-mode posting with digest-join (§6.1)"`

## Task M2.4: capabilities() with the attested run-pinning posture + requester-facing backend verbs

**Files:**
- Create: `packages/marketplace/binding/src/capabilities.ts`, `src/capabilities.test.ts`
- Create: `packages/marketplace/binding/src/backend.ts`, `src/backend.test.ts`

**Interfaces:**
- Consumes: `BackendCapabilities` (with the `runPinning` block, `@jinn-network/task-execution-backend`); the `TestableBackend` seam type (`@jinn-network/task-execution-testing`); the marketplace deployment profile + `attested` posture data (`@jinn-network/task-execution-profiles`); `postTask` + `honorOrRejectToday` (M2.2/M2.3); the projector's `observe` surface (M4, injected as a port so M2 does not depend on M4); `uploadRawCodecCid`/IPFS fetch (M2.1).
- Produces:
  - `marketplaceCapabilities(config): Promise<BackendCapabilities>` — declares the today-mode bounds (`maxConcurrent == maxTotal`; first-verdict finalization) and carries the `runPinning` block with the **`attested` posture** (profiles §5.2): pinning is conveyed to claimants as a claim-eligibility constraint and verified after-the-fact against the Evidence Runtime Observation (a pin violation is invalid **consumer-side**, never a protocol state, §7).
  - `makeMarketplaceBackend(config, ports): TestableBackend` — the requester-facing implementation: `submit(taskBytes, submissionBytes)` = validate + seal-check both, `mergeRequirements` → `honorOrRejectToday` → `postTask` (broadcast-intent) → `SubmissionAck`; `observe` = project from chain via the injected projector; `deliveries`/`fetchDelivery` = chain + IPFS fetch; `cancel` = `closeTask`/`releaseAttempt` (M3.4); `recover` = `recoverPostingIntents`; `capabilities` = `marketplaceCapabilities`. `preflight` optional. **It implements the TEP kit's `TestableBackend` seam explicitly** (the test-only `drive`/`recordDelivery`/`simulateReconciliation` verbs, `@jinn-network/task-execution-testing` `fake-backend.ts`) so the core kit can drive lifecycle facts against a chain-venue backend without a bespoke non-conforming verb — required because `describeTaskExecutionBackendContract(makeBackend: () => TestableBackend)` takes no deployment-profile/forkCtx argument (ruling §7.19).

- [ ] **Step 1: Write the failing `capabilities.test.ts`.** Today-mode: `runPinning.posture === "attested"`; `maxConcurrent` bound equals `maxTotal`; first-verdict finalization declared. Write the failing `backend.test.ts`: `submit` of a Submission with `minVerdicts:2` rejects `unsupported-requirement` (honor-or-reject wired); `submit` of a valid pair calls `postTask` and returns an ack carrying the `SubmissionUri`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `capabilities.ts` + `backend.ts`.** The backend is the requester-facing `TaskExecutionBackend`; the projector `observe` + IPFS fetch enter as injected ports (so M2 stands alone; M4 supplies the concrete projector). Mark today-mode divergences.
- [ ] **Step 4: Run → PASS.** Run the TEP core kit's `describeTaskExecutionBackendContract` **un-parameterized** (no profile argument — ruling §7.19) against a **stubbed-chain** `makeMarketplaceBackend`, which satisfies the `TestableBackend` seam (`drive`/`recordDelivery`/`simulateReconciliation`) so the kit can drive lifecycle facts (the full anvil-fork run + the native §16.2 profile conformance are M2.5). This confirms the frozen `TaskExecutionBackend` interface shape conforms.
- [ ] **Step 5: Commit.** `git commit -m "feat(marketplace): capabilities (attested posture) + requester-facing TaskExecutionBackend (§7)"`

## Task M2.5: Native §16.2 marketplace-profile conformance + un-parameterized core-kit sanity on an anvil fork

**Files:**
- Create: `packages/marketplace/testing/src/backend-conformance.ts` (subpath surface)
- Create: `packages/marketplace/testing/src/backend-conformance.test.ts` (drives it on a fork)
- Modify: `.github/scripts/marketplace-packed-types.test.mjs` (register the testing subpath) + `.github/workflows/marketplace-ci.yml` (anvil-fork job)

**Interfaces:**
- Consumes: `describeTaskExecutionBackendContract` (`@jinn-network/task-execution-testing`, run **un-parameterized** as the core sanity suite — it takes no deployment-profile/forkCtx argument, ruling §7.19); the profiles signed-doc / evidence / dispatch-binding / `evaluationSpecification`-digest assertions (`checkAdmissionReceipt`, `sealEvaluationSpec`, the resolved marketplace deployment profile — `@jinn-network/task-execution-profiles`); the trust verification procedures `authenticateRequester` (§7.5b) + `verifyEnvelopeBinding` + the injected resolvers (`@jinn-network/trust-core`, implemented by `@jinn-network/trust-resolve`); `makeMarketplaceBackend` (M2.4, which satisfies the `TestableBackend` seam); the deployed today-mode config.
- Produces: `describeMarketplaceBackendConformance(makeBackend, forkCtx)` — **two layers**, both fork-backed (Anvil fork of Base per §13 "local fork"; escrow lifecycle exercised in M3.5):
  1. **Core sanity suite** — `describeTaskExecutionBackendContract(makeBackend)` run **un-parameterized** (ruling §7.19; `makeBackend` returns a `TestableBackend`), asserting the frozen `TaskExecutionBackend` contract holds over the chain venue (submit → observe → deliveries → fetchDelivery → recover).
  2. **Native §16.2 marketplace-profile conformance** — authored **HERE in `marketplace-testing`** (NOT a re-exposed / profile-parameterized TEP kit — that kit has no profile seam, ruling §7.19 option (b)), asserting the §16.2 profile checks by composing the profiles + trust primitives directly: **signed Tasks + signed Submissions** (DSSE over exact sealed bytes — via `authenticateRequester` / `verifyEnvelopeBinding`); **mandatory evidence** (`executionIds` + `evidenceRecords` REQUIRED on Deliveries); **executor-signed Deliveries** (envelope-binding verification); the **`dispatch-binding`** check (the referenced Execution Evidence crate's captured inputs include the per-Attempt dispatch-context artifact §9.3); and **`evaluationSpecification` digest equality** (the Evidence `evaluationSpecification` digest equal to the Task's sealed `evaluation` descriptor digest — via `sealEvaluationSpec`). TEP §16.2, must #8.

- [ ] **Step 1: Author `backend-conformance.ts`** with the two layers: (a) call `describeTaskExecutionBackendContract(makeBackend)` **un-parameterized** for the core sanity suite (the fork-backed `makeMarketplaceBackend` satisfies the `TestableBackend` seam); (b) author the §16.2 profile assertions **natively** over the profiles + trust primitives (signed docs, mandatory evidence, executor-signed Deliveries, dispatch-binding, `evaluationSpecification` digest equality) — never profile-parameterizing the TEP kit (it has no profile argument, ruling §7.19).
- [ ] **Step 2: Write `backend-conformance.test.ts`** that spawns an Anvil fork of Base Sepolia, funds a creator Safe, and runs both layers (core sanity: submit → observe → deliveries → fetchDelivery; native §16.2 profile: signed docs, mandatory evidence, executor-signed Deliveries, dispatch-binding, `evaluationSpecification` digest equality). Skip cleanly when no RPC (mirror `client/scripts/e2e-validate.ts` skip discipline).
- [ ] **Step 3: Run → PASS** (or skip with a clear message when offline).
- [ ] **Step 4: Register the subpath in packed-types + add the anvil-fork CI job.** Commit: `git commit -m "test(marketplace): native §16.2 profile conformance + un-parameterized core-kit sanity on an anvil fork (§13)"`

---

# Milestone M3 — Claim + delivery + settlement legs (today-mode venue verbs)

Delivers the operator-facing venue verbs: the claim leg (§6.2 — chain `claimTask` → deterministic Attempt URI, pre-claim capability/preflight, post-claim rejection → `releaseAttempt`), the delivery leg (§6.3 — envelope convergence, today-mode keccak evidence-hash computed binding-internal, the mandatory decision-grade sha256↔keccak correspondence check, the zero-evidence-hash guard), and the settlement leg (§6.3 — delivery-claim, fee release, activity credit, race-loss mapping). Also `closeTask`/`releaseAttempt` today-mode approximations (§5.3, §6.1). Frozen interfaces: §6.2 claim; §6.3 delivery convergence + correspondence; §5.3 lifecycle exits.

## Task M3.1: Claim leg + pre-claim capability/preflight

**Files:**
- Create: `packages/marketplace/binding/src/claim.ts`, `src/claim.test.ts`

**Interfaces:**
- Consumes: `deriveMarketplaceAttemptUri` (M1.1); the `AttemptUri` type (`@jinn-network/task-execution-backend`) + the `DispatchContext` type (`@jinn-network/task-execution-protocol`) for the produced signatures; `JinnRouterV3.claimTask(taskId, priorityMech) → (attemptIndex, requestId)` ABI (M2.1); the embedded backend's `capabilities()` + optional `preflight` (via the pipeline's peer composition — injected as a port here so `binding` does not import `backend-local`); the mech `requestId` for correlation annotations.
- Produces:
  - `claimAttempt(taskId, config, ports): Promise<{ attemptIndex: number; attemptUri: AttemptUri; requestId: \`0x${string}\`; dispatchContext: DispatchContext }>` — today-mode: calls `claimTask`, reads `attemptIndex` from the `TaskAttemptCreated` event, derives the Attempt URI (§6.2), builds the dispatch-context `{ taskDigest, submission, nonce, attempt }`. Pre-claim, calls the injected capability-match + `preflight` probe (declared requirements vs declared capabilities vs live readiness — §6.2 made normative) **before spending anything**.
  - `dispatchContextDescriptor(attemptUri, requestId, txHash): unknown` — the correlation-annotation descriptor carried into `attempt-engaged` (§6.2; mech `requestId` + tx hashes ride as correlation annotations, TEP §16.2).

- [ ] **Step 1: Write the failing `claim.test.ts`.** Pre-claim: a capability mismatch or a failing preflight → no `claimTask` call, returns a typed pre-claim rejection (no spend). On success: `attemptUri` equals `deriveMarketplaceAttemptUri({chainId, coordinator, taskId, attemptIndex})`; the dispatch-context names that URI; the `requestId` rides as a correlation annotation.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `claim.ts`.** Pre-claim probe first; then `claimTask`; derive URI via the protocol export (never re-derived). Mark the today-mode note (claim funds the Mech request at claim; the revised-mode reservation-not-spend is M7/§5.2).
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): claim leg + pre-claim capability/preflight (§6.2)"`

## Task M3.2: Delivery convergence + the mandatory correspondence check

**Files:**
- Create: `packages/marketplace/binding/src/delivery.ts`, `src/delivery.test.ts`

**Interfaces:**
- Consumes: the sealed Delivery bytes from the embedded backend (a TEP document sealed by `@jinn-network/task-execution-protocol` under the caller-minted Attempt URI — §6.3; the binding NEVER re-seals); `uploadRawCodecCid` + `keccakEvidenceHash` (M2.1); `JinnRouterV3.claimSolutionDelivery(requestId, solutionDigest)` ABI; the Mech `Deliver` event (sha256 CID digest) + the router keccak, joined by `requestId`.
- Produces:
  - `convergeDelivery(sealedDeliveryBytes): { cid: string; sha256Digest: \`sha256:${string}\`; keccakEvidenceHash: \`0x${string}\` }` — the envelope IS the TEP Delivery under the marketplace deployment profile (one document, not a wrapper, §6.3). Uploads the exact sealed bytes; sha256 is identity everywhere the protocol looks; the keccak is computed binding-internal from the **same** sealed bytes (today-mode).
  - `checkDeliveryCorrespondence(input: { sha256Digest; keccakEvidenceHash; onChainSha256CidDigest; onChainKeccak }): { ok: true } | { ok: false; kind: "digest-divergence"; asserted: {...}; onChain: {...} }` — the **mandatory decision-grade** check (§6.3): a settlement-grade consumer MUST fetch the bytes, recompute both digests, and confirm they match the asserted values and the on-chain keccak. On mismatch, this returns a typed divergence — the projector MUST refuse to emit `delivery-recorded` (N4), never silently pick one digest.
  - The zero-evidence-hash guard survives verbatim (§6.3).
  - **Marketplace-profile Delivery requirements enforced (TEP §16.2):** the converged Delivery MUST carry `executionIds` + `evidenceRecords` (mandatory evidence) and be executor-signed; a settlement-grade consumer additionally requires the profile-named **`dispatch-binding`** Execution Verification check over the referenced Execution Evidence crate (its captured inputs include the per-Attempt dispatch-context artifact §9.3). The binding refuses to treat a Delivery as settlement-grade if the mandatory fields are absent; the `dispatch-binding` check itself is the consumer's Execution Verification (exercised in the marketplace-profile conformance, M2.5).

- [ ] **Step 1: Write the failing `delivery.test.ts`.** `convergeDelivery(sealed)` returns a CID whose digest == sha256(sealed) and a keccak == `keccakEvidenceHash(sealed)`. `checkDeliveryCorrespondence` with matching digests → `{ok:true}`; with a mismatched keccak (a dishonest operator submitting inconsistent digests) → `{ok:false, kind:"digest-divergence"}`. A zero evidence hash → rejected by the guard.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `delivery.ts`** per §6.3. Mark: the correspondence dies with the revision (revised-mode anchors sha256 only); today-mode both digests are on-chain (Mech `Deliver` carries sha256 CID digest, router carries keccak, joined by `requestId`).
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): delivery convergence + mandatory sha256↔keccak correspondence (§6.3)"`

## Task M3.3: Settlement leg + race-loss mapping

**Files:**
- Create: `packages/marketplace/binding/src/settlement.ts`, `src/settlement.test.ts`

**Interfaces:**
- Consumes: `JinnRouterV3.claimSolutionDelivery` ABI; `convergeDelivery` (M3.2); the TEP outcome vocabulary + `AttemptState` (`@jinn-network/task-execution-protocol`).
- Produces:
  - `settleDelivery(attempt, sealedDeliveryBytes, config, ports): Promise<{ settled: boolean; state: AttemptState }>` — binding-internal settlement (delivery claim, fee release, activity credit). First valid delivery wins atomically (unchanged, §5.2).
  - `mapRaceLoss(chainOutcome): AttemptState` — a lost race maps to **what actually happened** (typically `rejected` at claim or delivered-but-unsettled), **never** to failure — preserving today's race-lost discipline in TEP vocabulary (§6.3, kept off failure counters).

- [ ] **Step 1: Write the failing `settlement.test.ts`.** A first-wins delivery settles (`settled:true`, `state:"delivered"`); a race-lost delivery maps to `rejected`/`lost` (per `mapRaceLoss`), never `failed`; a re-claim of an already-settled attempt is idempotent.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `settlement.ts`** per §6.3. Delivered ≠ settled: settlement is binding-internal.
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): settlement leg + race-loss mapping to TEP outcomes (§6.3)"`

## Task M3.4: Lifecycle exits (closeTask / releaseAttempt) — today-mode approximation

**Files:**
- Create: `packages/marketplace/binding/src/lifecycle.ts`, `src/lifecycle.test.ts`

**Interfaces:**
- Consumes: `JinnRouterV3.refundUnusedTaskBudget(taskId)` ABI (today-mode); the announcement-withdrawal port (M4); the revised-mode `closeTask`/`releaseAttempt`/`addAttempts` ABIs (M7 — behind the seam).
- Produces:
  - `closeSubmission(taskId, config, ports): Promise<void>` — the requester's **explicit** close action (an active requester decision, not a pre-committed deadline requirement). Today-mode: budget refund (`refundUnusedTaskBudget`) + announcement withdrawal (honestly weaker than the revised `closeTask`, named §6.1); revised-mode: calls `closeTask` (reap-before-refund; delivery-survives-`Closed`; live reservation untouched — §5.3). Realizes TEP `submission-closed` (reason: requester close). The Submission's `closeAt` **deadline requirement** is **not** realized in today-mode — a `closeAt` requirement is rejected at honor-or-reject (ruling §7.20, M2.2); it is honored only in revised-mode via the on-chain claim window (M7.3).
  - `releaseAttempt(taskId, attemptIndex, config, ports): Promise<void>` — revised-mode only (today has no attempt release; today-mode returns a typed `unsupported` and the operator's abandonment is a named residual §5.2/§10). Cancel of an in-flight attempt is a **request, never a revocation** (§5.3): the requester signals through the protocol cancel flow; a compliant operator releases; no unilateral on-chain revocation.

- [ ] **Step 1: Write the failing `lifecycle.test.ts`.** Today-mode `closeSubmission` calls `refundUnusedTaskBudget` + withdraws the announcement; revised-mode (seam flipped) calls `closeTask`. `releaseAttempt` today-mode → typed `unsupported`; revised-mode → calls the contract. Cancel-as-request: a cancel signal never issues an on-chain revocation.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `lifecycle.ts`** behind the generation seam. Mark the today-mode weakness honestly (approximation, not the airtight `closeTask`).
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): lifecycle exits (closeTask/releaseAttempt) behind the generation seam (§5.3)"`

## Task M3.5: Escrow-lifecycle fixtures on an anvil fork (today generation)

**Files:**
- Create: `packages/marketplace/testing/src/escrow-lifecycle.ts`, `src/escrow-lifecycle.test.ts`
- Create: `packages/marketplace/testing/fixtures/escrow/*.json`

**Interfaces:**
- Consumes: the M2/M3 legs; an Anvil fork of Base Sepolia.
- Produces: `describeEscrowLifecycle(config, forkCtx, generation)` — the design §13 escrow-lifecycle fixtures for the **today** generation (revised generation added in M7 once the contracts exist): post / claim / deliver / verdict / refund, including no-valid-delivery-net-no-spend (today: the claim-time spend is the named residual — assert the honest today-mode behavior, not the revised invariant) and the race-lost discipline.

- [ ] **Step 1: Author the fork fixtures** for post→claim→deliver→settle→refund in today-mode. Where today-mode diverges from the frozen invariant (claim-time spend burns an abandoned claim's fee), the fixture asserts the **honest today-mode behavior** and cites §2/§5.2 (the revised invariant is proven in M7).
- [ ] **Step 2: Run → PASS** (or skip offline).
- [ ] **Step 3: Commit.** `git commit -m "test(marketplace): today-generation escrow-lifecycle fixtures on an anvil fork (§13)"`

---

# Milestone M4 — Projector #1 (chain events → observations + signed announcements)

Delivers projector #1 (must #3): the one projection machine producing TEP lifecycle observations AND discovery signed announcements from the same chain events (§8), so the two views cannot disagree. Conformance is a **native** projector-determinism + reorg suite (M4.5) that reuses the record-discovery kit's `reorged` correction-by-append discipline + `derivation-consistency` vectors as building blocks (the discovery kit ships no projector-determinism describe-function — the projector is a new machine). The derivation annotation's `blockHash`/`finalityTier`/`contractGeneration` additions are ratified per ruling §7.21 + record-discovery Addendum 2026-07-28-c, and M4.1 **hard-gates** on the Phase-3-merge verification that the implemented discovery annotation schema tolerates them. Frozen interfaces: §8 projector determinism, derivation annotations, `safe`/`finalized` policy, append-only corrections, single-projector censorship cross-check; §11.10.

## Task M4.1: Chain event decoding + derivation annotations

**Files:**
- Create: `packages/marketplace/projector/src/events.ts`, `src/events.test.ts`
- Create: `packages/marketplace/projector/src/derivation.ts`, `src/derivation.test.ts`

**Interfaces:**
- Consumes: the today-mode ABIs + `ContractGeneration` (`@jinn-network/marketplace-binding`); `viem` log decoding.
- Produces:
  - `decodeMarketplaceLogs(logs, generation): MarketplaceEvent[]` — decodes `TaskCreated`, `TaskAttemptCreated`, `EvaluationAttemptCreated`, Mech `Deliver`, `SolutionDeliveryClaimed`, `VerdictDeliveryClaimed`, `TaskBudgetRefunded` (today), plus the revised-mode `AttemptExpired`/`AttemptReleased`/`TaskClosed` (behind the seam).
  - `type DerivationAnnotation = { chainId; contract; event; blockNumber; blockHash; txHash; logIndex; finalityTier; contractGeneration }` — the discovery §6.2 EVM shape **plus** `blockHash` (reorg detection), `finalityTier`, and `contractGeneration` (so mode-dependent honor-or-reject, anchoring, and verdict authority are legible to consumers, N4). These three additions are **ratified standard additions** to the discovery derivation annotation (ruling §7.21 + record-discovery **Addendum 2026-07-28-c**: the annotation is unknown-field-tolerant and these are registered standard additions consumed by projector #1) — not a local superset against an unconfirmed schema. `event` is retained so `derivation-consistency` can target the exact log.

- [ ] **Step 1: Write the failing tests.** `decodeMarketplaceLogs` decodes a golden `TaskAttemptCreated` into `{taskId, attemptIndex, operator, requestId, priorityMech, deliveryRate}`; a `DerivationAnnotation` carries all nine fields incl. `blockHash`, `finalityTier`, `contractGeneration`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `events.ts` + `derivation.ts`.** `blockHash`, `finalityTier`, and `contractGeneration` are **ratified** standard additions to the discovery derivation annotation (ruling §7.21 + record-discovery Addendum 2026-07-28-c — the annotation is unknown-field-tolerant; these are registered additions consumed by projector #1). Cite the addendum in a code comment (not a "proposal" comment).
- [ ] **Step 4: HARD CROSS-PLAN GATE (ruling §7.21).** Before this milestone is considered green, verify at the **Phase-3 merge** that the record-discovery plan's **implemented** derivation-annotation schema actually **tolerates** (does not strip, does not reject) `blockHash`/`finalityTier`/`contractGeneration`, and that `derivation-consistency` passes over the marketplace annotations carrying them (against the sealed discovery Announcement Entry shape, JCS/RFC 8785). This is a blocking gate on M4, not an advisory comment — if the discovery schema has not yet landed Addendum 2026-07-28-c, M4 does not proceed.
- [ ] **Step 5: Run → PASS. Commit.** `git commit -m "feat(marketplace): chain event decoding + derivation annotations, ratified additions (§8, ruling §7.21)"`

## Task M4.2: Chain events → TEP observations

**Files:**
- Create: `packages/marketplace/projector/src/observe.ts`, `src/observe.test.ts`

**Interfaces:**
- Consumes: `decodeMarketplaceLogs` (M4.1); `deriveMarketplaceAttemptUri` (`@jinn-network/marketplace-binding`); the TEP observation vocabulary + `formatSequence` (`@jinn-network/task-execution-protocol`); `checkDeliveryCorrespondence` (M3.2).
- Produces: `projectObservations(events): ProtocolObservation[]` — the §8 event→observation column: Task posted → `submission-accepted`; Claim → `attempt-engaged` (deterministic Attempt URI, carrying the dispatch-context descriptor); Mech delivery + delivery-claim → `delivery-recorded` **only if** the sha256↔keccak correspondence holds (§6.3, else emit a typed divergence, never `delivery-recorded`, N4); Verdict-claim/finalization → `attempt-terminal` (mapped per §6.4); capacity-exhausted / first-verdict finalized → terminal; close/refund/expiry/release → `submission-closed` + terminal; reorg past an announced fact → corrective terminal per TEP fold rules.

- [ ] **Step 1: Write the failing `observe.test.ts`.** Golden event sequences → the exact observation types; a delivery with mismatched digests → NO `delivery-recorded` (a typed divergence instead, N4); the `attempt-engaged` observation names the deterministic Attempt URI.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `observe.ts`** per the §8 table. Determinism: same events → byte-identical observations (proven in M4.5).
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): chain events → TEP observations (§8)"`

## Task M4.3: Chain events → signed announcements

**Files:**
- Create: `packages/marketplace/projector/src/announce.ts`, `src/announce.test.ts`

**Interfaces:**
- Consumes: the Announcement Entry / Source Head sealed shapes + `DISCOVERY_SIGNING_SCOPE` (`@jinn-network/record-discovery-protocol`, program §7.11); the `serve` published-source toolkit (layout writer, head maintenance) (`@jinn-network/record-discovery-serve`); `facts/task-execution` per-kind recompute functions (via the injected `FactsRecompute` registry port, program §7.13); the derivation annotations (M4.1); an injected `DsseSigner`.
- Produces: `projectAnnouncements(events, ports): Announcement[]` — the §8 announcement column: Task posted → `available` Submission item (facts card: task digest, profile URI, requester IRI, deadline as record facts; price, window as substrate facts); Mech delivery + delivery-claim → `available` Delivery item (task digest, Attempt URI, outcome — the evaluator feed); Verdict-claim → `available` evaluation Delivery item; capacity/finalization/close → `withdrawn` (reason `delisted`); reorg → append-only signed retraction (reason `reorged`). Claim events produce **no** announcement (edges, not counters; claimability liveness is query-plane — Finding F5). Announcements are sealed + signed via `serve` under `jinn:discovery-announcements`. Today-mode gap named: posting-policy parameters not emitted by the deployed contracts ride in the Submission document the announcement references (subject to the digest-join a consumer MUST enforce, §6.1), chain-corroborated only after the revision.

- [ ] **Step 1: Write the failing `announce.test.ts`.** Task posted → an `available` Submission announcement whose facts card carries the task digest + profile URI + requester IRI; claim → no announcement; delivery → an `available` Delivery item; close → a `withdrawn` (`delisted`); the announcement is signed under `DISCOVERY_SIGNING_SCOPE` (assert the scope constant equals `"jinn:discovery-announcements"`, program §7.11). Record facts are recomputed **from record bytes** via the injected recompute functions (program §7.13), never from a supplied projection.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `announce.ts`** per §8. The `envelope:`/`capture:`/`checkpoint:` MetadataSet ingestion for evidence/corpus records continues; the `solvernet-manifest:` prefix retires (design §8/§14).
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): chain events → signed discovery announcements (§8, §7.11)"`

## Task M4.4: Finality policy + reorg corrections + single-projector censorship cross-check

**Files:**
- Create: `packages/marketplace/projector/src/finality.ts`, `src/finality.test.ts`
- Create: `packages/marketplace/projector/src/censorship-crosscheck.ts`, `src/censorship-crosscheck.test.ts`

**Interfaces:**
- Consumes: `viem` `safe`/`finalized` block tags; the derivation annotations (M4.1); `JinnRouterV3.TaskCreated` count via chain read.
- Produces:
  - `finalityPolicy(event, opts): { tier: "safe" | "finalized"; announce: boolean; gateExecution: boolean }` — announce from `safe` by default (a two-lane unsafe-provisional mode is an optional profile, follow-up); decision-grade consumers wait for `finalized`; the pipeline SHOULD gate expensive execution on the claim reaching `finalized` (§8, N2 — a `safe`→reorg reverts the claim and the work is unpaid; operator-borne loss unless finalized-gated).
  - `reorgCorrection(priorAnnouncement, reorgedBlock): Announcement` — append-only signed retraction (reason `reorged`), never a rewrite (§8).
  - `crossCheckCensorship(announcedOpenSet, onChainTaskCreatedCount): { consistent: boolean; missing: number }` — the single-projector recourse (N3): a consumer following one projector periodically cross-checks the announced open-Submission set against the on-chain `TaskCreated` count (a cheap `finalized`-only floor, distinct from full self-indexing), so censorship is detectable without storming shared RPC.

- [ ] **Step 1: Write the failing tests.** `finalityPolicy` announces on `safe`, gates execution on `finalized`; `reorgCorrection` emits an append-only retraction (the prior announcement is NOT mutated); `crossCheckCensorship` flags a discrepancy when the announced open set is smaller than the on-chain `TaskCreated` count.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `finality.ts` + `censorship-crosscheck.ts`** per §8. Corrections are append-only signed records, never rewrites.
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): finality policy + reorg corrections + censorship cross-check (§8)"`

## Task M4.5: Author the projector-determinism + reorg suite (reusing the discovery kit's reorged + derivation-consistency vectors)

**Files:**
- Create: `packages/marketplace/testing/src/projector-conformance.ts`, `src/projector-conformance.test.ts`
- Create: `packages/marketplace/testing/fixtures/projector/{golden-events,reorg-scenarios}/*.json`
- Modify: `.github/scripts/marketplace-packed-types.test.mjs` (register the subpath)

**Interfaces:**
- Consumes: the record-discovery conformance kit's **building blocks** — `runSourceConformance`'s `reorged` correction-by-append discipline + the `derivation-consistency` conformance vectors (`@jinn-network/record-discovery-testing`; the kit exports **no** "projector-determinism" describe-function — the marketplace projector, design §8 "projector #1", is a new machine this plan tests, so the suite is authored here, not imported); the projector `projectObservations`/`projectAnnouncements` (M4.2/M4.3).
- Produces: `describeMarketplaceProjectorConformance(projector)` — **authored natively in `marketplace-testing`**: feed identical event logs **twice** → assert **byte-identical** `ProtocolObservation[]` **and** `Announcement[]` (determinism); feed a reorg scenario (a reorg past an announced `available`) → assert an **append-only signed retraction** (reason `reorged`), never a rewrite (reusing the discovery kit's `reorged` correction-by-append discipline); assert `derivation-consistency` over the projected annotations (reusing the discovery kit's derivation-consistency vectors as building blocks).

- [ ] **Step 1: Author the golden-event + reorg fixtures** (a chain-log sequence; a reorg past an announced `available`). Pin observation + announcement digests. Adapt the discovery kit's `reorged` correction-by-append + `derivation-consistency` vectors as the building blocks.
- [ ] **Step 2: Write `projector-conformance.test.ts`** running the **native** suite against the projector: determinism (feed the same event log twice → byte-identical observations AND announcements) + reorg (announce → reorg → append-only signed retraction, never rewrite, asserted via the discovery `reorged` discipline) + derivation-consistency over the projected annotations.
- [ ] **Step 3: Run → PASS.**
- [ ] **Step 4: Register the subpath + commit.** `git commit -m "test(marketplace): author projector determinism + reorg suite reusing discovery reorged/derivation-consistency vectors (§13)"`

---

# Milestone M5 — The evaluation leg + named checks (trust §7.5a/§7.5b)

Delivers the evaluation leg (§6.4): requester-side derivation + sealing of the evaluation Submission (the default private-material case, profiles §9.1 "Sealer"), the evaluator's claim/execute path, and the named-check gate that decides whether a verdict is treated as **decision-grade** (NOT on-chain settlement protection — today-mode finalization is advisory-only, §6.4, frozen §11.8). Depends on the trust plan (design §15 step 5). Frozen interfaces: §6.4 evaluation sealer rule + named checks + §7.5a join + envelope-authoritative verdict mapping; §11.5/§11.8.

## Task M5.1: Requester-side evaluation derivation + sealing

**Files:**
- Create: `packages/marketplace/binding/src/evaluation-derive.ts`, `src/evaluation-derive.test.ts`

**Interfaces:**
- Consumes: `deriveEvaluationTask` + `sealEvaluationSpec` + the marketplace deployment profile (`@jinn-network/task-execution-profiles`); the protocol Submission sealer + `capabilityGrants` shape (`@jinn-network/task-execution-protocol`); the admission-receipt shape (profiles).
- Produces: `deriveAndSealEvaluationSubmission(input: { subjectTask; subjectDelivery; subjectResults; evaluationSpecDigest; admissionReceipt; capabilityGrants }): { document; bytes; digest }` — the evaluation task is **derived mechanically** from the settlement slot's `(Task, Delivery)` pair by the full-document template (byte-checkable by anyone, §6.4); **the requester-side binding seals it** (profiles §9.1 "Sealer"), carrying the admission receipt + the `capabilityGrants` that convey the private grader + test material (default production case marks test material private, profiles §7.1/§8; a self-sealing evaluator cannot dispatch that case). The evaluator-derives-and-seals shortcut is reserved for fully-public-spec deployments (profiles §9.1 carve-out) — a boolean `publicSpec` selects it.

- [ ] **Step 1: Write the failing test.** `deriveAndSealEvaluationSubmission` derives the evaluation task byte-exactly from `(Task, Delivery)` via `deriveEvaluationTask` (assert the derivation is byte-checkable: two independent derivations from the same pair agree); the sealed Submission carries the admission receipt + `capabilityGrants`; `publicSpec:false` requires the requester-side sealer (a self-sealing evaluator path is rejected for the private case).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `evaluation-derive.ts`** per §6.4. The verdict IS the evaluator-signed Result Evaluation Statement in their Delivery (M5.2).
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): requester-side evaluation derivation + sealing (§6.4)"`

## Task M5.2: The named-check gate (decision-grade verdict observation)

**Files:**
- Create: `packages/marketplace/binding/src/named-checks.ts`, `src/named-checks.test.ts`

**Interfaces:**
- Consumes: `settlementJoinCheck` (§7.5a) + `authenticateRequester` (§7.5b) + the injected `BindingResolver`/`AnchorResolver`/`WitnessVerifier`/`ChainFactResolver` (`@jinn-network/trust-core`, implemented by `@jinn-network/trust-resolve`); `checkVerdictConsistency` + `checkAdmissionReceipt` (`@jinn-network/task-execution-profiles`, program §7.10 — the evaluator Agent key signs the Statement; the harness emits the full measurements set); `deriveEvaluationTask` (M5.1 derivation byte-equality); the verdict-code correspondence (M3.2 pattern).
- Produces:
  - `type VerdictObservationGate = { decisionGrade: boolean; failures: Array<{ check: string; detail: string }> }`.
  - `gateVerdictObservation(input, ports): Promise<VerdictObservationGate>` — runs the §6.4 named checks that gate the **off-chain verdict observation / announcement** (whether a verdict is treated as decision-grade by any consumer), NOT on-chain settlement: (1) derivation byte-equality (pair-fixing removes evaluator input choice); (2) admission-receipt validity; (3) `verdict-consistency` (declared rule → code, `checkVerdictConsistency`); (4) evaluator ≠ solver (the on-chain address check is the **cheapest** enforcement point, explicitly NOT the security boundary, §5.3/§6.4); (5) the trust **§7.5a settlement join** (verdict DSSE key and settling Safe resolve to the same Agent IRI at the envelope's effective time, no partial credit; the effective time is cross-checked against the verdict-claim block time); (6) §7.5b requester authentication over the signed Submission. Envelope-authoritative verdict-code mapping: the Statement's verdict maps to `{Pass, Fail, Invalid, Unresolved}` with **no defaulting** — the binding refuses a missing verdict rather than guessing. In today-mode the projector publishes a signed **verdict-code ↔ Statement-verdict correspondence assertion** (both values) and refuses to treat a verdict as decision-grade if they disagree (containing the on-chain default-Pass quirk).

- [ ] **Step 1: Write the failing `named-checks.test.ts`** (reusing the trust kit's §7.5a/§7.5b fixtures, program §7.10 signer discipline): a valid verdict (derivation byte-exact + admission receipt valid + verdict-consistent + evaluator≠solver + §7.5a join passes + §7.5b passes) → `decisionGrade:true`; each single failure → `decisionGrade:false` naming the failed check; a Statement with a missing verdict → refused, not defaulted; a verdict-code disagreeing with the Statement verdict → `decisionGrade:false` (today-mode correspondence refusal); the §7.5a join across a rotated/mismatched identity → fails closed, no partial credit.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `named-checks.ts`** per §6.4. Mark: today-mode on-chain finalization/credit is **advisory-only** until the revision makes the on-chain code derive from and be checked against the signed Statement (frozen §11.8). The load-bearing control is the §7.5a join + declared-identity distinctness, not the on-chain address check.
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): named-check gate for decision-grade verdicts (§6.4, §7.5a/§7.5b)"`

## Task M5.3: Named-check + evaluation conformance

**Files:**
- Create: `packages/marketplace/testing/src/named-check-fixtures.ts`, `src/named-check-fixtures.test.ts`
- Modify: `.github/scripts/marketplace-packed-types.test.mjs`

**Interfaces:**
- Consumes: the trust kit's §7.5a/§7.5b fixtures (`@jinn-network/trust-testing`); `gateVerdictObservation` (M5.2); `deriveAndSealEvaluationSubmission` (M5.1).
- Produces: `describeNamedChecks(gate)` — derivation byte-equality (positive + negative); verdict-mapping refusal cases; on-chain evaluator ≠ solver rejection AND self-claim-allowed-on-solve (§5.3); delivery + verdict-code correspondence checking in today-mode (including the projector refusing to emit on mismatch).

- [ ] **Step 1: Author the fixtures** (reuse trust §7.5a/§7.5b; add derivation + verdict-mapping cases). Include **self-claim-allowed-on-solve** (a same-address solve is allowed, §5.3) and **evaluator ≠ solver rejected** (the cheap on-chain filter).
- [ ] **Step 2: Write `named-check-fixtures.test.ts`** → PASS.
- [ ] **Step 3: Register subpath + commit.** `git commit -m "test(marketplace): named-check + evaluation conformance (§13)"`

---

# Milestone M6 — Pipeline (daemon marketplace application; LIBRARY)

Delivers the operator pipeline (§7, §9): the pluggable claim predicate, the execution wiring config shape, the two structural guards, and the composition of the binding venue verbs with an embedded local backend through the two-party engagement entry (ruling §7.18, must #5). Also the §9 carve disposition as documentation-as-code. The live daemon cutover is OUT of scope (migration-mechanics session). Frozen interfaces: §7 operator sovereignty; §9 carve + pipeline composition rule with the two-party-entry exception; §11.9/§11.11.

## Task M6.1: Claim predicate + execution wiring + caps

**Files:**
- Create: `packages/marketplace/pipeline/src/claim-predicate.ts`, `src/claim-predicate.test.ts`
- Create: `packages/marketplace/pipeline/src/execution-wiring.ts`, `src/execution-wiring.test.ts`
- Create: `packages/marketplace/pipeline/src/caps.ts`, `src/caps.test.ts`

**Interfaces:**
- Consumes: discovery facts (the announced Submission facts card, via the injected discovery client — types only); the embedded backend `capabilities()` (`@jinn-network/task-execution-backend`).
- Produces:
  - `type ClaimPredicate = (facts: SubmissionFacts, capabilities: BackendCapabilities, caps: OperatorCaps) => boolean` — a **pluggable operator predicate** over (discovery facts, own backend capabilities, own caps); hand-picked IDs, take-everything-runnable, price thresholds, requester allowlists, per-task judgment are all equally valid and protocol-invisible (§7). The claim-nothing-when-unconfigured safety default survives (a null predicate claims nothing).
  - `type ExecutionWiringEntry = { workKind: string; harness: string; model: string; plugins: string[]; credentialRef: string; legacyManifestDigest?: string }` — work-kind → (harness, model, plugins, credential) mapping; **configuration for execution, not permission for claiming** (§7). `legacyManifestDigest` is the migration-honesty annotation: until the daemon migration completes, a predicate compiles down to today's manifest-digest matching via this per-entry legacy annotation (§7).
  - `type OperatorCaps = { spendCapWei: bigint; aiUnitCap: number }` + `checkCaps(intendedSpend, caps): boolean` — the operator's own spend/AI-unit caps (self-protection, re-keyed from manifest CID to the wiring entry's credential, §7).
  - `runPinningConstraint(facts): { pinned: boolean; harness?; model?; loadout?; effortFloor? }` — under the `attested` posture (§7), a pinned Submission is read by the predicate as a claim-eligibility constraint (decline work it won't run to the pin); honored pinning is verified after-the-fact against the Evidence Runtime Observation (a violation is invalid consumer-side, never a protocol state).

- [ ] **Step 1: Write the failing tests.** A take-everything-runnable predicate claims a runnable facts card and declines an unrunnable one; the unconfigured (null) predicate claims nothing; `checkCaps` blocks an over-cap spend; `runPinningConstraint` reads a pinned harness/model/effort-floor from the facts and declines a mismatch.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write the three modules** per §7. There is no membership, no filter schema, nothing prescribed — the predicate is the operator's own; the only structural gates are backend capability + preflight (M6.2) and the operator's own caps.
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): claim predicate + execution wiring + operator caps (§7)"`

## Task M6.2: Two-party engagement + pipeline composition (peer, §7.18)

**Files:**
- Create: `packages/marketplace/pipeline/src/engage.ts`, `src/engage.test.ts`
- Create: `packages/marketplace/pipeline/src/pipeline.ts`, `src/pipeline.test.ts`

**Interfaces:**
- Consumes: `claimAttempt` + `convergeDelivery` + `settleDelivery` venue verbs (`@jinn-network/marketplace-binding`); the embedded local backend `TaskExecutionBackend` including the two-party engagement entry `submit(taskBytes, submissionBytes, engagement?)` (`@jinn-network/task-execution-backend-local` — the assembly; ruling §7.18 — composed as a PEER through the standard interface only, NEVER importing supervisor/workspace/launchers); `TwoPartyEngagement` (M1.2); `deriveMarketplaceAttemptUri` (M1.1).
- Produces:
  - `buildEngagement(claim: { attemptUri; dispatchContext }): TwoPartyEngagement` — the pipeline mints the deterministic Attempt URI and builds the dispatch-context itself (§6.2), then hands them to the assembly's two-party entry.
  - `runPipeline(taskId, config, backend, ports): Promise<{ delivered: boolean; state: AttemptState }>` — the operator loop: claim (binding venue verb) → `buildEngagement` → `backend.submit(taskBytes, submissionBytes, engagement)` (the backend provisions/executes/harvests/seals the marketplace-profile Delivery under the caller-minted URI) → wait for the Delivery → `convergeDelivery` + `settleDelivery` (binding venue verbs). The backend is composed as a **peer**; the pipeline hands sealed bytes to `submit` and waits for the Delivery, never reaching into backend internals (ruling §7.18).

- [ ] **Step 1: Write the failing `engage.test.ts`.** `buildEngagement` produces `{attemptUri, dispatchContext}` where `attemptUri` equals the deterministic marketplace URI and the dispatch-context names it. Write the failing `pipeline.test.ts` using a **fake `TaskExecutionBackend`** (from `@jinn-network/task-execution-testing`'s in-memory fake) that records whether `submit` was called with the third `engagement` argument carrying the caller-minted URI; assert the fake adopts the URI (its sealed Delivery names the caller-minted URI, not a random one). Assert (a source-guard-level check) that `pipeline` imports only `@jinn-network/task-execution-backend-local` (the assembly), never `-supervisor`/`-workspace`/`-launchers`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `engage.ts` + `pipeline.ts`** per §6.2/§7.18. The two-party entry is the ONE public-interface exception to the no-subcomponent-imports rule (§9) — a public-interface addition, not a subcomponent reach-in.
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): two-party engagement + pipeline composition as a peer (§6.2, §7.18)"`

## Task M6.3: The §9 carve disposition (documentation-as-code)

**Files:**
- Create: `packages/marketplace/pipeline/src/carve.ts`, `src/carve.test.ts`

**Interfaces:**
- Produces: `TASK_ENGINE_CARVE: Record<string, "pipeline" | "embedded-backend" | "binding" | "application">` — the §9 disposition of today's TaskEngine states (DISCOVERED/CLAIMED/WAITING → pipeline; PRE_SNAPSHOT/RUNNING/POST_SNAPSHOT → embedded backend; PACKAGING → embedded backend seals the marketplace-profile Delivery; DELIVERING/COMPLETE → binding; AWAITING_ADOPTION/CLAIMING_DELIVERY → application (Autopilot); RACE_LOST → binding, off failure counters; FAILED → split by cause: backend-side → embedded backend terminal, venue-side → binding). The map is asserted by a test so the disposition is legible and drift-guarded; the **live daemon cutover is out of scope** (migration-mechanics session, program §9).

- [ ] **Step 1: Write the failing `carve.test.ts`** asserting the exact state→owner map of §9 (including FAILED's split-by-cause and RACE_LOST kept off failure counters).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Write `carve.ts`.** Comment: this is documentation-as-code; the actual `client/src/daemon/*` migration waits on the migration-mechanics design session.
- [ ] **Step 4: Run → PASS. Commit.** `git commit -m "feat(marketplace): §9 TaskEngine carve disposition as documentation-as-code"`

---

# Milestone M7 — The contract revision (Solidity code + Hardhat test kit; NO deploy)

Delivers the §5 revision as Solidity code + Hardhat tests (design §14 "Contracts" declared impact). Every deploy is the human-gated M8 runbook, never a task here. Prerequisite: confirm the Hardhat 3 migration (PR #996) has merged before starting (MEMORY: contracts-hardhat3-migration). Frozen interfaces: §5.1 anchor set + event completeness; §5.2 attempt semantics; §5.3 lifecycle exits; §11.2/§11.3/§11.4.

## Task M7.1: The revised recorder + router (Solidity)

**Files:**
- Create: `contracts/src/tasks/TaskCoordinatorV4.sol`
- Create: `contracts/src/staking/JinnRouterV4.sol`

**Interfaces:**
- Produces (the §5 revision, per the design §14 named requirements):
  - **`attemptIndex` split from occupancy** (§5.2, frozen §11.3): `attemptIndex` is strictly monotonic + never reused (the sole variable input to the deterministic Attempt URI); a separate **live-occupancy counter** gates `maxClaims`; release/expiry decrement occupancy, never `attemptIndex` (a claim→expire→reclaim yields two distinct `attemptIndex` and two distinct Attempt URIs).
  - **Reservation escrow** (§5.2): the fee is *reserved* at claim, released only on valid delivery; the **no-valid-delivery-net-no-spend** economic invariant; the Mech interaction that realizes it (reservation held in-router / Mech funded at delivery / Mech-funded-at-claim-refundable-on-timeout) is a bounded contract choice (§2).
  - **Attempts with honest expiry** (§5.2): `claim(taskId)` grants exclusive ownership with a deadline; **lazy reap** on the next state-changing touch emitting `AttemptExpired(taskId, attemptIndex, operator)`; **reap-before-refund** on any refund path; a minimum-hold/same-identity re-claim cooldown on `releaseAttempt` (bounds claim→release cycling); `addAttempts(taskId, n)` creator-only, reverts on `Closed`.
  - **Lifecycle exits** (§5.3, frozen §11.4): `closeTask(taskId)` creator-only (status→`Closed`, stops new claims, reaps past-deadline attempts, then refunds all unreserved budget), with the two invariants — (i) a delivery-claim for a live reserved attempt succeeds regardless of `Closed`; (ii) `closeTask` never frees a live reservation; `releaseAttempt(taskId, attemptIndex)` operator-only; no unilateral on-chain revocation.
  - **Event completeness** (§5.1): every posting-policy parameter emitted; one event per fact; digests + parties in indexed topics; the SolverNet `manifestDigest` discriminator dropped; `Closed`/`Cancelled` reachable.
  - **The revised anchor set** (§5.1): Submission digest anchored beside the task digest; Delivery + Verdict anchored by **sha256** of sealed bytes (one scheme); on-chain concurrency parameter + multi-verdict parameters; the **verdict code derives from the signed Statement** (§6.4 — the on-chain code and the Statement authoritative-equal).
  - **Self-eval prevention** retained on-chain as a cheap first filter (address-only), explicitly NOT the load-bearing control (§5.3/§6.4).

- [ ] **Step 1: Write the Solidity** for `TaskCoordinatorV4` + `JinnRouterV4` per the above, modeled on the deployed `TaskCoordinator.sol` + `JinnRouterV3.sol` (keep the two-rail escrow + Safe-routing; add the reservation split, the deadlines, the lifecycle exits, event completeness, the sha256 anchor convergence). (Solidity is not TDD-per-line; the Hardhat kit M7.2 is the red→green driver.)
- [ ] **Step 2: Compile.** `cd contracts && yarn build` (Hardhat 3) → zero errors.
- [ ] **Step 3: Commit.** `git commit -m "feat(contracts): TaskCoordinatorV4 + JinnRouterV4 revised recorder (§5 revision)"`

## Task M7.2: The escrow-lifecycle Hardhat test kit (revised generation)

**Files:**
- Create: `contracts/test/marketplace-revision/{escrow-lifecycle,attempt-index,lifecycle-exits,verdict-from-statement}.t.ts`

**Interfaces:**
- Consumes: `TaskCoordinatorV4` + `JinnRouterV4` (M7.1); the Hardhat 3 test harness.
- Produces: the §13 escrow-lifecycle invariants proven on the revised contracts: post / claim / deliver / verdict / close / release / expiry / top-up / refund, including **no-valid-delivery-net-no-spend**, **lazy-reap**, **reap-before-refund** (all-slots-expired → `closeTask` refunds everything), **closeTask-front-runs-delivery → delivery still settles**, and **claim → expire → reclaim yields distinct `attemptIndex`** (and thus distinct Attempt URIs). Also: `addAttempts` reverts on `Closed`; the release cooldown bounds cycling; the verdict code derives from the signed Statement.

- [ ] **Step 1: Write the failing Hardhat tests** for each invariant above (deploy the V4 pair on a Hardhat network, exercise the full lifecycle).
- [ ] **Step 2: Run → FAIL** (contracts incomplete) → iterate M7.1 until green (goal-driven).
- [ ] **Step 3: Run → PASS.**
- [ ] **Step 4: Commit.** `git commit -m "test(contracts): revised-generation escrow-lifecycle invariants (§13)"`

## Task M7.3: Wire the revised generation through the binding seam

**Files:**
- Modify: `packages/marketplace/binding/src/abis/` (add V4 ABIs), `src/generation.ts` (revised config), `src/lifecycle.ts`/`src/claim.ts`/`src/delivery.ts`/`src/settlement.ts` (revised-mode branches)
- Modify: `packages/marketplace/testing/src/escrow-lifecycle.ts` (add the revised generation through the seam)

**Interfaces:**
- Consumes: the V4 ABIs (from the compiled contracts); the `ContractGeneration` seam (M0.3).
- Produces: the revised-mode branches of the venue verbs (reservation-not-claim-spend; sha256-only anchoring; `closeTask`/`releaseAttempt`/`addAttempts` live; the correspondence check retired in revised-mode; the on-chain verdict code authoritative-equal to the Statement).

- [ ] **Step 1: Write failing tests** in `marketplace-testing` running the escrow-lifecycle fixtures through the **revised** generation (against a Hardhat/anvil deployment of V4) — the frozen invariants (no-valid-delivery-net-no-spend, reap-before-refund, closeTask-front-runs-delivery-still-settles, claim→expire→reclaim distinct URIs) now hold on-chain, not merely as today-mode approximations.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Fill the revised-mode branches** behind the seam. The flip is config (`generation: "revised"`), not a rewrite (§5.4).
- [ ] **Step 4: Run → PASS** (both generations green through the seam). Commit: `git commit -m "feat(marketplace): wire the revised generation through the binding seam (§5.4)"`

---

# Milestone M8 — Human-gated runbook (deploy + generation flip) — NOT an executing task

**This milestone is a runbook document, not code. No task in this plan executes a deploy (must #1; program §9).**

## Task M8.1: Author the deploy + generation-flip runbook

**Files:**
- Create: `docs/runbooks/marketplace-contract-revision-deploy.md`

**Interfaces:**
- Produces: a human-gated runbook covering: (1) the Base Sepolia redeploy of `TaskCoordinatorV4` + `JinnRouterV4` (Track 2 practice — testnet redeploys are cheap and practiced, §5.4); (2) the config flip `generation: "today"` → `"revised"` for operators; (3) the carried constraint for the future marketplace-contract design (program §8: the adoption-authorization Solidity hook uses an on-chain expected-signer slot settable only by the launcher Safe, so working-key rotation never re-imports the #1401 shape); (4) verification steps (the revised-generation escrow-lifecycle kit run against the deployed addresses). Every step is a **human action**; the runbook is documentation only.

- [ ] **Step 1: Write the runbook** with the deploy commands as **documented human steps** (never executed by this plan), the config-flip instructions, and the post-deploy verification checklist.
- [ ] **Step 2: Commit.** `git commit -m "docs(marketplace): human-gated contract-revision deploy + generation-flip runbook"`

---

## Self-review checklist (run before handing off)

1. **Spec coverage** — every design § maps to a task: §2/§5.2 escrow reframing (M7.1, M3.5); §5.1 anchor set + event completeness (M7.1); §5.2 attempt semantics (M7.1, M7.2); §5.3 lifecycle exits (M3.4, M7.1); §5.4 generation seam (M0.3, M7.3); §6.1 posting + digest-join + honor-or-reject (M2.2, M2.3); §6.2 claiming + deterministic URI (M1.1, M3.1); §6.3 delivery convergence + correspondence + settlement + race-loss (M3.2, M3.3); §6.4 evaluation sealer + named checks + verdict mapping (M5.1, M5.2); §7 operator sovereignty + attested posture (M2.4, M6.1); §8 projector (M4.1–M4.5); §9 carve (M6.3); §11 frozen interfaces (cited per task); §12 packages (M0.1); §13 conformance (M2.5, M3.5, M4.5, M5.3, M7.2); §14 declared impact (mech re-home M2.1, envelope convergence M3.2, contracts M7, projector M4, CLI honored as pinned boundary); §15 sequence (milestone order); §16 non-goals (Out of scope).
2. **Placeholder scan** — no "TBD"/"add validation"/"similar to Task N": each task carries concrete test cases + exact interfaces; the two-generation branches are named per leg.
3. **Type consistency** — `ContractGeneration`, `MarketplaceChainConfig`, `TwoPartyEngagement`, `DerivationAnnotation`, `ClaimPredicate`, `ExecutionWiringEntry`, `VerdictObservationGate`, `TASK_ENGINE_CARVE` each defined once and imported by name thereafter; `deriveMarketplaceAttemptUri` is a thin adapter over the protocol `deriveAttemptUri` (never re-derived); `mergeRequirements`/`EffectiveRequirements` consumed from protocol; `settlementJoinCheck`/`authenticateRequester` from trust-core; `deriveEvaluationTask`/`checkVerdictConsistency` from profiles; the Announcement Entry/Source Head + `DISCOVERY_SIGNING_SCOPE` from record-discovery.

## Findings (surfaced to the coordinator — never silently resolved)

- **F1 — the two-party engagement entry TOUCHES the frozen `TaskExecutionBackend` interface (must #4).** The exact surface: an optional third parameter `engagement?: TwoPartyEngagement` (`{ attemptUri, dispatchContext }`) on `submit`, i.e. `submit(taskBytes, submissionBytes, engagement?): Promise<SubmissionAck>`. The already-implemented, frozen interface is `packages/task-execution/backend/src/backend.ts:37` `submit(taskBytes: Uint8Array, submissionBytes: Uint8Array): Promise<SubmissionAck>` (Phase 2, merged). A **Submission-document-field** realization (carry the Attempt URI in the sealed Submission) is IMPOSSIBLE: the deterministic URI depends on `attemptIndex`, known only at claim time, but the requester seals the Submission at posting time (§5.2/§6.1) — so the URI cannot ride in the requester-sealed document. A **separate `engage()` method** is disallowed by ruling §7.18 (the binding consumes "ONLY through the standard interface" and "hands sealed bytes to `submit`"). Therefore widening `submit` is the only faithful realization, and because the interface is frozen-and-merged, it MUST be dispositioned by the coordinator as a dated addendum to the TEP plan/design and built into the local-backend assembly's Milestone C from day one (local-backend Addendum 2026-07-28-b) — **not silently widened**. This plan does not edit `backend/src/backend.ts`.
- **F2 — the requester-facing binding, not just the operator side, is a `TaskExecutionBackend`.** Design §13 ("the TEP kit runs against this binding … proves the backend contract's neutrality") implies the binding implements `TaskExecutionBackend` on the requester side (submit→post, observe→projector, fetchDelivery→IPFS). The design text describes the binding mostly through operator-facing venue verbs; this plan makes the requester-facing `TaskExecutionBackend` implementation explicit (M2.4) so the §13 kit has a subject. Flagged as an interpretation the coordinator should confirm, not a silent addition.
- **F3 — `closeAt` honor-or-reject asymmetry, today-mode. ADJUDICATED (ruling §7.20).** §6.1 rejects `minVerdicts>1` and `maxConcurrent>maxTotal`; the question was whether an unhonorable `closeAt` should reject with `unsupported-requirement` in today-mode (symmetric) or ride as a named-weaker approximation. **Resolved:** today-mode **rejects** a `closeAt` requirement with `unsupported-requirement` (TEP §8 forbids weak/partial honoring; today-mode has no on-chain claim window, so the former budget-refund + announcement-withdrawal "approximation" cannot stop a chain-direct claim after `closeAt` — it is weak honoring, dropped). This aligns exactly with backend-local C1; both bindings behave identically. Revised-mode honors `closeAt` via the on-chain claim window. No "declared-approximate" capability class in v1. Reflected in M2.2 (`honorOrRejectToday` rejects `closeAt`) and M3.4 (`closeSubmission` is the explicit requester close, distinct from the rejected `closeAt` requirement).
- **F4 — the multi-claim Submission vs single-attempt embedded backend interaction.** In the marketplace the requester's Submission may set `attempts.maxTotal > 1` (chain `maxClaims`), but the operator's embedded local backend runs ONE attempt and its C1 honor-or-reject requires `{maxTotal:1..1, maxConcurrent:1..1}`. The two-party engagement mode must scope the embedded backend's honor-or-reject to the single caller-identified attempt (the chain enforces `maxClaims`, not the local backend). The exact realization lives in the local-backend assembly's Milestone C (the two-party path); this plan's pipeline (M6.2) passes the sealed Submission + engagement and relies on that scoping. Surfaced as a cross-plan coordination item for the local-backend Milestone C, not resolved here.
- **F5 — scope-boundary report (must #6).** The design does **NOT** pull into scope: (a) the **discovery query-plane service** — §8 explicitly leaves claimability liveness "query-plane" and says "the explorer consumes the query layer above"; the projector produces announcements consumed by that layer, which this plan does not build; (b) the **subscribe relay** — never referenced in the design; announcements are published via `record-discovery-serve` and consumed by whatever client the query layer wires; (c) the **trust adoption-authorization object** — adoption maps to the Application (Autopilot) layer in the §9 carve (AWAITING_ADOPTION/CLAIMING_DELIVERY → application); the binding surfaces delivery + receipt observations only. The trust surfaces the design DOES pull in are the **verification procedures** `settlementJoinCheck` (§7.5a) + `authenticateRequester` (§7.5b) + `verifyEnvelopeBinding` and their injected resolvers — consistent with the program ledger holding the query-plane/subscribe/adoption-authorization out.
- **F6 — conformance-kit placement adjusts design §12.** Design §12 says "The conformance kit slice lives with the stack's testing package." A literal slice inside `@jinn-network/task-execution-testing` (the backend-local precedent) would invert dependencies here — a foundation-tree testing package depending on the application-tree `@jinn-network/marketplace-binding`. This plan therefore places the marketplace conformance in a **marketplace-tree** package `@jinn-network/marketplace-testing` that *consumes* the TEP + record-discovery kits as production deps — running the TEP core kit `describeTaskExecutionBackendContract` un-parameterized as a sanity suite (ruling §7.19) and reusing the discovery kit's `reorged` + `derivation-consistency` vectors as building blocks, while **authoring the §16.2 marketplace-profile conformance and the projector-determinism + reorg suite natively** (neither kit exports a profile-parameterized or projector-determinism describe-function to re-expose). Surfaced as an adjustment to §12's phrasing, not a silent divergence.
- **F7 — package names settled (must #7).** The design §12 uses "working names; settled at implementation planning." This plan settles: directories `packages/marketplace/{binding,projector,pipeline}` (+ `testing`) per §12; npm names `@jinn-network/marketplace-{binding,projector,pipeline,testing}`, consistent with the program §6 `@jinn-network/<tree>-<component>` convention. "Marketplace" is generic; the operator should confirm the prefix at the program-extension gate (as `record-discovery-*` was confirmed in program §6) — no existing `@jinn-network/marketplace-*` conflict was found in the repo, but the operator owns the final call.

## Addendum 2026-07-29-d — M3.5 ephemeral-fork fixture substrate

M3.5's "today generation on an Anvil fork" requires real transactions and state transitions
through the unchanged today-generation `TaskCoordinator` and `JinnRouterV3` contract code. It
does not require discovering or mutating a registered production Mech on the forked public
state. The deterministic fixture may deploy those unchanged today contracts plus the
repository's `MockTaskMarketplace`, `MockTaskActivityChecker`, and `MockTaskMech` fixtures into
the ephemeral Base Sepolia Anvil process, following the existing
`client/test/e2e/_daemon-harness-helpers.ts` V3 setup. The router/coordinator may not be mocked;
post, claim, solution delivery, evaluation claim, verdict delivery, settlement/finalization,
refund, and race-loss assertions must be actual local-chain calls and state reads. This local
fixture deployment is test setup, not an on-chain deployment program task. M2's separate fork
suite remains responsible for proving the deployed-address `createTask` wiring.

## Addendum 2026-07-29-e — revised lifecycle event ABI (program ruling §7.28)

M4.1 freezes the revised-generation lifecycle event shapes consumed by the projector and later
implemented by M7:

- `AttemptExpired(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator)`
- `AttemptReleased(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator)`
- `TaskClosed(uint256 indexed taskId, address indexed creator)`

The expiry/release triples are the exact attributable engagement facts required by design §5.2.
`TaskClosed` includes the creator because design §5.1 requires parties in indexed topics; a
task-id-only event is not event-complete. Refund value remains the separate
`TaskBudgetRefunded` economic fact under the one-event-per-fact rule. M4 decodes these events
only behind `generation: revised` and its fixtures are the ABI contract M7.1/M7.2/M7.3 must
implement and prove exactly. Today mode never invents these events.
