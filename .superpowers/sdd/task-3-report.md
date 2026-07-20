# Task 3 report — credential boundaries, detached attempts, safe cleanup, and session CLI

## Status

DONE

Commit:

`HEAD` — this report is included in the implementation commit; the exact SHA
is recorded in the task handoff because a commit cannot contain its own final
SHA.

## Scope delivered

### Credential pool and selection

- Added boot-time resolution for `JINN_IMPL_GH_TOKEN` and
  `JINN_REVIEW_GH_TOKEN` through `gh api user`.
- Preserved optional `JINN_REVIEW_BOT_LOGIN` as a case-insensitive assertion.
- Deduplicated identical tokens before resolution and consolidated credentials
  by normalized authenticated login while retaining both role preferences.
- Implement/merge-prep/merge prefer the implementation credential; review
  prefers the review credential.
- Review selection always rejects the PR author's login case-insensitively.
- A single configured credential can implement and can review a PR authored by
  a different login.
- Review recovery preserves the previous reviewer when available. If native
  requested changes make a reviewer switch unsafe, selection returns a
  structured `identity-unavailable` result.
- Tokens remain in native private fields. Pool/selection JSON, diagnostics,
  assertion errors, and credential-resolution errors contain logins/reasons,
  never token material.

### Sanitized child and Git environments

- Added a child environment builder that preserves runtime inputs such as
  `PATH`, `HOME`, and Hermes variables while removing ambient/equivalent GitHub
  token/PAT variables.
- Injects exactly one selected credential as `GH_TOKEN`.
- Injects the exact attempt paths for:
  - empty `GH_CONFIG_DIR`;
  - `GIT_ASKPASS` and `SSH_ASKPASS`;
  - `GIT_TERMINAL_PROMPT=0`;
  - `JINN_AUTOPILOT_SESSION_MANIFEST`.
- Added Git publication arguments that reset credential helpers, disable
  interactive credential lookup, and pin `core.askPass` to the attempt script.
- Parent command overlays explicitly blank ambient GitHub credentials before
  login resolution or cleanup fetches. Only the selected `GH_TOKEN` may be
  restored.

### Detached attempt workspace and manifest

- Added attempt layout:

  ```text
  <worktree-base>/v2/<runner-id>/<phase>/<subject>-<attempt-id>/
  ├── manifest.json
  ├── session.log
  ├── gh-config/
  ├── askpass
  └── worktree/
  ```

- Attempt IDs use `crypto.randomUUID()`.
- `JINN_AUTOPILOT_RUNNER_ID` is honored when present and must be
  filesystem-safe.
- The default runner ID combines a filesystem-safe hostname, PID, and
  process-boot UUID.
- Worktrees are always added with `git worktree add --detach` at the exact
  validated OID. They never check out the shared logical branch.
- Added strict `AttemptManifest` v2 decoding for attempt/runner/host, phase,
  issue/optional PR, subject, branch, target base, expected head, claim OID,
  optional review generation/ref OID, selected login, nullable pre-spawn PID,
  exact paths, and lifecycle timestamps.
- Unknown, missing, contradictory, malformed, non-canonical, and token fields
  are rejected.
- Manifest creation/update uses a mode-0600 sibling temporary file and atomic
  rename. Updates cannot change attempt identity, paths, or creation time.
- Runner-local capacity counts only strictly decoded, live manifests under the
  current runner's directory. It does not create a runner registry or affect
  shared ownership.

### Safe local cleanup

- Cleanup strictly validates manifest/path/attempt agreement and the exact v2
  directory before inspection or removal.
- Lexical escapes and symlink substitutions for the attempt, worktree,
  manifest, log, GH config, or askpass are rejected.
- Live PIDs are retained.
- Normal cleanup requires a clean worktree, an authenticated refresh of the
  expected remote publication ref, valid local/remote commit objects, and proof
  that local `HEAD` is an ancestor of that remote ref.
- Dirty, ahead, missing-object, authentication-failed, malformed,
  escaped-path, and ambiguous attempts are retained with structured,
  secret-free reasons.
