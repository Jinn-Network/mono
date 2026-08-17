# SWE-rebench v2 Testnet Acceptance Gate

This is the release-manager gate before opening a public-release PR or creating
a canary for `@jinn-network/operator`.

The canonical gate is app-first. CLI and Docker commands are still useful for
setup and diagnostics, but they are not sufficient by themselves: the release
must be proven through the operator console flow documented in
[`docs/runbooks/swe-rebench-v2-public-testnet.md`](../docs/runbooks/swe-rebench-v2-public-testnet.md).

## Required Local Gates

Run from `operator/` on the exact release branch:

```bash
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
  test/harnesses/impls/learner/codex-code-adapter.test.ts \
  test/harnesses/impls/learner/swe-rebench-v2-roundtrip.test.ts \
  test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts
yarn build
yarn release:olas-rails-smoke
```

Do not remove tests or lower assertions to pass this gate. If a test exposes a
real mismatch in the public flow, fix the implementation or explicitly hold the
release.

`vitest run test/smoke/donation-ipfs-http-smoke.test.ts` (and the corpus
integration suite, `vitest run test/corpus`) remain fast mocked/smoke checks. They do not replace `yarn release:olas-rails-smoke --execute`, which is the
release-blocking proof that the tokenless OLAS rails smoke harness can complete a
prediction.v1 loop on Base Sepolia and claim staking rewards.

## Required Browser Gates

Start a fresh daemon/dashboard session from the built app, then verify:

1. `/operator`
   - SWE-rebench v2 is visible in Discover when unjoined.
   - Joining as solver offers only supported harness/model choices and
     default-includes Network Tools and the learner plugin; the SWE-rebench v2
     runtime is recommended and removable only after a warning.
   - Joining as evaluator does not expose a solver-harness choice; evaluator
     dispatch is derived from the SolverNet contract.
   - Joined SolverNets no longer appear in Discover.
   - Data donation briefly explains the IPFS-first free donation flow, shows
     local and peer execution-data status, links to the execution-data review
     page, and has clear loading, empty, error, and permission states.
   - Public endpoint and paid pricing controls are not presented as required
     for this release; they may appear only as future/fallback architecture.
2. `/operator/execution-data`
   - Donated execution data is visible without exposing secrets, local paths,
     identity-bearing host metadata, or unsupported paid endpoint controls.
   - Peer donated data and local donated data have clear empty, loading,
     error, and permission states.
3. `/launcher/launched/:id`
   - The launched record is `swe-rebench-v2.v1`.
   - Generated task rows are visible.
   - Claim counts, claim caps, state transitions, spend, and runway are
     accurate.
   - No stale Prediction wording appears in the SWE flow.

Retain screenshots or browser recordings for the release evidence.

## Required Live Proof

The release is not ready until the live or canary-dry-run proof shows:

1. The launched SWE-rebench v2 generator posts real tasks.
2. At least one operator can claim and solve a generated task using the default
   `claude-code-learner` path. Codex-backed solving remains an optional
   explicit harness choice.
3. At least one evaluator can evaluate a generated solution.
4. The launcher task row moves through the expected states and settlement
   evidence is visible.
5. Spend/runway values match the launched SolverNet prices and current Safe
   balance.
6. Donated solver/evaluator artifacts are scrubbed, pinned to IPFS,
   advertised in envelopes with artifact and trajectory IPFS sources plus
   expected hashes, discovered by another operator, verified, acquired through
   Network Tools/MCP, cached as `network_artifacts`, and followed by a real
   SWE solve/evaluate loop.
   The subgraph may accelerate discovery, but on-chain ERC-8004 metadata plus
   IPFS must be sufficient for release proof.

Run the live OLAS rails proof with:

```bash
yarn release:olas-rails-smoke --execute
```

Release mode requires fresh evidence created after the command starts.
See [docs/runbooks/sepolia-olas-rails-smoke.md](../docs/runbooks/sepolia-olas-rails-smoke.md)
for config, funding, and evidence expectations.

When running the broader `yarn release:client --prepare` gate on `main`, the nested
`release:olas-rails-smoke` step runs in dry-run mode (no live chain interaction).

Record task IDs, settlement transaction hashes, and the evidence directory under
`.local/olas-rails-smoke/`.

## Donation And Scrubbing Gate

Before pinning or sharing any sample payload, manually inspect the redacted
payload and the signed envelope projection. The payload must not include:

- secrets or tokens;
- local filesystem paths;
- hostnames, usernames, email addresses, or machine-specific identifiers;
- raw private key material;
- unsupported model/harness settings presented as valid choices.

Automated coverage must include artifact discovery, permission handling,
retrieval, IPFS source propagation, hash mismatch failures, and human-readable
failure messaging.

Missing `operator.publicEndpoint` is not a blocker for the public testnet
donation path. Donation mode must use IPFS as the public artifact transport.
The Graph/Subgraph endpoints are optional accelerators, not the correctness
root for the release gate.
IPFS pinning, hash verification, or scrubbing failures are blockers.

## Docker Acceptance

The Docker acceptance scripts remain useful for packaging and daemon
diagnostics:

```bash
yarn setup:testnet-acceptance-operator --bootstrap
yarn release:testnet-acceptance
```

They do not replace the app-first SWE-rebench v2 and donation live proof above.
When used for release evidence, include the Docker evidence directory alongside
the app/browser/live-proof evidence.

One-time Docker auth still uses a local Claude token:

```bash
claude setup-token
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >> .env.acceptance
```

Do not paste Claude OAuth tokens into chat, issue trackers, release notes, or
PR descriptions.

## Release Decision

Do not open the PR or create a canary until all local gates, browser gates, and
the live SWE-rebench v2 plus donated-data consumption proof pass.
