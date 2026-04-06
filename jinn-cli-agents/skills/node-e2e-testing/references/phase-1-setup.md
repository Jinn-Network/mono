# Phase 1: Setup & Docker

**Prerequisites**: Phase 0 PASS
**Abort on failure**: Abort entire run

## Steps

### 1. Run setup (iterative)

Setup pauses when funding is needed, prints exact addresses and amounts. Fund and re-run until it completes:

```bash
cd "$CLONE_DIR" && yarn setup
# Read funding requirements from output, then from monorepo root:
yarn test:e2e:vnet fund <address> --eth <amount> --olas <amount>
cd "$CLONE_DIR" && yarn setup
# Repeat until complete.
```

After setup, record addresses from the output. Save to `.env.e2e`:
```bash
echo "OPERATE_PASSWORD=e2e-test-password-2024" >> .env.e2e
echo "AGENT_EOA_1=<agent-eoa-address>" >> .env.e2e
echo "SERVICE_A_SAFE=<service-safe-address>" >> .env.e2e
```

**CRITICAL**: `OPERATE_PASSWORD` must be in `.env.e2e` because the stolas setup encrypts agent keystores. The dispatch script loads `.env.e2e` last with `override: true`, so this takes precedence over any stale value in `.env` or `.env.test`.

### 2. Build Docker image

```bash
docker build -f jinn-node/Dockerfile jinn-node/ -t jinn-node:e2e
```

If the build fails with `ECONNRESET`, retry — earlier layers are cached.

## On Failure

- **Setup fails after funding**: Capture the exact error. Record what funding was requested vs what was provided.
- **Docker build fails**: Capture build output. If `ECONNRESET`, note it for retry. If compilation error, capture the TypeScript error.

## CHECKPOINT: Phase 1 — Setup & Docker

- [PASS|FAIL] `yarn setup` completed (service staked)
- [PASS|FAIL] Docker image built (`jinn-node:e2e`)
