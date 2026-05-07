# Jinn subgraph

Jinn-specific subgraph that indexes the deployed ERC-8004 registries and the
Jinn router, then synthesises a queryable `Operator` + `Execution` shape. See
the decision record at
[`docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md`](../docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md)
for the entity model that drives this schema.

## Layout

```
subgraph.yaml          per-dataSource manifest, default network: base-sepolia
schema.graphql         entities: Operator, Execution, Validation, Feedback,
                       FeedbackResponse, MetadataEntry, URIUpdate, RouterJob,
                       Task, TaskAttempt, Verdict, SolverNetManifestEvent
networks.json          per-network addresses + start blocks (see "Networks")
abis/                  real ABIs:
  IdentityRegistry.json
  ValidationRegistry.json
  ReputationRegistry.json
  JinnRouter.json (Phase 1 createRestoration/Evaluation + claimDelivery)
  TaskCoordinator.json (V3 task lifecycle — claim/submit/verdict/finalize)
  JinnRouterV3.json (V3 router — task creation, mech routing, refunds)
src/utils.ts           shared helpers — payload decoding, id construction,
                       manifest-ref parsing, V3 task ids,
                       SolverNet manifest key parsing
src/handlers/
  identity.ts          Registered, MetadataSet, URIUpdated
                       (also emits SolverNetManifestEvent rows for
                        `solvernet-manifest:<cid>` keys)
  validation.ts        ValidationRequest, ValidationResponse
  reputation.ts        NewFeedback, FeedbackRevoked, ResponseAppended
  router.ts            RestorationJobCreated, EvaluationJobCreated,
                       DeliveryClaimed
  task-coordinator.ts  V3 TaskCoordinator: TaskCreated, TaskClaimed,
                       TaskAttemptRequestRegistered, TaskSubmitted,
                       EvaluationClaimed, VerdictRequestRegistered,
                       VerdictDelivered, AttemptFinalized,
                       TaskCreationCreditLocked, TaskAttemptExpired
  jinn-router-v3.ts    V3 router: TaskCreated (with budget), TaskAttemptCreated,
                       EvaluationAttemptCreated, SolutionDeliveryClaimed,
                       VerdictDeliveryClaimed, TaskBudgetRefunded
```

## Networks

| Network        | Identity Registry                            | Validation Registry                          | Reputation Registry                          | JinnRouter                                   |
|----------------|----------------------------------------------|----------------------------------------------|----------------------------------------------|----------------------------------------------|
| base-sepolia   | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x7c502a4288C4f4279edbb363d692f530200e22dC` |
| base           | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0xfFa7118A3D820cd4E820010837D65FAfF463181B` |
| sepolia        | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | _(no router on L1)_                          |
| mainnet        | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | _(no router on L1)_                          |

ERC-8004 vanity addresses come from
`erc-8004/erc-8004-contracts/scripts/addresses.ts` (commit
`0463311…cf97`). Testnet uses MinimalUUPS v0.0.1; mainnet uses
MinimalUUPSMainnet v1.0.0. JinnRouter testnet address comes from
`contracts/deployment-phase1b-router-checker-baseSepolia-fast.json`
(`jinnRouterProxy`); mainnet address from `client/src/earning/contracts.ts`.

Start blocks are conservative placeholders set near the registry deployment
window. **Tighten them before deploying** — the graph-node will scan from the
configured block forwards, so picking a block at or just before the first
expected event minimises sync time. Replace once we have first-event blocks
in hand.

## Build

```bash
cd subgraph
yarn install
yarn codegen        # generates AssemblyScript types from ABIs + schema
yarn build          # compiles handlers to wasm and validates the manifest
```

Per-network builds substitute addresses + start blocks from
`networks.json`:

```bash
yarn build:base-sepolia
yarn build:base
```

## Decoding assumptions

The `MetadataSet` handler (`src/handlers/identity.ts`) dispatches on the
metadata key prefix:

- `envelope:<cid>`, `evaluation:<cid>`, `intent:<cid>`, `license:<cid>` →
  `Execution` row, payload decoded as the **provisional** v1 tuple:

  ```
  (uint8 version, uint8 tier, bytes32 manifestHash,
   bytes attestationQuoteCid, bytes32 sourceMeasurement)
  ```

  Decoder requires `version == 1` and `tier ∈ 0..4`. On any decode failure the
  row falls back to `payloadDecoded=false` + `tier=UNKNOWN`, raw bytes are
  preserved on `Execution.payloadBytes`. Re-publishes of the same metadata
  key overwrite the row in place.

