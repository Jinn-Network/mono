# Autopilot v2 cutover

This runbook moves an operator from the legacy single-runner dispatcher to the
GitHub-native active-active lifecycle. It is a preserve-first protocol cutover,
not a data migration and not a deployment script.

Do not run legacy and v2 dispatch concurrently. Legacy processes do not
understand early draft PRs, v2 branch claims, append-only review refs, or
attempt-scoped cleanup.

## Commands and modes

From `packages/autopilot`:

```bash
yarn autopilot --mode observe --once status
yarn autopilot --mode recover --once status
yarn autopilot --mode active --once status
```

`yarn autopilot` is the v2 entry point and defaults to `observe`, which is
zero-write. `autopilot:v2` remains an explicit alias.
`yarn autopilot:legacy` is retained only for rollback before the first v2
claim; it is not safe to run beside v2.

Modes:

- **observe** — derive and explain lifecycle state; no mutation.
- **recover** — reconcile projections and stale v2 work; make no new claims.
- **active** — recover, claim, execute, review, and merge within
  this process’s local caps. (Historical: merge-prep was a separate lane;
  Stage 5 of the single-surface lifecycle deleted it — behind/conflict
  work uses the children ladder. See
  `docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md`.)

No command in this runbook should be executed merely because the code was
installed. Activation is an explicit operator decision.

## 0. Quick start (Claude runtime)

For a new operator who only needs to run active autopilot with Claude on a
current `next` checkout, work through this section plus §1 (preflight), §7
(capability attestation), and §12 (supervisor). Hand this runbook to Claude
and ask it to execute those sections in order.

Prerequisites:

- Node 22 + Yarn (`corepack enable`)
- `gh` authenticated against `Jinn-Network/mono`
- Claude Code CLI in `PATH` as `claude` (autopilot spawns `claude -p` per stage)

```bash
cd packages/autopilot
yarn install
yarn typecheck

git remote add jinn-autopilot-v2 https://github.com/Jinn-Network/mono.git
# skip if the remote already exists — URL must be exactly the line above

export JINN_IMPL_GH_TOKEN=<implementation-bot-pat>
export JINN_DISPATCHER_AUTHOR_ALLOWLIST=<comma-separated-github-logins>
export JINN_AUTOPILOT_RUNNER_ID="${JINN_AUTOPILOT_RUNNER_ID:-$(hostname)-1}"
export JINN_AUTOPILOT_RUNTIME=claude   # default when unset; set explicitly

# Optional but recommended for review:
# export JINN_REVIEW_GH_TOKEN=<review-bot-pat>
# export JINN_REVIEW_BOT_LOGIN=<review-bot-login>

# §7 — required before active mode:
CAPABILITY_DIR="$HOME/.jinn-client/autopilot"
mkdir -p "$CAPABILITY_DIR" && chmod 700 "$CAPABILITY_DIR"
CAPABILITY_ATTESTATION="$(mktemp "$CAPABILITY_DIR/capability-attestation.json.XXXXXX")"
yarn autopilot:capability-probe --output "$CAPABILITY_ATTESTATION"
chmod 600 "$CAPABILITY_ATTESTATION"
export JINN_AUTOPILOT_CAPABILITY_ATTESTATION="$CAPABILITY_ATTESTATION"

yarn autopilot --mode observe --once status
yarn autopilot --mode active --once status   # one cycle
# yarn autopilot --mode active              # continuous (10 min cadence)
```

Start with low caps during first production use:

```bash
export JINN_AUTOPILOT_IMPLEMENTATION_CAP=1
export JINN_AUTOPILOT_REVIEW_CAP=1
```

## 1. Preflight the release

Before touching a supervisor:

```bash
cd packages/autopilot
yarn typecheck
yarn test
yarn autopilot --mode observe --once --json status
```

Configure a dedicated canonical HTTPS publication remote without changing the
operator’s ordinary `origin`:

