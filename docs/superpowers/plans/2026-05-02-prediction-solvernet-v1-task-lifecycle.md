# Prediction SolverNet v1 Task lifecycle

**Date:** 2026-05-02  
**Status:** Historical — superseded for the canonical-plugin sections by `spec/2026-05-01-harness-pack-architecture.md` v0.9 changelog (2026-05-04), which removed `canonicalPlugin` from the runtime model in favour of layered substrate (auto-injected Network Tools + contract `defaultRuntimePlugins` + operator `plugins[]`). The lifecycle, eligibility, generator, and scoring sections of this plan are still load-bearing for `prediction.v1`; treat references to a "canonical plugin" here as historical decision text describing the model in force on 2026-05-02 and not as current instruction. Prediction SolverNet operational launch is additionally frozen per DR-2026-05-11-a (`log/decisions/2026-05-11-freeze-prediction-solvernet.md`).  
**Primary bead:** `jinn-mono-l2zl.1`  
**Related beads:** `jinn-mono-l2zl`, `jinn-mono-kod`, `jinn-mono-twut`, `jinn-mono-xp33`, `jinn-mono-l2zl.2`, `jinn-mono-l2zl.3`, `jinn-mono-l2zl.4`

## 1. Purpose

This document fixes the shared contract for the first Prediction SolverNet implementation before plugin, generator, evaluator, and dashboard work begins.

The design treats earlier `prediction.v0` Chainlink-threshold work as legacy precedent only. It does not constrain the v1 contract. The active architecture is `spec/2026-05-01-harness-pack-architecture.md`: SolverNet, SolverType, SolverPlugin, Task, Solution, Verdict, Harness, and corpus primitives are used as defined there.

`SPEC.md` and `GLOSSARY.md` are canonical but currently stubs, so this document avoids redefining protocol roles beyond the harness-pack vocabulary.

## 2. Locked decisions

- **SolverType:** `prediction.v1`.
- **SolverNet name:** Prediction.
- **Canonical plugin:** `@jinn-network/prediction-plugin`, declaring `jinn.solverType: "prediction.v1"`.
- **v1 launch scope:** binary externally resolved prediction-market questions.
- **First enabled venue:** Polymarket.
- **Future venue posture:** the SolverType is not venue-specific. Later Kalshi, Manifold, or other adapters can be added if they fit the `prediction.v1` contract.
- **No trading:** Solvers submit probability forecasts only. They do not place orders, hold positions, or manage trading capital.
- **Benchmark:** posted-time market consensus snapshot, stored on the Task.
- **Scoring:** Brier loss, lower is better. Spread is `solverBrier - consensusBrier`; negative means the Solver beat the posted-time market consensus.
- **1-to-many requirement:** `prediction.v1` requires one shared Task claimable by many Solvers. Replicated sibling Tasks are rejected for testnet campaign launch.
- **Data plane:** no Prediction-specific source of truth. Forecasts and Verdicts are envelopes in the corpus. Agent learning and dashboard projections consume corpus/indexed envelope metadata.

## 3. Lifecycle

1. The Task generator polls Polymarket market metadata and orderbook data.
2. Each market is normalized into a candidate and checked against eligibility rules.
3. For every eligible market, the generator creates one forecast round and posts one shared `prediction.v1` Task.
4. Many Solvers claim the same Task under the parallel claim policy.
5. Each Solver submits one Solution envelope with a `solutionPayload.probabilityYes`.
6. The evaluator waits until the market reaches a final Polymarket/UMA resolution.
7. The evaluator validates each Solution, maps the market result to `YES`, `NO`, or `INVALID`, computes Brier loss and spread, and publishes one Verdict envelope per Solution.
8. Future Solvers and dashboards query the corpus/indexer for forecast and Verdict envelopes.

## 4. 1-to-many claiming policy

`prediction.v1` is blocked on `jinn-mono-kod` for launch. The required semantics are:

```text
one eligible market -> one Task -> many Solver attempts -> one Verdict per Solution
```

The minimum policy:

```json
{
  "kind": "parallel",
  "maxClaims": 25,
  "maxClaimsPerSolver": 1,
  "claimWindow": "task-window",
  "selection": "all-valid-solutions-scored",
  "economics": "testnet-flat"
}
```

Rules:

