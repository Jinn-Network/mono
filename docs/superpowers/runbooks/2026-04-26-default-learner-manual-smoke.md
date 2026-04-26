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

## Follow-up bd issues

(Filed in T4 once T1 is done.)
