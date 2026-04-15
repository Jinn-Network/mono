# Phase 0: Infrastructure + Clone

**Prerequisites**: None (first phase)
**Abort on failure**: Abort entire run

## Steps

### 1. Run bootstrap

Ask the user which branch to test, then:

```bash
yarn test:e2e:bootstrap --branch <branch>
```

This single command:
- Cleans up stale VNets
- Creates a fresh Tenderly VNet (Base fork)
- Starts local stack (Ponder, Control API, Gateway) as detached processes
- Waits for all health checks
- Clones jinn-node at the specified branch, installs deps, configures `.env`

Read `CLONE_DIR` from `.env.e2e` for subsequent phases:
```bash
CLONE_DIR=$(grep CLONE_DIR .env.e2e | cut -d= -f2-)
```

## Expected Output

- `Bootstrap Complete` banner with VNet ID, RPC URL, clone directory, and service PIDs

## On Failure

- **VNet creation fails**: Check `.env.test` has valid `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT_SLUG`, `TENDERLY_PROJECT_SLUG`.
- **Ponder fails to start**: Check if port 42069 is in use. Check if `.ponder` cache was cleaned.
- **Control API fails to start**: Check `.env` has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- **Clone fails**: Check branch name exists. Check HTTPS access to the repo.

## CHECKPOINT: Phase 0 — Infrastructure + Clone

- [PASS|FAIL] VNet created (RPC_URL in `.env.e2e`)
- [PASS|FAIL] Ponder healthy (`http://localhost:42069/graphql` responds)
- [PASS|FAIL] Control API healthy (`http://localhost:4001/graphql` responds)
- [PASS|FAIL] Gateway healthy (`http://localhost:3001/health` responds) — non-fatal
- [PASS|FAIL] Clone created and dependencies installed (`CLONE_DIR` in `.env.e2e`)
