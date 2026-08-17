# SWE-rebench v2 Public Testnet Runbook

**Audience:** operators joining the canonical SWE-rebench v2 SolverNet, and
release managers proving the app flow before a public testnet release.

**Canonical surface:** the dashboard app. CLI commands are acceptable for
diagnostics, but the release path must be visible and operable through
`/operator` and `/launcher/launched/:id`.

## Preconditions

1. Run the daemon on Base Sepolia and open the dashboard from the daemon URL.
2. Confirm the canonical launched SWE-rebench v2 SolverNet is indexed in
   Discover. Joined SolverNets must not remain in Discover after joining.
3. Confirm the operator has enough ETH runway in the agent EOA and launcher
   Safe for claim, delivery, verdict, and settlement transactions.
4. Solver joins default to **Hermes Agent** (`hermes-agent`). Operators may
   switch to Claude Code (`claude-code`) or Codex (`codex`) when intentionally
   running a Claude- or Codex-backed solver instead. Do not select disabled
   harnesses or models.

Hermes Agent is a self-improving agent by Nous Research with its own learning
loop (skill self-improvement, MEMORY/USER curation, FTS5 session search),
supporting 200+ models via OpenRouter plus additional providers (Nous Portal,
NVIDIA NIM, Xiaomi MiMo, GLM, Kimi, etc.). Because it is the default solver
harness, every operator joining as a solver needs Hermes installed. Install via
the Hermes one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
hermes model     # interactive provider + model picker
hermes doctor    # verify install
```

The daemon's `/operator` join flow runs a `hermes doctor` precheck before
allowing the join to save (when the Hermes Agent harness is selected — the
default). If `hermes doctor` reports issues, the dashboard surfaces the install
one-liner or the missing-config diagnostic with retry. The dashboard pins
`anthropic/claude-opus-4.6` as the default Hermes model (routed via OpenRouter);
operators can pick another from the model dropdown, or leave the join's `model`
field unset to inherit whatever they configured via `hermes model`.

Hermes's own learning loop drives orchestration — the Jinn-side seven-phase
`learner` plugin is not loaded for Hermes operators. SolverPlugins
(`network-tools`, `swe-rebench-v2-runtime`) are mounted via Hermes's native
MCP and skill loading. The freeze contract is enforced by daemon hash-fence
on `HERMES_HOME = ctx.implStateDir`; no Hermes-internal changes required.

For HarnessCheckpoint publication: Hermes operators must record the
`hermesGitSha` of their `$HERMES_HOME/hermes-agent/` clone in the checkpoint
manifest (the published version) because `hermes update` does not currently
support a `--version` flag. Forking operators check out that SHA before
restore.

## Join As Solver Or Evaluator

1. Open `/operator`.
2. In Discover, choose the canonical SWE-rebench v2 row.
3. Select the role:
   - Solver: `solver`
   - Evaluator: `evaluator`
   - Both: `solver` and `evaluator`
4. For the solver role, review the supported harness and model. Hermes Agent is
   the default. The SWE-rebench v2 runtime plugin is default-included and may
   be removed only after the app warning.
5. Save the join. The app should show a restart-required state; restart the
   daemon and verify the joined row appears only in the joined list.

Evaluator harness selection is derived from the SolverNet contract, not chosen
by the operator. Evaluator operators must still have Docker available before
taking real evaluator work. The evaluator applies submitted patches and runs
the upstream SWE-rebench v2 test suite in Docker.

## Configure The Launcher

1. Open `/launcher/launched/:id` for the canonical SWE-rebench v2 launch.
2. Confirm the contract identity is `swe-rebench-v2.v1`.
3. Review generator settings:
   - `N_target_successes`: successful verdicts required before a task is
     saturated.
   - `N_max_postings_per_task`: hard post cap for a task.
   - `cooldown_ms`: delay before reposting the same task.
   - Claim policy: max claims, max claims per operator, and lease TTL.
4. Confirm the spend/runway view uses the launched SolverNet prices and the
   current launcher Safe balance.
5. Keep task posting enabled only when the above values are intentional.

## Verify Generated Tasks

On `/launcher/launched/:id`, the task table is the release source of truth.
For a live proof, capture at least one generated task row moving through:

1. Open: the task is posted with a task CID and claim capacity.
2. Claims in flight: at least one operator claim is visible.
3. Fully claimed or settled: claim counts and state match the claim policy.
4. Settled: solution and verdict evidence exist for the same task.

The row should show clear task terminology. Avoid mixing task, work item, and
attempt labels for the same object.

## Data Donation Status

Open `/operator#data-market`. The section is named **Data donation**.

Donation mode means newly produced solver and evaluator artifacts are:

1. scrubbed for credentials, local paths, identity-bearing fields, and
   machine-specific metadata;
2. pinned to IPFS;
3. advertised in signed envelopes as donated sources;
4. discoverable and retrievable by other operators.

