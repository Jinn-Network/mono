# Phase 2: Add Second Service

**Prerequisites**: Phase 1 PASS
**Abort on failure**: Skip Phases 3, 4

## Steps

### 1. Preflight: service:add --dry-run

```bash
cd "$CLONE_DIR" && yarn service:add --dry-run
```

Expected: Detects existing service, auto-inherits staking contract, checks slot availability, shows what would be created. Exits 0 without deploying.

### 2. Run service:add

```bash
cd "$CLONE_DIR" && yarn service:add
```

The script will:
1. Detect the existing service and auto-inherit its staking contract
2. Create a new service config via the middleware API
3. Show funding requirements and exit

### 3. Fund and re-run

Fund the required addresses from the monorepo root:
```bash
yarn test:e2e:vnet fund <address> --eth <amount> --olas <amount>
```

Re-run to continue deployment:
```bash
cd "$CLONE_DIR" && yarn service:add
```

Repeat the fund + re-run cycle until the service is fully deployed and staked.

### 4. Verify: service:list

```bash
cd "$CLONE_DIR" && yarn service:list
```

Expected: Shows **2 services** with distinct config IDs, service IDs, and safe addresses. Both should show on-chain activity status.

### 4a. Assert mech delivery rates

After the second service is fully deployed, assert that every deployed mech matches the ecosystem standard delivery rate.
This is a **blocking gate** for Phase 3:

```bash
cd "$CLONE_DIR" && yarn tsx scripts/mech/assert-delivery-rates.ts --expected 99
```

Expected: The command exits `0` and reports `PASS` for every service mech. Any mismatch blocks worker execution.

### 5. Record addresses

After completion, get both service addresses:
```bash
cd "$CLONE_DIR" && yarn service:list 2>&1 | grep -i safe
```

Save to `.env.e2e`:
```bash
echo "SERVICE_B_SAFE=<second-safe-address>" >> .env.e2e
echo "AGENT_EOA_2=<second-agent-eoa>" >> .env.e2e
```

### 5a. Seed the credential bridge ACL

Both agents need ACL grants for the credential bridge. Seed once here after both services are deployed:

```bash
yarn test:e2e:vnet seed-acl "$CLONE_DIR"
```

Expected: `ACL seeded for 2 agent(s)` — both addresses listed.

## Expected Output

- Dry run: preflight passes, shows what would be created, exits 0
- First `service:add`: funding requirements printed (addresses + amounts)
- Subsequent runs: continues deployment, eventually reports staking success
- `service:list`: 2 services with distinct config IDs, service IDs, and safe addresses

## On Failure

- **Dry run fails**: Capture error. Check if first service exists in `.operate/services/`.
- **service:add fails**: Capture the exact error and which round of funding/re-run failed.
- **Staking fails**: Note the on-chain error (slot availability, bond amount, etc.)
- **service:list shows 1 service**: The add may have partially completed. Capture middleware API logs.
- **Quota exhaustion**: Record `yarn test:e2e:vnet status` output.

## CHECKPOINT: Phase 2 — Add Second Service

- [PASS|FAIL] `service:add --dry-run` completed preflight without error
- [PASS|FAIL] `service:add` completed (2nd service deployed and staked)
- [PASS|FAIL] `service:list` showed 2 services with distinct config IDs and safe addresses
- [PASS|FAIL] All deployed mechs have `maxDeliveryRate = 99` (`assert-delivery-rates.ts --expected 99`)
- [PASS|FAIL] ACL seeded — `cat .env.e2e.acl.json` shows 2 agent addresses under `grants`
