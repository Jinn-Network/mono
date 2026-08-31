# Agent skills (canonical)

This directory is the **only place to edit** in-repo agent skills (`SKILL.md` plus optional `references/`, `scripts/`, `assets/`, per [agentskills.io](https://agentskills.io)).

`./scripts/sync-skills.sh` publishes a generated, pruning, idempotent mirror of every directory here that contains `SKILL.md`. Do not copy or fork `SKILL.md` into a tool-specific tree.

| Role | Path | Who reads it |
|------|------|----------------|
| Canonical (edit here) | `.claude/skills/` | Claude Code; Copilot CLI auto-pickup; Cursor compatibility |
| Agent Skills standard mirror | `.agents/skills/` | Codex (repo discovery), Gemini CLI, Cursor |
| Cursor native mirror | `.cursor/skills/` | Cursor project discovery (still documented 2026-08-24) |
| Compatibility mirror | `.codex/skills/` | Not current Codex repo discovery; Cursor still loads it |

`.agents/skills`, `.cursor/skills`, and `.codex/skills` are **not authoritative**. After adding, renaming, or deleting a skill:

```bash
./scripts/sync-skills.sh
./scripts/sync-skills.sh --check
```

`--check` exits non-zero on drift. CI runs that gate on every pull request and merge group (`repo-structure-gate` / Skills mirror).

A leftover local `.git/info/exclude` rule `.agents/` (from `bd init --stealth`) can hide new untracked links in `git status`. The committed mirror is still tracked; `git add -f .agents/skills` is enough when adding a skill on a clone that still has that exclude.

## Codex loading paths

Codex discovers repo skills from `.agents/skills/` (walk from cwd to repo root). Skill bodies stay in Claude tool names; do not fork them. Map Claude primitives through the existing superpowers references:

- Codex: [obra/superpowers `codex-tools.md`](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/references/codex-tools.md)
- Gemini: [obra/superpowers `gemini-tools.md`](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/references/gemini-tools.md)

Local install of those references: `./scripts/install-superpowers-codex-global.sh`.

| Kind | Skill | Codex path |
|------|-------|------------|
| Bash + `gh` | `merge-batch` | `.agents/skills/merge-batch/SKILL.md` |
| Orchestration | `release-readiness` | `.agents/skills/release-readiness/SKILL.md` |

`merge-batch` is portable as written (Bash + `gh`). `release-readiness` uses Claude tool names (`Task`, `Skill`, `TodoWrite`); Codex maps those via `codex-tools.md` (`spawn_agent`, native skill load, `update_plan`).
