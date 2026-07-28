# Learner Task Workspace Boundary Implementation Plan

> **For agentic workers:** Use test-driven development. Add the contract
> regressions first, observe them fail against the old implementation, then
> make the smallest production and prompt changes that make them pass.

**Goal:** Ensure `jinn-repo.v1` restoration agents mutate and verify the
authoritative `<workingDir>/repo` checkout while all learner telemetry remains
rooted at the episode `workingDir`.

**Architecture:** Add an optional absolute `taskWorkspaceDir` to the learner
session inputs. `LearnerHarness` sets it only for `jinn-repo.v1` restoration
tasks. Both Claude Code and Codex prompts expose the two-root contract without
changing process cwd. The learner coordinator passes the task workspace to its
planner and step workers, whose prompt contracts resolve repository-relative
paths against that root and reserve episode-root paths for learner artifacts.

**Tech stack:** TypeScript, Vitest, Markdown skill/prompt contracts, Yarn 4,
Node 22.

## Constraints

- Keep Claude Code and Codex cwd at episode `workingDir`.
- Keep `.coordinator`, `.orient`, `.strategize`, `.plan`, `.execute`,
  `.debrief`, `.improve`, and `.memory-consolidation` under episode
  `workingDir`.
- Keep `implStateDir` unchanged as the persistent learner-state root.
- Do not rely on the task description mentioning `/repo` or on the
  SolverPlugin task skill being selected before `learn`.
- Leave non-repository tasks unchanged.
- Do not create another live issue or Task until the fixed build has passed
  verification and replaced the sole daemon.
- Run client commands with
  `PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH`.

## File map

- `client/src/harnesses/impls/learner/types.ts`: optional session workspace
  field and contract documentation.
- `client/src/harnesses/impls/learner/harness.ts`: derive the authoritative
  repository workspace for `jinn-repo.v1` restoration tasks.
- `client/src/harnesses/impls/learner/adapters/claude-code.ts`: include the
  two-root contract in Claude Code's initial prompt.
- `client/src/harnesses/impls/learner/adapters/codex-code.ts`: include the same
  contract in Codex's initial prompt.
- `client/plugins/learner/skills/learn/SKILL.md`: bind and pass
  `taskWorkspaceDir` through the uniform dispatch contract.
- `client/plugins/learner/skills/learn/planner-prompt.md`: require absolute task
  mutation paths under `taskWorkspaceDir`.
- `client/plugins/learner/skills/learn/step-worker-prompt.md`: resolve and
  verify Task `1195`-shaped relative paths against `taskWorkspaceDir`.
- `client/test/harnesses/impls/learner/task-workspace.test.ts`: harness and
  learner prompt-contract regressions.
- `client/test/harnesses/impls/learner/claude-code-adapter.test.ts`: Claude
  prompt/cwd regression.
- `client/test/harnesses/impls/learner/codex-code-adapter.test.ts`: Codex
  prompt/cwd regression.
- `client/test/harnesses/impls/learner/default-prediction-agent.test.ts`:
  non-repository prompt compatibility.

## Task 1: Add failing workspace regressions

- [ ] Add a `jinn-repo.v1` restoration harness test that requires
  `taskWorkspaceDir === join(workingDir, "repo")`, retains
  `inputs.workingDir === workingDir`, and finds learner artifacts under the
  episode root.
- [ ] Add a non-repository harness test that requires
  `taskWorkspaceDir === undefined`.
- [ ] Add a learner prompt-contract test requiring the uniform dispatch,
  planner, and step-worker prompts to receive `taskWorkspaceDir`; include the
  Task `1195` case mapping relative `client/docs/<file>.md` to the absolute
  repository path while keeping `.execute` under episode `workingDir`.
- [ ] Add Claude Code and Codex adapter assertions that the initial prompt
  names both roots and their distinct responsibilities while spawn cwd remains
  episode `workingDir`.
- [ ] Add a prediction assertion that no task workspace is exposed when the
  input omits one.
- [ ] Run the focused tests and retain the expected RED output showing the
  missing session field and missing prompt contract.

## Task 2: Implement the approved two-root contract

- [ ] Add optional `taskWorkspaceDir` to `TaskSessionInputs`.
- [ ] In `LearnerHarness.run`, set the absolute `join(ctx.workingDir, "repo")`
  only when `solverType === "jinn-repo.v1"` and
  `role === "restoration"`.
- [ ] Update both adapter prompt builders. With a workspace, state that task
  inspection, mutation, and verification occur only there and that learner
  artifacts stay at episode `workingDir`. Without one, preserve the existing
  single-root instruction.
- [ ] Update the learner skill's inputs and uniform dispatch to pass the
  optional absolute workspace.
- [ ] Update planner and step-worker contracts to route repository-relative
  paths under that workspace and fail/report a task mutation routed to the
  episode root.
- [ ] Re-run the focused tests and require GREEN.

## Task 3: Verify and checkpoint the fixed client

- [ ] Run all learner harness tests.
- [ ] Run client typecheck.
- [ ] Run the full client suite.
- [ ] Run the production client build.
- [ ] Run `git diff --check`.
- [ ] Review the exact diff for scope and telemetry-path preservation.
- [ ] Commit the tested fix.
- [ ] Stop the sole daemon through its foreground session, prove port `7332`
  is released, start the newly built client once with unchanged membership,
  and prove exactly one healthy daemon/listener remains.
- [ ] Send the verification and daemon-replacement checkpoint before any fresh
  external retry.
