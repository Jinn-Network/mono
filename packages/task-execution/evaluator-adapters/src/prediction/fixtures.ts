// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral oracles for the prediction scorer. Composition design §6.6: legacy behavior
 * enters as fixtures, never as ported code. Each entry cites the exact legacy file and line
 * range it was transcribed from.
 *
 * Provenance verification (2026-07-30): every citation below was checked against the real
 * legacy bytes before this module was written. Two plan-drafted citation classes pointed at
 * the wrong code and are corrected here (see `fixtures/prediction/README.md` §Provenance
 * corrections for the full account):
 *
 *  - The three `adversarial-result-is-*` fixtures (not JSON, not UTF-8, empty) cited
 *    `prediction-v1-evaluator/index.ts:112-118`, the catch block that turns a thrown
 *    envelope/payload *schema* validation error into a `solution.schema: FAIL` check. That
 *    catch only wraps `SignedEnvelopeSchema.parse` / `PredictionV1RestorationPayloadSchema.parse`
 *    (`index.ts:90-111`) — i.e. failures on JSON that has *already* parsed successfully. The
 *    line that actually turns raw bytes into JSON, `JSON.parse(manifestJson)`
 *    (`index.ts:81`), sits *outside* that try/catch (the try starts at `index.ts:89`) and is
 *    unguarded: malformed/empty/non-JSON input throws there, uncaught, crashing `run()`
 *    outright rather than producing a graceful `FAIL` check. Corrected the citation to
 *    `index.ts:80-81`. The fixtures' expected outcome (`fail`, not a crash) is kept as a
 *    deliberate normalization for this fresh-rewrite parser — treating unparseable raw
 *    solver-submitted content the same way the catch block treats a parseable-but-invalid
 *    envelope/payload (both are the solver's fault) — not a literal transcription of the
 *    legacy crash. Recorded here rather than silently ported.
 *  - `adversarial-probability-out-of-range` cited `prediction-v0-evaluator/score.ts:8-22`.
 *    That file is the *v0* Brier scheme (`SCORE_BASIS = 'brier.v1'`), superseded and not
 *    re-homed by this package (E5, Task 2) — it also does not itself validate probability
 *    range; it delegates to `canonical-metrics.ts#brierScore`, a different v0-only file. The
 *    v1 pipeline being re-homed here rejects an out-of-range `probabilityYes` earlier and
 *    more directly: `DecimalProbabilitySchema` (`packages/sdk/src/prediction-v1.ts:8-10`,
 *    `/^(0(\.\d+)?|1(\.0+)?)$/`) is enforced inside
 *    `PredictionV1RestorationPayloadSchema.parse(envelope.payload)` (`index.ts:110`), and a
 *    match failure throws there, caught by the same `solution.schema: FAIL` catch block used
 *    above (`index.ts:112-118`). "1.500000" fails that regex (the `1(\.0+)?` branch only
 *    admits trailing zeros). Corrected the citation to `index.ts:110-118`.
 *
 * The resolution-snapshot shape was cross-checked against the real `ResolutionSnapshot`
 * interface at `client/src/venues/polymarket/client.ts:69-77`: the real `status` enum is
 * `'unresolved' | 'resolved' | 'invalid' | 'cancelled' | 'ambiguous'`. There is no
 * `'unavailable'` value anywhere in the legacy stack (this matches Task 2 finding E4, already
 * reflected in `fixtures/parsers/prediction-market.parser.json`). The plan's
 * `PredictionResolutionSnapshot.status` type (`"resolved" | "unresolved" | "unavailable"`) is
 * corrected below to the real five-value enum.
 */

const encoder = new TextEncoder();

export interface PredictionResolutionSnapshot {
  readonly status: "resolved" | "unresolved" | "invalid" | "cancelled" | "ambiguous";
  readonly outcome?: "YES" | "NO";
  readonly resolvedAt?: string;
  readonly marketId: string;
  readonly conditionId: string;
  readonly sourceUrl: string;
}

export interface PredictionFixture {
  readonly name: string;
  readonly provenance: string;
  readonly resultBytes: Uint8Array;
  readonly snapshot: unknown;
  readonly market: { readonly marketId: string; readonly conditionId: string };
  readonly window: { readonly startTs: number; readonly endTs: number };
  readonly consensusProbabilityYes: string;
  readonly expect: {
    readonly verdict: "pass" | "fail" | "inconclusive";
    readonly integrity: boolean;
    readonly resolved: boolean;
    readonly solverBrier?: string;
    readonly consensusBrier?: string;
    readonly brierSpread?: string;
  };
}

const MARKET = { marketId: "0x5150", conditionId: "0xABCDEF" } as const;
const WINDOW = { startTs: 1_780_000_000_000, endTs: 1_780_086_400_000 } as const;

function result(payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

function resolved(outcome: "YES" | "NO"): PredictionResolutionSnapshot {
  return {
    status: "resolved",
    outcome,
    resolvedAt: "2026-06-02T00:00:00.000Z",
    marketId: MARKET.marketId,
    conditionId: MARKET.conditionId,
    sourceUrl: "https://example.invalid/markets/0x5150",
  };
}

export const PREDICTION_FIXTURES: readonly PredictionFixture[] = Object.freeze([
  {
    name: "scored-yes-solver-beats-consensus",
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:252-273",
    resultBytes: result({
      probabilityYes: "0.900000",
      submittedAt: "2026-06-01T00:00:00.000Z",
      modelId: "model-a",
    }),
    snapshot: resolved("YES"),
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.600000",
    expect: {
      verdict: "pass",
      integrity: true,
      resolved: true,
      solverBrier: "0.010000",
      consensusBrier: "0.160000",
      brierSpread: "-0.150000",
    },
  },
  {
    name: "scored-no-solver-worse-than-consensus",
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:252-273",
    resultBytes: result({
      probabilityYes: "0.800000",
      submittedAt: "2026-06-01T00:00:00.000Z",
      modelId: "model-a",
    }),
    snapshot: resolved("NO"),
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.300000",
    expect: {
      verdict: "pass",
      integrity: true,
      resolved: true,
      solverBrier: "0.640000",
      consensusBrier: "0.090000",
      brierSpread: "0.550000",
    },
  },
  {
    name: "inconclusive-market-unresolved",
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:136-141",
    resultBytes: result({
      probabilityYes: "0.500000",
      submittedAt: "2026-06-01T00:00:00.000Z",
      modelId: "model-a",
    }),
    snapshot: {
      status: "unresolved",
      marketId: MARKET.marketId,
      conditionId: MARKET.conditionId,
      sourceUrl: "https://example.invalid/markets/0x5150",
    },
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.500000",
    expect: { verdict: "inconclusive", integrity: true, resolved: false },
  },
  {
    name: "rejected-submission-outside-window",
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:120-131",
    resultBytes: result({
      probabilityYes: "0.900000",
      submittedAt: "2026-05-01T00:00:00.000Z",
      modelId: "model-a",
    }),
    snapshot: resolved("YES"),
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.600000",
    expect: { verdict: "fail", integrity: false, resolved: true },
  },
  {
    name: "rejected-market-identity-mismatch",
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:231-250",
    resultBytes: result({
      probabilityYes: "0.900000",
      submittedAt: "2026-06-01T00:00:00.000Z",
      modelId: "model-a",
    }),
    snapshot: { ...resolved("YES"), marketId: "0x0000" },
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.600000",
    expect: { verdict: "fail", integrity: false, resolved: true },
  },
  {
    name: "market-identity-condition-id-is-case-insensitive",
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:236",
    resultBytes: result({
      probabilityYes: "1.000000",
      submittedAt: "2026-06-01T00:00:00.000Z",
      modelId: "model-a",
    }),
    snapshot: { ...resolved("YES"), conditionId: "0xabcdef" },
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.500000",
    expect: {
      verdict: "pass",
      integrity: true,
      resolved: true,
      solverBrier: "0.000000",
      consensusBrier: "0.250000",
      brierSpread: "-0.250000",
    },
  },
  {
    name: "adversarial-result-is-not-json",
    // Corrected from the plan's :112-118 (the schema-validation catch block, which only
    // wraps already-parsed JSON). The raw `JSON.parse(manifestJson)` call that this fixture
    // actually attacks is unguarded and sits outside that try/catch — see the module header.
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:80-81",
    resultBytes: encoder.encode("{ this is not json"),
    snapshot: resolved("YES"),
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.600000",
    expect: { verdict: "fail", integrity: false, resolved: true },
  },
  {
    name: "adversarial-result-is-not-utf8",
    // Corrected from the plan's :112-118 for the same reason. The legacy evaluator never
    // decodes raw bytes itself — `ctx.task.context['restorationResult']` already arrives as a
    // JS string — so there is no legacy line that performs byte-level UTF-8 decoding; the
    // nearest real behavior is still the unguarded `JSON.parse` at :81, which throws on the
    // non-JSON text these poison bytes decode to. See the module header.
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:80-81",
    resultBytes: Uint8Array.from([0xff, 0xfe, 0xfd, 0x00]),
    snapshot: resolved("YES"),
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.600000",
    expect: { verdict: "fail", integrity: false, resolved: true },
  },
  {
    name: "adversarial-result-is-empty",
    // Corrected from the plan's :112-118 for the same reason: `JSON.parse("")` throws at
    // the unguarded call site, :81, not inside the schema-validation catch. See the module
    // header.
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:80-81",
    resultBytes: new Uint8Array(0),
    snapshot: resolved("YES"),
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.600000",
    expect: { verdict: "fail", integrity: false, resolved: true },
  },
  {
    name: "adversarial-probability-out-of-range",
    // Corrected from the plan's citation of the superseded v0 file
    // `prediction-v0-evaluator/score.ts:8-22`. The v1 pipeline being re-homed here rejects
    // "1.500000" earlier, via `DecimalProbabilitySchema` (packages/sdk/src/prediction-v1.ts:8-10,
    // `/^(0(\.\d+)?|1(\.0+)?)$/` — the `1(\.0+)?` branch only admits trailing zeros) enforced
    // inside `PredictionV1RestorationPayloadSchema.parse` at index.ts:110, caught by the same
    // solution.schema catch block as the adversarial-result-is-* fixtures above. See the
    // module header.
    provenance: "client/src/harnesses/impls/prediction-v1-evaluator/index.ts:110-118",
    resultBytes: result({
      probabilityYes: "1.500000",
      submittedAt: "2026-06-01T00:00:00.000Z",
      modelId: "model-a",
    }),
    snapshot: resolved("YES"),
    market: MARKET,
    window: WINDOW,
    consensusProbabilityYes: "0.600000",
    expect: { verdict: "fail", integrity: false, resolved: true },
  },
]);
