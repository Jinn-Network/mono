# Default learner — manual smoke test runbook

**Date:** 2026-04-26
**Branch:** `learner/spec`
**Plan:** `docs/superpowers/plans/2026-04-26-default-learner-full-cycle-verification.md` (Plan 4 T1)
**Claude Code version tested:** 2.1.119

This runbook captures findings from the first hands-on attempt to run the default-learner plugin against a real `claude` CLI. Plans 1-3 verified structural correctness via mocked harness; this is the first time the plugin actually loaded into Claude Code.

## Setup

```bash
# 1. Verify claude CLI available
claude --version
# → 2.1.119 (Claude Code)

# 2. Validate the plugin manifest
claude plugin validate /Users/adrianobradley/harbor/jinn-learner/client/plugins/default-learner
# → Initially failed: "No manifest found in directory. Expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json"
# → Fixed by adding .claude-plugin/plugin.json (commit TBD); now: ✔ Validation passed

# 3. Smoke test with --plugin-dir (Claude Code's local-plugin path)
SMOKE_DIR=$(mktemp -d -t jinn-smoke); mkdir -p "$SMOKE_DIR/work" "$SMOKE_DIR/state"
cd "$SMOKE_DIR/work" && IMPL_STATE_DIR="$SMOKE_DIR/state" claude \
  --plugin-dir /Users/adrianobradley/harbor/jinn-learner/client/plugins/default-learner \
  -p "List the Skills available to you ..."
```

## Findings

### What works

- ✅ Plugin manifest validates after adding `.claude-plugin/plugin.json`.
- ✅ `--plugin-dir` correctly loads the plugin into a `claude -p` session (no marketplace needed).
- ✅ All 8 skills are discovered and registered in the session, each namespaced as `default-learner:<skill-name>`:
  - `default-learner:coordinator`
  - `default-learner:orient`
  - `default-learner:strategize`
  - `default-learner:plan`
  - `default-learner:execute`
  - `default-learner:debrief`
  - `default-learner:improve`
  - `default-learner:memory-consolidation`
- ✅ Plugin frontmatter on each SKILL.md parses correctly.

### Critical bugs (block the loop)

#### B1 — Plugin manifest missing (fixed inline)

**Location:** `client/plugins/default-learner/.claude-plugin/plugin.json` (was missing)
**Symptom:** `claude plugin validate` failed with "No manifest found in directory."
**Root cause:** Plan 1 didn't include the Claude-Code-required manifest. The README's `cp -r` install would have failed on real plugins.
**Fix:** Added `.claude-plugin/plugin.json` with name/description/version/author. Validates clean.

#### B2 — README install instructions are wrong

**Location:** `client/plugins/default-learner/README.md` lines 18–30
**Symptom:** README tells operators to `cp -r .../default-learner ~/.claude/plugins/`. That path is for Claude Code's marketplace cache, not for user plugins.
**Root cause:** Plan 1 designed install instructions without testing against the actual Claude Code plugin loader.
**Fix:** Should document either (a) `claude --plugin-dir <path>` for local development, or (b) `claude plugin install <plugin>@<marketplace>` for marketplace distribution. The `cp -r` path is invalid.
**Status:** UNFIXED. Pending.

#### B3 — Skills referenced by bare name in coordinator, but registered with namespace

**Location:** `client/plugins/default-learner/skills/coordinator/SKILL.md` (Pipeline section)
**Symptom:** Coordinator skill instructs the agent: "Load the phase skill via the `Skill` tool (e.g., `Skill orient`)." But the actual registered skill names are `default-learner:orient` etc. Calling `Skill orient` would fail because no such skill exists; calling `Skill default-learner:orient` works.
**Root cause:** Plan 1 designed skill cross-references without knowing Claude Code namespaces plugin skills as `<plugin-name>:<skill-name>`.
**Fix needed:** Update coordinator SKILL.md to reference phase skills by their full namespaced names: `default-learner:orient`, `default-learner:strategize`, etc.
**Status:** UNFIXED. Pending.

#### B4 — Hook configuration missing

**Location:** Plugin missing `hooks/hooks.json` config file
**Symptom:** Session-start hook (`hooks/session-start.sh`) never fired; `$IMPL_STATE_DIR/.git` did not exist after the smoke session.
**Root cause:** Claude Code requires plugins to declare hook bindings in `hooks/hooks.json` (or similar) — the existence of an executable script under `hooks/` is not enough. Compare to `superpowers` plugin which has `hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start", "async": false }]
      }
    ]
  }
}
```
**Fix needed:** Add `client/plugins/default-learner/hooks/hooks.json` configuring the session-start hook to fire on SessionStart events.
**Status:** UNFIXED. Pending.

#### B5 — Agent frontmatter uses `allowed-tools:` but Claude Code expects `tools:`

