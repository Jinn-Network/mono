# Cross-tool skill sharing — author once, run in Claude Code, Codex, Gemini, Copilot

- **Date:** 2026-06-14
- **Author:** Ritsu with Claude (spike #321)
- **Status:** Spike finding — recommends an approach; defers the decision to a reviewed implementation Issue
- **Issue:** [#321](https://github.com/Jinn-Network/mono/issues/321) — spike: cross-tool skill sharing
- **Shape:** `spike` (output is a finding, not merged implementation)

## TL;DR

A cross-vendor **open standard already exists** and our skills already comply with it. The
question in the Issue ("symlinks, or a shim layer?") has been overtaken by events: between the
Issue's filing (2026-05-19) and today, Anthropic published the **Agent Skills** open spec
(`SKILL.md` with `name`+`description` frontmatter) and Codex, Gemini CLI, and Copilot CLI all
adopted it, converging on a shared discovery directory: **`.agents/skills/`**.

Recommendation: **stop maintaining `.codex/skills` / `.cursor/skills` symlink mirrors** (current
Codex no longer reads `.codex/skills`, and the mirror has already silently rotted — see Evidence),
and instead publish skills into the standard **`.agents/skills/`** directory, keep `.claude/skills/`
as canonical source, fix `sync-skills.sh` to be a *pruning idempotent mirror* gated in CI, and ship
a one-page per-platform **tool-name mapping** (borrowed verbatim from superpowers) plus an
`AGENTS.md` bootstrap pointer for the four orchestration skills that actually use Claude tool
primitives. The other seven skills are pure Bash+`gh` and port with zero translation.

## Context — what we have today

All custom skills live at `.claude/skills/<name>/SKILL.md`, loaded by Claude Code's `Skill` tool.
A prior chore (commit `7f367b7e7`, "symlink in-repo skills for Cursor and Codex") added
`scripts/sync-skills.sh`, which symlinks each `.claude/skills/<name>` into `.cursor/skills/` and
`.codex/skills/`. These symlinks are **committed git objects**, not generated at runtime.

## Evidence — the symlink v0 has already failed silently

Running the existing mechanism in this worktree surfaced two independent drift defects:

1. **8 of 17 committed `.codex/skills` symlinks are dangling.** They point at skills that were
   renamed or deleted since the chore landed (`cluster-model`, `growth-day`, `growth-refine`,
   `growth-watcher`, `twitter-strategy`, `x-post-builder`, `x-algorithm-grader`,
   `discover-twitter-recruits`). The canonical set moved; the committed links did not.

2. **`sync-skills.sh` is add-only — it does not prune.** Re-running it added the two missing
   links (`growth-experiment`, `learning-engine`) but left all 8 dangling links in place. Nothing
   runs the sync automatically (no hook, no CI gate), so the mirror rots between manual runs.

3. **Current Codex reads `.agents/skills`, not `.codex/skills`.** Per OpenAI's Codex skills docs,
   Codex discovers repo-level skills by walking `cwd → repo root` for **`.agents/skills/`** (plus
   `$HOME/.agents/skills`, `/etc/codex/skills`). The `.codex/skills/` directory the mirror targets
   is not in current Codex's discovery path at all — so even the 9 healthy links are invisible to
   the tool they were created for.

The path-sharing *idea* works (a skill resolved through a tool-specific directory loads fine — I
confirmed `eng-day` resolves through `.codex/skills/eng-day/SKILL.md → ../../.claude/skills/eng-day`
and is readable). The *maintenance* is what fails: committed symlinks against a moving canonical
set, an add-only sync, no automation, and a target directory that the vendor has since moved.

## What the Issue asked — answered

### 1. What does Codex's equivalent of a skill look like?
Codex shipped **Agent Skills** (Dec 2025), a primitive **distinct from `AGENTS.md`**. AGENTS.md =
persistent always-loaded repo conventions; a skill = an on-demand packaged workflow. A Codex skill
is a directory containing a required `SKILL.md` with YAML frontmatter (`name`, `description`) —
**the same shape as Claude Code** — plus optional `scripts/`, `references/`, `assets/`, and an
optional Codex-specific `agents/openai.yaml`. Discovery: repo-level `.agents/skills/`, user
`~/.agents/skills`, admin `/etc/codex/skills`. Invocation: explicit (`/skills`, `$`-mention) or
implicit auto-selection when the task matches the `description`. Subagents are supported behind
`multi_agent = true` in `~/.codex/config.toml` (`spawn_agent` / `wait_agent` / `close_agent`).
Source: developers.openai.com/codex/skills.

### 2. What's already out there in OSS?
- **An open standard.** Anthropic's **Agent Skills spec** (released 2025-12-18) defines the
  canonical `SKILL.md` shape: directory + `SKILL.md`, frontmatter `name` (≤64 chars, lowercase +
  hyphens) and `description` (≤1024 chars), Markdown body. By March 2026 ~32 tools read the same
  format/dirs (Codex, Gemini CLI, Copilot CLI, Cursor, JetBrains Junie, Kiro, Goose…).
  Spec: agentskills.io/specification. **Our skills already comply** — every `SKILL.md` has
  `name` + `description` frontmatter.
- **superpowers** (already in this repo) is the reference cross-platform pattern: keep the SKILL.md
  body in Claude Code tool-names as the lingua franca, and ship a *per-platform tool-mapping
  reference* (`references/codex-tools.md`, `gemini-tools.md`, `copilot-tools.md`) the agent loads
  into context. It does **not** rewrite each skill per tool.
- **Sync/translate tooling:** `runkids/skillshare` (one-command sync across CLIs),
  `rohitg00/skillkit` (install/translate/share across 40+ agents), curated catalogs
  (`VoltAgent/awesome-agent-skills`, `sickn33/antigravity-awesome-skills`).
- **Known friction:** `github/copilot-cli#1090` documents script/path-resolution problems with
  **symlinked** shared skill libraries across harnesses — direct evidence that symlinks carry a
  real cross-tool cost.

### 3. Is filesystem symlinking enough?
Partly, and only for the *path* problem. Two findings sharpen this:
- **Tool-name divergence only bites 4 of 11 skills.** A scan for hard Claude-tool directives
  (`Task`/`Skill`/`TodoWrite`/subagent dispatch/`` `Read` ``/`` `Edit` `` etc., excluding bash
  command text) ranks: `implement-issue` (14), `release-readiness` (7), `review-pr` (2),
  `merge-batch` (2), and **zero** for `eng-day`, `file-issue`, `create-press-release`,
  `growth-experiment`, `learning-engine`, `release-prep`, `testing-jinn-app`. The seven Bash+`gh`
  skills port by directory alone; only the four orchestration skills need a translation layer —
  and superpowers already supplies the exact table (`Task`→`spawn_agent`, `TodoWrite`→`update_plan`,
  `Skill`→native).
- **Symlinks bring their own failure modes:** committed-link drift (proven above) and the
  cross-harness script-path issues in copilot-cli#1090. A *generated, pruning, CI-gated* mirror is
  strictly better than committed symlinks.

### 4. Minimal shape that works today (POC)
`eng-day` (the Issue's suggested target — highest reuse, near-zero tool-specific behaviour)
already loads through a tool-specific skills directory unchanged (confirmed by resolving it through
the Codex-path symlink and reading the canonical `SKILL.md`). Because its body is entirely Bash +
`gh`, **no tool-name translation is required** — it is portable as-is to any Agent-Skills-compliant
tool the moment it sits in that tool's discovery directory (`.agents/skills/` for Codex/Gemini,
`.claude/skills/` for Copilot's auto-pickup). The only gap to "invocable in Codex" is publishing it
into `.agents/skills/` rather than the stale `.codex/skills/`.

### 5. Maintenance story
- **Canonical source stays `.claude/skills/`** (Claude Code native; Copilot CLI auto-reads it).
- **Publish into `.agents/skills/`** — the cross-vendor standard dir (Codex + Gemini + others).
- **Mapping ownership:** adopt superpowers' `codex-tools.md` / `gemini-tools.md` /
  `copilot-tools.md` rather than authoring our own — they track vendor tool renames as a maintained
  upstream. We add only an `AGENTS.md` / `GEMINI.md` bootstrap pointer ("skills here use Claude
  tool names; map via the superpowers reference"). Maintenance of the *mapping* is then upstream's
  job; ours is just the pointer + the four orchestration skills' assumptions.
- **Public artifact:** the mechanism (a pruning, CI-gated `.agents/skills/` mirror + bootstrap
  pointer) is generic enough to extract as a small public repo later, but that is not required for
  v1.

## Recommended approach (for the follow-up implementation Issue)

1. **Canonical = `.claude/skills/`.** Unchanged. Keep authoring skills here in Claude tool-names.
2. **Mirror into `.agents/skills/`** — the standard directory Codex and Gemini read. Retire the
   `.codex/skills/` and `.cursor/skills/` mirrors (Cursor and current Codex both read `.agents/`;
   Copilot auto-reads `.claude/`).
3. **Rewrite `sync-skills.sh` as a pruning idempotent mirror** (delete stale links/dirs, add new
   ones) and add a `--check` mode that exits non-zero on drift.
4. **Gate the mirror in CI** (`--check` in a lightweight workflow) so drift fails a PR instead of
   rotting silently. This is the fix for the root cause found in this spike.
5. **Add an `AGENTS.md` (Codex) and `GEMINI.md` (Gemini) bootstrap pointer** stating that skills use
   Claude Code tool names and pointing at the superpowers per-platform mapping references for the
   four orchestration skills.
6. **No per-tool SKILL.md forks.** Bodies stay in the Claude lingua franca; translation is the
   mapping reference's job (superpowers pattern, Agent-Skills standard).

## Migration shape (10+ skills → new layout)

- The seven Bash+`gh` skills move for free — they appear in `.agents/skills/` and work.
- The four orchestration skills (`implement-issue`, `release-readiness`, `review-pr`,
  `merge-batch`) work once the bootstrap pointer + superpowers mapping are present; their
  `Task`/`Skill`/`TodoWrite` usage maps cleanly (Codex `spawn_agent`/native/`update_plan`).
- Delete the 8 dangling symlinks and the `.codex/skills` + `.cursor/skills` mirrors as part of the
  migration commit.

## Open questions for implementation

1. **Verify the discovery dir against the installed Codex/Gemini versions.** Vendor conventions
   move fast; the spike trusts official docs (Codex `.agents/skills`, Gemini `.agents/skills`
   alias, Copilot `.claude/skills` auto-pickup) but the implementer should confirm against the
   exact CLI builds Captain runs before deleting the old mirrors.
2. **Symlink vs copy for `.agents/skills/`.** copilot-cli#1090 reports symlink script-path
   breakage across harnesses; decide symlink (cheap, but the #1090 risk) vs generated copy (no
   path ambiguity, but a build step). Lean copy if any skill ships `scripts/`.
3. **Where does the bootstrap live** — repo-root `AGENTS.md`/`GEMINI.md`, and how does it coexist
   with any existing project instructions?
4. **Adopt vs vendor the mapping references.** Symlink superpowers' references, or copy them in?
   Copying decouples us from upstream churn but loses free updates.
5. **Public extraction** — worth publishing the mirror+pointer mechanism as a standalone repo?
   Defer until v1 proves out internally.

## Out of scope (deferred to implementation)

- Migrating any skill's *behaviour* to per-tool idioms (the whole point is to avoid that).
- Making `.agents/skills/` vs `.claude/skills/` the single canonical root — this finding keeps
  `.claude/skills/` canonical and treats `.agents/skills/` as a generated mirror; revisit only if
  a tool stops reading `.claude/`.

## Next step

Open an implementation Issue (`chore` or `refactor`, depending on whether CI-gating the mirror is
treated as tooling or as a small migration) referencing this finding, scoped to items 1–6 of the
recommended approach.