```bash
git remote add jinn-autopilot-v2 https://github.com/Jinn-Network/mono.git
git remote get-url jinn-autopilot-v2
```

If the remote already exists, require its URL to be exactly
`https://github.com/Jinn-Network/mono.git`. Do not place a token in a URL or
rewrite a contradictory remote automatically.

Required active/recover configuration:

- `JINN_IMPL_GH_TOKEN`
- `JINN_DISPATCHER_AUTHOR_ALLOWLIST`
- stable, unique `JINN_AUTOPILOT_RUNNER_ID` per process

Active mode additionally requires
`JINN_AUTOPILOT_CAPABILITY_ATTESTATION`, created by the live probe in section
7. Recover and observe do not require it.

Optional second identity:

- `JINN_REVIEW_GH_TOKEN`
- `JINN_REVIEW_BOT_LOGIN`

The implementer and reviewer GitHub identities must remain distinct for a PR.
With only one credential, the process prioritizes implementation and may
review only PRs authored by a different identity.

Runtime selection is process-wide (`JINN_AUTOPILOT_RUNTIME`). Unset defaults
to **Claude**. Supported values: `claude`, `hermes`, `cursor`. There is no
per-stage override.

```bash
export JINN_AUTOPILOT_RUNTIME=claude   # default
# export JINN_AUTOPILOT_RUNTIME=hermes
# export JINN_AUTOPILOT_RUNTIME=cursor
```

Runtime-specific prerequisites:

- **Claude** — `claude` in `PATH`; non-interactive `claude -p` must work.
- **Hermes** — configured stateless launcher; set `JINN_DISPATCHER_HERMES_MODEL`,
  `JINN_DISPATCHER_HERMES_PROVIDER`, and `JINN_DISPATCHER_HERMES_PYTHON` as
  needed. Keep Hermes selected for the coordinator and every stage.
- **Cursor** — Cursor Agent CLI; set `JINN_CURSOR_BIN` and `JINN_CURSOR_MODEL`
  when not using defaults.

Optional tuning (see also `CLAUDE.md`):

| Env | Default | Purpose |
|---|---|---|
| `JINN_AUTOPILOT_IMPLEMENTATION_CAP` | dispatcher default | Max concurrent implement sessions per process |
| `JINN_AUTOPILOT_REVIEW_CAP` | dispatcher default | Max concurrent review sessions per process |
| `JINN_AUTOPILOT_WORKTREE_BASE` | `~/.jinn-client/autopilot/attempts` | Attempt worktree root |
| `JINN_AUTOPILOT_ONLY_ISSUES` | unset (unrestricted) | Canary: comma-separated issue numbers |
| `JINN_AUTOPILOT_STALE_AFTER_MS` | `7200000` (2 h) | Staleness threshold for claim takeover |
| `JINN_AUTOPILOT_CHILDREN` | on | Children ladder (`0`/`false` to disable) |
| `JINN_AUTOPILOT_CARRYOVER` | on | Integration-ladder carryover (`0`/`false` to disable) |
| `JINN_AUTOPILOT_CLEANUP_ENABLED` | on in active mode | Opt out with `false` |
| `JINN_AUTOPILOT_ATTEMPT_GRACE_MS` | `1800000` (30 min) | Grace before removing dead dirty/ahead/preparing worktrees |
| `JINN_AUTOPILOT_DISK_FLOOR_GB` | `10` | Free-disk floor; below it, force-evict oldest dead attempts and pause new worktree claims |

## 2. Quiesce legacy dispatch

1. Disable every legacy supervisor’s ability to dispatch new sessions.
2. Let active legacy sessions reach a remote branch/PR checkpoint where
   practical.
3. Stop remaining legacy parent and child processes.
4. Do not remove worktrees, branches, refs, PRs, logs, or session directories.
5. Confirm no host can automatically restart `autopilot:legacy`.

Record the stop time, hosts, supervisor names, and last observed child PIDs.
Process exit is not proof that work was published.

## 3. Inventory every legacy host independently