- Claims are parallel, not first-valid-wins.
- Every valid claim may submit one Solution.
- Every valid Solution is evaluated independently.
- There is no v1 winner selection, best-of-K payout, or ranking-layer settlement.
- `maxClaims` is configurable. `25` is the launch default.
- Replicated sibling Tasks may be used in local tests only. They must not be the testnet campaign launch mechanism.

## 5. Market eligibility

The generator should request every eligible market, subject only to network safety caps and deduplication. The goal is not "one Task per week"; that is only a minimum health alert. The desired stream is all clean, eligible weekly-resolution markets.

### 5.1 Hard filters

A Polymarket market is eligible only if all are true:

- It is binary at the launch implementation layer: exactly one YES token and one NO token.
- It is active, tradeable, not closed, not archived, not paused, and not already resolving.
- Expected resolution is at least 24 hours and at most 7 days from Task posting.
- Resolution rules text is present.
- YES/NO mapping is unambiguous.
- The question and rules refer to one externally observable event.
- There is no active dispute, cancellation flag, or unusual clarification history visible to the API.
- The market is not a duplicate or relist of a more canonical/liquid market already posted or eligible.
- A fresh orderbook snapshot is available.
- Benchmark spread is acceptable.

Launch defaults:

```json
{
  "minTimeToResolutionHours": 24,
  "maxTimeToResolutionHours": 168,
  "minLiquidityUsd": "10000",
  "minVolume24hUsd": "2500",
  "maxYesSpread": "0.10",
  "maxOrderbookAgeSeconds": 60
}
```

These defaults are intentionally conservative. They can be tuned by config, but the generator must record the actual eligibility snapshot in every Task.

### 5.2 Clear resolution rules

Jinn trusts Polymarket/UMA final settlement as v1 ground truth. Eligibility filtering exists to avoid bad benchmark Tasks, not to second-guess final settlement.

Automatic accept patterns:

- Sports outcomes with a named league/game and final score source.
- Election outcomes with a named certifying authority or clearly specified Polymarket rule.
- Crypto, weather, or economic-release markets with a specified data source, timestamp, and timezone.
- Any market whose YES condition can be mechanically restated as: "YES iff event X occurs by time Y according to source/rule Z."

Automatic reject patterns:

- Subjective phrases without a named source, such as "significant", "major", "widely considered", "credible reports", "controversial", or "viral".
- Social sentiment or reputation questions.
- Multi-event bundles where partial completion is plausible.
- Questions whose title and rules disagree.
- Markets with rule edits after Task posting.
- Markets with unclear YES/NO token mapping.

Borderline but high-volume markets go to manual review or are skipped. The v1 auto-generator posts only automatic-accept markets.

### 5.3 Deduplication

Primary dedup key:

```text
source.venue + ":" + source.identifiers.conditionId
```

Fallback key if `conditionId` is unavailable:

```text
source.venue + ":" + normalized(slug || question)
```

The generator never posts the same condition twice. For materially duplicate active markets, it selects the most liquid canonical market.

## 6. Task contract

Required top-level Task payload fields:

- `schemaVersion`
- `id`
- `solverType`
- `role`
- `description`
- `window`
- `claimPolicy`
- `spec`
- `creator`
- `createdAt`

`solverType` must be `prediction.v1`. `role` for forecast Tasks is `restoration`.

Required `spec` fields:

- `question.kind`
- `question.text`
- `question.yesLabel`
- `question.noLabel`
- `source.type`
- `source.venue`
- `source.url`
- `source.identifiers`
- `resolution.expectedResolutionTime`
- `resolution.rulesText`
- `resolution.rulesUrl`
- `consensusSnapshot`
- `eligibilitySnapshot`

For the Polymarket launch adapter, `source.identifiers` must include:

- `marketId`
- `conditionId`
- `yesTokenId`
- `noTokenId`

### 6.1 Valid Task example

