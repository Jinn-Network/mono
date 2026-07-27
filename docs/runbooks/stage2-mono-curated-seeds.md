# Stage 2 mono starter corpus

Operator runbook for [#2010](https://github.com/Jinn-Network/mono/issues/2010)
and [#2190](https://github.com/Jinn-Network/mono/issues/2190): privately
prepare, approve, publish, and verify 15 new retrieval-visible
`Jinn-Network/mono` episodes for a clean Hermes installation.

This is an operator-only process. Raw transcripts and private draft episodes
never enter the repository. The standalone layer remains unable to publish:
wallet access and live publication dependencies are supplied only by the
client-owned command after an explicit `--yes`.

## Safety boundary

The offline audit checks every selected `*.episode.json` for:

- exact `Jinn-Network/mono` targeting and the shared `mono` probe term;
- the canonical `retrieval:visible.v1` mark;
- distinct episode IDs and distinct full mono source-commit URLs;
- full base commits, recorded-session origin, completed
  test/evaluator-backed outcomes, and failure/fix/command evidence;
- the deterministic seed scrub preflight; and
- at least the same `K=3` records required by the public corpus probe.

A passing audit does not make the episodes useful, approve their wording,
authorize publication, or prove a live retrieval result. All 15 records need
manual factual, usefulness, and privacy review before the first wave.

Publication is immutable. If a publish or anchor outcome is ambiguous, stop.
Do not retry until the printed envelope and transaction have been reconciled.
Preserve the seed-import state because it carries idempotency and supersede
lineage.

## 1. Prepare the environment

Use Node 22 and build the independent packages plus the client:

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

Confirm that the local bootstrapped identity is the intended Base Sepolia
operator. Do not use production credentials. Read
`docs/runbooks/stage1-evidence-seeding.md`, especially the privacy residuals
and ambiguous-publication recovery rules.

Create a durable private workspace with owner-only permissions:

```bash
install -d -m 700 "$HOME/.jinn-client/local-corpus/launch-15"
```

Copy the non-loadable template there for each draft:

```bash
cp packages/layer/fixtures/curated-mono-candidates/episode.template.json \
  "$HOME/.jinn-client/local-corpus/launch-15/<stable-id>.episode.json"
```

## 2. Author and re-perform all 15 records

Prepare exactly these new records:

| Wave | Record IDs |
| --- | --- |
| 1 — newcomer experience | `source-dashboard-flake`, `claim-gate-usd-estimated-metered`, `plugin-federated-local-public-pickup`, `plugin-stock-hermes-useful-retrieval`, `packed-cold-stock-runtime-smoke` |
| 2 — daemon/operator reliability | `daemon-gate-eval-scan-on-evaluator-role`, `daemon-nonblocking-inflight-recovery`, `discovery-skip-expired-execution-window`, `transcript-watcher-recency-bound`, `pidfile-recycled-daemon` |
| 3 — evaluation/CI | `cross-language-parity-test-fail-closed`, `eval-docker-abort-classify-unscorable`, `evaluator-cost-monotonic-clock-and-finite-guard`, `pilot-evaluator-parity-strip-testhunks-tmp`, `publish-canary-path-filter-bundled-workspace` |

For each record:

1. Inspect the private source material and linked merged commit.
2. In isolated temporary worktrees, run the focused failing command at the
   recorded base commit and the passing command at the source commit.
3. Author a minimal repo-relative failure/fix/command trio and a concise,
   reusable synthesis.
4. Use a unique full
   `https://github.com/Jinn-Network/mono/commit/<40-sha>` source URL.
5. Set `origin: operator-recorded-session`, a completed
   `tests-passed`/`evaluator-verified` outcome, and
   `retrieval:visible.v1`.
6. Include `mono` and specific subsystem vocabulary in the tags.
7. Remove usernames, emails, credentials, private URLs, absolute home paths,
   and unnecessary transcript content.

Do not fabricate historical output. If a historical environment cannot be
re-performed faithfully, withhold that record and curate a replacement before
approval. Do not include skill-distillation material in this launch.

## 3. Audit the complete private batch

```bash
set -o pipefail
corepack yarn --cwd client stage2:validate-curated-seeds --episodes-dir \
  "$HOME/.jinn-client/local-corpus/launch-15" \
  --repo Jinn-Network/mono --json \
  | tee /tmp/stage2-mono-launch-15-audit.json
```

Require:

- `automatedStatus: "pass"`;
- `recordCount: 15` and `eligibleRecordCount: 15`;
- every record has `automatedStatus: "pass"`;
- `humanCurationRequired: true`;
- `publishAuthorized: false`; and
- `liveProbe.status: "not-run"`.

The checked-in negative control must still exit `1`:

```bash
corepack yarn --cwd client stage2:validate-curated-seeds --episodes-dir \
  "$PWD/packages/layer/fixtures/stage1-seeds" --json
```

After the mechanical pass, manually review every final file for accuracy,
usefulness, minimality, and privacy. All 15 must receive human approval before
Wave 1 is published.

## 4. Back up publication state

The state file is needed for idempotency and `supersedes` attribution. Never
replace it with an empty file before publishing.

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

Keep the backup until all three waves and the clean-Hermes verification are
complete. If any publication may have succeeded, do not roll the state file
backward.

## 5. Plan and approve three waves

Copy the already approved files into three private wave directories, five per
directory. Do not edit their content while splitting the batch.

For each wave, generate a fresh read-only layer report:

```bash
"$JINN_LAYER_BIN" seed plan \
  --episodes-dir "$HOME/.jinn-client/local-corpus/launch-15/wave-1" \
  --out /tmp/stage2-mono-wave-1-plan.json
```

Repeat with `wave-2` and `wave-3`. Confirm that each report has exactly five
`import` rows and that its IDs and digests match the approved files. Record
explicit human approval of each immutable report. Any subsequent edit requires
a fresh full audit, wave plan, and approval.

## 6. Preview, publish, and gate each wave

The preview derives the real operator identity but performs no IPFS, RPC,
chain, ledger, or seed-state writes:

```bash
corepack yarn --cwd client stage2:publish-curated-seeds \
  --episodes-dir "$HOME/.jinn-client/local-corpus/launch-15/wave-1" \
  --report /tmp/stage2-mono-wave-1-plan.json \
  --json
```

Verify chain `84532`, Safe, agent address, agent ID, five record IDs, and all
digests. The private key and password are never printed.

Only after that exact preview is approved, execute:

```bash
corepack yarn --cwd client stage2:publish-curated-seeds \
  --episodes-dir "$HOME/.jinn-client/local-corpus/launch-15/wave-1" \
  --report /tmp/stage2-mono-wave-1-plan.json \
  --json --yes
```

For scripted password input, add `--password-fd <n>`. Password resolution is:
explicit file descriptor, `JINN_PASSWORD`, the operator password file, then a
fail-closed error.

Require five imports and zero errors. Re-run the same command once and require
zero imports plus five unchanged skips. Then:

1. Fetch and validate every returned CID, signed episode envelope, artifact,
   attribution, and scrub result.
2. Reconcile every anchor transaction.
3. Run the public probe and stock Hermes doctor.
4. Test a clean Hermes home with a normal question relevant to the wave.

Proceed to the next wave only after the current wave is fully green. Stop on a
failed row, unexpected identity, digest mismatch, state/ledger warning,
partial result, or ambiguous transaction.

The standalone command remains intentionally parked:

```bash
"$JINN_LAYER_BIN" seed execute /tmp/stage2-mono-wave-1-plan.json \
  --episodes-dir "$HOME/.jinn-client/local-corpus/launch-15/wave-1"
```

It must reject execution because no authorized client publish adapter was
injected.

## 7. Verify the public cold-start experience

After all three waves:

```bash
set -o pipefail
"$JINN_LAYER_BIN" corpus probe "Jinn-Network/mono" --json \
  | tee /tmp/stage2-mono-corpus-probe.json
```

Require `corpus-reachable.ok` and `corpus-content.ok`, with at least 15 newly
published retrieval-visible mono records fetchable from the public corpus.

From a stock Hermes installation with an empty local episode directory and the
released Jinn plugin enabled:

- ask a natural plugin/newcomer question;
- ask a daemon/operator reliability question;
- ask an evaluator/CI question; and
- ask one unrelated negative-control question.

Verify that relevant questions automatically receive correctly attributed
public evidence without a slash command, while the unrelated question does not
receive irrelevant corpus context. Preserve scrubbed transcripts, timestamps,
the plugin/layer versions, retrieved envelope refs, and the usefulness
judgment.

Only after this live proof is green should the plugin README be refreshed with
the verified cold-start journey.

## 8. Evidence and recovery

Record on #2010:

- the candidate commit and tool versions;
- the complete audit result and 15 approved digests;
- each wave's import/skip result, CIDs, and anchor transactions;
- fetched-envelope and scrub verification;
- the live layer probe and stock-doctor results; and
- scrubbed clean-Hermes retrieval evidence.

Records are immutable. Correct an unsafe or inaccurate record by publishing a
reviewed superseding record with the same stable identity. To demote it,
remove the retrieval mark from the corrected episode and use the normal
approved seed plan/execution lane; the curated auditor will intentionally
reject that unmarked correction. Verify that read-time supersede collapse no
longer admits the old marked version. Never claim deletion or edit an already
published envelope.