The public testnet app intentionally uses free IPFS donation. Full paid price
configuration, access policy, and optional direct operator endpoints are the
intended data-market architecture, but they are not required for this release.
The app should preview that future architecture without presenting pricing or
public endpoints as setup gates.

Current release path:

1. **Donate now:** scrubbed execution artifacts are pinned to IPFS.
2. **Discover now:** signed metadata advertises CIDs and expected hashes.
3. **Consume now:** peers retrieve from IPFS and verify bytes before reuse.
4. **Later:** paid pricing, access policy, and optional direct endpoint fallback.

## Consume Donated Data

The app-backed solver/evaluator flow must be able to consume donated data from
another operator without a CLI-only workaround:

1. Operator A runs with donation mode enabled and produces artifacts.
2. Operator B runs a solver or evaluator on SWE-rebench v2.
3. Operator B discovers envelopes through Network Tools
   (`search_records` or `inspect_record`) using canonical on-chain ERC-8004
   metadata plus IPFS. A subgraph may accelerate this query, but it is not the
   required correctness path.
4. `acquire_artifact` receives the donated IPFS `sources` from the envelope and
   retrieves the artifact by CID.
5. The artifact is mirrored into Operator B's network artifact cache with IPFS
   provenance.
6. Operator B's learner-facing MCP path reuses that cached artifact after the
   initial acquisition.
7. Operator B continues through a real SWE solve/evaluate loop after the
   donated artifact is available locally.
8. Missing, invalid, or hash-mismatched sources return actionable failure
   messages instead of silently falling back.

Do not treat a missing `operator.publicEndpoint` as a donation failure. Direct
HTTP endpoints are future/fallback plumbing for this release; IPFS donation is
the public transport that must work.

## Acceptance Gates

Run these on the release branch before PR or canary:

```bash
cd operator
yarn typecheck
yarn vitest run \
  test/config.test.ts \
  test/api/operator-artifacts-endpoint.test.ts \
  test/harnesses/engine/packaging-donation.test.ts \
  test/harnesses/engine/artifact-scrub.test.ts \
  test/trajectory/processors/path-scrub.test.ts \
  test/trajectory/emit.test.ts \
  test/mcp/search-records-corpus.test.ts \
  test/mcp/acquire-artifact-fast-path.test.ts \
  test/api/daemon-api-auth.test.ts \
  test/smoke/donation-ipfs-http-smoke.test.ts \
  test/solver-types/swe-rebench-v2-auto.test.ts \
  test/e2e/swe-rebench-v2.test.ts \
  test/adapters/mech/safe-revert.test.ts \
  test/tx-retry.test.ts \
  test/adapters/mech/contracts.test.ts \
  test/harnesses/impls/claude-code-learner/codex-code-adapter.test.ts \
  test/harnesses/impls/claude-code-learner/swe-rebench-v2-roundtrip.test.ts \
  test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts \
  test/harnesses/impls/hermes-agent \
  test/api/hermes-doctor-endpoint.test.ts
yarn build
yarn release:donation-consumption --producer-handshake-key <daemon-handshake-key>
```

The corpus integration suite (`vitest run test/corpus`) and the donation smoke
suites are mocked/fast-path coverage. They are useful diagnostics, but they are
not the release proof for public donation mode. The release-blocking proof is
`yarn release:donation-consumption` with fresh two-operator evidence from the
canonical on-chain/IPFS path.
The producer daemon prints the handshake key on startup; the gate uses it only
to read the UI-protected producer artifact inventory.
For the broader `yarn release:client --prepare` gate on `main`, export
`JINN_DONATION_PRODUCER_HANDSHAKE_KEY` or
`JINN_DONATION_PRODUCER_UI_TOKEN` before starting the release script.

Then browser-verify a fresh daemon/dashboard session:

1. `/operator`: Discover, join, joined list, Data donation, loading, empty,
   error, and permission states.
2. `/operator/execution-data`: local donated execution data, peer donated data,
   redaction, and loading, empty, error, and permission states.
3. `/launcher/launched/:id`: generator status, task rows, claim counts, state
   transitions, spend, and runway.
4. Donation consumption: cross-operator donated artifact retrieval through
   Network Tools/MCP, network-artifact caching, and the real SWE solve/evaluate
   loop.

## Evidence To Retain

Keep the evidence with the release notes:

1. command outputs for the acceptance gates above;
2. screenshots of `/operator`, `/operator/execution-data`, and
   `/launcher/launched/:id`;
3. task IDs, task CIDs, claim counts, solution/verdict envelope CIDs, and
   settlement transaction hashes for the live proof;
4. a redacted donated artifact envelope showing IPFS sources;
5. a redacted acquired artifact cache row from a different operator.

Do not open the PR or create a canary release until the live SWE-rebench v2
solve/evaluate loop and donated-data consumption proof both pass.