**Location:** `client/plugins/default-learner/agents/*.md` (all 7 agents)
**Symptom:** Agents may not be loadable with current frontmatter. Example existing Claude Code plugin agent (`feature-dev/agents/code-reviewer.md`):
```yaml
---
name: code-reviewer
description: ...
tools: Glob, Grep, LS, Read, ...
model: sonnet
color: red
---
```
Our agents use `allowed-tools:` (matches the SKILL.md convention but NOT the agent convention).
**Root cause:** Plan 1 designed agent frontmatter mirroring SKILL.md, without checking Claude Code's distinct agent frontmatter schema.
**Fix needed:** Rename `allowed-tools:` → `tools:` in all 7 agent .md files. Optionally add `model:` and `color:` fields for convention.
**Status:** UNFIXED. Pending. **Verification needed:** check whether agents actually load and become spawnable via the Agent tool.

#### B6 — Hook script extension `.sh` may not be Windows-portable

**Location:** `client/plugins/default-learner/hooks/session-start.sh`
**Symptom:** Comment in superpowers' `hooks/run-hook.cmd` notes Claude Code's "Windows auto-detection ... prepends `bash` to any command containing `.sh`." Hook scripts in superpowers use extensionless names + a polyglot wrapper.
**Root cause:** Plan 1 used `.sh` extension by convention.
**Fix needed (low priority):** rename to `session-start` (extensionless) or add a `run-hook.cmd` wrapper. Not blocking on macOS where this works fine.
**Status:** UNFIXED. Defer to follow-up.

### Important bugs (degrade but don't block)

#### B7 — `IMPL_STATE_DIR` env propagation untested

**Symptom:** Even after B4 is fixed (`hooks.json` exists), need to verify Claude Code propagates the parent shell's `IMPL_STATE_DIR` env var to the spawned hook process. If not, the hook can't read where to git-init.
**Status:** UNVERIFIED — pending B4 fix to test.

#### B8 — Coordinator's PLUGIN_ROOT references may be wrong

**Symptom:** Coordinator SKILL.md uses `$PLUGIN_ROOT` (set by hook). But Claude Code uses `${CLAUDE_PLUGIN_ROOT}` per superpowers' hook config. The hook (Plan 2 fix `cfec07e3`) derives `PLUGIN_ROOT` from `${BASH_SOURCE[0]}`, which works regardless of whether Claude Code provides `CLAUDE_PLUGIN_ROOT`. So this may actually be fine — but worth confirming that the hook's exported `PLUGIN_ROOT` reaches the coordinator skill's session env (likely NOT — env vars set in a hook process don't propagate to the parent claude session).
**Status:** Probable secondary bug; will surface after B4 is fixed.

### What is NOT verified yet

- Whether agents (under `agents/`) load successfully after B5 fix.
- Whether the coordinator skill can actually spawn agents via the Agent tool.
- Whether the coordinator skill's pipeline-walking logic reaches phase 4 (Execute).
- Whether the session-start hook actually git-inits `implStateDir` when properly configured.
- Whether Improve actually mutates `implStateDir` and commits.
- Whether a second cycle picks up changes from the first.

## Recommended fix sequence

In order of dependency:

