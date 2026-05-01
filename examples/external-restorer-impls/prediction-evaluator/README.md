# @jinn-examples/prediction-evaluator

Path 2 worked example: a custom-scoring evaluator for `prediction.v0`.
Wraps Brier loss plus the Murphy 1973 reliability/resolution/uncertainty
decomposition, against a deterministic stub oracle so unit tests run
offline.

## What this shows

- Default-export factory shape per
  `spec/2026-05-external-restorer-impls.md` §3.2.
- `supports({ kind: 'prediction.v0', type: 'evaluation' })` — claims
  evaluation, declines restoration. Mirror image of the forecaster
  pattern.
- `run(ctx)` reads the restoration envelope under evaluation
  (`ctx.intent.spec.restorationUnderEvaluation.forecastProbability`),
  fetches the resolved outcome, computes a Brier score, and emits a
  `verdictPayload` shaped like `{ score, scoringRule, resolvedOutcome,
  resolvedAt }`.
- `gating` carries the same score so evaluator selection logic upstream
  can route on it.
- Calibration math (`brier`, `decomposeBrier`) is exposed as a named
  export so other impls can import the helper without inheriting the
  evaluator factory.
- A signed manifest (`jinn.manifest.json`) declares supported kinds +
  RPC capability allow-list. The PLACEHOLDER signature must be replaced
  before production use.

## Run the tests

```bash
yarn install
yarn test           # unit tests — offline, deterministic
yarn build          # produces dist/
```

## Coexistence with the in-repo evaluator

If your evaluator targets `prediction.v0` and there is already an
in-repo evaluator for that kind
(`client/src/restorer/impls/prediction-v0-evaluator/`), the daemon
registers the in-repo one by default and excludes yours per
`spec/2026-05-external-restorer-impls.md` §3.4 step 8
(`impl-name-collision` resolution).

To run your evaluator instead of the in-repo one, add to your daemon
config:

```jsonc
{ "restorers": { "disabled": ["prediction-v0-evaluator"] } }
```

## Oracle stub

`src/oracle-stub.ts` ships a deterministic outcome keyed on
`intentId`, so unit tests run offline. Real builders replace the body
with a live oracle call:

```ts
const r = await fetch(`https://oracle.example.com/markets/${intentId}`);
const { outcome, resolvedAt } = await r.json();
return { intentId, resolvedOutcome: outcome, resolvedAt };
```

## Spec

- `spec/2026-04-30-plug-in-surface.md` §3.3.2 — evaluator pattern.
- `spec/2026-05-external-restorer-impls.md` §3 — loader contract.
- `spec/2026-05-executor-trust-boundary.md` §5 — manifest signing.
- Murphy, A. H. (1973). A new vector partition of the probability score.
  *Journal of Applied Meteorology*, 12(4), 595-600.
