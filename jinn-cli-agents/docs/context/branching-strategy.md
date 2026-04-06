---
title: Git Branching Strategy
purpose: context
scope: [worker, gemini-agent]
last_verified: 2026-01-30
related_code:
  - gemini-agent/shared/code_metadata.ts
  - worker/git/branch.ts
  - worker/git/push.ts
  - worker/orchestration/jobRunner.ts
keywords: [git, branch, checkout, parent-child, dependency, merge]
when_to_read: "When understanding how job branches are named, created, or merged"
---

# Branching Strategy

## Branch Naming Convention

Pattern: `job/{jobDefinitionId}[-{slug}]`

```
job/{uuid}                    # Without job name
job/{uuid}-{normalized-name}  # With job name (max 20 chars)
```

Slug normalization (from `code_metadata.ts:162-173`):
- Lowercase, alphanumeric + hyphens only
- Multiple hyphens collapsed to single
- Leading/trailing hyphens stripped
- Truncated to `maxSlugLength` (default: 20)

Examples:
```
job/a1b2c3d4-e5f6-7890-abcd-ef1234567890
job/a1b2c3d4-e5f6-7890-abcd-ef1234567890-fix-login-bug
```

## Branch Checkout Flow

```
                          +------------------+
                          | checkoutJobBranch |
                          +--------+---------+
                                   |
              +--------------------+--------------------+
              |                    |                    |
         [local exists?]    [remote exists?]    [neither exists]
              |                    |                    |
              v                    v                    v
      git checkout          git checkout -b       git checkout -b
         {branch}        {branch} origin/{branch}   {branch} {base}
              |                    |                    |
              +--------------------+--------------------+
                                   |
                                   v
                          clearBuildCaches()
```

CheckoutMethod types:
- `local` - Branch already exists locally
- `remote_tracking` - Created local from `origin/{branch}`
- `new_from_base` - Created from baseBranch (first-time creation)

## Base Branch Resolution

When creating new branch, base is resolved in order:
1. If `origin/{baseBranch}` exists -> use remote
2. If `{baseBranch}` exists locally -> use local
3. Error: base branch missing

For job branches (`job/uuid-*` pattern):
- Use HEAD commit if parent branch not yet pushed
- Enables child dispatch before parent completes push

## Branch Hierarchy (Parent/Child)

```
main
  |
  +-- job/parent-uuid-fix-auth
        |
        +-- job/child-uuid-add-tests    (baseBranch: job/parent-uuid-fix-auth)
        |
        +-- job/child-uuid-update-docs  (baseBranch: job/parent-uuid-fix-auth)
              |
              +-- job/grandchild-uuid-typos
```

Children inherit `codeMetadata` from parent, setting:
- `baseBranch` = parent's branch name
- `parent.jobDefinitionId` = parent's job def ID
- `root.jobDefinitionId` = original ancestor's job def ID

## Dependency Branch Merging

When `target.dependencies` array is non-empty, each dependency's branch is merged:

```
                    Dependency Jobs

job/dep-a-uuid ----+
                   |
job/dep-b-uuid ----+----> merge into ---> job/current-uuid
                   |
job/dep-c-uuid ----+
```

Merge sequence (`jobRunner.ts:222-309`):
1. Fetch branch info for each `depJobDefId`
2. Call `syncWithBranch(repoRoot, depBranchName)`
3. If conflict: commit with markers, continue to next dep
4. Store conflicts in `additionalContext.mergeConflicts`

## Conflict Handling

On merge conflict:
```
1. Conflict detected (CONFLICT in stderr)
2. Get conflicting files: git diff --name-only --diff-filter=U
3. Leave conflict markers in files:
   <<<<<<< HEAD
   current changes
   =======
   incoming changes
   >>>>>>> origin/job/dependency-branch
4. Stage and commit: "WIP: Merge conflict from {branch} - agent must resolve"
5. Continue processing remaining dependencies
6. Store in additionalContext.mergeConflicts:
   [{ branch: "job/dep-uuid", files: ["src/index.ts"] }]
```

Agent sees merge conflicts as committed files with markers and resolves them.

## Stash Behavior

Before checkout or merge, uncommitted changes are stashed:

```
1. Check: git status --porcelain
2. If changes exist (except .beads/ when beads enabled):
   - git stash push -m "Auto-stash before {operation}"
   - Record stashed file paths
3. On failure to stash: continue anyway
4. Store in result: stashedChanges: ["file1.ts", "file2.ts"]
5. Inform agent via additionalContext.stashedChanges
```

## Push Strategy

From `push.ts`:

```
1. Configure credentials (GITHUB_TOKEN -> ~/.git-credentials)
2. Verify remote: git remote get-url origin
3. Push: git push -u origin {branch}:{branch}
4. On non-fast-forward rejection:
   a. git fetch origin {branch}
   b. git rebase origin/{branch}
   c. git push -u origin {branch}:{branch}
   d. On rebase conflict: git rebase --abort, throw error
```

Timeout: 60 seconds (`GIT_PUSH_TIMEOUT_MS`)

## Build Cache Cleanup

After branch switch, stale caches are cleared (`branch.ts:19-48`):

```
.next/           # Next.js
.contentlayer/   # Contentlayer
.turbo/          # Turborepo
.vite/           # Vite
.parcel-cache/   # Parcel
.svelte-kit/     # SvelteKit
.nuxt/           # Nuxt
.astro/          # Astro
.output/         # Nuxt/Nitro
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODE_METADATA_DEFAULT_BASE_BRANCH` | `main` | Default base for new branches |
| `CODE_METADATA_REPO_ROOT` | - | Repository root path |
| `JINN_WORKSPACE_DIR` | - | Parent directory for cloned repos |
| `CODE_METADATA_REMOTE_NAME` | `origin` | Git remote name |
| `GITHUB_TOKEN` | - | Auth token for push |

## Timeouts

| Operation | Timeout |
|-----------|---------|
| Clone | 120s |
| Fetch | 60s |
| Checkout | 30s |
| Push | 60s |
| Status | 10s |
| Commit | 10s |