- Exact redundant cleanup succeeds when the registered worktree has already
  been removed.
- Worktree removal uses the proven Git common directory and exact worktree
  path, without `--force`; only afterward is the exact attempt directory
  removed.
- Same-host dead-attempt sweeping may inspect all local runner directories,
  but only invokes this local cleanup proof. It leaves live PIDs alone and has
  no GitHub mutation/inference path.

### Strict fail-closed session CLI

- Added the singular internal route:
  - `session checkpoint`
  - `session implementation-complete --summary-file <path>`
  - `session review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path>`
  - `session review-fix-publish`
  - `session merge-prep-complete --summary-file <path>`
  - `session human --reason-file <path>`
- Grammar rejects unknown commands/options, alternate ordering, duplicates,
  missing values, and trailing input before reading a manifest.
- The CLI requires `JINN_AUTOPILOT_SESSION_MANIFEST`, re-reads and strictly
  validates it immediately before delegation, and enforces phase/operation
  compatibility.
- Added a narrow injectable `SessionProtocol` interface.
- Every production protocol method throws a clear `operation not wired` error.
  No lifecycle writer, checkpoint publication, verdict submission,
  merge-prep operation, or Human projection is activated.
- The existing plural `sessions` route and normal dispatcher path are
  unchanged.

### Runtime compatibility

- No changes were made to `coordinator-session.ts`, Hermes home/runtime
  mechanics, legacy implementation/review/merge-prep dispatch, lifecycle
  controller writer modes, or the canonical skills.
- Existing full-suite tests continue to prove that Hermes remains the global
  runtime and receives the selected `GH_TOKEN` for implementation, review, and
  merge-prep sessions.

## RED / GREEN evidence

All test commands ran from `packages/autopilot`.

### Credential pool and child authentication

RED:

```text
yarn vitest run test/lifecycle/credentials.test.ts
```

Result: suite failed to load because
`src/lifecycle/credentials.ts` did not exist.

GREEN:

```text
yarn vitest run test/lifecycle/credentials.test.ts
```

Initial result: 1 file passed, 7 tests passed.

Hardening RED/GREEN:

- credential-resolution error initially propagated
  `resolution-secret`; final error names only the credential preference;
- child environment initially omitted
  `JINN_AUTOPILOT_SESSION_MANIFEST`; final environment includes the exact
  manifest path.

Final focused result: 1 file passed, 8 tests passed.

### Detached attempts, strict manifests, and cleanup

RED:

```text
yarn vitest run test/lifecycle/attempt-workspace.test.ts
```

Result: suite failed to load because
`src/lifecycle/attempt-workspace.ts` did not exist.

GREEN:

```text
yarn vitest run test/lifecycle/attempt-workspace.test.ts
```

The first implementation run produced one expected failure: exact clean
cleanup retained because removal lacked a proven Git common directory. After
adding that proof, 1 file passed and 9 tests passed.

Hardening RED:

- configured runner env override returned the generated ID;
- cleanup fetch did not explicitly blank ambient `GITHUB_TOKEN`;
- `sweepDeadAttempts` was absent;
- a symlinked worktree returned `ambiguous` instead of `escaped-path`.

Hardening GREEN:

```text
yarn vitest run test/lifecycle/attempt-workspace.test.ts \
  test/lifecycle/credentials.test.ts
```

Result: 2 files passed, 18 tests passed. Final attempt suite has 11 tests.

### Session CLI and route

RED:

```text
yarn vitest run test/cli/session.test.ts test/cli/routing.test.ts
```

Result:

- session suite failed to load because `src/cli/session.ts` did not exist;
- singular route test failed because `shouldRouteToSession` did not exist.

GREEN:

```text
yarn vitest run test/cli/session.test.ts test/cli/routing.test.ts
```

Result: 2 files passed, 28 tests passed.

## Files changed

Production:

