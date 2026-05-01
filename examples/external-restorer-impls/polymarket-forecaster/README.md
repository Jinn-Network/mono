# @jinn-examples/polymarket-forecaster

Path 2 worked example for the Jinn plug-in surface: a Polymarket forecaster external restorer impl for `prediction.v0` on Base.

This is the warmest-cohort recruit's reference path — a Polymarket / Kalshi bot operator wrapping their existing forecasting pipeline as a Jinn restorer impl.

## What this shows

- Default-export factory shape (`ExternalRestorerEnv -> RestorerImpl`) per `spec/2026-05-external-restorer-impls.md` §3.2.
- `supports({ kind: 'prediction.v0', type: 'restoration' })` — claims restoration, declines evaluation.
- `isReady()` switches on `env.stub` so CLI introspection reports correctly.
- `run(ctx)` reads `ctx.intent.spec.marketId`, fetches a market snapshot, returns a `RestorationOutput` whose `gating.probability` is the forecast.
- A signed manifest (`jinn.manifest.json`) declares supported kinds + RPC capability allow-list. The PLACEHOLDER signature must be replaced before production use.

## Run the tests

```bash
yarn install
yarn test           # unit tests — offline, deterministic
yarn test:e2e       # Anvil-fork test (skipped if anvil is not on PATH)
yarn build          # produces dist/
```

## Wiring into the daemon

Once the daemon's external-impl loader integration ships (Plan §5.7-5.8 follow-up), an operator's `~/.jinn-client/config.json` declares:

```json
{
  "trustedImplSigners": [
    { "alg": "ed25519", "publicKey": "<your base64 pubkey>", "label": "polymarket-forecaster author" }
  ],
  "restorers": {
    "externalImpls": [
      {
        "name": "@jinn-examples/polymarket-forecaster",
        "entry": "/path/to/node_modules/@jinn-examples/polymarket-forecaster"
      }
    ]
  }
}
```

The daemon loads, signature-verifies, factory-constructs, and dispatches the impl on matching `prediction.v0` intents.

## Polymarket client

`src/polymarket-client.ts` ships a deterministic stub keyed off `marketId` so unit tests run offline. Real builders replace the body with a real Polymarket gamma-markets API call:

```ts
const r = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
const market = await r.json();
return {
  marketId,
  question: market.question,
  endTimeIso: market.end_date_iso,
  yesPrice: Number(market.outcomePrices?.[0] ?? 0),
};
```

## Spec

- `spec/2026-04-30-plug-in-surface.md` §3.3.1 — forecaster pattern.
- `spec/2026-05-external-restorer-impls.md` §3 — loader contract.
- `spec/2026-05-executor-trust-boundary.md` §5 — manifest signing.
