# Phase B Native Vertical — Base Sepolia Runbook

## Status and safety boundary

This is the operational contract for the Phase B requester, solver, evaluator, and independent
consumer proof on **Base Sepolia only**. It is not evidence that a live run has happened.

At the repository head that introduced this runbook:

- the accepted command is production-wired; without `--execute` it performs only the read-only
  readiness check and does not load role keys, construct a transaction, or post a task;
- execution additionally requires `JINN_NATIVE_VERTICAL_EXECUTE=1` and `JINN_PASSWORD`; the
  requester host remains alive to serve its signed public source until SIGINT/SIGTERM;
- no live Base Sepolia transaction or closure run was performed while writing this runbook;
- Base Sepolia must not default to `native-v1` until a separately captured, validated live closure
  receipt proves both finalized settlements and the public consumer report;
- Base mainnet (chain ID `8453`) remains prohibited.

Never interpret a local/fork test, a readiness envelope, an unsigned manifest, or this document as
the live Phase B closure artifact.

## Accepted request command

The one accepted requester invocation is:

```bash
jinn native-vertical request \
  --network base-sepolia \
  --fixture prediction-forecast-golden.json \
  --run-id <unique-run-id>
```

`<unique-run-id>` must be new for a new sealed Submission identity. Repeating an already sealed run
ID must recover or return the prior durable posting outcome; it must never mint another logical post.
Run it without `--execute` first and archive the readiness envelope. Do not bypass a refusal by
populating a database, calling a product-internal function, or broadcasting equivalent calldata
manually. The separately authorized live form is:

```bash
JINN_NATIVE_VERTICAL_EXECUTE=1 JINN_PASSWORD='<from-approved-secret-source>' \
  jinn native-vertical request \
  --network base-sepolia \
  --fixture prediction-forecast-golden.json \
  --run-id <unique-run-id> \
  --execute
```

## Fixed network contract

Every role uses this exact deployment:

| Field | Required value |
|---|---|
| Network | Base Sepolia |
| `eth_chainId` | `0x14a34` (`84532`) |
| Generation | `today` |
| Task Coordinator | `0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98` |
| Jinn Router | `0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247` |
| Mech Marketplace | `0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7` |
| Activity checker | `0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70` |
| Explorer | `https://sepolia.basescan.org` |

Address comparison is byte-for-byte after normalizing hexadecimal case. Any different chain ID,
generation, address, or empty contract code aborts the run. In particular, `JINN_ENABLE_MAINNET=1`
does not authorize chain ID `8453`.

## Preflight: complete before loading keys

Preflight is a strict fence. Steps 1–7 use public configuration and read-only RPC calls only. Do not
open an identity store, request `JINN_PASSWORD`, connect a signer, construct Safe calldata, or invoke
a wallet before all seven pass.

1. **Parse public configuration.** Require `network=testnet`, `chainId=84532`, generation `today`,
   all four fixed addresses, isolated absolute state directories, public source URLs, an IPFS API
   URL, finality confirmations, and canonical decimal transaction caps.
2. **Verify the chain.** Call `eth_chainId`; require exactly `0x14a34`. Abort immediately on `8453`
   or any other value.
3. **Verify deployed code.** Call `eth_getCode` at each fixed address at the same canonical block.
   Every response must contain non-empty code. Record the block number/hash used for the check.
4. **Dry-run the operations.** Use `eth_call` and `eth_estimateGas` from the configured requester,
   solver, and evaluator addresses for create task, claim, marketplace delivery, solution claim,
   evaluation claim, and verdict claim. A revert, unknown ABI, wrong destination, or unexpected
   value aborts.
5. **Apply hard caps.** Compare quoted value and maximum fee against the configured canonical-decimal
   caps: `createTaskMaxWei`, `claimMaxWei`, `solutionSettlementMaxWei`,
   `evaluationClaimMaxWei`, `verdictSettlementMaxWei`, and `escrowMaxWei`. There is no interactive
   cap override. Phase B uses `maxClaims=1`, `allowSolverSelfEvaluation=false`, and the smallest
   non-zero solution/verdict rates accepted by the read-only simulation.
6. **Verify funding.** Use `eth_getBalance` at the same canonical block and require, after the cap
   checks:
   - requester Safe: escrow `(solution rate + verdict rate) × 1` plus twice the quoted create-task
     maximum gas;
   - solver account/Safe: twice the quoted aggregate maximum for claim, marketplace delivery, and
     solution claim;
   - evaluator account/Safe: twice the quoted aggregate maximum for evaluation claim, marketplace
     delivery, and verdict claim.
   Funding must be Base Sepolia faucet funds and within the per-run ETH/escrow budget.
7. **Seal a read-only preflight report.** It must state `chainId`, contract-address verification,
   contract-code verification, funding verification, and cap verification without secrets. A false
   or missing field is a hard refusal.

