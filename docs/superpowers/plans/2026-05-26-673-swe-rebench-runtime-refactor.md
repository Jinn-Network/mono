# Issue #673 — Strip Orchestration from swe-rebench-v2-runtime

**Shape:** `refactor` — replace two orchestration-named skills (`orient`, `plan`) with a single domain-reference skill (`task`).

**Branch:** `refactor/673-swe-rebench-runtime-domain-only`
**Worktree:** `/Users/adrianobradley/life's-work/jinn-mono_worktrees/673`
**Design note:** Stage 1 output (see issue #673 thread).

## Acceptance criteria (from the issue)

1. `client/plugins/swe-rebench-v2-runtime/skills/orient/SKILL.md` deleted.
2. `client/plugins/swe-rebench-v2-runtime/skills/plan/SKILL.md` deleted.
3. New domain-only reference skill at `client/plugins/swe-rebench-v2-runtime/skills/task/SKILL.md` (Stage 1 chose `task/` over `contract/` because "contract" collides with on-chain contracts in this codebase).
4. `client/plugins/learner/` unchanged.
5. `client/plugins/network-tools/` unchanged.
6. Post-change: a codex session against a sympy-27510-class swe-rebench-v2.v1 task produces commits beyond `init implStateDir` in `~/.jinn-client/engine/impl-state/codex-code-learner/swe-rebench-v2_v1/.git` with `improve:` / `consolidate:` messages.

## Steps

### 1. Create the new `task` skill

- **Action:** Write `client/plugins/swe-rebench-v2-runtime/skills/task/SKILL.md` with the domain-only reference content from the design note.
- **Files touched:** `client/plugins/swe-rebench-v2-runtime/skills/task/SKILL.md` (new).
- **Result:** A single SKILL.md whose frontmatter is:
  ```yaml
  ---
  name: swe-rebench-v2-task
  description: Reference for swe-rebench-v2.v1 task structure — input fields, repo setup, FAIL_TO_PASS/PASS_TO_PASS semantics, the swe-rebench-v2-solution.v1 output schema, and how to submit a typed payload. Consult this skill when orienting on a task or constructing a solution.
  ---
  ```
  Four sections in order:
  1. **Task input shape** — full `goal.spec` field inventory from `orient/SKILL.md` lines 8–15.
  2. **Repository handling** — verbatim repo-setup guidance from `orient/SKILL.md` line 19 (`$workingDir/repo`, clone URL pattern, harvester fallback explanation).
  3. **Test semantics: FAIL_TO_PASS and PASS_TO_PASS** — consolidated. `FAIL_TO_PASS` definition from `orient` step 4 + `PASS_TO_PASS` semantics from `plan` step 3. Includes a subsection "Prior execution data in the Jinn corpus" carrying the corpus-lookup pattern from `orient` step 3 (`solverType`, `role`, `artifactType`, and the search → inspect → acquire workflow language).
  4. **Solution payload schema and submission** — from `plan/SKILL.md` lines 27–51. Full JSON schema block, `submit_typed_payload` usage, Zod `issues[]` mismatch path, `.execute/solution-payload.json` fallback, daemon-derived-fields caveat.
- **MUST NOT appear in the new skill** (orchestration-verb sentences from `plan/SKILL.md`): the line beginning *"After a successful submission, this Plan/Execute cycle is complete…"*, and any step-numbered "Orient → Plan → Execute" cycle language. The new skill describes the task domain, not a workflow phase.
- **Acceptance check:** `grep -E "Orient summary|Plan/Execute cycle|Pass this (summary|plan) forward" client/plugins/swe-rebench-v2-runtime/skills/task/SKILL.md` returns nothing. `grep -c "submit_typed_payload\|\.execute/solution-payload\.json\|FAIL_TO_PASS\|PASS_TO_PASS\|swe-rebench-v2-solution\.v1\|\$workingDir/repo" client/plugins/swe-rebench-v2-runtime/skills/task/SKILL.md` is ≥ 6.

### 2. Delete the orchestration skills

- **Action:** Remove `orient/` and `plan/` skill directories.
- **Files touched:**
  - Delete `client/plugins/swe-rebench-v2-runtime/skills/orient/SKILL.md`
  - Delete `client/plugins/swe-rebench-v2-runtime/skills/plan/SKILL.md`
  - Also remove the now-empty `orient/` and `plan/` directories if they have no other files (verify with `ls`).
- **Acceptance check:** `ls client/plugins/swe-rebench-v2-runtime/skills/` lists only `task/`.

### 3. Update `jinn.plugin.json`

- **Action:** Replace the `skills` array and update the `description`.
- **Files touched:** `client/plugins/swe-rebench-v2-runtime/jinn.plugin.json`.
- **Diff sketch:**
  ```diff
  -    "skills": [
  -      "skills/orient/SKILL.md",
  -      "skills/plan/SKILL.md"
  -    ],
  -    "description": "Provides Solver-side orientation + planning skills for SWE-rebench v2 code-issue Tasks."
  +    "skills": [
  +      "skills/task/SKILL.md"
  +    ],
  +    "description": "Provides domain reference for swe-rebench-v2.v1 code-issue tasks — task shape, repo handling, FAIL_TO_PASS / PASS_TO_PASS semantics, and solution payload schema."
  ```
- **Acceptance check:** `jq '.jinn.skills' client/plugins/swe-rebench-v2-runtime/jinn.plugin.json` prints `["skills/task/SKILL.md"]`.

### 4. Update the plugin `README.md`

- **Action:** Rewrite the bullet list and one-liner so the plugin advertises a single domain-reference skill, not orient+plan.
- **Files touched:** `client/plugins/swe-rebench-v2-runtime/README.md`.
- **Diff sketch:**
  ```diff
  -Provides Solver-side orientation + planning skills for the `swe-rebench-v2.v1` SolverNet.
  -
  -This plugin bundles two skills:
  -- `swe-rebench-v2-orient` — read the task, identify FAIL_TO_PASS tests, plan the bug hypothesis.
  -- `swe-rebench-v2-plan` — sketch the minimal diff that satisfies FAIL_TO_PASS without breaking PASS_TO_PASS.
  +Provides a Solver-side domain reference skill for the `swe-rebench-v2.v1` SolverNet.
  +
  +This plugin bundles one skill:
  +- `swe-rebench-v2-task` — task input shape, repo handling, FAIL_TO_PASS / PASS_TO_PASS semantics, and the `swe-rebench-v2-solution.v1` output schema with `submit_typed_payload` usage.
  ```
  Leave the `## See also` section and Hermes-migrator pointer alone (only the orient+plan summary changes).
- **Acceptance check:** `grep -E "swe-rebench-v2-orient|swe-rebench-v2-plan" client/plugins/swe-rebench-v2-runtime/README.md` returns nothing.

### 5. Update existing tests that reference the old skill paths

Three tests in `client/test/` load the SKILL.md files by absolute path or assert on the symlinked path under `.agents/skills/`. They must be updated to point at `task/`.

#### 5a. `client/test/harnesses/impls/learner/codex-code-adapter.test.ts`

- **Line 297:** change
  ```ts
  expect(existsSync(join(workingDir, '.agents', 'skills', 'swe-rebench-v2-runtime__plan', 'SKILL.md'))).toBe(true);
  ```
  to
  ```ts
  expect(existsSync(join(workingDir, '.agents', 'skills', 'swe-rebench-v2-runtime__task', 'SKILL.md'))).toBe(true);
  ```
- **Lines 270–271 (negative assertions on prompt content):** leave as-is. They assert the harness prompt does NOT mention `swe-rebench-v2-orient` / `swe-rebench-v2-plan`. That property still holds (and is in fact strengthened) after the refactor.
- **Lines 252–253 (comment referencing `skills/{orient,plan}/`):** update the comment to point at `skills/task/` so the doc-comment matches the new layout.
- **Acceptance check:** `yarn test client/test/harnesses/impls/learner/codex-code-adapter.test.ts` passes after the new `task/` skill is in place.

#### 5b. `client/test/harnesses/impls/learner/swe-rebench-v2-roundtrip.test.ts`

Three test blocks read the skill files directly:

- **Lines 151–179** (`'documents the harness-neutral fallback payload file and schema shape'`): change the path from `'skills', 'plan', 'SKILL.md'` to `'skills', 'task', 'SKILL.md'`. The four `expect(skill).toContain(...)` assertions (`typed structured payload`, `no typed-payload submission tool at all`, `Prefer the tool path whenever it exists`, `.execute/solution-payload.json`) all still hold in the new file (carried verbatim from `plan/`).
- **Lines 181–199** (`'orient skill owns repo setup so the harness prompt can stay generic'`): change the path from `'skills', 'orient', 'SKILL.md'` to `'skills', 'task', 'SKILL.md'`. Rename the test description to `'task skill owns repo setup so the harness prompt can stay generic'`. The five `expect(skill).toContain(...)` assertions (`$workingDir/repo`, `Do not reuse a repo`, `https://github.com/<goal.spec.repo>.git`, `<goal.spec.base_commit>`, ``harvester reads a `git diff` ``) all still hold (verbatim from `orient/`).
- **Lines 201–217** (`'documents SWE execution data retrieval through Network Tools'`): change the path from `'skills', 'orient', 'SKILL.md'` to `'skills', 'task', 'SKILL.md'`. The four positive `toContain` assertions (`Jinn knowledge corpus`, `"swe-rebench-v2.v1"`, `"swe-rebench-v2_v1_solution"`, `index card`) and three negative assertions all still hold (the corpus-lookup section is preserved in the new skill's Section 3).
- **Acceptance check:** `yarn test client/test/harnesses/impls/learner/swe-rebench-v2-roundtrip.test.ts` passes.

#### 5c. Other test references that need NO change

Verified by `grep` (recorded here so Stage 3 doesn't second-guess):

- `client/test/config.test.ts`, `client/test/cli/commands/harnesses.test.ts`, `client/test/scripts/donation-consumption-acceptance.test.ts`, `client/test/solver-nets/contracts.test.ts` — reference only the plugin id `'bundled:swe-rebench-v2-runtime'` or `'swe-rebench-v2-runtime'`. Plugin id is unchanged.
- `client/test/harnesses/impls/hermes-agent/{swe-rebench-v2-roundtrip,config-builder,bootstrap}.test.ts` — reference only the directory path `swe-rebench-v2-runtime/skills` (no `orient` / `plan` subdir). Path remains valid.
- `client/test/e2e/hermes-agent-full-cycle.ts` — references the plugin root, not the skill subdirs.
- `client/src/` — `grep` confirms no references to `swe-rebench-v2-orient`, `swe-rebench-v2-plan`, `__orient`, or `__plan`.

### 6. Run the test suite

- **Action:** `cd client && yarn test`.
- **Expected:** all green. The two updated tests cover the only direct content/path coupling; everything else is plugin-id-level and unaffected.
- **If anything else fails:** treat as a discovery — search for the failing test's reference to `orient`/`plan` and update or roll back. Do NOT broaden the refactor.

## Verification (the acceptance-criterion gate)

The real gate is a codex run producing post-init commits in impl-state. Procedure (Stage 3 runs this):

**Prerequisites**
- Operator config has the `swe-rebench-v2.v1` SolverNet joined (`joinedSolverNets[<manifestCid>]`) with `harness: 'codex-code'` (or whichever codex variant the operator is on).
- Daemon configured to run against a sympy-27510-class swe-rebench-v2.v1 task — either a launched SolverNet on testnet that surfaces such tasks, or `yarn e2e:daemon-harness JINN_E2E_HARNESS=codex` against an Anvil-fork-driven settlement loop if available.
- Claude / codex CLI on PATH; API keys present.
- `JINN_EVAL_DISK_FLOOR_GB` not blocking (default 20).

**Run**
1. Clear or note baseline: `ls -la ~/.jinn-client/engine/impl-state/codex-code-learner/swe-rebench-v2_v1/.git/refs/heads/`.
2. Start `jinn run` (or the harness e2e). Let it claim a sympy-27510-class task.
3. After the task settles (success or failure), inspect the impl-state git log:
   ```
   git -C ~/.jinn-client/engine/impl-state/codex-code-learner/swe-rebench-v2_v1 log --oneline
   ```
4. **Pass condition:** the log shows at least one commit beyond `init implStateDir`, ideally with `improve:` or `consolidate:` prefixes (the learner's commit verbs). A single such commit confirms the agent dispatched through Orient/Plan/Execute and submitted a payload — i.e. the new domain skill was discoverable and the loop didn't stall on missing orchestration prompts.
5. **Fail condition:** only the bootstrap `init implStateDir` commit, or no commits at all. This means the learner never made it past Plan — escalate (see Risks).

Window pressure (the agent skipping Plan because of context-window saturation) is **out of scope** for this PR. If verification fails for window reasons rather than skill-discovery reasons, that's a separate concern.

## Risks and mitigations

- **Agent doesn't find the new skill.** The learner plugin's planner subagent prompt (`client/plugins/learner/skills/learn/planner-prompt.md`) is domain-agnostic and doesn't name plugin skills explicitly. Discovery happens via the harness loading all plugin skills at session start + the agent matching the skill description. The new description ("Reference for swe-rebench-v2.v1 task structure… Consult this skill when orienting on a task or constructing a solution") cues both phases.
  - **Mitigation:** if the post-change codex run shows the agent never consults `swe-rebench-v2-task`, strengthen the description with a more explicit cue (e.g. add "Read this skill before sketching any patch."). Do NOT touch `client/plugins/learner/` — that violates AC4.

- **Stale reference in `swe-rebench-v2-diffmin/skills/diffmin/SKILL.md` line 107** (`"The swe-rebench-v2-plan skill from swe-rebench-v2-runtime sketches the…"`). This is a documentation cross-reference, not a runtime dependency. **File as a follow-up issue, not part of this PR** (issue scope is `swe-rebench-v2-runtime` only, per ACs 4–5 leave-alone discipline).

- **Verification window pressure.** As noted in §Verification, if the codex run fails to produce post-init commits because of context-window exhaustion (not skill-discovery), that's a known separate concern — flag in the PR description and proceed.

## What NOT to touch (defense-in-depth)

- `client/plugins/learner/` — entire plugin (AC4).
- `client/plugins/network-tools/` — entire plugin (AC5).
- `client/plugins/swe-rebench-v2-diffmin/` — the stale reference there is a documented follow-up.
- `client/src/harnesses/` — all adapter code.
- `client/src/earning/` — earning bootstrap unaffected.
- `client/src/harnesses/impls/learner/harvest.ts` and related harvest paths — separate follow-up.
- The five `expect(promptArg).not.toContain('swe-rebench-v2-orient' / '-plan')` regression guards in `codex-code-adapter.test.ts` — they remain valid and load-bearing.

## Tests — current coverage summary

Direct content coverage of the runtime plugin's skill files lives in two test files:

- `client/test/harnesses/impls/learner/swe-rebench-v2-roundtrip.test.ts` — three blocks reading `plan/SKILL.md` and `orient/SKILL.md` for content assertions (Step 5b above).
- `client/test/harnesses/impls/learner/codex-code-adapter.test.ts` — one block asserting the symlinked path `.agents/skills/swe-rebench-v2-runtime__plan/SKILL.md` exists (Step 5a above).

Hermes-agent tests assert only the directory-level path (`swe-rebench-v2-runtime/skills`) and need no change. Plugin-id-level tests (config, solver-nets, donation, harnesses CLI, e2e) reference only `bundled:swe-rebench-v2-runtime` and need no change.

No new test coverage is manufactured by this PR. The real verification gate is the codex impl-state-commit check — manufacturing additional tests for a content/schema move would be ceremony for its own sake.

## Commit shape

Single commit. Suggested message:

```
refactor(swe-rebench-v2-runtime): replace orient+plan skills with task domain reference (#673)

The two orchestration-named skills (`swe-rebench-v2-orient`, `swe-rebench-v2-plan`)
duplicated the learner plugin's Orient/Plan/Execute/Knowledge phase structure
and locked the runtime plugin to a single agent loop. Replace them with a
single domain-reference skill `swe-rebench-v2-task` that documents the task
input shape, repo handling, FAIL_TO_PASS/PASS_TO_PASS semantics, and the
swe-rebench-v2-solution.v1 output schema. The learner plugin owns
orchestration; this plugin owns domain reference.

Verified by running a codex session against a sympy-27510-class task and
observing post-init commits in
~/.jinn-client/engine/impl-state/codex-code-learner/swe-rebench-v2_v1/.git.

Closes #673.
```

(Stage 3 should adjust verbiage and reword the verification line to reflect the actual run.)
