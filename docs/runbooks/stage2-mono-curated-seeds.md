# Stage 2 curated mono seed batch

Operator runbook for issue
[#1826](https://github.com/Jinn-Network/mono/issues/1826): prepare,
review, publish, and verify the first `Jinn-Network/mono` batch that satisfies
the shared `K=3` retrieval-visible corpus probe.

The repository supplies a template, an offline mechanical auditor, and the
read-only planning lane. It deliberately supplies no pre-approved batch.
The operator owns record selection, authorship, privacy review, publication,
the live testnet probe, and the attributed working-session judgment.

## What the offline audit proves

For every `*.episode.json` file in the selected directory, it checks:

- exact `Jinn-Network/mono` targeting and the shared `mono` probe term;
- the canonical `retrieval:visible.v1` mark;
- a distinct episode ID and distinct full mono commit URL;
- a full base commit, recorded-session origin, completed test/evaluator-backed
  outcome, and failure/fix/command evidence;
- the deterministic seed scrub preflight; and
- at least the same `K=3` records used by `corpus-content`.

A local pass does **not** mean the records are useful enough to curate, does
not authorize publication, and does not claim a live probe ran. Every report
states those boundaries explicitly.

## 1. Prerequisites

- Run from the Stage 2 candidate that contains the accepted visibility,
  supersede, seed-scrub, corpus-probe, and stock-Hermes work.
- Use Node 22 and install/build the independent package chain plus the client:

  ```bash
  corepack yarn --cwd packages/plugin install --immutable
  corepack yarn --cwd packages/plugin build
  corepack yarn --cwd packages/core install --immutable
  corepack yarn --cwd packages/core build
  corepack yarn --cwd packages/layer install --immutable
  corepack yarn --cwd packages/layer build
  corepack yarn --cwd client install --immutable
  export JINN_LAYER_BIN="$PWD/packages/layer/dist/bin/jinn-layer.js"
  ```

- Confirm the operator's testnet identity and discovery configuration are the
  intended ones before any publication. Do not use production credentials or
  promote `main` as part of this runbook.
- Read `docs/runbooks/stage1-evidence-seeding.md`, especially its privacy
  residuals and ambiguous-publication recovery rules.

## 2. Author a private candidate batch

Copy the non-loadable template out of the repository fixture tree:

```bash
mkdir -p /tmp/jinn-stage2-mono-candidates
cp packages/layer/fixtures/curated-mono-candidates/episode.template.json \
  /tmp/jinn-stage2-mono-candidates/<stable-id>.episode.json
```

Prepare three or more distinct records. The checked-in
`source-dashboard-flake` Stage 1 episode is a candidate, not an automatic
approval; the existing Stage 1 fixture set has only one mechanically eligible
marked mono record.

For each record, the operator must review facts the script cannot establish:

- the task is genuinely repo-specific and useful to an early mono session;
- commands and outputs came from a real recorded session or a faithful
  re-performance of the linked merged fix;
- synthesis and tags are authored, specific, and not boilerplate;
- excerpts are minimal, accurate, repo-relative, and free of user, machine,
  customer, credential, private URL, and other sensitive data;
- the full PII/secret residual described by the Stage 1 runbook has been
  inspected manually; and
- the retrieval mark is an intentional curation decision, not a copied
  default.

## 3. Mechanical audit (read-only)

```bash
set -o pipefail
corepack yarn --cwd client stage2:validate-curated-seeds --episodes-dir \
  /tmp/jinn-stage2-mono-candidates --repo Jinn-Network/mono --json \
  | tee /tmp/stage2-mono-curated-audit.json
```

Require all of:

- `automatedStatus: "pass"`;
- `eligibleRecordCount >= 3`;
- every record has `automatedStatus: "pass"`;
- `humanCurationRequired: true`;
- `publishAuthorized: false`; and
- `liveProbe.status: "not-run"`.

The negative control must fail honestly at the current one-of-three state:

```bash
corepack yarn --cwd client stage2:validate-curated-seeds --episodes-dir \
  "$PWD/packages/layer/fixtures/stage1-seeds" --json
```

That command exits `1`; it is evidence that the tool does not turn the
checked-in fixtures into a completed Stage 2 claim.

## 4. Back up local publication state

The idempotency file is needed to attach `supersedes` to a prior publication.
Preserve it; never replace it with an empty file before publishing.

```bash
seed_state="${JINN_LAYER_SEED_STATE_PATH:-$HOME/.jinn-client/harness-layer/seed-import-state.json}"
backup_dir="/tmp/jinn-stage2-mono-state-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
if [ -f "$seed_state" ]; then
  cp -p "$seed_state" "$backup_dir/seed-import-state.json"
  printf '%s\n' "$seed_state" > "$backup_dir/source-path.txt"
else
  printf '%s\n' "ABSENT: $seed_state" > "$backup_dir/source-path.txt"
fi
```

Keep the backup until publication, probe verification, and issue evidence are
complete. If no publication occurred, it may restore accidentally damaged
local state. If any publication or anchor may have succeeded, **do not roll
the state file backward**: reconcile the printed envelope/transaction first,
or a retry can duplicate immutable records and break supersede lineage.

## 5. Plan, inspect, and explicitly approve

Planning performs no corpus or chain writes:

```bash
"$JINN_LAYER_BIN" seed plan --episodes-dir \
  /tmp/jinn-stage2-mono-candidates \
  --out /tmp/stage2-mono-curated-plan.json
```

Compare the plan digests and rows with the audited files. A human must read
every final file and explicitly approve this exact plan. Any edit after that
review requires a fresh audit and plan.

## 6. Publication is intentionally parked

The extracted layer deliberately does not import the client's wallet or
chain-writing implementation. Its CLI rejects `derive-env` and live
`seed execute` unless an authorized host injects the publication adapter.
The audit and plan above are safe and read-only; stop there in the parked
state. Live publication and its immutable-record recovery procedure remain
an operator gate for the future outbound-lane design.

## 7. Run the shared live probe

```bash
set -o pipefail
"$JINN_LAYER_BIN" corpus probe "Jinn-Network/mono" --json \
  | tee /tmp/stage2-mono-corpus-probe.json
```

Require both `corpus-reachable.ok` and `corpus-content.ok` to be `true`.
The content detail must report at least three retrieval-visible matching
records. Also run the stock Hermes doctor and require its `corpus-content`
check to report the same green result; do not substitute an offline fixture
test for either live observation.

## 8. Record the attributed operator moment

From a clean `Jinn-Network/mono` worktree, start a normal stock-Hermes working
session with the accepted Jinn plugin enabled. Give it a genuine task whose
vocabulary matches one curated episode. Do not script an artificial injection.

Before allowing the episode to influence the work, capture the visible
knowledge packet and verify:

- the task-linked prior episode appeared without a manual corpus lookup;
- the UI/message names the source record or envelope ref;
- the failure/fix/command excerpts and authored synthesis match the published
  episode; and
- the information was relevant and useful, not merely lexically matched.

Complete the working session and preserve a scrubbed transcript excerpt,
timestamp, commit/worktree identity, task prompt, retrieved envelope ref, and
the operator's usefulness judgment. This live session cannot be replaced by
the local validator or corpus search command.

## 9. Evidence and rollback

Comment on #1826 with:

- the exact candidate commit and tool version;
- the offline audit JSON;
- the approved plan digests;
- published envelope refs and anchor transactions;
- the live layer probe and stock-doctor results; and
- the scrubbed attributed-session evidence and operator judgment.

Records are immutable. If a curated record is wrong or unsafe, stop using it
immediately and prepare a corrected record with the same stable identity. To
demote rather than replace it, remove the retrieval mark from the corrected
episode, run the normal seed plan/execute lane (the curated-batch audit will
intentionally fail an unmarked record), and publish it as the superseding
record. Verify that read-time collapse no longer admits the old marked
version. Never claim deletion, edit an already published envelope, or discard
the state that links the superseding publication.

Keep #1826 human-blocked until all three live acceptance facts are present:
three published marked mono records, green shared probes, and one genuinely
useful attributed mono working session.