Only after that report passes may each process request its password and open the minimum identity
stores for its own role. Requester and admission custody are distinct. Solver delivery, evaluator
verdict, and all three discovery identities are distinct persistent Ed25519 roles; none is derived
from an EVM secret.

## Isolated state and configuration

Use a unique run root and separate private directories for requester, solver, evaluator, and
consumer. The consumer must not be granted filesystem access to any producer directory.

Required product controls include:

- `operator.verticalMode = "native-v1"` only for an explicitly authorized native run;
- role `requester`, `solver`, or `evaluator` per process;
- `operator.native.chainId = 84532` and generation `today`;
- the exact `operator.native.contracts.*` values above;
- `operator.native.transactionCaps.*` as canonical decimal strings;
- public base URL and trusted discovery source list;
- the Base Sepolia endpoint through structured testnet configuration or `BASE_SEPOLIA_RPC_URL`;
- IPFS API endpoint, finality confirmations, trust-root path, digest-pinned infrastructure bundle,
  and (for the evaluator) a digest-pinned deployment module and signer handle;
- isolated `JINN_STATE_DIR`/configured state path for each role and a consumer-only state path;
- `JINN_NO_UI=1` for every acceptance process.

Secrets belong only in the approved encrypted stores or secret environment variables
(`JINN_PASSWORD` and, if required, `JINN_IPFS_API_TOKEN`). Never put them in logs, configs retained
as evidence, source entries, closure manifests, or support bundles. Treat credentials embedded in a
`BASE_SEPOLIA_RPC_URL` endpoint the same way.

## Startup order

1. Start the approved Kubo/IPFS or pinning endpoint. Prove a raw-CID byte-for-byte round trip.
2. Start solver public evidence/discovery service.
3. Start evaluator public discovery service.
4. Start solver role. Require one worker lease, venue rollback/catch-up, source synchronization,
   backend readiness, evidence readiness, and zero uncertain operations.
5. Start evaluator role. Require distinct evaluator authority, digest-pinned deployment, isolated
   host signer channel, venue/source health, and self-evaluation disabled.
6. Start the independent consumer with public URLs and trust roots only; it may retry the requester
   source until the requester command mounts it.
7. Run the accepted request command only after its read-only readiness passes and the operator has
   authorized the capped Base Sepolia run. The command acquires the requester lease, mounts the
   requester public source, posts, announces, and remains the requester role process.
8. Verify requester well-known, signed head, archive, and exact record paths, then continue until
   both independent settlement operations are finalized and the consumer reaches every signed
   source head and emits a decision-grade verification report.

## Required health before request

Every native role must report:

- mode `native-v1` with native fallback count `0`;
- the expected persistent public role key IDs and effective-time bindings;
- exactly one live worker lease for the scoped role/chain/coordinator/agent;
- signed source-chain continuity, freshness, and source lag `0`;
- canonical block greater than or equal to finalized block and venue caught up;
- backend capability/preflight ready for the prediction or evaluation profile;
- evidence repository/catalog reconciled and ready;
- no broadcast-uncertain or otherwise unreconciled transaction operation;
- no legacy daemon, bridge, TaskEngine, or delivery watcher loaded.

If health regresses before the requester broadcast, abort without side effects. After any broadcast,
stop new work and reconcile the durable operation before deciding whether the run can resume.

## Six mandatory restart drills

Perform the deterministic local/Anvil drill first. For a live closure run, restart only at boundaries
that the release manager has judged safe; never induce a public-testnet reorg. Each drill reuses the
same run ID, operation IDs, exact sealed bytes, source sequence, and transaction reconciliation.

| Checkpoint | Stop after durable evidence | Required recovery proof |
|---|---|---|
| `posting` | Posting intent is durable; inject before broadcast and after wallet invocation before hash persistence | Reconcile canonical `TaskCreated`/Safe nonce history; zero duplicate posts; signed association uses the original Submission and posting terms |
| `claim` | Claim operation intent or uncertain/broadcast transaction is durable | One logical `claimOperationId`; replacement hashes remain attached to it; execution starts only after canonical finality |
| `backend-submit` | Exact Task, Submission, dispatch context, and backend-submit intent are durable | `backend.recover` reports matching; no second Attempt or divergent submit |
| `evidence` | Execution evidence and Delivery are sealed but publication/settlement is incomplete | Every `Delivery.evidenceRecords` digest resolves; publication resumes once; Delivery bytes do not change |
| `solution-settlement` | Solution publication and settlement intent are durable | Receipt/replacement/canonical logs reconcile to one finalized solution operation |
| `verdict-settlement` | Verdict/evaluation Delivery publication and verdict-settlement intent are durable | Decision-grade gate reruns over public bytes; one finalized verdict operation; consumer graph equals uninterrupted run |

For every drill retain the seed, injected boundary, sanitized before/after state summaries, operation
IDs and transaction hashes, source heads, final graph digest, and comparison with the uninterrupted
run. The reports named by the closure manifest must cover exactly these six checkpoint names.

