# PR #1727 reconciliation report

## Scope

- PR: `#1727` — `feat(operator-app): surface launcher vetted-pool staleness when EVAL_SEMANTICS_VERSION mismatches`
- Original exact head: `8496db98a274696a52ca615e87d85c6e2b6334dd`
- Reconciled target: `origin/next` at `77313739343b0ce6304aa268e52059efa0759101`
- Implementation head before this report commit: `4f34462820599b316f2066b3bc0feec9f1225058`
- Worktree: `.worktrees/pr-1727-reconcile`
- Local branch: `codex/pr-1727-reconcile`

Both target-branch updates were merged with ordinary merge commits; the PR was not rebased. The second update incorporated PR #1947 after `origin/next` advanced during verification.

## Result

The reconciled change preserves the intended end-to-end behavior:

1. The vetted-pool reader can inspect a publication without filtering out an eval-semantics mismatch.
2. The swe-rebench-v2 generator derives `poolPublicationStale` while retaining the existing automatic re-publication attempt on each generator tick.
3. The synchronous generator-state snapshot exposes the stale bit.
4. The launched-record dispatcher preserves only an exact `true` stale value.
5. The launched-record API overlays the live snapshot onto the record returned to the SPA.
6. The launched SolverNet dashboard renders a warning that is distinct from the no-publication and re-published states.

The reconciliation also:

- adds a dispatcher assertion for the stale bit;
- proves stale and re-published notices remain independently renderable when both fields are present;
- clarifies that the construction-time disk read makes a subsequent cold synchronous `getState()` informative rather than guaranteeing same-microtask completion;
- documents why the best-effort stale-status read may swallow an error already surfaced by the publication path;
- corrects helper/test traceability from the eval-semantics epic to issue #796.

## Effective diff against current `origin/next`

Twelve intended files, 345 insertions:

- `client/OPERATOR-APP-SPEC.md`
- `client/src/api/launcher-status.ts`
- `client/src/dashboard/spa/src/api/types.ts`
- `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx`
- `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx`
- `client/src/solver-types/_swe-rebench-v2-validated-pool.ts`
- `client/src/solver-types/swe-rebench-v2.ts`
- `client/src/solvernets/launched-record-dispatcher.ts`
- `client/test/dashboard/solvernet-flow.e2e.test.ts`
- `client/test/main/launched-record-dispatcher.test.ts`
- `client/test/solver-types/swe-rebench-v2-auto.test.ts`
- `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts`

## Verification

All verification used Node `22.23.1` and Yarn `4.13.0`.

- Focused helper/generator/dispatcher/SPA tests:
  - `yarn vitest run test/main/launched-record-dispatcher.test.ts src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx test/solver-types/swe-rebench-v2-validated-pool.test.ts test/solver-types/swe-rebench-v2-auto.test.ts`
  - Result: 4 files passed, 128 tests passed.
- Client typecheck:
  - `yarn typecheck`
  - Result: exit 0.
- Production client + SPA build:
  - `yarn build`
  - Result: exit 0.
- Real built-daemon + Chromium SolverNet flow:
  - `yarn playwright test --config=playwright.config.ts test/dashboard/solvernet-flow.e2e.test.ts`
  - Result: 7 tests passed, including the stale-publication warning at the served app surface.
- Whitespace/error check:
  - `git diff --check origin/next...HEAD`
  - Result: exit 0.

The build retains the repository's existing large-chunk warning, and Playwright reports the existing `NO_COLOR`/`FORCE_COLOR` environment warning. Neither affected the exit status or assertions.

## Environment note

The first dependency install inherited system Node 20 and tried to source-build `better-sqlite3`; that build's shell quoting does not tolerate the apostrophe in the worktree path. Re-running setup with the repository-compatible Node 22 runtime selected the supported dependency path and completed successfully. This is not a product blocker.

## Blockers and publication

- Functional blockers: none found.
- No push, PR mutation, comment, draft conversion, or merge was performed.