- `packages/autopilot/src/lifecycle/credentials.ts`
- `packages/autopilot/src/lifecycle/attempt-workspace.ts`
- `packages/autopilot/src/lifecycle/index.ts`
- `packages/autopilot/src/cli/session.ts`
- `packages/autopilot/src/cli/routing.ts`
- `packages/autopilot/scripts/run-autopilot.ts`

Tests:

- `packages/autopilot/test/lifecycle/credentials.test.ts`
- `packages/autopilot/test/lifecycle/attempt-workspace.test.ts`
- `packages/autopilot/test/cli/session.test.ts`
- `packages/autopilot/test/cli/routing.test.ts`

Evidence:

- `.superpowers/sdd/task-3-report.md`

## Required final verification

Fresh focused run after the final code changes:

```text
yarn vitest run test/lifecycle test/dispatcher/identity.test.ts
```

Result:

- 12 files passed;
- 137 tests passed;
- 0 failures.

Fresh typecheck:

```text
yarn typecheck
```

Result: exit 0, no diagnostics.

Fresh full package suite:

```text
yarn test
```

Result:

- 83 files passed;
- 852 tests passed;
- 0 failures.

Expected resilience-test stderr was present for injected failure paths; it did
not represent test failures. Existing implementation/review/merge-prep and
Hermes runtime suites were included and green.

Repository checks:

- `git diff --check`: exit 0.
- No branch publication, PR creation, review submission, merge-prep execution,
  merge, lifecycle claim, Project mutation, or lifecycle writer activation was
  performed.

## Self-review

- Re-read the Task 3 brief and active-active identity, local isolation,
  cleanup, migration, and implementation-boundary requirements.
- Confirmed the only existing production entrypoint change is an exact
  singular `session` routing branch that returns before dispatcher boot.
- Confirmed the production session protocol has no writer dependency and every
  operation fails closed.
- Confirmed no legacy dispatcher, review dispatch, merge-prep dispatch,
  coordinator runtime, Hermes adapter, lifecycle controller, claim adapter, or
  GitHub reconciler behavior changed.
- Confirmed every token-bearing structure uses native private storage or a
  process environment and no token is copied into manifests/results/reasons.
- Confirmed GitHub login-resolution and cleanup errors do not interpolate raw
  subprocess errors.
- Confirmed reviewer/author comparison and asserted-login comparison are
  case-insensitive.
- Confirmed one-login/two-token consolidation retains per-phase token
  preference without pretending there are two identities.
- Confirmed child and command overlays strip both named and equivalent ambient
  GitHub token/PAT variables while retaining non-GitHub runtime inputs.
- Confirmed worktree creation is detached at the exact OID and concurrent
  same-common-dir attempts use distinct paths.
- Confirmed cleanup performs no deletion before exact manifest/path/symlink,
  liveness, cleanliness, object, fetch, and reachability checks.
- Confirmed neither normal cleanup nor sweeping uses
  `git worktree remove --force`.
- Confirmed cleanup/sweep outputs are local-only and have no shared lifecycle
  transition or abandonment inference.
- Confirmed all new behavior was developed through observed RED then GREEN
  cycles, including the self-review hardening findings.

## Concerns

- The attempt and cleanup integration coverage uses real local repositories and
  bare remotes. It has not been exercised against a disposable private GitHub
  repository with expiring credentials, enterprise hosts, or every server-side
  authentication failure shape.
- Cleanup of a private remote must be invoked with the still-selected
  credential in `CleanupAttemptOptions.env`. Missing, expired, or wrong
  credentials intentionally retain the attempt as
  `authentication-failed`; there is no fallback to ambient/global auth.
- `pid: null` is the strict pre-spawn manifest state and must be atomically
  updated after child launch. A later integration task must wire that update
  and the terminal timestamp into the phase adapter; this task deliberately
  does not activate dispatch.
- Live active-active canary, crash campaign, and migration cutover remain
  required by the approved design before enabling any lifecycle writer.

---

## Review-fix pass — 2026-07-20

Reviewed implementation:

- Task 3 implementation baseline:
  `a59e753ea3b2bfa81773173461166e0f3564702b`