## Public artifact capture

Under the unique run ID, retain a sanitized public evidence bundle containing:

- exact commit and canonical package tarball digests, B9 platform/acceptance manifest digests,
  product digest, and infrastructure-bundle digest;
- public role/agent/key IDs and binding digests for requester submission, admission, requester
  discovery, solver delivery/discovery, and evaluator verdict/discovery;
- requester, solver, and evaluator signed source heads and immutable archive entries;
- exact Task, EvaluationSpec, admission receipt, Submission, requester envelope, solution output,
  solution evidence, solution Delivery/envelope, evaluation Task/Submission/evidence,
  verdict envelope, and evaluation Delivery/envelope digests;
- solution and verdict operation IDs, transaction hashes, block hashes/numbers, finalized status,
  and exact `https://sepolia.basescan.org/tx/<hash>` links;
- all six recovery-report digests;
- the independent consumer report and its digest;
- a sanitized configuration digest, not a producer-private configuration path.

The consumer report must be generated from its own state directory through public discovery,
retrieval, trust, and chain interfaces. It independently verifies exact bytes, signatures,
effective-time bindings, the record graph, canonical requester posting terms (`maxClaims=1` and
self-evaluation false), and both settlements.

**The report has no failure representation by design.** Verification is all-or-nothing: the
consumer either produces a report with `decisionGrade: true`, or it throws and produces no report
at all. There is no partial report, no `decisionGrade: false` value, and no silent pass on a failing
check. The failure signal downstream tooling (and this runbook) must key on is therefore the
**absence** of the report file / a non-zero consumer exit, not a field inside a report -- a report
that exists is, by construction, a pass.

**Scope limit: EOA ceremonies only.** The consumer's trust catalog rejects any role binding whose
only ceremony evidence is a Safe/ERC-1271 witness signature (the production trust catalog wires a
witness verifier that always returns unverified for Safe ceremonies). Every one of the four signing
roles (requester submission, admission, solver delivery, evaluator verdict) must be bound via an
offline-verifiable EOA (SIWE-style) ceremony for this vertical's consumer to reach a decision-grade
report. A role bound only through a Safe ceremony causes the consumer to fail closed, not to skip
that role's check.

Do not retain passwords, private keys, forwarded signer material, tokens, RPC credentials, full
confidential inputs, producer state paths, identity-store paths, trust-root paths, or private DB
contents. The closure manifest is canonical JSON and carries public digests/identities only.

## Completion and explicit non-completion

A run is complete only when both settlement transactions are canonically finalized, every public
source lag is zero, the independent consumer is decision-grade, and the sanitized closure manifest
validates byte-for-byte. Before then, keep the manifest absent and leave the default mode unchanged.
The manifest's `acceptanceCriteria` ids 1–62 are enumerated in
[phase-b-acceptance-criteria.md](phase-b-acceptance-criteria.md); each entry's evidence digests
must point at artifacts proving that specific criterion.

This runbook intentionally records **no live run** and **no default flip**. The manual closure step
must add the actual commit, package digests, transaction links, source heads, recovery reports, and
consumer-report digest from the separately authorized run.

## Rollback to compatibility mode

Rollback is explicit and recoverable:

1. Stop requester submission, solver work, and evaluator work; allow each host to release only its
   own scoped worker lease and close its single venue owner.
2. Preserve all native state directories, role keys, exact records, source archives, operation
   journals, IPFS data, and chain facts. Never delete or reinterpret them as legacy provenance.
3. Reconcile or mark the status of any already-broadcast operation. Rollback does not authorize a
   replacement transaction or cancellation beyond the existing capped operation policy.
4. Set `operator.verticalMode = "legacy"` explicitly in the compatibility product configuration.
5. Restart the legacy product and verify only the compatibility daemon/TaskEngine/watcher estate is
   active. There is no silent native-to-legacy fallback inside a running native process.
6. Record the rollback reason, last canonical block/source heads, nonterminal native operations, and
   the location of the preserved native evidence bundle.

If native mode was never enabled—or the accepted requester command still reports feature-disabled—
there is nothing to roll back. Do not manufacture a closure receipt merely to exercise rollback.

## Local verification commands

These commands are read-only with respect to RPC, wallets, IPFS, and chain state:

```bash
cd client
yarn vitest run \
  test/architecture/native-product-mutation-gate.test.ts \
  test/architecture/phase-b-native-runbook.test.ts
yarn vitest run \
  test/native-requester/requester.test.ts \
  test/native-consumer/graph.test.ts \
  test/native-consumer/verification.test.ts \
  test/native-consumer/public-vertical.test.ts \
  test/daemon/native-recovery-matrix.test.ts
```

Run the full hosted, packed-tarball, Anvil recovery, and domain gates before scheduling the separately
authorized live proof.