On each host, collect without cleanup:

```bash
git worktree list --porcelain
git branch -vv
git status --short
gh pr list --repo Jinn-Network/mono --state open \
  --json number,headRefName,headRefOid,isDraft,body
```

For every legacy worktree/session, record:

- clean or dirty worktrees, including untracked files;
- local branches and detached heads;
- ahead commits not reachable from the remote branch;
- remote branches without PRs;
- implementation, review, and (historical) merge-prep sessions;
- draft and ready PRs;
- the selected identity when known.

Publish a clean committed head to its existing branch and draft PR only when
its mapping and authority are unambiguous. Preserve dirty worktrees, ahead
commits, ambiguous mappings, and authority-sensitive work under an explicit
Human hold. Never infer abandonment from another host’s missing local
artifact.

This inventory is a one-time migration aid. Local inventories do not become
shared lifecycle state.

## 4. Normalize GitHub without rewriting history

Use this table:

| Existing state | Cutover treatment |
|---|---|
| Todo issue, no PR | Leave eligible |
| In Progress with one draft PR | Preserve branch/PR; grandfather for GitHub-head staleness |
| In Progress without PR | Human reconciliation; do not infer abandonment |
| Ready In Review PR | Eligible for a new exact-head review claim |
| Draft review-fix PR | Preserve/finish the legacy reviewer or park Human before v2 recovery |
| Human-held draft | Preserve and exclude |
| Current-head native approval, CI green | Eligible for merge when integration ladder satisfied |
| Current-head native approval, CI not green | `ci-blocked`: one exact-head CAS-fenced rerun, then `ci-failure` child if still red |
| Conflicting approved PR | File reconcile child (children ladder) |
| Merged PR | Reconcile Done; dead attempt worktrees cleaned per §10 |

Do not rename existing branches, synthesize historical review refs, rewrite
commits, or close/reopen PRs merely to look v2-native. New implementations use
`autopilot/<issue-number>`; an existing unambiguous PR keeps its branch.

## 5. Shadow in observe

Run at least two observers, preferably with different runner IDs and local
worktree bases:

```bash
JINN_AUTOPILOT_RUNNER_ID=observer-a \
  yarn autopilot --mode observe --once --json status > observer-a.json

JINN_AUTOPILOT_RUNNER_ID=observer-b \
  JINN_AUTOPILOT_WORKTREE_BASE=/different/local/base \
  yarn autopilot --mode observe --once --json status > observer-b.json
```

Compare GitHub-derived conclusions, not local path text. They must agree on:

- eligible issues;
- active/stale implementation and review;
- Human holds;
- `ci-blocked`, merge-ready, and children-ladder candidates;
- native gate blockers;
- proposed recovery.

A missing local worktree on either observer must not change those conclusions.
Resolve every contradictory mapping diagnostic before active mode.

## 6. Reconcile in recover

Run one bounded recovery cycle:

```bash
yarn autopilot --mode recover --once --json status
```

Review every applied/failed/no-op reconciliation. `recover` may repair Project,
draft/label/comment projections and re-enable ordinary claims after proven v2
staleness; it must not create new work.

The initial stale threshold is two hours without real branch-head or
marker-bound verdict progress. Comments, CI, Project edits, logs, and process
heartbeats are not progress.

## 7. Prove live GitHub ref capabilities

This is a blocking capability gate before the same-host canary and before review activation.
Unit tests and a local bare remote are necessary but do not prove that the
production GitHub transport honors the review protocol.

Choose an owner-only local destination outside the repository and run the
executable probe:

