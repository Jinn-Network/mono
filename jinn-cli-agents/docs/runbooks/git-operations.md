---
title: Git Operations Runbook
purpose: runbook
scope: [worker]
last_verified: 2026-01-30
related_code:
  - worker/git/branch.ts
  - worker/git/push.ts
  - worker/git/autoCommit.ts
  - worker/git/workingTree.ts
  - worker/constants.ts
keywords: [git, branch, checkout, merge, stash, push, rebase, conflict]
when_to_read: "When debugging git operations in the worker: branch checkout, merging, conflict resolution, or stash recovery"
---

# Git Operations Runbook

How agents handle git operations: branch creation, merging, conflict resolution, and stash recovery.

## Branch Checkout Strategy

The `checkoutJobBranch()` function in `worker/git/branch.ts` uses three checkout methods:

| Method | Condition | Command |
|--------|-----------|---------|
| `local` | Local branch exists | `git checkout <branch>` |
| `remote_tracking` | Remote exists, local doesn't | `git checkout -b <branch> origin/<branch>` |
| `new_from_base` | Neither exists | `git checkout -b <branch> <baseRef>` |

Base branch resolution order: local branch > `origin/<branch>` > fallback to `main`.

## Auto-Stash Before Checkout

Before any checkout/merge, uncommitted changes are automatically stashed:

```
git stash push -m "Auto-stash before checkout to <branch>"
```

Stashed files are returned in `BranchCheckoutResult.stashedChanges[]`.

## Merge Strategy

`syncWithBranch()` merges dependency branches into the current branch:

```
git merge <targetRef> --no-edit
```

Conflicts are LEFT in the working tree for agent resolution. The function returns:
- `hasConflicts: true` when merge fails with conflicts
- `conflictingFiles[]` - list from `git diff --name-only --diff-filter=U`

## Push with Auto-Rebase

`pushJobBranch()` handles non-fast-forward rejections automatically:

```
git push -u origin <branch>:<branch>
# If rejected:
git fetch origin <branch>
git rebase origin/<branch>
git push -u origin <branch>:<branch>
```

On rebase failure, `git rebase --abort` runs automatically.

## Build Cache Cleanup

After branch switches, stale build caches are cleared:
`.next`, `.contentlayer`, `.turbo`, `.vite`, `.parcel-cache`, `.svelte-kit`, `.nuxt`, `.astro`, `.output`

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Your local changes would be overwritten by checkout` | Auto-stash failed | Manual: `git stash push -m "manual"` then retry |
| `CONFLICT (content)` in merge | Dependency has conflicting changes | Agent resolves conflicts, then `git add . && git commit` |
| `Failed to create branch from <ref>` | Base branch missing | Ensure baseBranch exists locally or on remote |
| `updates were rejected (non-fast-forward)` | Remote has commits you don't | Auto-handled by fetch+rebase; if rebase fails, check for conflicts |
| `Failed to abort rebase` | Rebase state corrupted | Manual: `rm -rf .git/rebase-merge` |
| `TypeError: Cannot read properties of null (reading 'hash')` | Stale build cache | Auto-cleared; manual: `rm -rf .next .turbo` |

## Stash Recovery

To recover auto-stashed changes:

```bash
git stash list                    # Find stash with "Auto-stash before checkout"
git stash show -p stash@{0}       # Preview changes
git stash pop stash@{0}           # Apply and remove from stash
```

## Timeouts

From `worker/constants.ts`:

| Operation | Timeout |
|-----------|---------|
| Checkout | 30s |
| Push | 60s |
| Fetch | 60s |
| Status/Commit | 10s |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODE_METADATA_DEFAULT_BASE_BRANCH` | `main` | Base branch for new branches |
| `CODE_METADATA_REMOTE_NAME` | `origin` | Remote name for push |
| `GITHUB_TOKEN` | - | Token for credential helper |

## Auto-Commit

`autoCommitIfNeeded()` commits changes before push:

1. Check `git status --porcelain` for changes
2. Stage with `git add --all`
3. Commit with derived message (max 72 chars, truncated with `...`)

Commit message derived from: execution summary > final status message > fallback `[Job <id>] auto-commit`.

## Beads File Handling

When beads is enabled, `.beads/` changes are auto-committed separately before checkout:

```
git add .beads/
git commit -m "chore: sync beads state before checkout"
```

This prevents checkout failures from beads daemon activity.
