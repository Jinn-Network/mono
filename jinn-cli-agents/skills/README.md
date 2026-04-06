# Centralized Agent Skills

This directory contains the canonical source for all Agent Skills used across different AI coding assistants.

## Supported Agents

| Agent | Skills Location | Distribution |
|-------|-----------------|--------------|
| Claude Code | `.claude/skills/` | Symlink or copy |
| Gemini CLI | `.gemini/skills/` | Symlink or copy |
| Codex | `.codex/skills/` | Symlink or copy |
| Cursor | `.cursor/skills/` | Symlink or copy |

## Directory Structure

```
skills/
├── README.md           # This file
├── ventures/           # Ventures registry skill
│   └── SKILL.md
├── services/           # Services registry skill (future)
│   └── SKILL.md
└── ...
```

## Distribution Strategy

### Option 1: Symlinks (Recommended for Unix/macOS)

Skills are symlinked from agent directories to this central location:

```bash
# Run the sync script to create symlinks
yarn skills:sync
```

This creates:
- `.claude/skills/ventures` → `skills/ventures`
- `.gemini/skills/ventures` → `skills/ventures`
- etc.

### Option 2: Copy (Windows or when symlinks don't work)

```bash
# Copy skills to all agent directories
yarn skills:copy
```

## Adding a New Skill

1. Create the skill directory in `skills/<skill-name>/`
2. Add `SKILL.md` with the standard Agent Skills format
3. Run `yarn skills:sync` to distribute

## Agent Skills Format

All skills follow the [Agent Skills open standard](https://agentskills.io):

```yaml
---
name: skill-name
description: When to use this skill. Be specific about triggers.
---

# Skill Title

Instructions for the agent...
```

The `description` is critical - agents use it to decide when to automatically load the skill.

## Notes

- Skills are model-invoked (automatic) based on task context
- The same skill works across Claude, Gemini, Codex, and other compatible agents
- Keep skills focused - one capability per skill
- Test skills after changes to ensure they load correctly
