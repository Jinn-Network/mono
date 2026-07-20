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
