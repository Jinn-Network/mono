# Agent bootstrap

Author in-repo skills only in [`.claude/skills/`](.claude/skills/). Generated mirrors are not authoritative. Refresh with `./scripts/sync-skills.sh`; CI fails `./scripts/sync-skills.sh --check` on drift.

## Codex discovery

Codex loads repo skills from [`.agents/skills/`](.agents/skills/) (cwd up to the repo root). That tree is a generated symlink mirror of `.claude/skills/`. Do not edit or fork skill bodies there. If `git status` hides new links, a leftover local `.git/info/exclude` `.agents/` rule from `bd init --stealth` is the usual cause; `git add -f .agents/skills` still stages them.

Skill bodies use Claude Code tool names. Map them with the existing superpowers references — do not rewrite `SKILL.md` per tool:

- [codex-tools.md](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/references/codex-tools.md)
- [gemini-tools.md](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/references/gemini-tools.md)

`.cursor/skills/` and `.codex/skills/` are generated compatibility mirrors (Cursor still discovers both). Codex's current repo path is `.agents/skills/`, not `.codex/skills/`.

## Expected Codex loading paths

| Kind | Skill | Path Codex should load |
|------|-------|------------------------|
| Bash + `gh` | `merge-batch` | [`.agents/skills/merge-batch/SKILL.md`](.agents/skills/merge-batch/SKILL.md) |
| Orchestration | `release-readiness` | [`.agents/skills/release-readiness/SKILL.md`](.agents/skills/release-readiness/SKILL.md) |

`merge-batch` is Bash + `gh` and needs no tool-name translation. `release-readiness` is an orchestration skill: map `Task` / `Skill` / `TodoWrite` through `codex-tools.md` (`spawn_agent`, native skill load, `update_plan`).

Repo conventions beyond skills live in [`CLAUDE.md`](CLAUDE.md) and [`docs/engineering/handbook.md`](docs/engineering/handbook.md).
