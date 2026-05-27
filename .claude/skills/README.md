# Agent skills (multi-harness)

This directory is the **canonical** source for in-repo agent skills (`SKILL.md` + optional `references/`, etc., per [agentskills.io](https://agentskills.io)).

Cursor and Codex load the same definitions via symlinks:

| Harness     | Path              |
|-------------|-------------------|
| Claude Code | `.claude/skills/` |
| Cursor      | `.cursor/skills/` |
| Codex       | `.codex/skills/`  |

After adding or renaming a skill, run from the repo root:

```bash
./scripts/sync-skills.sh
```

Edit skills only here — do not copy `SKILL.md` into `.cursor/` or `.codex/`.
