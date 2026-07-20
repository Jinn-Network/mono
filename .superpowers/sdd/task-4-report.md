# Task 4 Report — Implementation Phase

## Status

DONE

Commit: recorded in the Task 4 handoff after commit creation.

## Delivered scope

- Added the injected v2 implementation action executor:
  - canonical issue reality re-read before claim;
  - ambiguity-first Human escalation;
  - stable `autopilot/<issue>` branch creation or exact one-PR branch adoption;
  - selected Task 3 implement credential and canonical HTTPS-only publication;
  - exact Task 1 empty claim commit and remote lease result handling;
  - post-claim target-base authority re-read;
  - draft PR/readback, marker, `engine:review`, and Project `In Progress`
    before detached attempt creation or coordinator spawn;
  - process-wide Claude/Hermes coordinator parity and Task 3 child tracking.
- Added implementation-only production session handlers:
  - `checkpoint` re-reads manifest, remote claim ancestry, and exact PR
    head/draft/branch/base/marker authority, requires a real tree change,
    publishes through an exact lease, and advances only the progressive
    manifest head;
  - `implementation-complete` checkpoints pending work, publishes one durable
    empty phase-complete commit, restores draft before projections when
    needed, updates summary/label/Project, and makes ready last;
  - `human` persists a structured marker/comment, Human label/Project state,
    and draft state idempotently;
  - bounded strict UTF-8 file reads for summary/reason inputs.
- Extended Task 2 recovery narrowly so the completion summary is durable:
  - the GitHub reader extracts it from the exact phase-complete commit;
  - snapshot/projection carries a head-pinned summary repair before
    label/Project/ready;
  - the reconciler exposes an exact-head summary writer contract.
- Added the narrow progressive expected-head manifest updater required by
  successful checkpoints.
- Kept review, review-fix, merge-prep, merge, and the global v2 `active`
  controller unwired. Production active mode remains explicitly rejected.

## RED/GREEN evidence

- Executor RED: missing implementation executor module, then failing
  concurrency/stable/adopted/reality/ambiguity paths. GREEN after exact claim,
  draft-before-spawn, and identity implementation.
- Session RED: missing implementation session protocol, then failures for
  exact lease, real-tree, progressive manifest, completion, Human, and
  ambiguous-marker recovery. GREEN after protocol and production port work.
- Review follow-up RED:
  - multiple `pr-open` mappings returned ineligible instead of Human;
  - post-claim target-base changes still opened a PR;
  - checkpoint accepted missing marker, changed branch/base, and ready PRs;
  - completion could create its marker before exact PR revalidation;
  - Task 2 had no durable summary recovery action;
  - completion projection did not restore draft before summary/Project.
  All are covered and GREEN.
- Production identity RED covered SSH rejection, selected HTTPS askpass/token,
  exact remote lease, session-bound manifest reads, and malformed newer
  lifecycle evidence failing closed.
- Final-review remediation RED:
  - the first focused run produced the expected 14 failures across 66 tests:
    brand-new executor claims could not authorize their bound PR session,
    ordinary ineligibility flattened branch ambiguity, completion recovery
    continued after failed prerequisites, marker retry and Human paths lacked
    complete PR authority, Human did not dominate completion, retries trusted
    changed summary input, and summary metadata parsing collided with
    metadata-looking summary lines;
  - an additional exact-order RED proved ambiguous marker retry read the
    durable summary after its last PR validation;
  - an additional Human-order RED proved a base change between redraft and
    later Human mutations was not detected.
- Final-review remediation GREEN:
  - an omitted PR number is accepted only on the manifest's exact original
    implementation claim; the bound draft PR still must match exact issue,
    number, head, branch, base, and lifecycle marker;
  - ambiguity is evaluated after issue existence/open checks and the canonical
    reality check, but before ordinary eligibility;
  - completion repair actions form an explicit previous-success chain, so a
    failed summary/label/Project prerequisite prevents ready;
  - ambiguous completion retry re-reads durable summary and then exact active
    PR authority immediately before its lease publication;
  - `review:needs-human` or Project `Human` stops completion before a marker,
    `In Review`, or ready mutation, with repeat checks during projection;
  - Human revalidates complete PR authority initially and between ordered
    mutations;
  - phase-complete retries reject summary-file drift and use the exact
    completion commit's durable summary;
  - lifecycle metadata is parsed only from the terminal contiguous trailer
    block, leaving `Jinn-Autopilot-*` summary lines unambiguous.

## Files

- `packages/autopilot/src/lifecycle/implementation-executor.ts`
- `packages/autopilot/src/lifecycle/implementation-session.ts`
- `packages/autopilot/src/lifecycle/implementation-session-production.ts`
- `packages/autopilot/src/lifecycle/codecs.ts`
- `packages/autopilot/src/lifecycle/attempt-workspace.ts`
- `packages/autopilot/src/lifecycle/github-reader.ts`
- `packages/autopilot/src/lifecycle/snapshot.ts`
- `packages/autopilot/src/lifecycle/projection.ts`
- `packages/autopilot/src/lifecycle/reconciler.ts`
- `packages/autopilot/src/lifecycle/types.ts`
- `packages/autopilot/src/lifecycle/index.ts`
- `packages/autopilot/src/cli/session.ts`
- Matching CLI and lifecycle unit/integration tests.

## Verification

- `yarn vitest run test/lifecycle test/dispatcher/coordinator-session.test.ts`
  — 15 files, 191 tests passed.
- `yarn typecheck` — passed.
- `yarn test` — 86 files, 918 tests passed.
- `git diff --check` — passed.

## Self-review

- Claim/PR/Project/spawn ordering matches the brief: PR exact readback precedes
  Project, attempt creation, and spawn.
- Claim losers and unresolved ambiguity perform no downstream mutation.
- Checkpoints cannot publish from a stale manifest/claim or changed PR.
- Completion evidence is durable before recoverable projections, and ready is
- Completion projection prerequisites stop in order after failure rather than
  allowing Project or ready to overtake durable summary repair.
- Human is dominant in both direct session completion and recovery; Human
  never readies or deletes work.
- New-branch claims intentionally omit the not-yet-created PR number, while
  session authority permits that omission only for the exact original claim
  bound by the manifest and exact PR readback.
- Completion summaries are recovered from the exact phase-complete commit and
  terminal trailer parsing cannot consume metadata-looking summary content.
- Production session Git/GitHub calls use the selected token/askpass and reject
  SSH/non-canonical publication remotes.
- No global active-controller, review writer, merge-prep writer, or merge
  activation was added.

## Concerns

- The concrete implementation action executor remains intentionally injected
  and is not connected to global `active` mode in Task 4.
- The production GitHub writer paths are unit/integration tested with command
  runners and local bare remotes, but no live GitHub canary was run.
- A checkout intended for later active-mode activation must configure the
  canonical HTTPS publication remote; SSH remotes are deliberately rejected.
