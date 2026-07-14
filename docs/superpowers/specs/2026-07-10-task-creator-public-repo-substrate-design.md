# Task Creator public-repository substrate bootstrap

- **Version:** 0.1
- **Date:** 2026-07-10
- **Status:** approved design
- **Program position:** Task Creator rung 1.5 / rung 4a
- **Parent design:** [`spec/2026-07-08-task-creator-v0.md`](../../../spec/2026-07-08-task-creator-v0.md)
- **Starting proof:** PR [#1485](https://github.com/Jinn-Network/mono/pull/1485), head `0ae4fc1a8`
- **Handoff:** [`docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md`](../../handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md)

## 1. Summary

PR #1485 proves the rung-1 commit-echo plumbing: a fix-shaped commit can become a
candidate, empirical before/after evaluation can derive F2P/P2P, admission can
validate it, the row can be published to IPFS, and the production evaluator can
route and grade it. The proof still borrows a Docker image and evaluator
configuration from a scorable SWE-rebench instance in the same repository.

This design removes that dependency. It introduces a normalized,
content-addressed `TaskEnvironmentSpec.v1` plus replaceable environment providers.
The first provider describes `Jinn-Network/mono` explicitly. Later providers infer
environments from repository-owned configuration, with RepoLaunch available as an
agentic provider only when deterministic evidence is insufficient.

The output remains an ordinary admitted `swe-rebench-v2.v1` minted task. The
generator, posting path, task economics, solver claim path, and verdict shape do
not fork. Environment construction ends before the existing generator begins.

The first useful proof is a natural `jinn-mono` fix, not present in the existing
`jinn-repo.v1` pool, built and graded through the generalized minted-task path. A
second unfamiliar public repository is the portability gate before claiming that
the abstraction generalizes beyond Jinn.

## 2. Relationship to the Task Creator ladder

This is not a replacement for Task Creator v0.

| Existing rung | Relationship to this design |
|---|---|
| Rung 1 — commit echo | PR #1485 proves the pipeline using pre-admitted Rebench substrates. This design makes that pipeline usable outside those repositories. |
| Rung 2 — hunk-subset echo | Unchanged and out of scope. It can consume `TaskEnvironmentSpec` later. |
| Rung 4 — environment construction | This design pulls forward the smallest useful public-repository slice: explicit and deterministic substrate bootstrap. Full agentic construction remains later. |
| Composition | The normalized substrate becomes the environment component composed with trace-derived gold and empirical verifier derivation. |

The sequencing refinement is named **rung 1.5 / rung 4a**. Jinn dogfood is real
non-benchmark usage, so it supplies the first concrete demand for the environment
component that the parent design intentionally left abstract.

Parent decisions D1–D5 remain in force. This design adds detail; it does not
reopen self-funded escrow, consent, discrimination, commit-echo ordering, or the
public/private boundary.

## 3. Problem statement

The current harvest loop calls `findSourceInstanceForRepo`. That source instance
supplies four things the commit miner cannot yet produce:

1. a Docker image containing the repository at a usable base state;
2. install/build configuration;
3. a test command;
4. a log parser.

No matching validated-pool row means no candidate can reach empirical derivation.
Cloning an arbitrary repository does not solve this. The missing product is a
reproducible evaluator substrate that another operator can pull, verify, and run.

There are two independent jobs:

- **Environment discovery:** determine how an unfamiliar repository is built and
  tested.
- **Environment execution:** reproducibly build, publish, verify, and consume the
  resulting substrate.

This design makes execution a stable Jinn-owned contract. Discovery becomes a
provider interface that can improve without changing admission or evaluation.

## 4. Goals and non-goals

### 4.1 Goals

- Mint tasks from licensed public repositories that have no Rebench pool row.
- Keep minted tasks in the existing `swe-rebench-v2.v1` lane.
- Make image, recipe, parser, and source state content-addressed and drift-checked.
- Separate explicit, deterministic, and agentic discovery from trusted execution.
- Make harvest jobs resumable, idempotent, and budget-bounded.
- Prove the path first on `jinn-mono`, then on one unfamiliar public repository.
- Keep the gold patch local and structurally unavailable to the image builder.

### 4.2 Non-goals

- Private-repository publication.
- Hunk-subset echo or general trace mining.
- Automatic support for every language or build system in the first tranche.
- Dynamically executing generated parser code.
- Windows, macOS, or Android evaluator images.
- Replacing the Task Creator generator, posting policy, or economics.
- Automatically deprecating `jinn-repo.v1`.
- Building daemon-managed mirrors before the explicit proof works.
- G1 capsule runtime schemas, `session-derived.v2`, or `SandboxProvider` work.

## 5. Approaches considered

### 5.1 Selected: normalized contract with a provider ladder

Every discovery mechanism produces an `EnvironmentBuildRecipe`; an isolated
builder turns that recipe into one `TaskEnvironmentSpec`. Minting and evaluation
depend only on the normalized spec.

Provider order is:

1. explicit repository/operator configuration;
2. deterministic inference from Dockerfiles, devcontainers, CI, and language
   conventions;
3. agentic environment construction.

This keeps the integrity boundary under Jinn's control and avoids paying for an
agentic process when the repository or captured session already supplies the
answer.

### 5.2 Rejected: RepoLaunch as the native Task Creator format

RepoLaunch can discover build and test procedures across languages, but it is an
expensive agentic process and emits dynamic parser code that the current evaluator
cannot safely consume. Jinn would still need normalization, isolation, OCI
publication, digest pinning, admission, and verdict-time checks. RepoLaunch is
therefore a provider, not the Task Creator's substrate format.

### 5.3 Rejected: per-repository SolverTypes and evaluators

The existing `jinn-repo.v1` evaluator is useful evidence that Jinn tasks are
gradeable, but repeating that pattern per repository would fork schemas,
generators, evaluator logic, economics, and downstream consumption. The parent
design explicitly chose one shared minted-task lane.

## 6. Architectural invariants

1. A public-repository mint is an ordinary admitted `swe-rebench-v2.v1` task.
2. The environment builder never receives the gold patch or fix commit.
3. New public-repository images contain the repository at `baseCommit`, with
   dependencies baked in and a clean worktree.
4. Runtime image references are digest-qualified; tags are informational only.
5. Evaluators execute only versioned trusted parsers.
6. Gold-grade and known-bad evidence are bound to image, environment, parser, and
   test-patch hashes.
7. Publication gates run before an image or row is made public.
8. Infrastructure failures emit no solver verdict.
9. Existing benchmark and minted-row v1 tasks remain compatible.
10. The generator does not build, discover, fetch, or reason about environments.

## 7. Component model

### 7.1 Candidate source

The commit-echo source emits:

- repository slug;
- base and fix commits;
- problem statement;
- gold code patch;
- test patch or gold test files;
- test-file paths and language hints.

For `jinn-mono`, the first source reuses the useful parts of
`jinn-repo-extract.ts`: merged-PR selection, issue context, test-file extraction,
and a test-stripped solution patch. The output is adapted to the Task Creator
candidate shape; it does not become a `jinn-repo.v1` task.

The candidate source owns the gold. It gives environment discovery only the repo,
base commit, language, and non-secret hints such as workspace and test-file paths.

### 7.2 Environment recipe resolver

`EnvironmentRecipeResolver` declares whether it supports a request and, if so,
produces an `EnvironmentBuildRecipe`. It is discovery only: it performs no Docker
build, sandbox provisioning, IPFS write, or OCI write. `SandboxProvider` is reserved
for the later G1 capsule runtime, where it provisions solver and evaluator runtime
environments; it is not a discovery synonym in this bootstrap.

Conceptual interface:

```ts
interface EnvironmentBuildRequest {
  repo: string;
  repoUrl: string;
  baseCommit: string;
  language?: string;
  workspaceHint?: string;
  testPathHints: string[];
  commandHints: string[];
}

interface EnvironmentBuildRecipe {
  source: Pick<EnvironmentBuildRequest, 'repo' | 'repoUrl' | 'baseCommit'>;
  platform: 'linux/amd64';
  workspace: '/testbed';
  buildDefinition: string;
  smokeCommands: string[];
  testCommands: string[];
  parser: { id: string; version: string; digest: `sha256:${string}` };
  inputRights: Array<{ inputRef: string; rightsRef: string }>;
}

interface EnvironmentRecipeResolver {
  readonly id: string;
  readonly version: string;

  supports(request: EnvironmentBuildRequest): Promise<
    | { supported: true; confidence: 'explicit' | 'deterministic' | 'agentic' }
    | { supported: false; reason: string }
  >;

  resolve(request: EnvironmentBuildRequest): Promise<EnvironmentBuildRecipe>;
}
```

`EnvironmentBuildRequest` deliberately has no `fixCommit`, gold patch, test-patch
content, or gold-test content. `testPathHints` may name files introduced by the
future test patch; they are command-construction hints, not build inputs.

The resolver registry tries configured resolvers in order. Once a resolver claims a
request, malformed output is an error from that resolver, not permission to
silently fall through to a different interpretation.

### 7.3 Isolated environment builder

The builder:

1. runs on a disposable Linux/amd64 worker;
2. checks out exactly `baseCommit`;
3. executes the recipe without wallet or signing credentials;
4. runs the recipe's environment smoke commands at the base state;
5. asserts `HEAD == baseCommit` and a clean worktree;
6. builds an amd64 OCI image;
7. generates the image scan and build evidence;
8. hands the image to an outer controller for registry upload;
9. emits an attested `TaskEnvironmentSpec`.

Registry credentials belong to the outer controller and never enter the build
context. The initial registry is operator-configured, with GHCR as the first Jinn
deployment target.

### 7.4 Publication gate

The publication gate runs before OCI and IPFS disclosure. It verifies:

- repository visibility;
- per-input and per-environment-layer publication rights references;
- held-out and repository denylist status;
- explicit task-publication authorization;
- base image and dependency policy evidence;
- image secret scan;
- image platform and digest;
- trusted parser identity;
- absence of gold inputs from the builder request and recipe.

Public GitHub visibility is not a redistribution licence. GitHub's licensing
guidance states that without a licence default copyright restrictions apply,
including restrictions on reproduction and distribution. A repository must
therefore have an allowlisted SPDX licence or a recorded explicit authorization
before Jinn publishes an image containing its code.

For the first tranche, approved base images and repository licences are an
allowlist. The builder also emits an SBOM reference so later policy versions can
strengthen dependency review without changing the environment contract.

### 7.5 Empirical verifier and admission adapter

The empirical verifier runs:

- base image + test patch + empty solution;
- base image + test patch + gold solution.

It records full parsed before/after results, derives F2P/P2P, and rejects dead
candidates with no F2P. The before run is the discrimination proof; the after run
is the gold-grade proof.

Admission may reuse this evidence only when all bindings match:

- image digest;
- environment hash;
- parser id/version/digest;
- test-patch hash;
- task instance id;
- evaluator semantics version.

Any mismatch causes a rerun. Reuse avoids paying for an identical second pair of
Docker runs without weakening the admission boundary.

### 7.6 Shared evaluator runtime

At verdict time the existing evaluator route:

1. resolves the minted row from its `ipfs://` dataset reference;
2. resolves and hashes the environment spec;
3. pulls the image by digest;
4. confirms platform, image digest, environment hash, row hash, and admission;
5. applies the task's test patch;
6. applies the solver patch;
7. runs the declared commands;
8. parses through the trusted parser registry;
9. applies SWE-bench resolved semantics: every F2P passes and no P2P fails;
   extra tests do not invalidate an otherwise correct result.

The solver never runs in this evaluator environment. It works in its own clean
solve-time environment and supplies only its Solution patch; a new evaluator
environment is started from the digest-pinned image for grading. G0b creates the
evaluator image/recipe path only, not a general `SandboxProvider` runtime.

An evaluator setup, pull, patch, parser, or runtime failure is ungradeable and
emits no signed verdict.

## 8. `TaskEnvironmentSpec.v1`

The public spec describes an already-built evaluator environment. It never
contains the gold solution.

```ts
interface TaskEnvironmentSpecV1 {
  schemaVersion: 'jinn.task-environment.v1';

  source: {
    repo: string;
    repoUrl: string;
    baseCommit: string;
  };

  inputs: Array<{
    inputRef: string;
    sha256: `sha256:${string}`;
    rightsRef: string; // SPDX evidence or explicit authorization for this input
  }>;

  execution: {
    platform: 'linux/amd64';
    workspace: '/testbed';
    image: {
      reference: string; // registry/name@sha256:...
      digest: `sha256:${string}`;
    };
    testCommands: string[];
    parser: {
      id: string;
      version: string;
      digest: `sha256:${string}`;
    };
    timeoutSeconds: number;
    environment: Record<string, string>;
  };

  build: {
    recipeCid: string;
    recipeHash: `sha256:${string}`;
    provider: 'explicit' | 'deterministic' | 'agentic';
    providerId: string;
    providerVersion: string;
  };

  publication: {
    publicRepoVerifiedAt: string;
    rightsPolicyVersion: string;
    buildSmoke: 'pass';
    imageSecretScan: 'pass';
    sbomCid: string;
  };

  attestation: {
    environmentHash: `sha256:${string}`;
    algo: 'secp256k1';
    operatorSafe: string;
    signer: string;
    signature: string;
  };
}
```

### 8.1 Hashing

`environmentHash` is SHA-256 over RFC 8785-canonical JSON containing the
immutable `source`, `inputs`, `execution`, and `build` fields plus the rights-policy
version and SBOM CID. It excludes observation timestamps and the attestation itself.

The configured operator signer signs `environmentHash`; `operatorSafe` records
the attributed operator. This is provenance and integrity evidence, not a new
protocol-level trust claim. Admission still verifies the substrate locally.

### 8.2 Runtime setup policy

Dependencies are baked into new public-repository images. Arbitrary setup commands
from the build recipe do not rerun on evaluator hosts. This improves latency,
reproducibility, and isolation. Existing Rebench rows may continue using their
legacy `install_config` behavior.

Build smoke commands prove that the toolchain and repository can start without
the task patch; task-specific test commands are first executed during empirical
verification, after the test patch is applied. This distinction supports commits
that introduce a new test file without exposing that file to the builder.

### 8.3 Parser policy

The evaluator bundle owns a versioned parser allowlist. Initial new support is
`vitest-json.v1`; existing Rebench parser identifiers remain supported.

RepoLaunch or another agentic provider may propose parser code during discovery,
but v1 does not execute it. The provider must map onto an admitted parser or place
the job in `awaiting_input` for a human-reviewed parser addition.

## 9. Artifacts and compatibility

### 9.1 Minted-row versioning

The minted artifact parser accepts a versioned union:

- `swe-rebench-v2-minted-pool.v1`: current Rebench-backed mints;
- `swe-rebench-v2-minted-pool.v2`: public-repository mints with
  `environmentSpecCid` and `environmentHash`.

For v2, `image_name` remains present for compatibility but must be a
digest-qualified OCI reference. `install_config.log_parser` names the trusted
parser. The environment spec is the canonical operational source; adapters derive
the legacy-compatible row view from it.

### 9.2 Row hashing

Minted-row v2 uses `rowHashVersion: 2`, covering the existing row inputs plus:

- environment-spec CID;
- environment hash;
- digest-qualified image reference;
- parser identity and digest.

Benchmark and minted-row v1 admissions remain on row-hash version 1. Verdict-time
recheck selects the stored version. This avoids globally invalidating the current
validated benchmark pool merely to add the new minted substrate.

### 9.3 Published vetted-pool evidence

The existing published vetted-pool reference carried in task eligibility remains
the evaluator's admission evidence. Its v2 entry includes the row-hash version and
environment bindings. No new on-chain task schema is required: `hf_dataset` still
points at the IPFS minted-row artifact.

## 10. Generator and posting invariant

Environment construction finishes by writing an admitted entry to the existing
minted pool. From that point:

1. the generator loads benchmark pool union minted pool;
2. existing scorable and held-out filters run;
3. existing selection chooses the candidate;
4. the synthetic quota and informative-band halt apply;
5. complexity-weighted escrow and synthetic provenance are attached;
6. existing minter/source-solver claim protections apply;
7. `MechAdapter.postTask` posts an ordinary `swe-rebench-v2.v1` task.

The generator never calls an environment provider or builder. It does not inspect
the environment spec. The only compatibility work is accepting an admitted v2 row
through the existing minted-pool loader.

Public-repository tasks remain synthetic/minted for economic and integrity policy;
they do not bypass the 25% quota or other guards merely because their source commit
was written by a human.

## 11. End-to-end data flow

Each candidate becomes a durable job:

```text
discovered
  -> source-gated
  -> recipe-resolved
  -> image-built
  -> publication-gated
  -> empirically-verified
  -> admitted
  -> artifacts-published
  -> eligible-for-posting
  -> posted
```

Detailed flow:

1. Discover new commits or merged PRs and persist candidate jobs.
2. Run visibility, rights, authorization, denylist, held-out, parser, and commit
   shape checks before expensive work.
3. Resolve an environment recipe through the provider registry.
4. Reuse a cached environment or build one on an isolated amd64 worker.
5. Scan, publish, hash, and attest the environment.
6. Run bound before/after empirical evaluation.
7. Reuse the bound empirical evidence in admission.
8. Publish the environment spec and minted-row v2 artifacts to IPFS.
9. Add the admitted row to the existing minted pool.
10. Let the unchanged generator post it when existing policy selects it.
11. Let an independent evaluator pull and grade it by digest.

Gold remains local to steps 6–7. The image contains only `baseCommit`; the public
test patch is part of the task row, and the solver patch arrives only at verdict
time.

## 12. Durable state and idempotency

`HarvestStateStore` advances to a v2 schema with:

- per-repository discovery cursor;
- jobs keyed by stable candidate id;
- current stage and attempt count;
- recipe, image, environment, admission, and IPFS references;
- terminal disposition or retry schedule;
- CPU time, build duration, and optional provider cost;
- created/updated timestamps.

The discovery cursor advances after jobs are persisted, not after they succeed.
Thus a later cursor cannot make a failed candidate disappear. This replaces the
current coupling between the high-water cursor and rejected cache.

Environment builds are idempotent by:

```text
repo + baseCommit + recipeHash + platform
```

Minted instances remain idempotent by repository + fix commit. Each transition
checks for an existing valid artifact before performing a write.

The v1 state migration creates a job record for known rejected ids and retains the
last scanned commit. Rejected entries without structured reasons become terminal
legacy rejections; operators may explicitly requeue them.

## 13. Failure handling

### 13.1 Terminal rejection

- private source;
- missing/incompatible publication rights;
- denylisted or held-out repo;
- invalid source/test patch;
- untrusted parser;
- failed image secret or rights scan;
- no F2P;
- known-bad passes;
- gold fails.

### 13.2 Retryable infrastructure failure

- GitHub/API/network outage;
- builder or Docker outage;
- OCI registry outage;
- IPFS outage;
- transient disk or capacity exhaustion.

Retryable failures use bounded exponential backoff and preserve completed stages.

### 13.3 Awaiting input

- no supporting provider;
- ambiguous rights evidence;
- missing publication authorization;
- unsupported test framework;
- agentic output requiring parser review.

These jobs are neither rejected nor retried automatically.

### 13.4 Quarantine

- flaky tests;
- non-reproducible build;
- conflicting parser reports;
- repeated timeout;
- digest instability.

Quarantined jobs require operator inspection and an explicit requeue.

### 13.5 Evaluator failure

Pull, setup, patch, command, parser, and resource failures produce no verdict. A
task may be attempted by another evaluator; no infrastructure failure becomes a
solver `FAIL`.

## 14. Resource and security controls

Operators configure per-day and per-repository limits for:

- candidates discovered;
- concurrent builds;
- build CPU minutes;
- empirical evaluation runs;
- disk use;
- agentic-provider spend.

Agentic discovery is disabled without an explicit non-zero budget. Consecutive
infrastructure failures open a provider circuit breaker without stopping unrelated
repositories.

Builders receive no wallet, Safe signing, GitHub-write, or registry credentials.
Package installation requires network access, so the disposable worker—not the
long-running daemon—is the containment boundary. Registry upload and attestation
run in the outer controller.

Revoking an environment hash stops future posting. Already-published OCI and IPFS
artifacts must be treated as irreversible disclosure even if a registry later
garbage-collects them; publication gates therefore fail closed.

## 15. First explicit provider: `jinn-mono`

The provider configuration encodes:

- repository: `Jinn-Network/mono`;
- source rights: repository Apache-2.0 licence;
- platform: Linux/amd64;
- base image/toolchain: approved Node 22 image;
- workspace: `/testbed`, with commands scoped to `client/`;
- dependency install: Corepack plus `yarn install --immutable`, baked at build;
- environment smoke: a provider-pinned command that exercises Yarn/Vitest without
  requiring the candidate's test patch;
- test execution: targeted Vitest files from the candidate;
- parser: `vitest-json.v1`;
- runtime timeout and bounded environment variables.

This knowledge lives in the provider, not a `jinn-mono` evaluator. The existing
`jinn-repo.v1` evaluator is retained as an oracle for the chosen fixture. Matching
verdicts provide a strong comparison while the generalized path is new.

The fixture must be a natural merged fix that is absent from the shipped
`jinn-repo.v1` pool. Reusing an existing fixture would prove compatibility but not
fresh task creation.

## 16. Evaluator harness durability

Empirical mode depends on the upstream report exposing full `passed_actual` and
`failed_actual` sets. The operator's manual patch from the rung-1 live proof is not
durable.

The evaluator harness therefore:

1. pins an exact `SWE-rebench-V2` upstream commit;
2. applies a versioned Jinn patch bundle during `onEnable`;
3. records upstream commit and patch digest in the enabled state;
4. upgrades or repairs an existing state whose bundle is stale;
5. runs an empirical-mode self-test before reporting ready.

The same versioned bundle owns trusted parser additions such as
`vitest-json.v1`. A fresh enable must require no manual upstream edits.

## 17. Delivery milestones

### A — contract and compatibility

- environment schema and canonical hash;
- provider and builder interfaces;
- trusted parser registry;
- minted-row v1/v2 union and row-hash versioning;
- publication and rights gate;
- harvest-state v2.

### B — `jinn-mono` factory proof

- natural merged fix outside the existing pool;
- explicit provider;
- amd64 image built and published by digest;
- empirical F2P/P2P;
- admission and IPFS artifacts;
- no autonomous posting yet.

### C — full network proof

- existing generator selects the admitted v2 row;
- normal escrow and posting;
- solver delivery;
- independent evaluator pull and verdict;
- normal network settlement.

### D — portability proof

Repeat the factory and network proof for one unfamiliar, licensed public
repository without adding a bespoke evaluator. Provider configuration and an
already-admitted parser may vary.

### E — deterministic automation

Add discovery from repository Dockerfiles, devcontainers, CI workflows, and
language conventions, followed by optional managed mirrors and continuous
harvesting.

### F — agentic provider

Integrate RepoLaunch or an equivalent provider only for demonstrated unsupported
repositories. Its output is normalized and subjected to every existing builder,
parser, rights, admission, and publication gate.

## 18. Test strategy

### 18.1 Unit and schema

- canonical environment hashing;
- rights-basis union and allowlist policy;
- provider selection and non-fallthrough;
- parser pass/fail/skip/malformed fixtures;
- row-hash v1/v2 selection;
- state transitions and idempotency keys.

### 18.2 Security and integrity

- provider/builder interfaces cannot receive gold or fix commit;
- private, unlicensed, denied, and unauthorized repos fail closed;
- failed secret scan blocks publication;
- image reports `HEAD == baseCommit` and a clean worktree;
- gold/test patch is absent from image layers and build context;
- parser version/digest mismatch blocks evaluation;
- image/environment/row drift emits no verdict.

### 18.3 Integration

- disposable local OCI registry build and pull;
- bound empirical evidence reuse and forced rerun on mismatch;
- mocked OCI/IPFS orchestration;
- daemon restart at each durable stage;
- retry, quarantine, awaiting-input, and cursor advancement;
- existing minted-row v1 and benchmark-row regression;
- generator regression proving v2 takes the existing post path.

### 18.4 Live proofs

- clean amd64 `jinn-mono` factory proof;
- independent evaluator host proof;
- full generator/post/deliver/grade loop;
- second-repository portability proof.

## 19. Acceptance criteria

1. A natural `jinn-mono` fix outside Rebench and outside the existing
   `jinn-repo.v1` pool becomes an admitted minted-row v2 task.
2. Its OCI image is public and pullable by digest on a clean amd64 host.
3. Bound before/after reports establish at least one F2P and admission accepts
   that evidence.
4. Gold is absent from the image, environment spec, build recipe, IPFS artifacts,
   and task payload.
5. Visibility, rights, authorization, held-out, denylist, parser, and image-scan
   gates fail closed.
6. A separate evaluator detects environment or image drift and emits no verdict.
7. The existing generator posts the task without a new generator, selection
   strategy, or posting path.
8. Existing synthetic quota, escrow, claim, lineage, and informative-band guards
   apply to the task.
9. A solver delivery and evaluator verdict settle through the normal network
   loop.
10. Restarting any pre-post stage resumes without duplicating builds, images,
    rows, or tasks.
11. Existing Rebench and minted-row v1 behavior remains compatible.
12. One unfamiliar licensed public repository passes through the abstraction
    without a bespoke evaluator.
13. `jinn-repo.v1` and the generalized evaluator produce matching verdicts on
    the selected Jinn fixture.
14. A fresh evaluator enable passes empirical mode without manual upstream edits.

## 20. Scaling and kill criteria

This design earns environment portability; it does not independently authorize
mint volume. Task Creator v0's original controls remain decisive:

- admission yield at least 30%;
- a minted family in the informative solve-rate band;
- cost no more than 3x baseline per distill-admissible trajectory;
- lookup-flagged trajectories excluded from distillation;
- scaling paused on a null three-arm measurement;
- synthetic postings capped at 25%.

Environment-specific reporting adds build success rate, median build duration,
CPU minutes, retry/quarantine rate, and cache reuse. These diagnose substrate
cost; they do not replace the parent design's usefulness metric.

## 21. Deferred decisions

The following are explicitly deferred and do not block this design:

- private-repository image disclosure controls;
- automatic admission of generated parser code;
- non-Linux/amd64 platforms;
- hunk-subset and trace-derived candidate generation;
- protocol-level trust or plural attestation for environment builders;
- `jinn-repo.v1` deprecation;
- generalized dependency-licence policy beyond the versioned allowlist and
  recorded SBOM used for the first proofs.

Each requires a separate design or evidence gate. None may be inferred from the
success of the public-repository bootstrap.
