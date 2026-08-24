# DeFi long-tail protocol probe (historical)

This is a completed historical research artifact, not production code. No
runtime package imports or depends on this experiment.

It is preserved here so the scored run remains reproducible as an inert
record. It does not authorize a product claim, a follow-up issue, or
integration into Colophon, the operator, or any other shipped package.

## Status

The scored run completed **42 cells and passed 36**. Protocol familiarity in
pretraining did not predict success. Runtime documentation largely flattened
the familiarity gap.

The surviving failure surfaces were:

- exact-target execution
- excessive caution
- venue ambiguity
- approval hygiene

The work does **not** justify a product claim that obscure-protocol knowledge
is the primary wedge.

Keep [`RESULTS.md`](RESULTS.md), the preregistration, and the QA record
intact. Do not rewrite the reported result to make it more favorable.

## What is here

- Preregistration and amendment
- Protocol and task definitions
- Harness and scoring code
- Address and fixture documentation
- QA record
- Committed analysis in `RESULTS.md` (raw cell dumps lived outside git, under
  `~/defi-longtail-probe-runs/`, and are not part of this archive)
- Package manifests and lockfiles needed to install and typecheck

Do not treat `{{PRIVATE_KEY}}` placeholders as credentials. They are template
slots for throwaway Anvil wallets.

## Verification that is in scope

Deterministic, no-spend only:

```bash
npm ci
cd harness && npm ci && npx tsc --noEmit && npx tsc -p tsconfig.instances.json --noEmit
```

Do not rerun agent trials. Do not spend funds. Do not issue live protocol
transactions.