```bash
CAPABILITY_DIR="$HOME/.jinn-client/autopilot"
mkdir -p "$CAPABILITY_DIR"
chmod 700 "$CAPABILITY_DIR"
CAPABILITY_ATTESTATION="$(mktemp "$CAPABILITY_DIR/capability-attestation.json.XXXXXX")"
rm -f -- "$CAPABILITY_ATTESTATION"
unset JINN_AUTOPILOT_CAPABILITY_ATTESTATION
if yarn autopilot:capability-probe --output "$CAPABILITY_ATTESTATION"; then
  chmod 600 "$CAPABILITY_ATTESTATION"
  export JINN_AUTOPILOT_CAPABILITY_ATTESTATION="$CAPABILITY_ATTESTATION"
else
  unset JINN_AUTOPILOT_CAPABILITY_ATTESTATION
  rm -f -- "$CAPABILITY_ATTESTATION"
  false
fi
```

The probe uses only unique disposable canary refs and the configured v2
publication transport. Each run uses a fresh owner-only destination, refuses
to overwrite an existing path, unsets the prior environment binding before
probing, and exports the new artifact only after success. It verifies and
records:

1. **absent-ref creation** — create a disposable review ref only with the
   protocol's zero/absent expectation; a competing create must be rejected.
2. **expected-parent advance** — advance that ref from its exact observed OID;
   repeat with the stale expected parent and prove rejection leaves the ref
   unchanged.
3. **atomic two-ref success** — from known exact parents, atomically advance a
   disposable branch and review ref in one publication.
4. **atomic two-ref rejection** — race or deliberately stale one expected
   parent and prove the publication is rejected with **both refs unchanged**.
5. **ambiguous read-back** — interrupt or obscure one response and prove the
   adapter classifies the result only by reading both exact refs.
6. **read via git transport** — after creating the disposable review ref,
   list it back through the same `git ls-remote <remote> '<glob>'` mechanism
   production's review-claim reader uses, and require the exact OID just
   pushed; GitHub's GraphQL `ref(qualifiedName:)` permanently returns null
   for `refs/jinn-autopilot/*` (proven live), so this proof covers the read
   path, not just the write path.

It uses no production PR branch and no existing review ref. It writes the
owner-only attestation only after exact cleanup succeeds. If any outcome or
cleanup is ambiguous it writes no attestation and retains remaining disposable
refs for inspection instead of guessing.

Production active preflight reads and validates the configured attestation,
including repository, remote, authenticated implementer identity, every proof,
and its 30-day validity window. Active mode fails closed when the artifact is
missing, malformed, expired, broadly readable, or for another identity/remote.
Re-run the live probe after expiry. Do not enable review or run an active canary
unless every proof passes against GitHub. A failure is a release blocker; it is
not permission to fall back to a non-atomic fix publication or to change
upstream Hermes.

## 8. Same-host canary

Create or select one disposable, fully triaged canary issue. Start two active
processes on the same host with independent runner IDs, worktree bases, and
capacity one:

```bash
JINN_AUTOPILOT_RUNNER_ID=canary-a \
JINN_AUTOPILOT_WORKTREE_BASE=/safe/exact/path/canary-a \
JINN_AUTOPILOT_IMPLEMENTATION_CAP=1 \
JINN_AUTOPILOT_REVIEW_CAP=1 \
yarn autopilot --mode active --once --json status

JINN_AUTOPILOT_RUNNER_ID=canary-b \
JINN_AUTOPILOT_WORKTREE_BASE=/safe/exact/path/canary-b \
JINN_AUTOPILOT_IMPLEMENTATION_CAP=1 \
JINN_AUTOPILOT_REVIEW_CAP=1 \
yarn autopilot --mode active --once --json status
```

Launch the two commands concurrently. Verify:

- both discovered the same issue;
- exactly one implementation claim became branch head;
- only the winner started substantive work;
- exactly one early draft PR exists;
- detached attempt paths do not collide;
- the loser reports the race without shared cleanup.

Repeat the race for review. (Historical: this canary also raced merge-prep via
`JINN_AUTOPILOT_MERGE_PREP_CAP`; that env and lane were deleted in Stage 5 —
behind/conflict scheduling is children-ladder only.)

## 9. Cross-host canary

