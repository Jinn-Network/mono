---
name: node-railway-mainnet-testing
description: End-to-end canary validation for jinn-node on Railway/Base mainnet. Runs strict pre-smoke gates first, then optional 30-minute smoke gate after successful delivery evidence.
allowed-tools: Bash Read Edit Write Glob Grep
user-invocable: true
disable-model-invocation: true
---

# Railway Mainnet Canary Testing

Use this skill to validate canary worker + canary gateway behavior on Railway with strict pass/fail gates.

## Sessions

| Session | Argument | What it tests | Reference |
|---|---|---|---|
| **Pre-smoke** *(default)* | `pre-smoke` | Preflight, deploy correctness, baseline delivery, credential auth, job filtering, fail-closed/security | [pre-smoke-session.md](references/pre-smoke-session.md) |
| **Smoke** | `smoke` | 30-minute stability window after pre-smoke PASS | [smoke-session.md](references/smoke-session.md) |

## Rules

1. `pre-smoke` must pass before `smoke` is allowed.
2. This is a test workflow only. Do not change production logic to make tests pass.
3. Stop at failed phase gates and report diagnostics.
4. Keep artifacts in `.tmp/railway-canary-e2e/<run-id>/`.

## Default Command

```bash
yarn test:railway:canary -- \
  --session pre-smoke \
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

## Checkpoint + Final Report

Use the checkpoint format defined in [checkpoints.md](references/checkpoints.md).

Always write:
- `preflight.json`
- `deploy.json`
- `dispatch-results.json`
- `credential-matrix.json`
- `logs-security.json`
- `checkpoint.md`
- `final-report.md`

## Troubleshooting

See [troubleshooting.md](references/troubleshooting.md).
