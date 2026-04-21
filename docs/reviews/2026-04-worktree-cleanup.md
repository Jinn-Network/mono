# Worktree Cleanup — 2026-04-17

Audit and cleanup of stale/orphan git worktrees in `jinn-mono`. Operated from the canonical checkout at `/Users/adrianobradley/jinn-mono`.

## Targets and actions

### 1. `.worktrees/jinn-agent-packaging-research`

- **Branch:** `ale/jinn-agent-packaging-research` → tip `e31d802c`
- **Remote:** `origin/ale/jinn-agent-packaging-research` at the same SHA (`0/0` ahead/behind)
- **Working tree:** clean
- **Commits not on main (3):**
  - `e31d802c` client: fix faucet credentials and update reporting
  - `464073ec` client: fix bootstrap env and MCP error signaling
  - `0f081d4f` client: fix quickstart and MCP lifecycle regressions
- **Status:** Unmerged but abandoned (per user decision). Committed work is preserved on `origin/ale/jinn-agent-packaging-research` and recoverable via `git fetch origin ale/jinn-agent-packaging-research`.
- **Action:** `git worktree remove` + `git branch -D ale/jinn-agent-packaging-research`.

### 2. `.worktrees/jinn-client-testing`

- **Branch:** `ale/jinn-client-testing` → tip `e9212381`
- **Remote:** `origin/ale/jinn-client-testing` at the same SHA (`0/0` ahead/behind)
- **Working tree:** dirty — 9 modified files, 399 insertions / 154 deletions
- **Commits not on main (12):** auth verb + preflight stack, Claude auth probe, Docker-first testnet acceptance gate, runtime balance top-up loop, delivery-claim verification, et al. (full list via `git log main..ale/jinn-client-testing`).
- **Uncommitted diff (stat):**

      client/README.md                                   |   4 +-
      client/RELEASING.md                                |   1 +
      client/TESTNET_ACCEPTANCE.md                       |   1 +
      client/docker-compose.acceptance.yml               |   3 +-
      client/scripts/setup-testnet-acceptance-operator-docker.mjs | 14 +-
      client/src/cli/commands/auth.ts                    |  80 +++++-
      client/src/cli/commands/doctor.ts                  |  35 ++-
      client/src/main.ts                                 |  48 ++--
      client/src/preflight/claude-auth.ts                | 287 +++++++++++++++------
      client/test/preflight/claude-auth.test.ts          |  80 ++++--
      10 files changed, 399 insertions(+), 154 deletions(-)

- **Status:** Unmerged but abandoned (per user decision). Committed tip is preserved on `origin/ale/jinn-client-testing` and recoverable via `git fetch origin ale/jinn-client-testing`. Uncommitted changes were saved as a recoverable patch at `docs/reviews/2026-04-worktree-cleanup-jinn-client-testing-uncommitted.patch` before worktree removal.
- **Action:** `git worktree remove --force` (required because of the uncommitted edits) + `git branch -D ale/jinn-client-testing`.

### 3. `/private/tmp/jinn-pr2-review`

- **State:** detached HEAD at `82919fb1` ("client: fix faucet credentials and update reporting"). No branch, no uncommitted changes.
- **Status:** Orphan PR-review worktree.
- **Action:** `git worktree remove`.

### 4. `/private/tmp/jinn-pr3-review`

- **State:** detached HEAD at `e9212381` (same commit as `ale/jinn-client-testing` tip). No branch, no uncommitted changes.
- **Status:** Orphan PR-review worktree. The underlying commit remains reachable from `origin/ale/jinn-client-testing` even after cleanup.
- **Action:** `git worktree remove`.

## Recovery pointers

If any of this work is needed again:

- `git fetch origin ale/jinn-agent-packaging-research && git checkout -b ale/jinn-agent-packaging-research origin/ale/jinn-agent-packaging-research`
- `git fetch origin ale/jinn-client-testing && git checkout -b ale/jinn-client-testing origin/ale/jinn-client-testing`
- Uncommitted client-testing edits: `git apply docs/reviews/2026-04-worktree-cleanup-jinn-client-testing-uncommitted.patch`

## Untouched worktrees

The following active worktrees were out of scope and left alone: `.worktrees/jinn-mono-end-to-end-daemon-accept-measurable-in-6f7ccc20`, `.worktrees/jinn-worktree-cleanup` (this session), `.worktrees/phase1a-rollout-fix`, the seven `.claude/worktrees/agent-*` (locked), and `~/.cursor/worktrees/jinn-mono/w4i1`.
