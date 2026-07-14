# Unblock Real Jinn Differential Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task by task.

**Goal:** Produce a real Jinn PR #1458 differential-admission receipt and receipt-bound Anvil evidence without weakening the public-repository trust boundary.

**Architecture:** Buildx writes an explicit Docker-export archive, then Docker imports and inspects it on the resolved active daemon. Publication returns the signed environment spec plus its CID. The existing proof command creates/verifies the eight-run receipt, and a new operational Anvil command consumes only verified environment/receipt artifacts.

**Tech Stack:** TypeScript, Docker Buildx/Desktop, Docker archive import, GHCR, IPFS, EIP-191, Vitest, Anvil.

## Global Constraints

- Build only `linux/amd64` from the exact Jinn base `ae8093a8848e70e581f46d66dcdb56789c0808a3` and canonical `resolveJinnMonoRecipeV1`.
- Builder credentials, gold patches, test-patch contents, and signer credentials never enter Docker build inputs or tracked files.
- The image path is Buildx Docker archive export, `docker image load`, then `docker image inspect`; never Buildx `--load`.
- A real proof requires a published digest-qualified image, EIP-191-signed environment, explicit approved `operatorSafe:signer` pair, real receipt CID/hash, and all eight targeted observations.
- No receipt, CID, empirical success, or testnet result may be fabricated or claimed before the corresponding live artifact exists.
- `EVAL_SEMANTICS_VERSION` remains `4`; generator, economics, claim, posting, and grading semantics stay unchanged.

---

### Task 1: Archive-export Docker builder

**Files:**
- Modify: `client/src/task-creator/environment/adapters.ts`
- Modify: `client/test/task-creator/environment/adapters.test.ts`
- Create: `client/test/task-creator/environment/archive-export.integration.test.ts`

**Interfaces:**
- Keep `EnvironmentBuilder.build(recipe): Promise<BuiltEnvironment>` stable.
- Add internal temporary archive/metadata handling and sanitized active-daemon runtime resolution.

- [ ] Add failing unit tests requiring `buildx build --output type=docker,dest=... --metadata-file ...`, `docker image load --input ...`, and a subsequent inspect on the same explicit daemon endpoint.
- [ ] Add failures for missing/empty archive, failed load, unexpected loaded tag, non-amd64 inspect, and cleanup; assert isolated config exposes plugin discovery only and no auth/credential-helper fields.
- [ ] Implement archive export/import with unconditional cleanup. Resolve the active daemon endpoint before isolation; create a fresh config containing only approved plugin directories; use the same sanitized environment for build/load/inspect.
- [ ] Add an opt-in Docker integration test that builds a minimal amd64 Dockerfile through the real archive path and verifies the loaded image.
- [ ] Run focused tests and commit `fix(task-creator): export environment images through archive`.

### Task 2: Published environment bundle and CLI output

**Files:**
- Modify: `client/src/task-creator/environment/publication.ts`
- Modify: `client/src/task-creator/environment/publish-cli.ts`
- Modify: `client/scripts/task-creator-environment-publish.ts`
- Modify: `client/test/task-creator/environment/publication.test.ts`
- Modify: `client/test/task-creator/environment/publish-cli.test.ts`

**Interfaces:**
- Introduce `PublishedTaskEnvironmentV1 { spec: TaskEnvironmentSpecV1; environmentCid: string }` as the publication-controller return value.
- Execute-mode CLI accepts `--output <path>` and reports environment CID/hash/image reference.

- [ ] Add failing tests that require the environment upload CID to survive controller/CLI output and the output file to contain canonical signed spec bytes atomically.
- [ ] Preserve preflight behavior; reject `--output` use that would write during preflight.
- [ ] Implement the bundle return and execute-only output write. Confirm the returned CID is from the final signed environment upload, not recipe/SBOM uploads.
- [ ] Run focused tests and commit `feat(task-creator): expose published environment bundle`.

### Task 3: Real Jinn receipt publication and verification gate

**Files:**
- Modify: `client/scripts/task-creator-jinn-differential-proof.ts`
- Modify: `client/test/task-creator/jinn-differential-proof.test.ts`
- Modify: `docs/runbooks/task-creator-environment-publish.md`
- Modify: `docs/runbooks/task-creator-public-repo-proof.md`

**Interfaces:**
- Existing receipt generation/verification stays strict; add operational orchestration only for a published signed environment and digest image.

- [ ] Add failing tests for digest pull/inspect before proof execution and rejection when the local image is unavailable or its inspected platform/ID drifts from the signed environment.
- [ ] Implement the pre-run image availability check using `docker pull` plus inspect outside the builder, then retain proof runner `--pull=never`.
- [ ] Document the exact operator sequence: execute publication with external signer, record environment CID/output, pull image, execute eight-run receipt, record CID/SHA, and run offline verification.
- [ ] Run focused tests, then execute the real command only when GHCR, IPFS, signer, and approved attester configuration are present. Commit code/docs without a receipt if those inputs are absent or any real gate fails.

### Task 4: Operational receipt-bound Anvil proof

**Files:**
- Create: `client/scripts/task-creator-jinn-differential-anvil-proof.ts`
- Modify: `client/package.json`
- Modify: `client/test/task-creator/public-repo-anvil-lifecycle.ts`
- Modify: `client/test/hermetic/public-repo-anvil-lifecycle.test.ts`

**Interfaces:**
- Add `task-creator:jinn-differential-anvil-e2e` accepting environment path/CID, receipt path/CID/expected SHA, approved attester pair, and evidence output path.

- [ ] Add failing tests showing malformed/drifted environment, receipt, CID, or attester fails before Anvil compilation/deployment.
- [ ] Implement an operational wrapper that invokes the existing strict verifier, binds a v2 row from receipt-derived F2P/P2P, runs the Anvil lifecycle, and atomically writes task/environment/receipt/delivery/verdict/corpus evidence.
- [ ] Keep the Anvil result labelled receipt-bound lifecycle evidence; the empirical result remains the Docker receipt.
- [ ] Run focused tests and commit `feat(task-creator): add real Jinn Anvil proof command`.

### Task 5: Live local proof and verification handoff

**Files:**
- Modify: `docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md`
- Modify: `docs/runbooks/task-creator-public-repo-proof.md`

- [ ] Run `yarn typecheck`, focused suites, harvest E2E, public-repo E2E, public-repo Anvil E2E, archive-export Docker integration, and serialized full tests.
- [ ] If live operator configuration is present, execute publication, real receipt generation, offline verification, and the operational Anvil command; check in the receipt/evidence only after all gates pass.
- [ ] Update handoff with actual CID/hash/evidence if generated, or the exact missing external prerequisite/blocker if not. Commit `docs(task-creator): record real Jinn proof status`.