- Review-fix code and tests:
  `25c7235ab2016b6efa6b79a3350baf2d26f5e87a`
- Independent-review closure:
  `47bbd2c5bf8151bd8cc997618f33b57906cc9d47`

### Findings closed

1. Added strict `preparing | running | exited` process state. Process state,
   PID, and child timestamps must agree. Preparing manifests count against
   their runner's capacity and are retained because they contain no positive
   terminal evidence. Sweeping proceeds only for an explicit `exited` state or
   a `running` state whose recorded PID is positively observed dead.
   `trackAttemptChild` installs a parent-side exit handler which records
   `exited` through an atomic manifest update.
2. Review recovery with native requested changes now returns
   `identity-unavailable` when the previous reviewer login is missing, empty,
   self-reviewing, or unavailable. It never substitutes an arbitrary reviewer.
3. Child Git authentication now strips inherited `GIT_CONFIG_*` overrides,
   disables system/global configuration, installs command-scope
   `credential.helper=`, disables credential interaction, and binds
   `core.askPass`, `GIT_ASKPASS`, and `SSH_ASKPASS` to the attempt askpass.
   Cleanup fetches use the same environment-level boundary in addition to
   publication command arguments.
4. The strict manifest now records the canonical repository root, canonical
   Git common directory, remote name, and a SHA-256 remote URL identity. Atomic
   updates cannot change this identity. Cleanup re-reads the creating
   repository and the attempt worktree common directory and retains any
   mismatch as ambiguous before fetch or removal.
5. Workspace creation constructs and strictly decodes the complete prospective
   manifest before creating the v2 directories, auth files, log, manifest, or
   registered worktree. If `git worktree add` fails after registration, exact
   non-forced removal and registry read-back run. Exact attempt artifacts are
   deleted only after registry absence is proven; otherwise the strict
   manifest is retained so no registered worktree is manifestless.
6. A missing worktree directory is no longer sufficient cleanup proof.
   Cleanup proves that the exact canonicalized path is absent from
   `git worktree list --porcelain -z`, fetches the recorded remote publication
   ref with isolated authentication, and proves the recorded head reachable
   before deleting sibling metadata.

Cleanup and sweeping still have no GitHub API, lifecycle projection, branch
publication, or shared recovery mutation path. The missing-worktree integration
test records all cleanup commands and proves they are local Git
read/fetch operations only, with no `gh`, `git push`, or `git update-ref`.

### Review-fix RED / GREEN evidence

All commands ran from `packages/autopilot`.

Credential recovery and child Git environment:

```text
yarn vitest run test/lifecycle/credentials.test.ts
```

- RED: 2 failed, 6 passed. Missing previous reviewer selected an arbitrary
  reviewer; inherited Git config/helper values remained usable.
- GREEN: 1 file passed, 8 tests passed.

Process state and positive terminal evidence:

```text
yarn vitest run test/lifecycle/attempt-workspace.test.ts
```

- RED: 8 failed, 4 passed. `processState` and atomic transition helpers were
  absent, and a preparing attempt was removed.
- GREEN: 1 file passed, 12 tests passed after the state machine, parent exit
  binding, and cleanup gate were added.

Canonical repository identity, prevalidation, and rollback:

```text
yarn vitest run test/lifecycle/attempt-workspace.test.ts
```

- RED: 3 failed, 12 passed. Repository identity was absent, invalid input
  created v2 artifacts, an injected post-registration Git failure leaked a
  registered worktree, and remote identity drift reached authentication
  handling instead of failing closed as ambiguous.
- GREEN: 1 file passed, 15 tests passed.

Missing-worktree proof:

```text
yarn vitest run test/lifecycle/attempt-workspace.test.ts
```

- RED: 1 failed, 16 passed. A physically missing but still-registered worktree
  was removed.
- The first registry implementation exposed a macOS `/var` versus
  `/private/var` canonical-path mismatch. After canonicalizing both registry
  and prospective missing paths through the nearest existing ancestor,
  targeted GREEN was 1 passed, 16 skipped.