- `agentWallet` → reserved, written to `Operator.agentWallet`.

- Anything else → `MetadataEntry { metadataKey, metadataValue, … }`. Lets us
  see new keys without shipping a new subgraph.

The exact byte layout is **deferred** to the canonical commitment payload
spec (Beads `jinn-mono-g7h`). The decoder in `src/utils.ts/decodeExecutionPayload`
is tagged so it can be swapped cleanly when that spec lands.

`Validation.execution` and `Feedback.execution` are best-effort joins. The
former joins on `requestHash == manifestHash` (DR §4.4: `requestHash =
manifest.evidenceHash`). The latter parses the manifest reference out of
`feedbackURI` / `tag2` (recognised forms: `manifest:<cid>`, `ipfs://<cid>`,
bare `bafy…` / `Qm…` CID; or a `0x`-prefixed bytes32 manifestHash for direct
lookup). Consumers can also join on `Feedback.manifestRef ==
Execution.manifestCid` at query time when the heuristic misses.

## Open questions / assumptions

- **Provisional payload tuple.** Aligned with Beads `jinn-mono-g7h`; see
  `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md`.
  When the canonical spec lands, swap the decoder in `src/utils.ts` and
  re-run `yarn codegen && yarn build`.
- **Start blocks.** Placeholders. Tighten once first registry events are
  observed on each chain.
- **Mainnet JinnRouter.** Currently set to `0xfFa7118…0181B` (Phase 0
  deployment). When Phase 1b mainnet deploys, swap the address.
- **`evidenceHash` arg on V2 `claimDelivery`.** Phase 1b V2 has signature
  `claimDelivery(bytes32 requestId, bytes32 evidenceHash)` but emits the
  same `DeliveryClaimed(claimer, requestId, jobType)` event — the
  evidenceHash is consumed by JinnRouter and not re-emitted. The DR (§4.4)
  treats `evidenceHash` as the `requestHash` filed against
  `ValidationRegistry`, which we index directly. No subgraph change needed
  to track the hash itself.
- **Live event sample.** Not verified on chain at build time — addresses
  and signatures come from the canonical reference repo and the deployment
  artifacts. First testnet deployment of an envelope publish should be
  cross-checked against `Operator.agentURI` + `Execution.manifestCid`.

## V3 task lifecycle and SolverNet manifest events

The V3 datasources (`TaskCoordinator` + `JinnRouterV3`) cover the post-Phase 1b
task primitive — see `contracts/src/tasks/TaskCoordinator.sol` and
`contracts/src/staking/JinnRouterV3.sol`. Both emit paired events for every
state transition; the subgraph load-or-creates entity rows keyed by composite
ids (`<taskId>` for `Task`, `<taskId>-<attemptIndex>` for `TaskAttempt`,
`<taskId>-<attemptIndex>-<verdictIndex>` for `Verdict`) so events can arrive
in either order.

Authoritative split:
- **TaskCoordinator** is the source of truth for state machine transitions
  (claimed → submitted → finalized; verdict claimed → delivered) and for the
  manifest digest + deadline fields on the task.
- **JinnRouterV3** carries the JINN budgets (`solutionBudget`,
  `verdictBudget`), mech routing details, and the on-chain `requestId`s pinned
  to each attempt / verdict.

The base-sepolia addresses come from
`contracts/deployment-task-coordinator-router-v3-baseSepolia-fast.json`:

| Component         | Address                                      |
|-------------------|----------------------------------------------|
| TaskCoordinator   | `0x9ce736d3CB367cC5Db538B7962bdf416EbD7451B` |
| JinnRouterV3      | `0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9` |

Mainnet addresses are not yet wired into `networks.json` — V3 has not been
deployed to base mainnet at the time of this writing.

`SolverNetManifestEvent` rows are produced by the existing `IdentityRegistry`
datasource. Whenever a launcher writes
`setMetadata(agentId, "solvernet-manifest:<cid>", payload)` on its operator
NFT, the handler emits an immutable per-write row keyed by `<txHash>-<logIndex>`.
Latest-state lookups still use the `MetadataEntry` row for the same key; the
manifest event entity preserves the full append history. This is the data
that powers `api.solvernets.listRegistry` (operator catalog) and the
launched-record-aware claim eligibility filter.
