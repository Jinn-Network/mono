# Pre-smoke Session

Run this first. It is fully blocking.

## Command

```bash
yarn test:railway:canary:pre-smoke -- \
  --repo Jinn-Network/jinn-node \
  --branch <branch> \
  --worker-project jinn-worker \
  --worker-env production \
  --worker-service canary-worker-2 \
  --gateway-project jinn-shared \
  --gateway-env production \
  --gateway-service x402-gateway-canary \
  --workstream <workstream-id> \
  --operate-dir /Users/adrianobradley/jinn-nodes/jinn-node/.operate \
  --expected-delivery-rate 99
```

## Phases

| Phase | Name | Gate |
|---|---|---|
| 0 | Hard Preflight | Abort on fail |
| 1 | Deploy Correctness | Abort on fail |
| 2 | Baseline Worker Function | Abort on fail |
| 3 | Credential Authorization Matrix | Abort on fail |
| 4 | Job Filtering Behavior | Abort on fail |
| 5 | Fail-Closed + Security/Observability | Abort on fail |

## Required outcomes

1. Canary worker and gateway are redeployed and verified against expected repo/branch metadata.
2. Worker shows claim, execution, and delivery success for at least one real request.
3. Trusted vs untrusted credential behavior is enforced.
4. Credential-required job filtering works without starving non-credential jobs.
5. Logs show auth decisions and no secret leakage patterns.

## Output artifacts

Artifacts are written to `.tmp/railway-canary-e2e/<run-id>/`.