- Final attempt suite: 1 file passed, 17 tests passed, including registry
  absence, remote reachability, and local-only cleanup assertions.

Runner-local preparing capacity:

```text
yarn vitest run test/lifecycle/attempt-workspace.test.ts \
  -t 'counts only this runner'
```

- RED: expected 2 live local manifests, received 1.
- GREEN: 1 passed, 16 skipped. Same-runner preparing manifests count locally;
  other-runner and terminal manifests do not.

### Review-fix verification

Focused lifecycle and identity verification:

```text
yarn vitest run test/lifecycle test/dispatcher/identity.test.ts
```

Result:

- 12 files passed;
- 143 tests passed;
- 0 failures.

Typecheck:

```text
yarn typecheck
```

Result: exit 0, no diagnostics.

Full package suite:

```text
yarn test
```

Result:

- 83 files passed;
- 858 tests passed;
- 0 failures.

Expected resilience-test stderr was present only for injected failure paths.
`git diff --check` also exited 0.

### Review-fix self-review and concerns

- Re-read all six review findings, the Task 3 brief, and the approved identity,
  local isolation, cleanup, and implementation-boundary contracts.
- Confirmed strict decoding rejects missing/unknown process or repository
  identity fields and contradictory process/PID/timestamp combinations.
- Confirmed no recoverable cleanup path uses `--force`, broad deletion, or
  local absence as shared abandonment evidence.
- Confirmed a remote URL is not stored directly; only its SHA-256 identity is
  recorded, and no token-bearing environment value enters the manifest.
- Confirmed the session CLI remains fail-closed and the legacy dispatcher,
  Hermes/runtime adapters, claims, projection, and GitHub mutation paths remain
  unchanged.

Retained concerns:

- `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` are a
  deliberate POSIX runtime assumption. The Autopilot package currently runs
  under a POSIX shell, but a future native Windows port must replace this with
  a platform-specific null path while preserving the same isolation invariant.
- Repository identity uses a SHA-256 digest of the exact configured remote URL.
  Harmless textual changes to an equivalent URL intentionally retain the
  attempt as ambiguous instead of weakening identity matching.
- Private/enterprise GitHub authentication and the crash campaign still need
  live canary coverage before lifecycle writer activation.

### Independent completion-review closure

An independent read-only review of
`a59e753ea3b2bfa81773173461166e0f3564702b..25c7235ab2016b6efa6b79a3350baf2d26f5e87a`
identified four additional fail-closed gaps. Each was reproduced before the
closure commit:

- RED child-environment coverage showed ambient `SSH_AUTH_SOCK`,
  `SSH_AGENT_PID`, `GIT_SSH`, and `GIT_SSH_COMMAND` survived. GREEN strips
  those inputs and pins `GIT_SSH_COMMAND=false`, so an SSH remote cannot bypass
  the selected `GH_TOKEN`/askpass identity.
- RED process coverage showed an already-exited child remained `running`.
  GREEN binds exit observation before the atomic running transition and
  reconciles `exitCode` immediately afterward.
- RED missing-worktree coverage showed metadata could be removed without a
  recorded terminal head. GREEN adds optional strict `terminalHead`, records it
  atomically with `exited`, and retains a missing worktree unless that exact
  terminal OID is reachable from the refreshed publication ref.
- RED rollback coverage showed a pre-existing missing registry entry was
  unregistered by a colliding create call. GREEN proves registry absence before
  filesystem side effects, so rollback can remove only a registration
  introduced after that call's clean baseline.

Fresh verification after these closure changes repeated the required commands:

- focused lifecycle/identity: 12 files, 143 tests, 0 failures;
- `yarn typecheck`: exit 0;
- full package: 83 files, 858 tests, 0 failures;
- `git diff --check`: exit 0.

Additional retained concern: the hardened child deliberately cannot publish to
an SSH remote. Before active phase adapters are wired, publication must use a
validated HTTPS GitHub remote so the selected token and exact askpass are the
only usable principal. This is fail-closed in the current inactive Task 3
infrastructure, not an ambient-auth fallback.
