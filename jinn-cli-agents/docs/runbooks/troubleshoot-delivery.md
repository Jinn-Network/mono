---
title: Troubleshoot Delivery
purpose: runbook
scope: [worker]
last_verified: 2026-01-30
related_code:
  - worker/delivery/transaction.ts
  - worker/delivery/ponderVerification.ts
  - worker/status/autoDispatch.ts
keywords: [delivery, transaction, safe, nonce, gas, verification, ponder, idempotency]
when_to_read: "When debugging Safe transaction failures, nonce conflicts, or delivery verification issues"
---

# Troubleshoot Delivery

Debugging Safe transaction and delivery failures.

## Error Reference

| Symptom | Cause | Fix |
|---------|-------|-----|
| `nonce too low` | Pending tx used expected nonce | Wait for pending tx; retries with 15-240s backoff (5 attempts) |
| `replacement transaction underpriced` | Concurrent tx with same nonce | Auto-retries; increase gas if persistent |
| `Transaction not found` | RPC returned before confirmation | Hybrid check verifies on-chain state; often already delivered |
| `RpcVerificationError` | RPC failed after 5 retries | Falls back to Ponder verification automatically |
| `Request already delivered` | Idempotent check passed | Normal behavior; no action needed |
| `Request was revoked` | Mech contract revoked during delivery | Check contract state; re-dispatch job if needed |
| `Safe address has no contract code` | Safe not deployed on chain | Deploy Safe or use direct EOA delivery |
| `Missing Safe delivery configuration` | No `JINN_SERVICE_SAFE_ADDRESS` or key | Set required env vars |
| `Delivery transaction already pending` | Duplicate delivery attempt | Wait for pending tx (3-min timeout) |

## Idempotency Handling

The delivery system tracks pending transactions to prevent duplicates:

```
pendingDeliveries Map: requestId -> { txHash, timestamp }
```

**Stale entries cleared after 3 minutes.**

Before delivery:
1. Clear stale pending entries
2. Check if pending delivery exists for this request
3. If pending, verify its transaction receipt
4. If receipt exists and succeeded, return existing hash
5. If no receipt (still pending), throw "already pending"

## Gas Estimation Issues

Gas estimation failures typically manifest as:
- Transaction reverts during estimation
- Underpriced transaction errors

**Debug nonce state:**
```bash
# Check agent wallet nonces
cast nonce $AGENT_ADDRESS --rpc-url $RPC_URL
cast nonce $AGENT_ADDRESS --block pending --rpc-url $RPC_URL
```

The code logs nonce state at DEBUG level before each delivery attempt:
- `latestNonce`: Confirmed transaction count
- `pendingNonce`: Including pending txs
- `pendingTxCount`: Gap between them

## Nonce Conflicts

Nonce issues trigger automatic retries with exponential backoff:

| Attempt | Backoff |
|---------|---------|
| 1 | 15s |
| 2 | 30s |
| 3 | 60s |
| 4 | 120s |
| 5 | 240s (max) |

Before each retry:
1. Re-verify request is still undelivered
2. If already delivered, return success
3. If verification fails, abort entirely

## Verification Flow

Delivery status verified via dual strategy:

```
verifyUndeliveredStatus()
    |
    v
[RPC Check] --> success --> return
    |
    | RpcVerificationError
    v
[Ponder Fallback] --> success --> return
    |
    | error
    v
Throw "Unable to verify delivery status"
```

**RPC verification** (`isUndeliveredOnChain`):
- Queries `getUndeliveredRequestIds()` in 100-item batches
- Exponential backoff: 1s, 2s, 4s, 8s, 16s (5 retries)
- Safety limit: 20,000 offset max

**Ponder verification** (`checkDeliveryStatusViaPonder`):
- GraphQL query for `requests.delivered` field
- Exponential backoff: 1s, 2s, 4s (3 retries)

## Transaction Not Found Recovery

When `deliverViaSafe` throws "Transaction not found":

1. Worker queries on-chain state via hybrid check
2. If request no longer in undelivered set, assume success
3. Return `{ status: 'confirmed', tx_hash: undefined }`

## Revocation Detection

After successful delivery, worker checks for `RevokeRequest` event:

```typescript
wasRequestRevoked({ txHash, requestIdHex, mechAddress, rpcHttpUrl })
```

Parses transaction receipt logs for:
- Event signature: `keccak256('RevokeRequest(bytes32)')`
- Contract address matches mech
- Data field contains requestId

If revoked: throws "Request was revoked by the Mech contract during delivery"

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `JINN_SERVICE_SAFE_ADDRESS` | Safe wallet address | Yes |
| `OPERATE_PASSWORD` | Keystore decryption password | Yes |
| `RPC_URL` | Ethereum RPC endpoint | Yes |
| `PONDER_GRAPHQL_URL` | Ponder GraphQL endpoint | Fallback |

## Diagnostic Commands

```bash
# Check Safe deployment
cast code $JINN_SERVICE_SAFE_ADDRESS --rpc-url $RPC_URL

# Check if request is undelivered on-chain
cast call $MECH_ADDRESS "getUndeliveredRequestIds(uint256,uint256)" 100 0 --rpc-url $RPC_URL

# Check transaction receipt
cast receipt $TX_HASH --rpc-url $RPC_URL

# Query Ponder for delivery status
curl -X POST $PONDER_GRAPHQL_URL \
  -H "Content-Type: application/json" \
  -d '{"query":"{ requests(where:{id:\"REQUEST_ID\"}) { items { delivered transactionHash } } }"}'

# Check agent nonce state
cast nonce $AGENT_ADDRESS --rpc-url $RPC_URL
```

## Delivery Payload Structure

Built by `buildDeliveryPayload()` in `worker/delivery/payload.ts`:

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Mech request ID |
| `output` | string | Agent execution output |
| `telemetry` | object | Execution telemetry |
| `artifacts` | array | IPFS artifacts (`{cid, topic, name?, type?}`) |
| `status` | string | COMPLETED \| DELEGATING \| WAITING \| FAILED |
| `jobDefinitionId` | string? | UUID for job tracking |
| `jobName` | string? | Human-readable job name |
| `workerTelemetry` | object? | Worker-level metrics |
| `measurementCoverage` | object? | Blueprint measurement results |

## Delivery Flow

```
deliverViaSafeTransaction(context)
    |
    v
[Check Safe deployed] --> no --> throw "no contract code"
    |
    v
[Clear stale pending deliveries]
    |
    v
[Check pending delivery exists] --> yes --> verify receipt --> return/throw
    |
    v
[verifyUndeliveredStatus] --> already delivered --> throw "already delivered"
    |
    v
[Build delivery payload]
    |
    v
[deliverViaSafe with retries] --> track in pendingDeliveries
    |
    v
[Check for RevokeRequest event] --> revoked --> throw
    |
    v
Return { tx_hash, status }
```