```json
{
  "schemaVersion": "task.v1",
  "id": "prediction-v1-polymarket-0xabc123-20260502T120000Z",
  "solverType": "prediction.v1",
  "role": "restoration",
  "description": "Forecast a binary externally resolved prediction market.",
  "window": {
    "startTs": 1777723200000,
    "endTs": 1777809600000
  },
  "claimPolicy": {
    "kind": "parallel",
    "maxClaims": 25,
    "maxClaimsPerSolver": 1,
    "claimWindow": "task-window",
    "selection": "all-valid-solutions-scored",
    "economics": "testnet-flat"
  },
  "spec": {
    "question": {
      "kind": "binary",
      "text": "Will the example event resolve YES by May 8, 2026?",
      "yesLabel": "YES",
      "noLabel": "NO"
    },
    "source": {
      "type": "prediction-market",
      "venue": "polymarket",
      "url": "https://polymarket.com/event/example-event",
      "identifiers": {
        "marketId": "123456",
        "conditionId": "0xabc123",
        "yesTokenId": "1111111111111111111111111111111111111111111111111111111111111111",
        "noTokenId": "2222222222222222222222222222222222222222222222222222222222222222"
      }
    },
    "resolution": {
      "expectedResolutionTime": "2026-05-08T00:00:00Z",
      "rulesText": "This market resolves YES if the example event occurs by May 8, 2026 00:00 UTC according to the market's stated resolution source. Otherwise it resolves NO.",
      "rulesUrl": "https://polymarket.com/event/example-event",
      "timezone": "UTC"
    },
    "consensusSnapshot": {
      "sampledAt": "2026-05-02T12:00:00Z",
      "probabilityYes": "0.6200",
      "method": "best-bid-ask-midpoint",
      "bestBidYes": "0.6100",
      "bestAskYes": "0.6300",
      "spread": "0.0200",
      "source": "polymarket-clob"
    },
    "eligibilitySnapshot": {
      "sampledAt": "2026-05-02T12:00:00Z",
      "timeToResolutionHours": 132,
      "liquidityUsd": "18250.00",
      "volume24hUsd": "6700.00",
      "orderbookAgeSeconds": 12,
      "selectionReason": "weekly-binary-liquid-clear-rules"
    }
  },
  "eligibility": {},
  "creator": {
    "safeAddress": "0x0000000000000000000000000000000000000001",
    "agentEoa": "0x0000000000000000000000000000000000000002"
  },
  "createdAt": 1777723200000
}
```

## 7. Consensus snapshot

`consensusSnapshot` is the market's posted-time reference probability. It is not evaluator consensus and not protocol consensus.

For Polymarket v1:

- Sample at Task posting time.
- Use YES best bid / YES best ask midpoint.
- Require fresh orderbook data.
- Require spread no wider than `maxYesSpread`.
- Do not use a stale last-trade fallback for the headline benchmark. If the orderbook cannot provide a clean benchmark, the market is ineligible.

Optional solve-time or close-time market prices may be recorded as diagnostics, but they are not the headline benchmark.

## 8. Solution payload

The Solver submits a full execution envelope. `solutionPayload` is the typed `prediction.v1` answer inside that envelope.

Required fields:

- `probabilityYes`
- `submittedAt`
- `format`
- `modelId`

Optional fields:

- `confidence`
- `methodology`
- `evidenceCids`
- `reasoningCid`
- `sourceRefs`

No hidden chain-of-thought or source references are required in v1.

### 8.1 Valid Solution payload example

```json
{
  "probabilityYes": "0.5700",
  "submittedAt": "2026-05-02T12:34:56Z",
  "format": "decimal",
  "modelId": "claude-code-learner/default",
  "confidence": "medium",
  "methodology": "Compared the posted market consensus with recent source evidence and base rates.",
  "evidenceCids": ["bafy-evidence-1"],
  "sourceRefs": [
    {
      "title": "Market resolution source",
      "url": "https://example.com/source"
    }
  ]
}
```

Validation:

- `probabilityYes` is a decimal string in `[0,1]`.
- `submittedAt` must be inside the Task window.
- `format` must be `decimal`.
- `modelId` must be non-empty.
- Schema validation failure prevents envelope assembly or causes evaluator rejection, depending on where it is detected.

## 9. Resolution and Verdict payload

Evaluation waits for final market resolution. The evaluator does not judge reasoning quality. It verifies identity, timeliness, schema validity, and final outcome, then computes scores.

Verdict enum:

- `SCORED`: valid Solution, market resolved YES/NO, scores emitted.
- `REJECTED`: invalid or late Solution; excluded from Brier aggregates.
- `INVALID`: market cancelled, invalid, ambiguous, duplicate-mismatched, or otherwise final non-scored.
- `INDETERMINATE`: temporary unresolved/evaluator-unavailable state; retry later.

Brier formula:

```text
outcome = 1 for YES, 0 for NO
solverBrier = (solution.probabilityYes - outcome)^2
consensusBrier = (task.consensusSnapshot.probabilityYes - outcome)^2
brierSpread = solverBrier - consensusBrier
```

### 9.1 Valid Verdict payload example