1. **B1 (DONE)** — manifest exists.
2. **B5** — fix agent frontmatter so agents are loadable.
3. **B4** — add hooks.json so session-start hook fires.
4. **B3** — fix skill cross-references in coordinator + any phase skill that calls another skill.
5. **B2** — update README install instructions (cosmetic; doesn't affect runtime).
6. **Re-run smoke test.** Expect to discover B7 / B8 / new bugs.
7. Iterate until coordinator can walk all 7 phases on a synthetic intent.

## Notes for follow-up

- Plan 4 T2's `learner-loop-test` synthetic kind only matters once B3+B4+B5 are fixed — there's nothing for the kind to drive into until skills + agents + hooks all work.
- Plan 4 T3's two-cycle e2e harness will need to be updated to use `--plugin-dir` instead of `cp -r`.
- Plan 1's `validate-plugin.mjs` doesn't catch B1, B5, or B4 (it validates a layout that doesn't match Claude Code's actual requirements). Worth augmenting the validator after we know the right shape.

## Verified findings (after fix batch B1+B3+B4+B5)

After landing the four critical fixes (commit `<TBD>`), the smoke test progressed dramatically. The full cycle was verified end-to-end on real Claude Code 2.1.119.

### Smoke 2: skill + agent discovery + hook fire

After the fix batch, ran the same smoke against the plugin:
- ✅ All 8 skills discovered as `default-learner:<name>`
- ✅ All 7 agents registered as spawnable subagent types (`default-learner:explorer`, `:strategist`, `:planner`, `:step-worker`, `:analyst`, `:promoter`, `:consolidator`)
- ✅ Session-start hook fired: `$IMPL_STATE_DIR/.git` exists, identity `default-learner` configured, initial commit `init implStateDir` present.

### Smoke 3: Orient phase end-to-end

Invoked `Skill default-learner:coordinator` with a synthetic intent and asked it to run only Orient:
- ✅ Coordinator boot wrote `workingDir/.coordinator/boot.json` with implStateDirShaAtStart, intentId, windowEndTs.
- ✅ Coordinator decided which Orient topics applied (only intent-parse, correctly skipped world-state/own-history/others-history for the trivial smoke kind).
- ✅ Spawned `default-learner:explorer` subagent with topic="intent-parse".
- ✅ Explorer wrote `workingDir/.orient/intent-parse.json` matching the explorer.md output schema.
- ✅ Coordinator collated `workingDir/.orient/summary.json` matching the orient/SKILL.md schema.

### Smoke 4: full 7-phase cycle (load-bearing test)

Same setup but asked the coordinator to run all seven phases. Test ran to completion in ~10 minutes.

**All 7 phases ran cleanly** (orient → strategize → plan → execute → debrief → improve → memory-consolidation) and produced artifacts under `workingDir/.<phase>/`.

**Improve actually mutated implStateDir** — HEAD advanced through 4 separate git commits:
```
4b5e87c improve: persist answers to Orient open questions
e8a27e4 improve: capture canonical-write + read-back-verify strategy template
d4d4e8b improve: seed runs/index.json with fullcycle-1 record
8c2c662 improve: add smoke-test verification note for 2026-04-26
9210411 init implStateDir
```

The Improve agent accepted 4 of 5 Debrief recommendations, rejected 1 (premature skill promotion), and committed each accepted change as a separate logical commit per spec §6.2 / promoter.md design.

Memory consolidation correctly chose no-op (no conflicts, no regressions, sub-threshold sizes) — HEAD unchanged at `4b5e87c`.

### Smoke 5: cycle 2 sees cycle 1's state (LOAD-BEARING ASSERTION)

Re-ran the coordinator with the same `implStateDir` (HEAD `4b5e87c` from cycle 1) and a different intent (`fullcycle-2`):

- ✅ **Cycle 2 `boot.json` captured `implStateDirShaAtStart = "4b5e87ca..."`** — cycle 1's final HEAD, NOT the original init commit. **The next run picks up the prior run's mutations.**

This is the headline claim of the entire learner design — and it works end-to-end, verified live, no mocks.

### Bugs the verified test surfaced

#### B7 — coordinator's skillBundleCid computation falls back to a stub

**Symptom:** boot.json `skillBundleCid` shows `"sha256:smoke-test-no-bundle-hash"` (smoke 3) or `"sha256:unknown-no-plugin-root"` (smoke 5), not a real digest.
**Root cause:** Coordinator's bash recipe references `$PLUGIN_ROOT` to hash the plugin contents, but the env var isn't set inside the coordinator's session (the hook sets it on its own process, which doesn't propagate). Claude Code provides `${CLAUDE_PLUGIN_ROOT}` but the coordinator skill doesn't reference it.
**Fix needed:** Update coordinator SKILL.md boot section to use `${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}` — Claude Code's variable preferred, hook's fallback for other harnesses.
**Severity:** Important (constitution span attributes are stub; doesn't break the loop but degrades the constitution's tamper-evidence value).
**Status:** UNFIXED.

#### B8 — README install path still says `cp -r` (already noted as B2)

Demoted to B2 priority; same bug.

### What is now verified

- Plugin discovery via `--plugin-dir`
- Plugin manifest validates
- 8 skills load with namespaced names
- 7 agents register as spawnable subagents
- Session-start hook fires on session start; `implStateDir` git-init'd; identity configured
- Coordinator skill walks the seven-phase pipeline end-to-end on a real Claude Code session
- Each phase spawns its specialized subagent via the Agent tool
- Each phase writes its artifacts to `workingDir/.<phase>/` per the spec
- Improve actually mutates `implStateDir` and git-commits each change
- **Cycle 2 sees cycle 1's mutations via the updated `implStateDirShaAtStart`**
- Memory consolidation correctly no-ops when nothing to curate

### What is NOT yet verified

- Skip-execute / phase-range hint flow (the wrapper's specialist-delegation path) — needs a kind with a registered specialist + the wrapper to actually delegate.
- The full daemon path: engine → wrapper → shim → harness adapter → claude. Smoke tests invoked claude directly via shell; the shim's spawn machinery hasn't been exercised live.
- Real venue kind end-to-end (portfolio.v0 etc.). Smoke kind is `smoke-test` synthetic.

## Follow-up bd issues

Filed under Plan 4 T4 (commit `<TBD>`):

| Issue | Title | Priority |
|---|---|---|
| `jinn-mono-4p6` | hook script .sh extension may not be Windows-portable (B6) | P3 |
| `jinn-mono-e8o` | validate-plugin.mjs doesn't catch real Claude Code plugin requirements | P2 |
| `jinn-mono-k8s` | formal learner-loop-test intent kind (Plan 4 T2 follow-up) | P3 |
| `jinn-mono-iee` | automated two-cycle e2e harness (Plan 4 T3 follow-up) | P3 |

T2 (`learner-loop-test` kind) and T3 (automated e2e harness) deferred — the inline `smoke-test` kind used in the manual smoke verified the loop works without needing a formally registered kind, and the manual cycle-1 + cycle-2 demonstration verified the load-bearing claim without an automated harness. Both are useful for CI / regression catching but aren't required for the "does the cycle work" verification that Plan 4 set out to deliver.

T1 is the substantive deliverable of Plan 4. The headline finding: **the default learner's full cycle works end-to-end against real Claude Code, including the next-run-picks-up-prior-mutations claim.**
