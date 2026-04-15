---
title: jinn-node Subtree Workflow
purpose: runbook
scope: [git, jinn-node]
last_verified: 2026-02-09
related_code:
  - scripts/subtree.sh
  - scripts/lib/common.sh
  - jinn-node/package.json
keywords: [subtree, jinn-node, sync, push, pull, standalone]
when_to_read: "Use when syncing changes between the monorepo jinn-node/ directory and the standalone jinn-node repository"
---

# jinn-node Subtree Workflow

How to sync the `jinn-node/` directory between the monorepo and the standalone `https://github.com/Jinn-Network/jinn-node.git` repository.

## Background

The jinn-node directory is managed as a **git subtree** (not a submodule). This means:
- Changes to `jinn-node/` are committed normally in the monorepo
- Those changes must be explicitly pushed to the standalone repo
- Changes made directly in the standalone repo must be explicitly pulled
- Subtree remotes and split caches are **local to each clone** — every fresh clone needs setup

## Setup (Once Per Clone)

Every fresh clone needs the jinn-node remote configured:

```bash
yarn subtree:setup
```

This adds the `jinn-node` remote pointing to `https://github.com/Jinn-Network/jinn-node.git` and fetches the latest refs. Safe to run multiple times (idempotent).

## Checking Status

```bash
yarn subtree:status
```

Shows:
- Monorepo commits to `jinn-node/` not yet pushed to standalone
- Latest commits on the standalone repo

## Pushing Changes (Monorepo -> Standalone)

After committing changes to `jinn-node/` in the monorepo:

```bash
yarn subtree:push
```

Requirements:
- Working tree must be clean
- Run from the branch containing your changes (usually main)
- May take 30-60s (subtree split replays history)

## Pulling Changes (Standalone -> Monorepo)

If someone committed directly to the standalone repo:

```bash
yarn subtree:pull
```

Requirements:
- Working tree must be clean
- Creates a merge commit in the monorepo

## Common Scenarios

### You edited jinn-node/ in the monorepo
1. Commit changes normally: `git add jinn-node/ && git commit ...`
2. Push to monorepo: `git push origin main`
3. Sync to standalone: `yarn subtree:push`

### Someone pushed to the standalone repo directly
1. Pull into monorepo: `yarn subtree:pull`
2. Push to monorepo: `git push origin main`

### Fresh clone, need to work with subtree
1. Setup: `yarn subtree:setup`
2. Check status: `yarn subtree:status`

### Push fails with "updates were rejected"
Someone pushed to the standalone repo since your last sync:
1. Pull first: `yarn subtree:pull`
2. Then push: `yarn subtree:push`

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `fatal: 'jinn-node' does not appear to be a git repository` | Run `yarn subtree:setup` |
| `Working tree has modifications` | Commit or stash changes first |
| Push is very slow | Normal — subtree push replays history. Wait. |
| `refusing to merge unrelated histories` | Do NOT use `--squash`. The subtree was added without `--squash` and you cannot mix modes. |
| Setup says "already configured" but push fails | Try `yarn subtree:setup` again to re-fetch, or check network connectivity |