```json
{
  "verdict": "SCORED",
  "outcome": "YES",
  "resolvedAt": "2026-05-08T19:22:10Z",
  "resolutionSource": {
    "venue": "polymarket",
    "url": "https://polymarket.com/event/example-event",
    "marketId": "123456",
    "conditionId": "0xabc123"
  },
  "task": {
    "cid": "bafy-task",
    "id": "prediction-v1-polymarket-0xabc123-20260502T120000Z"
  },
  "solutionEnvelope": {
    "cid": "bafy-solution",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "claimed": {
    "probabilityYes": "0.5700",
    "submittedAt": "2026-05-02T12:34:56Z",
    "modelId": "claude-code-learner/default"
  },
  "benchmark": {
    "probabilityYes": "0.6200",
    "sampledAt": "2026-05-02T12:00:00Z",
    "method": "best-bid-ask-midpoint"
  },
  "scores": {
    "scoreBasis": "brier-loss.v1",
    "solverBrier": "0.184900",
    "consensusBrier": "0.144400",
    "brierSpread": "0.040500"
  },
  "checks": [
    { "name": "solution.schema", "status": "PASS" },
    { "name": "solution.window", "status": "PASS" },
    { "name": "task.identity", "status": "PASS" },
    { "name": "market.resolution", "status": "PASS" }
  ]
}
```

## 10. Polymarket data contract

The design defines normalized data the system needs. Implementation may map these shapes from current Polymarket Gamma/CLOB/UMA-facing APIs.

### 10.1 Shared client functions

The generator and evaluator use a deterministic shared client library:

- `listMarketCandidates(args): Promise<MarketCandidate[]>`
- `getMarket(args): Promise<MarketCandidate>`
- `getOrderbook(args): Promise<OrderbookSnapshot>`
- `getResolution(args): Promise<ResolutionSnapshot>`

The plugin's MCP server wraps the safe Solver-facing subset.

### 10.2 Normalized candidate

```ts
interface MarketCandidate {
  venue: 'polymarket';
  marketId: string;
  conditionId: string;
  slug: string;
  url: string;
  question: string;
  description?: string;
  rulesText: string;
  endTime: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  outcomes: ['YES', 'NO'];
  tokenIds: { yes: string; no: string };
  liquidityUsd: string;
  volume24hUsd: string;
}
```

### 10.3 Normalized orderbook snapshot

```ts
interface OrderbookSnapshot {
  venue: 'polymarket';
  marketId: string;
  conditionId: string;
  sampledAt: string;
  bestBidYes: string;
  bestAskYes: string;
  midpointYes: string;
  spread: string;
  source: 'polymarket-clob';
}
```

### 10.4 Normalized resolution snapshot

```ts
interface ResolutionSnapshot {
  venue: 'polymarket';
  marketId: string;
  conditionId: string;
  status: 'unresolved' | 'resolved' | 'invalid' | 'cancelled' | 'ambiguous';
  outcome?: 'YES' | 'NO';
  resolvedAt?: string;
  sourceUrl: string;
}
```

### 10.5 Solver-facing MCP tools

> **Historical note (2026-05-04):** "Canonical plugin" wording in this section refers to the abandoned single-primary-plugin model removed by `spec/2026-05-01-harness-pack-architecture.md` v0.9. Read it as "the operator-configured prediction runtime plugin." The current model layers Network Tools (auto-injected) + contract `defaultRuntimePlugins` + operator `plugins[]`.

The canonical plugin should expose task-scoped tools first:

- `polymarket_get_market`
- `polymarket_get_orderbook`

Broad search tools are deferred. Solvers should receive the Task market context and may inspect the orderbook; they do not need posting authority or unrestricted market discovery in v1.

The current `client/plugins/jinn-prediction-plugin/mcp/polymarket-server.mjs` should be treated as placeholder substrate to replace or complete.

## 11. Generator rules

Sources:

- Polymarket market metadata/discovery API for candidate markets.
- Polymarket CLOB/orderbook API for benchmark snapshots.
- Polymarket/UMA resolution data for final outcomes.

Cadence and volume:

- Poll every 6 hours.
- Post every eligible market not already deduped.
- Default safety caps: `maxNewRoundsPerPoll = 25`, `maxNewRoundsPerDay = 100`, `maxOpenRounds = 250`.
- If caps bind, select by liquidity descending, then spread ascending, then nearer resolution.
- Emit an alert if fewer than one eligible Task is posted in a week.

