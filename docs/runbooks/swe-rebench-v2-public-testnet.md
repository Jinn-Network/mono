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
4. Solver joins default to Claude Code (`claude-code-learner`). Operators may
   switch to Codex (`codex-code-learner`) when intentionally running a
   Codex-backed solver. Do not select disabled harnesses or models.

## Join As Solver Or Evaluator

1. Open `/operator`.
2. In Discover, choose the canonical SWE-rebench v2 row.
3. Select the role:
   - Solver: `solver`
   - Evaluator: `evaluator`
   - Both: `solver` and `evaluator`
4. For the solver role, review the supported harness and model. Claude Code is
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
   (`search_records` or `inspect_record`).
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
cd client
yarn typecheck
yarn vitest run \
  src/dashboard/spa/src/pages/Launcher.test.tsx \
  src/dashboard/spa/src/pages/LauncherCreate.test.tsx \
  src/dashboard/spa/src/pages/LauncherLaunched.test.tsx \
  src/dashboard/spa/src/pages/launcher-create \
  src/dashboard/spa/src/pages/launcher-launched \
  src/dashboard/spa/src/pages/operator-catalog \
  src/dashboard/spa/src/pages/operator/OperatorDataMarket.test.tsx \
  src/dashboard/spa/src/captures/CapturesTab.test.tsx \
  test/config.test.ts \
  test/api/operator-artifacts-endpoint.test.ts \
  test/harnesses/engine/packaging-donation.test.ts \
  test/harnesses/engine/artifact-scrub.test.ts \
  test/trajectory/processors/path-scrub.test.ts \
  test/trajectory/emit.test.ts \
  test/mcp/search-records-corpus.test.ts \
  test/mcp/acquire-artifact-fast-path.test.ts \
  test/api/daemon-api-auth.test.ts \
  test/smoke/donation-mode-smoke.test.ts \
  test/solver-types/swe-rebench-v2-auto.test.ts \
  test/e2e/swe-rebench-v2.test.ts \
  test/adapters/mech/safe-revert.test.ts \
  test/tx-retry.test.ts \
  test/adapters/mech/contracts.test.ts \
  test/harnesses/impls/claude-code-learner/codex-code-adapter.test.ts \
  test/harnesses/impls/claude-code-learner/swe-rebench-v2-roundtrip.test.ts \
  test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts
yarn build
yarn release:donation-consumption --producer-handshake-key <daemon-handshake-key>
```

`yarn corpus:e2e` and the donation smoke suites are mocked/fast-path coverage.
They are useful diagnostics, but they are not the release proof for public
donation mode. The release-blocking proof is `yarn release:donation-consumption`
with fresh two-operator evidence.
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
