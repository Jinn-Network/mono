# `prediction.v0` — PIS Phase 1 Dogfood — Design

**Version:** 1
**Date:** 2026-04-20
**Author:** ritsukai
**Status:** design approved, pre-implementation
**Related:**
- `spec/2026-04-17-portfolio-v0-design.md` (restorer engine + evaluator framework)
- `spec/2026-03-25-activity-checker.md` (JinnRouter + counters)
- PIS trial plan (growth doc — Oak & Ritsu)

## 1. Context

The PIS (Prediction Intelligence Service) trial plan frames the first Jinn
subnet as a beachhead in the "decentralized alpha arena" narrative: same
competition substrate as Virtuals' Degen Claw / Nof1's Alpha Arena, but with a
deterministic verifier and the signals themselves as monetizable artifacts.

Phase 1 is an internal dogfood: one Chainlink-resolved crypto-price intent,
Ritsu and Oak each running an executor, rails proven end-to-end, a 3–4 page
report covering spec, methodologies, resolution, and what a buyer would have
paid for the better signal. Exit criterion: rails work. If broken, fix before
going external.

The `ale/jinn-mono-end-to-end-daemon-accept-measurable-in-6f7ccc20` branch
already shipped the kind-agnostic `RestorationEngine` + `RestorerImpl`
pluggable-impl interface + deterministic evaluator framework for
`portfolio.v0`. Adding `prediction.v0` is the natural first test of that
generality.

While working through the design, one core simplification emerged over the
portfolio.v0 precedent: **restoration and evaluation share the same intent
payload.** The DesiredState schema already has `type: 'restoration' |
'evaluation'` and `restorationRequestId`; the `MechAdapter` already stamps
both correctly when auto-creating eval jobs. Portfolio.v0's separate
`portfolio.v0.eval` kind + `EvalSpec` pointer fields turn out to be
redundant — evaluator can re-derive everything from `intent.spec` +
`intent.restorationRequestId` + `intent.context.restorationResult`. The only
real fix needed is to dispatch impls on `(kind, type)` instead of kind
alone. This design makes that change once and cleans up portfolio.v0 to
match.

## 2. Scope

**In scope:**

- New `prediction.v0` intent kind (threshold + range questions, single
  Chainlink feed).
- `prediction-v0-baseline` — spot-carry reference restorer impl.
- `prediction-v0-evaluator` — deterministic Chainlink-oracle verifier,
  Brier scoring.
- Minimal Chainlink `AggregatorV3` read client (new
  `client/src/venues/chainlink/`).
- Engine-level dispatch change: `RestorerImpl.supports` takes
  `(kind, type)`.
- Clean up portfolio.v0 to use unified-payload model (retire
  `portfolio.v0.eval` kind + `EvalSpec`; portfolio evaluator reads
  `intent.spec` + `intent.restorationRequestId` + inlined manifest).
- `MockV3Aggregator` contract for deterministic e2e tests.
- E2E test on Anvil fork of Base Sepolia.
- CLI extension: `jinn submit-intent --spec-file <path>` for posting typed
  intents.

**Out of scope:**

- Oak's MiroFish wrapper (lives in Oak's fork; `prediction-v0-baseline`'s
  `strategy.ts` is the extension point).
- JinnRouter / activity-checker upgrades (existing router already
  distinguishes submit vs resolve via `restorationDeliveryCount` vs
  `evaluationDeliveryCount`; confirmed against
  `contracts/src/staking/JinnRouter.sol:240-241`).
