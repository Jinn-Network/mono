# Smoke Session

Run only after `pre-smoke` has passed and delivery evidence exists.

## Command

```bash
yarn test:railway:canary:smoke -- \
  --repo Jinn-Network/jinn-node \
  --branch <branch> \
  --worker-project jinn-worker \
  --worker-env production \
  --worker-service canary-worker-2 \
  --gateway-project jinn-shared \
  --gateway-env production \
  --gateway-service x402-gateway-canary \
  --smoke-duration-minutes 30
```

If needed, point smoke to a specific pre-smoke run:

```bash
yarn test:railway:canary:smoke -- --pre-smoke-run-id <run-id>
```

## Gates

1. Preconditions: prior pre-smoke summary exists with PASS + successful delivery.
2. 30-minute monitoring window.
3. No mech-resolution regression markers.
4. No repeated credential error loops.
5. No secret/token leakage markers in logs.

## Output

Smoke writes the same report files in a new run directory under `.tmp/railway-canary-e2e/`.