Repeat with one process per host. Hide or omit each host’s local artifacts from
the other and verify the GitHub-derived decision remains identical. Exercise a
hard crash after a published checkpoint and confirm another process resumes
from GitHub without deleting the first host’s recoverable local work.

At least one disposable canary should remain unchanged for the full two-hour
threshold before takeover is tested.

## 10. Progressive activation and worktree cleanup

Enable in this order:

1. one production implementation slot;
2. a second independent implementation process;
3. review with distinct identities;
4. children ladder (finding/reconcile/reconcile-child, `ci-failure` child,
   tier-0 `update-branch`);
5. higher per-process caps after backlog/rate-limit health is demonstrated.

**Worktree cleanup** is on by default in active mode. Each active cycle sweeps
dead attempt directories under `JINN_AUTOPILOT_WORKTREE_BASE/v2/` (default
`~/.jinn-client/autopilot/attempts/v2/`). Opt out only when debugging:

```bash
export JINN_AUTOPILOT_CLEANUP_ENABLED=false
```

Cleanup rules (host-local, PID-liveness-guarded, exact-path only):

- **Live child PID** — never removed.
- **Clean + pushed** — removed immediately on the next cycle.
- **Dead dirty/ahead/preparing** — removed after `JINN_AUTOPILOT_ATTEMPT_GRACE_MS`
  (default 30 min). Durable work is on the pushed branch; the worktree is a
  disposable cache.
- **Malformed orphan dirs** — removed after the same grace period.
- **Escaped paths** — never removed.
- **Below `JINN_AUTOPILOT_DISK_FLOOR_GB`** (default 10 GB free) — oldest dead
  attempts are force-evicted first; new worktree-creating claims pause until
  space recovers. Merge, update-branch, reconcile-child, rerun-failed-checks,
  and file-ci-failure-child still run.

Verify cleanup behavior during the crash campaign in §8–§9 before raising caps.

## 11. Rollback

Before the first v2 claim, stop v2 and re-enable legacy if necessary.

After any v2 claim exists:

1. stop new v2 active processes everywhere;
2. leave existing branches, refs, PRs, Project state, worktrees, and manifests
   intact;
3. run only `observe` or `recover`;
4. repair the defect;
5. roll forward with a v2-compatible build.

Do not restart legacy after v2 has published a claim. Stopping a process must
not destroy GitHub-visible progress, and rollback is never a cleanup event.

## 12. Operator supervisor (`supervise.sh`)

The operator-local supervisor at `~/.jinn-client/eng-loop/supervise.sh` is
gitignored and per-operator. After the single-surface lifecycle ships, it must
launch **only** the v2 entry point:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /path/to/jinn-mono/packages/autopilot
export JINN_AUTOPILOT_RUNNER_ID="${JINN_AUTOPILOT_RUNNER_ID:-$(hostname)-1}"
export JINN_AUTOPILOT_RUNTIME="${JINN_AUTOPILOT_RUNTIME:-claude}"
# Required: JINN_IMPL_GH_TOKEN, JINN_DISPATCHER_AUTHOR_ALLOWLIST,
# JINN_AUTOPILOT_CAPABILITY_ATTESTATION (active mode).
unset JINN_MERGE_PREP   # deleted — children ladder only
exec yarn autopilot --mode active
```

Do **not** invoke `yarn autopilot:legacy`, export `JINN_MERGE_PREP`, or kill
patterns keyed to the deleted merge-prep lane. Long-running deployments should
use `run-autopilot-v2.ts` (the default `yarn autopilot` script).

## 13. Board painter token

The scheduled workflow `.github/workflows/autopilot-board-painter.yml` requires
a repo secret with org Projects v2 write access:

- **Preferred:** `JINN_AUTOPILOT_PAINTER_TOKEN`
- **Fallback:** `JINN_IMPL_GH_TOKEN`

Confirm one is configured in the repository Actions secrets before relying on
board convergence in production. The default `GITHUB_TOKEN` is insufficient for
the org-level "Jinn engineering" project board.