- Subsidy model for first executors (Oak/Ritsu 10-min call).
- Phase 2–4 (external onboarding, buyer pilot, second vertical).
- `strategy_recipe` artifact monetization.
- PIS-specific Telegram / growth-doc work (non-code).

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Ritsu's daemon                   Oak's daemon                │
│                                                              │
│  posts prediction.v0 I_R      posts prediction.v0 I_O        │
│         │                              │                     │
│         ▼                              ▼                     │
│  ┌────────────┐              ┌────────────┐                  │
│  │  I_R on    │◄─── restore ──┤ baseline   │                 │
│  │  chain     │     claims    │  strategy  │                 │
│  │            │    + delivers │  (Oak's)   │                 │
│  └─────┬──────┘              └────────────┘                  │
│        │                                                     │
│        │ Ritsu's adapter auto-creates E_R after              │
│        │ restoration delivery claimed (§4.3)                 │
│        ▼                                                     │
│  ┌────────────┐              ┌────────────┐                  │
│  │  E_R on    │◄── evaluate ──┤ evaluator  │                 │
│  │  chain     │    claims     │ (either    │                 │
│  │            │    + delivers │  daemon)   │                 │
│  └────────────┘              └────────────┘                  │
│                                      │                       │
│                                      ▼                       │
│                               Chainlink AggregatorV3         │
│                               (Base Sepolia ETH/USD)         │
└─────────────────────────────────────────────────────────────┘
                           (mirror for I_O)
```

### 3.1 Unified-payload model

**Same intent payload for both roles.** The restorer and the evaluator read
the same `DesiredState.spec`. They are distinguished by:

- `DesiredState.type`:
  - `'restoration'` → `prediction-v0-baseline` runs (or Oak's wrapper, etc.).
  - `'evaluation'` → `prediction-v0-evaluator` runs.
- `DesiredState.restorationRequestId`: populated on eval requests by the
  adapter (already working in `client/src/adapters/mech/adapter.ts:411`).
- `DesiredState.context.restorationResult`: the restorer's signed manifest
  JSON, inlined by the adapter when it fetches from IPFS post-delivery
  (already working at `adapter.ts:352-360`).

The evaluator re-derives everything else (Chainlink reading, comparison,
Brier score) from `intent.spec` + the inlined manifest. No pointer fields
in the spec itself.

### 3.2 Engine dispatch change

**Widen `RestorerImpl.supports` signature** at
`client/src/restorer/types.ts:48`:

```ts
// before
supports(spec: { kind: string }): boolean;

// after
supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean;
```

**Update `RestorerImplRegistry.findFor`** at
`client/src/restorer/engine/registry.ts:62`:

```ts
findFor(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): RestorerImpl | undefined
```

`byKind` remains a `string → implName` map (keyed on kind — the mental model
is "which impl handles this kind by default, for the common restoration
case"). For evaluation dispatch, the registry falls through to first-match
`supports({kind, type: 'evaluation'})`. Simpler than threading `type` into
`byKind`.

**Thread `type` through the engine.** `PersistedIntent` gains a nullable
`type` column (migration: `ALTER TABLE restoration_intents ADD COLUMN
intent_type TEXT`). Populated from `DesiredState.type` at `engine.observe()`
time. All `findFor({kind: intent.specKind})` call sites become
`findFor({kind: intent.specKind, type: intent.type})` — roughly 5 call sites
in `client/src/restorer/engine/engine.ts`.

**Daemon watcher** (`client/src/daemon/daemon.ts:239`) passes
`request.desiredState.type` into `engine.observe()`.

### 3.3 Portfolio.v0 cleanup

Same dispatch change applies to portfolio.v0. Retirement of `EvalSpec`:

- `client/src/restorer/impls/portfolio-v0-evaluator/index.ts:241` —
  `supports({kind, type}) = kind === 'portfolio.v0' && type === 'evaluation'`.
- `client/src/restorer/impls/portfolio-v0-evaluator/types.ts` — delete
  `EvalSpec` interface. Evaluator's `run()` reads:
  - `intent.spec` → the original `PortfolioV0Spec` (oracle/target/constraint).
  - `intent.restorationRequestId` → identifies the restoration to verify.
  - `intent.context.restorationResult` (string) → restorer's manifest JSON,
    parsed to `RestorationManifest`. `manifest.intent.cid` and
    `manifest.intent.onchainCreationTx` carried inside the manifest itself.
- `client/src/restorer/impls/claude-mcp-hyperliquid/index.ts:88` —
  `supports({kind, type}) = kind === 'portfolio.v0' && type !== 'evaluation'`.
- `client/src/main.ts:306-313` — remove `'portfolio.v0.eval'` byKind entry.
  Keep `'portfolio.v0': 'claude-mcp-hyperliquid'`. Evaluator selected via
  first-match when `type === 'evaluation'`.
- `client/scripts/e2e-portfolio-v0.ts:620-720` — delete the hand-rolled
  `EvalSpec` construction and direct evaluator invocation. Let the daemon's
  auto-eval path produce the eval request; assert on the yielded verdict
  coming back through the engine.
- All tests under `client/test/restorer/impls/portfolio-v0-evaluator/` —
  update fixtures to use portfolio.v0 spec + `restorationResult` context
  instead of EvalSpec.

This is additive cleanup (not a behavior change), but the blast radius is
real — call it out during code review.

## 4. `prediction.v0` typed spec

Location: `client/src/types/prediction.ts` (new).

### 4.1 Spec schema

```ts
const ThresholdQuestionSchema = z.object({
  kind: z.literal('threshold'),
  operator: z.enum(['GT', 'GTE', 'LT', 'LTE']),
  threshold: z.string(),              // decimal string, no float precision loss
  resolveTs: z.number().int(),        // ms epoch
});

const RangeQuestionSchema = z.object({
  kind: z.literal('range'),
  lowerBound: z.string(),             // inclusive
  upperBound: z.string(),             // exclusive
  resolveTs: z.number().int(),
});

const PredictionV0SpecSchema = z.object({
  kind: z.literal('prediction.v0'),
  oracle: z.object({
    venue: z.enum(['chainlink-base-sepolia', 'chainlink-base']),
    feed: HexStringSchema,            // AggregatorV3 proxy address
    feedDescription: z.string(),      // e.g., "ETH / USD"
  }),
  question: z.discriminatedUnion('kind', [
    ThresholdQuestionSchema,
    RangeQuestionSchema,
  ]),
});

const PredictionV0EligibilitySchema = z.object({
  maxSubmissionDelayMs: z.number().int().default(60_000),
});

const PredictionV0IntentSchema = z
  .object({
    id: z.string(),
    description: z.string().min(1),
    window: WindowSchema,
    spec: PredictionV0SpecSchema,
    eligibility: PredictionV0EligibilitySchema.default({}),
  })
  .refine(d => d.window.endTs - d.window.startTs === 3_600_000, {
    message: 'window must be exactly 1h (endTs - startTs === 3_600_000 ms)',
    path: ['window'],
  })
  .refine(d => d.spec.question.resolveTs === d.window.endTs + 900_000, {
    message: 'resolveTs must equal window.endTs + 900_000 ms (15min)',
    path: ['spec', 'question', 'resolveTs'],
  });
```

### 4.2 Submission manifest (`prediction.v0.submission.v1`)

Restorer's signed output, uploaded to IPFS, CID delivered via
`mech.deliverToMarketplace`.

```ts
{
  schemaVersion: 'prediction.v0.submission.v1',
  generatedAt: number,
  intent: {
    cid: string,
    onchainCreationTx: `0x${string}`,
    onchainCreationBlock: number,
    requestId: `0x${string}`,
  },
  restorer: { safeAddress: `0x${string}`, agentEoa: `0x${string}` },
  window: { startTs, endTs },
  prediction: {
    probability: string,              // decimal [0,1]; e.g., "0.55"
    submittedAt: number,              // ms epoch, ≥ window.startTs, ≤ window.endTs
    modelId: string,                  // e.g., "spot-carry.v1"
  },
  // Evaluator snapshots the feed state the restorer saw (informational only —
  // not trusted by evaluator). Lets reports show "restorer saw $X, actual
  // was $Y".
  oracleSnapshot?: {
    feed: `0x${string}`,
    roundId: string,
    answer: string,                   // raw int256 as string
    updatedAt: number,
  },
  rationale?: Array<{ ts: number, note: string }>,
  signature: { algo: 'secp256k1', signer, hash, sig },
}
```

### 4.3 Verdict manifest (`prediction.v0.verdict.v1`)

Evaluator's signed output.

```ts
{
  schemaVersion: 'prediction.v0.verdict.v1',
  generatedAt: number,
  intent: { cid, onchainCreationTx, onchainCreationBlock, requestId },
  evaluator: { safeAddress, agentEoa },
  window: { startTs, endTs },
  verdict: 'PASS' | 'FAIL' | 'REJECTED' | 'INDETERMINATE',
  score: string,                      // brier.v1: (1 - (p - outcome)^2) × 1e18
  scoreBasis: 'brier.v1',
  scoreVersion: '1',
  oracleReading: {
    feed: `0x${string}`,
    roundId: string,
    answer: string,                   // raw int256 as string
    updatedAt: number,
    nextRoundUpdatedAt?: number,      // bounds 'spanning' check
  },
  claimed: {
    probability: string,
    submittedAt: number,
    modelId: string,
    submissionManifestCid: string,
  },
  groundTruth: 'YES' | 'NO',          // resolved per question.kind + oracle reading
  checks: Array<{ name, status, detail? }>,
  signature,
}
```

## 5. Restorer impl — `prediction-v0-baseline`

Location: `client/src/restorer/impls/prediction-v0-baseline/` (new).

### 5.1 Files

```
index.ts       RestorerImpl entrypoint
strategy.ts    Swappable predict(intent, snapshot) → { probability, modelId }
types.ts       Local types (Strategy, StrategyPrediction)
```

### 5.2 Impl behavior

```ts
class PredictionV0BaselineImpl implements RestorerImpl {
  name = 'prediction-v0-baseline';
  version = '1.0.0';
  supports({kind, type}) {
    return kind === 'prediction.v0' && type !== 'evaluation';
  }
  async canAttempt(intent) {
    const parsed = PredictionV0IntentSchema.safeParse(intent);
    if (!parsed.success) return { ok: false, reason: parsed.error.message };
    if (Date.now() > intent.window.endTs) return { ok: false, reason: 'window closed' };
    return { ok: true };
  }
  async run(ctx) {
    const intent = PredictionV0IntentSchema.parse(ctx.intent);
    const snapshot = await readChainlinkLatest(intent.spec.oracle);   // read feed NOW
    const { probability, modelId } = await strategy.predict(intent, snapshot);
    const submittedAt = Date.now();

    const submission = {
      probability,                          // decimal string ∈ [0,1]
      submittedAt,
      modelId,
    };
    writeFileSync(join(ctx.workingDir, 'prediction.json'), JSON.stringify(submission));

    return {
      venueRef: { name: 'chainlink' },
      gating: { probability, submittedAt: String(submittedAt), modelId },
      informational: {
        oracleSnapshot: {
          feed: intent.spec.oracle.feed,
          roundId: String(snapshot.roundId),
          answer: String(snapshot.answer),
          updatedAt: snapshot.updatedAt,
        },
      },
      artifacts: [
        { path: 'prediction.json', role: 'prediction_submission' },
      ],
    };
  }
}
```

### 5.3 Baseline strategy (`strategy.ts`)

Spot-carry: "current state tends to persist."

```ts
async function predict(intent, snapshot) {
  const currentPrice = scaleToDecimal(snapshot.answer, snapshot.decimals);
  const currentlyYes = evaluateQuestion(intent.spec.question, currentPrice);
  return {
    probability: currentlyYes ? '0.55' : '0.45',
    modelId: 'spot-carry.v1',
  };
}
```

Evaluates the question against the current price — "if the window ended now,
would this be YES?" — and emits a probability 0.55/0.45 accordingly.

Intentionally dumb. The point of Phase 1 is rails, not alpha. Oak's
MiroFish wrapper replaces `strategy.ts` in his fork. The `strategy` module
boundary is the contract between shared rails and executor-specific logic.

### 5.4 Engine-provided context

- `ctx.workingDir` — restorer writes `prediction.json` here; engine walks it
  post-run to collect artifacts for IPFS upload.
- `ctx.implStateDir` — persistent state across attempts (unused in baseline).
- `ctx.abort` — fires at `window.endTs`. Restorer should check before
  submitting; baseline is fast enough it never hits this.
- `ctx.msUntilEndTs()` — for impls that want to defer submission; baseline
  submits immediately.

## 6. Evaluator impl — `prediction-v0-evaluator`

Location: `client/src/restorer/impls/prediction-v0-evaluator/` (new).
Modeled structurally on `portfolio-v0-evaluator/`.

### 6.1 Files

```
index.ts              RestorerImpl entrypoint
canonical-metrics.ts  resolvePrediction, oraclePriceAtOrAfter, brierScore
score.ts              scoreBasis = 'brier.v1'
types.ts              Local types
checks/
  availability.ts     oracle_reachable, oracle_round_covers_resolve_ts
  eligibility.ts      submission_within_window
  integrity.ts        window_bounds, manifest_fields_present, manifest_signature
  consistency.ts      answer_matches_oracle   (the PASS/FAIL pivot for outcome)
  spec.ts             question_kind_supported
```

### 6.2 Impl behavior

```ts
class PredictionV0Evaluator implements RestorerImpl {
  name = 'prediction-v0-evaluator';
  version = '1.0.0';
  supports({kind, type}) {
    return kind === 'prediction.v0' && type === 'evaluation';
  }
  async run(ctx) {
    // 1. Parse intent — same spec the restorer ran under
    const intent = PredictionV0IntentSchema.parse(ctx.intent);
    // 2. Load restorer's manifest from inlined context (fallback: fetch by
    //    deliveryDataHex from chain → IPFS)
    const submissionManifest = loadSubmissionManifest(ctx.intent);
    // 3. Verify signature against manifest.restorer.agentEoa
    // 4. Fetch Chainlink round spanning resolveTs
    const oracleReading = await oraclePriceAtResolveTs(
      intent.spec.oracle.feed,
      intent.spec.question.resolveTs,
      publicClient,
    );
    // 5. Run checks (availability → eligibility → integrity → consistency → spec)
    const checks = [...runChecks(intent, submissionManifest, oracleReading)];
    // 6. Derive verdict
    const verdict = deriveVerdict(checks);  // same rule as portfolio.v0
    // 7. Compute score
    const groundTruth = resolveGroundTruth(intent.spec.question, oracleReading);
    const probability = submissionManifest.prediction.probability;
    const score = verdict === 'PASS'
      ? brierScore(probability, groundTruth === 'YES' ? 1 : 0)
      : '0';
    // 8. Assemble + sign verdict manifest
    const verdictManifest = assembleVerdictManifest({ ... });
    writeFileSync(join(ctx.workingDir, 'verdict.json'), JSON.stringify(verdictManifest));
    return {
      venueRef: { name: 'chainlink' },
      gating: { verdict, score, scoreBasis: 'brier.v1', groundTruth },
      informational: { oracleReading, claimedProbability: probability },
      artifacts: [{ path: 'verdict.json', role: 'evaluation_verdict' }],
    };
  }
}
```

### 6.3 Oracle round picker

Spanning semantics: find round R where
`R.updatedAt ≤ resolveTs < nextRound.updatedAt`. That round's `answer` is
the authoritative price at `resolveTs`.

Algorithm (`canonical-metrics.ts:oraclePriceAtResolveTs`):

1. Call `latestRoundData()` → `(roundId, answer, updatedAt)`.
2. If `updatedAt ≤ resolveTs` AND there is no newer round yet → round is
   not yet spanning. Availability check `oracle_round_covers_resolve_ts`
   marks SKIP → verdict INDETERMINATE. Evaluator should be retried on the
   next engine tick once a newer round is published.
3. If `updatedAt > resolveTs`: walk back by decrementing `roundId` (via
   `getRoundData`) until we find R where
   `R.updatedAt ≤ resolveTs < nextRound.updatedAt`. Return R + nextRound.

Base Sepolia ETH/USD on Chainlink updates sparsely (heartbeat ~24h,
deviation ~0.5%). In practice this may require waiting several minutes past
`resolveTs` for the next update. The engine tick loop + `INDETERMINATE`
retry handles this automatically.

### 6.4 Ground-truth resolution

```ts
function resolveGroundTruth(question, oracleReading) {
  const price = scaleToDecimal(oracleReading.answer, oracleReading.decimals);
  if (question.kind === 'threshold') {
    const t = question.threshold;
    switch (question.operator) {
      case 'GT':  return decGt(price, t) ? 'YES' : 'NO';
      case 'GTE': return decGte(price, t) ? 'YES' : 'NO';
      case 'LT':  return decLt(price, t) ? 'YES' : 'NO';
      case 'LTE': return decLte(price, t) ? 'YES' : 'NO';
    }
  }
  // range: YES iff lowerBound ≤ price < upperBound
  return decGte(price, question.lowerBound) && decLt(price, question.upperBound) ? 'YES' : 'NO';
}
```

Decimal comparison helpers live in `canonical-metrics.ts` to avoid float
precision drift. All values are decimal strings end-to-end.

### 6.5 Brier score

```ts
function brierScore(probabilityStr, outcome) {
  // Score ∈ [0,1]. Scaled to 1e18 fixed-point for on-chain comparability.
  const p = parseFloat(probabilityStr);
  const s = 1 - Math.pow(p - outcome, 2);
  return BigInt(Math.round(s * 1e18)).toString();
}
```

Example: `p=0.55, outcome=1 (YES)` → `s = 1 - 0.2025 = 0.7975` →
`"797500000000000000"`.

Non-PASS verdicts score `"0"`. The `scoreBasis` field is open for
`brier.v1` today; future `brier_calibrated.v1` / `log_score.v1` land as
additive values without schema changes.

### 6.6 Verdict derivation (mirrors portfolio.v0 §7.3)

```
if any availability.* FAIL           → INDETERMINATE
else if any eligibility.* FAIL       → REJECTED
else if any integrity.* / consistency.* / spec.* FAIL → FAIL
else                                 → PASS
```

### 6.7 Check list

| Check | Meaning | Source |
|---|---|---|
| `availability.oracle_reachable` | RPC succeeds | network |
| `availability.oracle_round_covers_resolve_ts` | round w/ `updatedAt ≥ resolveTs` exists; SKIP else | chain |
| `eligibility.submission_within_window` | `submittedAt ∈ [window.startTs, window.endTs]` | manifest |
| `integrity.window_bounds` | `startTs < endTs ≤ resolveTs`; `endTs - startTs == 3_600_000`; `resolveTs == endTs + 900_000` | intent |
| `integrity.manifest_fields_present` | probability parses as decimal ∈ [0,1]; modelId non-empty; submittedAt is ms epoch int | manifest |
| `integrity.manifest_signature` | secp256k1 sig valid for `manifest.restorer.agentEoa` | manifest |
| `integrity.intent_ref` | `manifest.intent.cid` matches the eval intent's restoration-request on-chain creation data | manifest + chain |
| `spec.question_kind_supported` | `question.kind ∈ {'threshold', 'range'}`; `operator ∈ {'GT','GTE','LT','LTE'}` for threshold | intent |

No `consistency.*` checks in v0. In portfolio.v0 they exist because the
restorer's manifest *claims* recomputed metrics (equity return, drawdown,
fills set) and the evaluator must verify claimed-vs-rederived within
tolerance. Prediction.v0 has no such claim surface — the restorer commits
to a probability, and the evaluator independently derives ground truth
from the oracle; there's nothing cross-verifiable. The score is the
comparison.

**Important subtlety about `PASS`.** `verdict: "PASS"` does not mean "the
restorer was right." It means "the submission is valid and scorable." The
outcome signal lives in the `score` field (Brier). A perfectly calibrated
but wrong prediction still `PASS`es with a score near `0.25` (for
`p=0.5, wrong`) or `0` (for `p=0, wrong`). The Phase 1 report compares
scores across operators, not verdicts.

## 7. Chainlink read client

Location: `client/src/venues/chainlink/client.ts` (new).

Minimal read-only client. No write paths.

### 7.1 ABI

```ts
const AGGREGATOR_V3_ABI = [
  {name: 'latestRoundData', type: 'function', stateMutability: 'view', inputs: [],
   outputs: [
     { name: 'roundId', type: 'uint80' },
     { name: 'answer', type: 'int256' },
     { name: 'startedAt', type: 'uint256' },
     { name: 'updatedAt', type: 'uint256' },
     { name: 'answeredInRound', type: 'uint80' },
   ]},
  {name: 'getRoundData', type: 'function', stateMutability: 'view',
   inputs: [{ name: '_roundId', type: 'uint80' }],
   outputs: /* same as latestRoundData */},
  {name: 'decimals', type: 'function', stateMutability: 'view', inputs: [],
   outputs: [{ name: '', type: 'uint8' }]},
  {name: 'description', type: 'function', stateMutability: 'view', inputs: [],
   outputs: [{ name: '', type: 'string' }]},
];
```

### 7.2 Exports

- `readChainlinkLatest(oracle, publicClient) → RoundReading`
- `oraclePriceAtResolveTs(oracle, resolveTs, publicClient) → {round: RoundReading, nextRound: RoundReading | null}`
- `scaleToDecimal(answer: bigint, decimals: number) → string`
- `BASE_SEPOLIA_FEEDS`, `BASE_FEEDS` — known-good ETH/USD, BTC/USD addresses.

Known feed (Base Sepolia ETH/USD): `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`
(verify current at Phase 1 kickoff — feed addresses rotate).

## 8. MockV3Aggregator contract

Location: `contracts/src/testing/MockV3Aggregator.sol` (new).

Minimal implementation of `AggregatorV3Interface` with owner-settable
`(roundId, answer, updatedAt)`. Used by the e2e test to produce
deterministic rounds.

```solidity
contract MockV3Aggregator {
  uint8 public immutable decimals;
  int256 public latestAnswer;
  uint256 public latestTimestamp;
  uint80 public latestRound;
  mapping(uint80 => int256) public answers;
  mapping(uint80 => uint256) public timestamps;

  constructor(uint8 _decimals, int256 _initialAnswer) {
    decimals = _decimals;
    updateAnswer(_initialAnswer);
  }

  function updateAnswer(int256 _answer) public {
    latestAnswer = _answer;
    latestTimestamp = block.timestamp;
    latestRound++;
    answers[latestRound] = _answer;
    timestamps[latestRound] = block.timestamp;
  }

  function latestRoundData() external view returns (
    uint80, int256, uint256, uint256, uint80
  ) {
    return (latestRound, latestAnswer, latestTimestamp, latestTimestamp, latestRound);
  }

  function getRoundData(uint80 _roundId) external view returns (
    uint80, int256, uint256, uint256, uint80
  ) {
    return (_roundId, answers[_roundId], timestamps[_roundId], timestamps[_roundId], _roundId);
  }

  function description() external pure returns (string memory) { return "MOCK / USD"; }
}
```

## 9. CLI extension

Location: `client/src/cli/commands/submit-intent.ts` (edit).

Current: `--id` + `--description` only (line 42-45). Extend with:

- `--spec-file <path>` — JSON file containing `{spec, window, eligibility}`.
  Merged with `--id` and `--description`.
- The loaded file is Zod-validated against the relevant spec schema
  (discriminated union on `spec.kind`).
- Dry-run prints the full intent for operator review.

Example fixture: `client/fixtures/prediction-v0-intent.example.json`:

```json
{
  "window": { "startTs": 0, "endTs": 3600000 },
  "spec": {
    "kind": "prediction.v0",
    "oracle": {
      "venue": "chainlink-base-sepolia",
      "feed": "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
      "feedDescription": "ETH / USD"
    },
    "question": {
      "kind": "threshold",
      "operator": "GT",
      "threshold": "3500",
      "resolveTs": 4500000
    }
  }
}
```

CLI fills in `startTs = now`, `endTs = now + 3_600_000`,
`resolveTs = endTs + 900_000` when values are `0` (operator templates).

## 10. Cross-evaluation flow

For the PIS Phase 1 dogfood:

1. **Coordination (out of band).** Ritsu and Oak agree on a feed + threshold +
   start time via Telegram. They each prepare the same intent JSON.
2. **Intent posting.** Ritsu posts `I_R` via `jinn submit-intent --spec-file`.
   Oak posts `I_O`. Both go through `createRestorationJob` → two separate
   request IDs on chain.
3. **Restoration.** Each executor's daemon sees the *other's* intent (their
   own is claim-policy-filtered or simply race-lost to the other). Oak's
   daemon claims `I_R`, runs `prediction-v0-baseline` (or Oak's wrapper),
   delivers signed submission. Ritsu's daemon does the same for `I_O`.
4. **Delivery claim.** Each creator's daemon auto-claims its
   restoration's delivery (existing `adapter.watchForDeliveries` flow →
   `JinnRouter.claimDelivery` → `restorationDeliveryCount++`).
5. **Eval auto-creation.** Each creator's daemon auto-creates an eval job
   via `tryCreateEvaluationJob` → `JinnRouter.createEvaluationJob` →
   `evaluationCreationCount++`. Eval payload is the same `PredictionV0Spec`
   + `type: 'evaluation'` + `restorationRequestId` + `context.restorationResult`.
6. **Evaluation.** Both daemons see the eval request in `watchForRequests`.
   First-to-claim runs `prediction-v0-evaluator`. Self-grading is possible
   (a creator claiming the eval for their own intent) but harmless because
   the evaluator is deterministic and Chainlink-anchored. Verdict delivered
   → `evaluationDeliveryCount++`.

**Optional claim policy tightening (v1.1, not required for Phase 1):** each
operator's `ClaimPolicy` rejects eval requests whose
`restorationRequestId` points to a restoration the same Safe delivered.
Prevents self-grading for cleaner attribution in the growth report.
Implemented as a ~20-line `NoSelfGradePolicy` at
`client/src/adapters/mech/claim-policy.ts`.

## 11. Activity checker — no changes

Verified against `contracts/src/staking/JinnRouter.sol` and the deployed
proxy at `0x7c502a4288C4f4279edbb363d692f530200e22dC` (Base Sepolia, per
`contracts/deployment-phase1b-router-checker-baseSepolia-fast.json`):

| PIS event | Router counter | Line |
|---|---|---|
| Intent published | `creationCount[creator]++` | `JinnRouter.sol:151` |
| Prediction submitted | `restorationDeliveryCount[restorer]++` | `JinnRouter.sol:240` |
| Evaluation requested | `evaluationCreationCount[creator]++` | inside `createEvaluationJob` |
| Prediction resolved | `evaluationDeliveryCount[evaluator]++` | `JinnRouter.sol:241` |

Satisfies the PIS plan's "Activity checker handles 'prediction submitted'
and 'prediction resolved' as separate events" prerequisite. No router
upgrade needed.

## 12. Testing strategy

### 12.1 Unit tests

Mirror `client/test/restorer/impls/portfolio-v0-evaluator/`:

```
client/test/
  types/prediction.test.ts                          # schema refinements
  venues/chainlink/client.test.ts                   # round picker, decimal scaling
  restorer/impls/prediction-v0-baseline/
    index.test.ts                                   # run() writes prediction.json, honors abort
    strategy.test.ts                                # spot-carry math
  restorer/impls/prediction-v0-evaluator/
    index.test.ts                                   # full pipeline, all 4 verdicts
    canonical-metrics.test.ts                       # brier edges, ground-truth resolution
    score.test.ts                                   # brier.v1 boundaries
    test-helpers.ts                                 # shared fixtures
    checks/
      availability.test.ts
      eligibility.test.ts
      integrity.test.ts
      consistency.test.ts
      spec.test.ts
```

Key fixtures:
- Synthetic `PredictionV0Intent` with threshold + range variants.
- Synthetic `SubmissionManifest` with valid + invalid signatures.
- Synthetic Chainlink round data: spanning, stale, missing, before-threshold,
  after-threshold.

### 12.2 E2E test

Location: `client/scripts/e2e-prediction-v0.ts` (new, modeled on
`e2e-portfolio-v0.ts`).

Runs on Anvil fork of Base Sepolia (port 8548 to avoid portfolio.v0
collision on 8547). Uses `MockV3Aggregator` for deterministic oracle
rounds.

**Phases:**

1. **Bootstrap** — Anvil fork; deploy `MockV3Aggregator` with initial
   answer `$3400 × 10^8`.
2. **Post intent** (Safe A as creator) — `window.startTs = now`,
   `endTs = now + 1h`, `resolveTs = endTs + 15min`,
   `question = {kind: 'threshold', operator: 'GT', threshold: '3500',
   resolveTs}`.
3. **Assert counter** — `creationCount[safeA] == 1`.
4. **Restorer run** (Safe B's daemon) — mines time to ~30min in, mock
   aggregator at `$3450`. Baseline impl emits `probability: "0.45"`
   (current price below threshold → 0.45). Delivers.
5. **Assert counter** — `restorationDeliveryCount[safeB] == 1`.
6. **Advance past endTs**. Push mock round with `answer: $3550 × 10^8`,
   `updatedAt: resolveTs + 1s`. Mine.
7. **Assert counter** — `evaluationCreationCount[safeA] == 1`.
8. **Evaluator run** (Safe C's daemon) — fetches the mock round, computes
   ground truth YES, Brier score `1 - (0.45 - 1)^2 = 0.6975`, verdict PASS.
9. **Assert counter** — `evaluationDeliveryCount[safeC] == 1`.
10. **Four-verdict coverage** (parallel runs in same script):
    - `PASS`: restorer emits `0.45`, oracle at resolveTs `> threshold`,
      Brier ≈ `0.6975 × 1e18`.
    - `FAIL`: synthetic manifest with an invalid signature → verdict FAIL,
      score `0`.
    - `REJECTED`: synthetic manifest with `submittedAt > window.endTs` →
      verdict REJECTED, score `0`.
    - `INDETERMINATE`: don't push the post-`resolveTs` mock round. Evaluator
      marks `oracle_round_covers_resolve_ts` as SKIP → INDETERMINATE.

Expected runtime: <120s total. Reuses `runPhase()` + mining-interval
patterns from `e2e-portfolio-v0.ts`.

### 12.3 Portfolio.v0 regression

- `client/test/` — update `portfolio-v0-evaluator` tests to use unified
  payload (portfolio.v0 spec + `restorationResult` context).
- `client/scripts/e2e-portfolio-v0.ts` — replace hand-rolled `EvalSpec`
  block (lines 620-720) with daemon-loop auto-eval assertion.
- All must stay green.

## 13. Phase 1 operational runbook

Post-implementation, pre-Phase 1 kickoff:

1. **Coordinate.** Oak + Ritsu agree on feed (Base Sepolia ETH/USD), threshold,
   and launch time.
2. **Fund.** Both Safes funded with Base Sepolia ETH (gas) + OLAS (bond).
   `jinn fund-requirements --json` surfaces gaps.
3. **Verify feed.** Read `latestRoundData()` on the chosen Chainlink feed;
   confirm it's actively updating (last update < 24h ago).
4. **Dry-run.** `jinn submit-intent --spec-file predict-eth-3500.json
   --dry-run` on each side. Verify intent body.
5. **Post.** Both operators post their intents roughly simultaneously.
6. **Monitor.** Watch each daemon's HTTP status + logs for restoration
   claim / deliver / eval auto-creation / verdict delivery. Expected
   timeline: 1h + ~20min (oracle round propagation) ≈ 80min end-to-end.
7. **Collect artifacts.** Manifest CIDs + verdict CIDs — fetch from IPFS,
   attach to the Phase 1 report.
8. **Report.** 3–4 pages per PIS plan: spec, methodologies, resolution,
   side-by-side Brier scores.

## 14. Execution hygiene

**Branch.** Design doc lives on
`ale/jinn-mono-end-to-end-daemon-accept-measurable-in-6f7ccc20`.
Implementation work happens in a fresh worktree branched off this one so the
dispatch refactor + portfolio.v0 cleanup + prediction.v0 additions land in
one coherent PR.

**Sequence (implementation plan will detail).**
1. Engine dispatch widening (types.ts + registry.ts + engine.ts + daemon.ts).
2. Portfolio.v0 evaluator cleanup (supports + EvalSpec retirement + tests).
3. Prediction.v0 schema + baseline impl.
4. Chainlink client.
5. Prediction.v0 evaluator + checks.
6. MockV3Aggregator.
7. E2E script.
8. CLI extension.
9. Documentation (CLAUDE.md note if needed).

## 15. Verification

1. **Type check.** `cd client && yarn typecheck` → zero errors.
2. **Unit tests.** `cd client && yarn test` → all prediction + updated
   portfolio suites pass.
3. **Portfolio regression.** Existing portfolio.v0 e2e still passes under
   the unified-payload model.
4. **Prediction e2e.** `cd client && yarn tsx scripts/e2e-prediction-v0.ts` →
   completes <120s, all 4 verdicts produced, all 4 counters increment.
5. **Router assertion in e2e.** All four counters deltas confirmed per §12.2.
6. **CLI smoke.** `jinn submit-intent --spec-file fixtures/prediction-v0-intent.example.json --dry-run` prints expected intent.
7. **Base Sepolia manual run (before Phase 1 kickoff).** One full
   end-to-end cycle against the real Chainlink feed on Base Sepolia.
   Verify counters on the live router proxy.

## 16. Estimated effort

| Piece | Lines | Days |
|---|---|---|
| Engine dispatch change + portfolio cleanup | ~150 | 0.5 |
| Prediction types + schema | ~150 | 0.5 |
| Baseline impl + strategy stub | ~250 | 0.5 |
| Chainlink client | ~120 | 0.25 |
| Evaluator + 5 checks + metrics + score | ~600 | 1.5 |
| MockV3Aggregator + hardhat integration | ~80 | 0.25 |
| CLI + fixtures | ~100 | 0.25 |
| E2E script | ~500 | 1 |
| Unit tests (baseline + evaluator + chainlink) | ~500 | 1 |
| Portfolio test updates | ~150 | 0.25 |
| **Total** | **~2600** | **~6 days** |

Single-developer estimate, focused work. Ships well inside the PIS plan's
"1–2 weeks" implicit window.