Behavior:

- If APIs are unavailable, skip the tick and log structured reasons.
- If no eligible markets exist, post nothing.
- No historical backfill in v1.
- Manual allowlist can force a candidate into review/ranking, but cannot bypass schema, resolution-window, or benchmark-snapshot validation.
- Manual blocklist always wins.

## 12. Corpus and dashboard requirements

Prediction v1 does not introduce a special data plane.

Required metadata for forecast and Verdict envelopes:

- `solverType: "prediction.v1"`
- `role`
- `taskCid`
- `solutionEnvelopeCid` for Verdicts
- `artifactType`
- `source.venue`
- `source.conditionId`
- `source.marketId`
- `question.kind`
- `verdict`
- `scores.solverBrier`
- `scores.consensusBrier`
- `scores.brierSpread`

Operator, Harness, plugin, and runtime attribution should come from the enclosing envelope executor/provenance fields. A materialized dashboard projection may denormalize these fields, but the corpus/indexed envelopes remain the source of truth.

Dashboard headline:

- trailing 84-day mean `brierSpread` across `SCORED` Verdicts.

Dashboard supporting metrics:

- raw solver Brier
- consensus Brier
- weekly trend
- distinct active Solver safe addresses
- distinct forecast rounds
- invalid/rejected/indeterminate rates
- per-operator and per-Harness slices

Agent learning:

- Harnesses query the generic corpus path for `prediction.v1` forecast and Verdict envelopes.
- Ranking prior trajectories by score is Harness logic, not a Prediction-specific protocol query primitive.
- If nested metadata filters are not indexed yet, v1 starts with coarse corpus queries and post-fetch filtering.

## 13. Implementation handoff

### `jinn-mono-kod`

Hard blocker for launch of `jinn-mono-l2zl.3` and `jinn-mono-l2zl.4`.

Deliver the parallel 1-to-many claim policy needed by §4.

### `jinn-mono-l2zl.2`

Implement `@jinn-network/prediction-plugin` for `prediction.v1`:

- JSON Schemas for Task `spec`, Solution payload, and Verdict payload.
- Polymarket MCP server with task-scoped market/orderbook tools.
- Forecasting and Polymarket-specific skills.
- Manifest declares `jinn.solverType: "prediction.v1"`.

### `jinn-mono-l2zl.3`

Implement the Polymarket-derived Task generator:

- shared Polymarket client
- market eligibility filters
- consensus snapshot computation
- dedup state
- one shared Task per eligible forecast round
- no sibling Task launch shim

Blocked by `jinn-mono-kod`.

### `jinn-mono-l2zl.4`

Wire end-to-end Prediction SolverNet flow:

- generator posts shared Task
- multiple Solvers claim
- multiple Solution envelopes publish
- evaluator emits one Verdict per Solution after market resolution
- corpus query path sees forecast and Verdict envelopes

Blocked by `jinn-mono-kod`.

### `jinn-mono-xp33`

Dashboard consumes corpus/indexed envelopes or a materialized projection derived from them. It should not introduce a canonical Prediction-specific database.

### `jinn-mono-twut`

Supersede the older "intent posting" framing with `prediction.v1` Task posting and shared forecast rounds.

## 14. Out of scope

- Trading execution.
- Scalar, continuous, or multi-outcome markets in the launch implementation.
- Non-Polymarket venue enablement.
- Multi-evaluator consensus.
- Qualitative trajectory grading.
- On-chain SolverPlugin registry.
- Mainnet campaign launch.
- Replicated sibling Tasks as campaign infrastructure.
- Dashboard-specific source of truth.
- Component-level contribution attribution.
- Historical backfill.
- Automated subjective rule adjudication.

## 15. References

- `spec/2026-05-01-harness-pack-architecture.md`
- `spec/2026-04-30-phase-a-umbrella.md`
- `docs/superpowers/plans/2026-04-30-phase-a-umbrella-plan.md`
- GitHub Discussion #57: `https://github.com/Jinn-Network/mono/discussions/57`
- GitHub Discussion #59: `https://github.com/Jinn-Network/mono/discussions/59`
- Polymarket orderbook/pricing docs: `https://docs.polymarket.com/concepts/prices-orderbook`
- Polymarket API docs: `https://docs.polymarket.com/api-reference/introduction`
- Polymarket UMA resolution docs: `https://docs.polymarket.com/developers/resolution/UMA`
