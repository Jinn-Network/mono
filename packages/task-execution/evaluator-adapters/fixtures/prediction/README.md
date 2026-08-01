# prediction fixtures

Behavioral oracles for the prediction scorer (Task 6). Composition design §6.6: legacy
behavior enters this package as test fixtures and assertions only — no file under
`client/src/harnesses/impls/prediction-v1-evaluator/` or `prediction-v0-evaluator/` is ported,
copied, or adapted as code. The 10 entries in `../../src/prediction/fixtures.ts`
(`PREDICTION_FIXTURES`) are each cited to the exact legacy file and line range they were
transcribed from; every citation was checked against the real legacy bytes before this
fixture module was written (see §Provenance corrections below for the four the plan got
wrong).

## The seven checks

Per Task 2 finding E4 (already reflected in
`../parsers/prediction-market.parser.json`), the evaluator being re-homed —
`prediction-v1-evaluator/index.ts` — runs **seven** checks per attempt, not the plan's
originally-stated four:

1. `solution.envelope` (`index.ts:96,101`) — the manifest decodes to a signed envelope whose
   `solverType`/`role` match `prediction.v1`/`solution`.
2. `integrity.manifest_signature` (`index.ts:103`) — the envelope's signature verifies against
   its recomputed top-level hash.
3. `integrity.signedTask_ref` (`index.ts:104-109`) — the envelope's `task.cid` matches the
   expected solution-task CID, or is reported `INDETERMINATE` when that expectation is itself
   missing from context.
4. `solution.schema` (`index.ts:110-118`) — the envelope's payload parses against
   `PredictionV1RestorationPayloadSchema` (including the `DecimalProbabilitySchema` range
   check on `probabilityYes`, `packages/sdk/src/prediction-v1.ts:8-10`).
5. `solution.window` (`index.ts:120-131`) — the payload's `submittedAt` falls inside the
   task's claim window.
6. `market.identity` (`index.ts:231-250`) — the resolution snapshot's `marketId` matches
   exactly and `conditionId` matches case-insensitively (`index.ts:236`).
7. `market.resolution` (`index.ts:135-141`) — `PASS` when the snapshot is `resolved`,
   `INDETERMINATE` when `unresolved`, `FAIL` (with the raw status as detail) for any of the
   other three real status values (`invalid` / `cancelled` / `ambiguous`).

## Verdict derivation

`deriveVerdict` (`index.ts:223-229`): any check other than `market.resolution` reporting
`FAIL` yields `REJECTED` (mapped to the protocol verdict `fail`); any check reporting
`INDETERMINATE` — either `market.resolution` on an unresolved market, or
`integrity.signedTask_ref` when the expected task CID is missing from context — yields
`INDETERMINATE` (mapped to `inconclusive`); a resolved market with an outcome yields `SCORED`
(mapped to `pass`); otherwise `INVALID`. Per Finding C (binding on this plan), a harness can
only deliver `inconclusive` when the spec's own `verdictRule` recomputes to `inconclusive`
under a declared `inconclusiveWhen` predicate — the one `inconclusive` fixture here
(`inconclusive-market-unresolved`) sets `resolved: false`, a boolean `measurements` entry a
spec's `inconclusiveWhen` can key on directly.

## Brier basis

`scoreBrier` (`index.ts:252-273`): `brier = (probability - target)^2`, target `1` for `YES`
and `0` for `NO`; `spread = solverBrier - consensusBrier`. Scores are computed only when the
verdict is `SCORED` (`index.ts:143-145`) — a non-`SCORED` verdict never carries a score, which
is why every `fail`/`inconclusive` fixture below omits `solverBrier`/`consensusBrier`/
`brierSpread`.

## Decimal-string encoding

All three score fields are fixed six-fraction-digit decimal strings (`.toFixed(6)`,
`index.ts:269-271`) — never JSON numbers, per the I-JSON sealed-numbers rule.

## Provenance corrections

Four of the plan's cited ranges did not support the fixture they were attached to; all four
were verified against the real files and corrected before this module shipped:

1. **`adversarial-result-is-not-json`**, **`adversarial-result-is-not-utf8`**, and
   **`adversarial-result-is-empty`** all cited `index.ts:112-118` — the `catch` block that
   turns a thrown *schema-validation* error into a `solution.schema: FAIL` check. That catch
   wraps only `SignedEnvelopeSchema.parse` and `PredictionV1RestorationPayloadSchema.parse`
   (`index.ts:90-111`), i.e. failures on JSON that has already parsed successfully. The line
   that turns raw bytes into JSON, `JSON.parse(manifestJson)` (`index.ts:81`), sits *outside*
   that try/catch (the `try` starts at `index.ts:89`) and is unguarded: malformed, empty, or
   non-UTF-8-decoded input throws there, uncaught — crashing `run()` outright rather than
   producing a graceful check-based verdict. Corrected all three citations to `index.ts:80-81`.
   The fixtures' expected outcome (`fail`, not a crash) is kept as a deliberate normalization
   for this fresh-rewrite parser — treating unparseable raw solver-submitted content the same
   way the catch block treats a parseable-but-invalid envelope/payload (both are the solver's
   fault) — not a literal transcription of the legacy crash. Recorded here rather than
   silently ported; Task 7 (the parser) should treat this as a considered design choice to
   revisit, not an assumed given.
2. **`adversarial-probability-out-of-range`** cited `prediction-v0-evaluator/score.ts:8-22`.
   That file implements the *v0* Brier scheme (`SCORE_BASIS = 'brier.v1'`), superseded and not
   re-homed by this package (Task 2 finding E5) — and it does not itself validate probability
   range; it delegates to a different v0-only file, `canonical-metrics.ts#brierScore`. The v1
   pipeline actually being re-homed here rejects an out-of-range `probabilityYes` earlier and
   through a different mechanism entirely: `DecimalProbabilitySchema`
   (`packages/sdk/src/prediction-v1.ts:8-10`, `/^(0(\.\d+)?|1(\.0+)?)$/` — the `1(\.0+)?`
   branch only admits trailing zeros after the decimal point, so `"1.500000"` does not match)
   is enforced inside `PredictionV1RestorationPayloadSchema.parse(envelope.payload)`
   (`index.ts:110`), and a regex mismatch throws there, caught by the same `solution.schema`
   catch block as the three fixtures above. Corrected the citation to `index.ts:110-118`.

## Resolution-snapshot shape correction

The plan's `PredictionResolutionSnapshot.status` type was
`"resolved" | "unresolved" | "unavailable"`. Cross-checked against the real
`ResolutionSnapshot` interface at `client/src/venues/polymarket/client.ts:69-77`: the real
`status` enum is `'unresolved' | 'resolved' | 'invalid' | 'cancelled' | 'ambiguous'` — there is
no `'unavailable'` value anywhere in the legacy stack. This matches Task 2 finding E4, already
reflected in `../parsers/prediction-market.parser.json`. Corrected the type in
`fixtures.ts` to the real five-value enum; no existing fixture used the invalid `'unavailable'`
literal, so no fixture *value* changed.
