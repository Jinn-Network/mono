# x402 Multi-Token Fork: EIP-2612 Permit Settlement

> Planning doc for forking x402 away from sole USDC dependence via EIP-2612 `permit` + `transferFrom`.

---

## Problem

x402 (Coinbase) hardcodes USDC as the only payment token. The protocol schema is token-agnostic (`asset: string` in `PaymentRequirements`), but the implementation never followed through:

- `ChainConfig` maps chain IDs to `{ usdcAddress, usdcName }` exclusively
- Settlement calls `transferWithAuthorization` (EIP-3009) — only implemented by Circle tokens (USDC, EURC)
- The Coinbase-operated facilitator at `x402.org/facilitator` only verifies/settles USDC
- `selectPaymentRequirements()` preferentially picks USDC when multiple options exist

Jinn prices in wei but settles in USDC. We want to accept any ERC-20 — starting with WETH, DAI, and venture tokens ($AMP2).

---

## Why EIP-2612 Permit

x402's current gasless model uses EIP-3009 `transferWithAuthorization` — the facilitator relays a signed transfer without the payer paying gas. Only USDC and EURC implement EIP-3009.

EIP-2612 `permit` is far more widely adopted:

| Standard | Tokens | Mechanism |
|----------|--------|-----------|
| EIP-3009 | USDC, EURC only | `transferWithAuthorization(from, to, value, ...)` — single signed call |
| EIP-2612 | DAI, WETH, UNI, AAVE, most modern ERC-20s | `permit(owner, spender, value, deadline, v, r, s)` + `transferFrom(from, to, value)` — two calls |

EIP-2612 requires two transactions (permit + transferFrom) but unlocks the entire ERC-20 ecosystem. The facilitator calls `permit` to gain allowance, then `transferFrom` to move tokens — both in a single transaction via multicall or sequential in one block.

---

## Architecture

### Current flow (x402 upstream)

```
Client                    Server (x402-hono)              Facilitator (x402.org)
  |                            |                                |
  |--- POST /endpoint -------->|                                |
  |<-- 402 + PaymentReqs ------|                                |
  |                            |                                |
  | sign TransferWithAuth      |                                |
  | (EIP-3009, USDC only)      |                                |
  |                            |                                |
  |--- POST + X-PAYMENT ------>|                                |
  |                            |--- /verify (payload) --------->|
  |                            |<-- { valid: true } ------------|
  |                            |                                |
  |                            |  [execute handler]             |
  |                            |                                |
  |                            |--- /settle (payload) --------->|
  |                            |    calls USDC.transferWithAuth  |
  |                            |<-- { success, txHash } --------|
  |<-- 200 + response --------|                                |
```

### Forked flow

```
Client                    Server (x402-hono)              Jinn Facilitator (self-hosted)
  |                            |                                |
  |--- POST /endpoint -------->|                                |
  |<-- 402 + PaymentReqs ------|                                |
  |    (asset: any ERC-20)     |                                |
  |                            |                                |
  | sign EIP-2612 permit       |                                |
  | (works with any token)     |                                |
  |                            |                                |
  |--- POST + X-PAYMENT ------>|                                |
  |                            |--- /verify (payload) --------->|
  |                            |    check permit sig + balance   |
  |                            |<-- { valid: true } ------------|
  |                            |                                |
  |                            |  [execute handler]             |
  |                            |                                |
  |                            |--- /settle (payload) --------->|
  |                            |    token.permit() then          |
  |                            |    token.transferFrom()         |
  |                            |<-- { success, txHash } --------|
  |<-- 200 + response --------|                                |
```

Key differences:
1. `PaymentRequirements.asset` can be any ERC-20 address
2. Client signs an EIP-2612 `permit` instead of EIP-3009 `transferWithAuthorization`
3. Facilitator is self-hosted, knows how to settle arbitrary tokens
4. Settlement is permit + transferFrom (atomic in one tx via batch)

---

## Fork Surface

### What changes

| Package | File/Area | Change | Size |
|---------|-----------|--------|------|
| `x402` | `src/shared/evm/config.ts` | Replace `ChainConfig` with generic `TokenConfig` supporting arbitrary ERC-20s | S |
| `x402` | `src/schemes/exact/evm/verify.ts` | Verify EIP-2612 permit signature instead of EIP-3009 auth | M |
| `x402` | `src/schemes/exact/evm/settle.ts` | Call `permit()` + `transferFrom()` instead of `transferWithAuthorization()` | M |
| `x402` | `src/schemes/exact/evm/createPayment.ts` | Sign EIP-2612 permit instead of EIP-3009 authorization | M |
| `x402` | `src/shared/evm/usdc.ts` → `token.ts` | Rename, generalize `getUsdcAddress` → `getTokenAddress` | S |
| `x402` | `src/shared/evm/eip3009.ts` → `eip2612.ts` | Replace authorization types with permit types | S |
| `x402` | `src/client/selectPaymentRequirements.ts` | Remove USDC preference; select by network + scheme only | S |
| `x402-hono` | No changes needed | Middleware already passes `asset` through | — |
| `@coinbase/x402` | Replace entirely | Self-hosted facilitator, no CDP dependency | M |
| **New** | `services/x402-facilitator/` | Self-hosted Hono facilitator (~200 LOC) | M |

### What stays the same

- `x402-hono` middleware — already asset-agnostic
- `PaymentRequirements` schema — already has generic `asset: string`
- `x402-fetch` client — already passes asset through
- Wire format (X-PAYMENT header, base64 encoding)
- 402 response structure
- `services/x402-gateway/` — only change is pointing `facilitator` config to self-hosted URL

---

## Implementation Plan

### Phase 1: Fork and generalize x402 (3-5 days)

1. **Fork `x402` to `@jinn/x402`**
   - Clone from `github.com/coinbase/x402` at tag v1.1.0
   - Publish as `@jinn/x402` (or use workspace package)

2. **Generalize ChainConfig**
   ```typescript
   // Before
   type ChainConfig = { usdcAddress: Address; usdcName: string };

   // After
   type TokenConfig = {
     address: Address;
     name: string;        // EIP-712 domain name (e.g. "Wrapped Ether")
     version: string;     // EIP-712 domain version
     decimals: number;
   };
   type ChainConfig = {
     defaultToken: TokenConfig;          // backwards compat: USDC
     tokens: Record<Address, TokenConfig>; // all known tokens
   };
   ```

3. **Replace EIP-3009 with EIP-2612 in the EVM scheme**

   New authorization types:
   ```typescript
   const permitTypes = {
     Permit: [
       { name: "owner", type: "address" },
       { name: "spender", type: "address" },  // facilitator address
       { name: "value", type: "uint256" },
       { name: "nonce", type: "uint256" },     // sequential, from token contract
       { name: "deadline", type: "uint256" },
     ],
   };
   ```

   New payload structure:
   ```typescript
   interface PermitPayload {
     owner: Address;
     spender: Address;     // facilitator's settlement address
     value: string;
     nonce: string;        // from token.nonces(owner)
     deadline: string;
     signature: Hex;
   }
   ```

4. **Update verify** — recover signer from permit signature, check token balance, validate deadline

5. **Update settle** — call `token.permit(owner, spender, value, deadline, v, r, s)` then `token.transferFrom(owner, payTo, value)` in a single multicall (or sequential, both in one tx submission)

6. **Update createPayment (client-side)** — query `token.nonces(owner)`, construct EIP-712 permit, sign with wallet

### Phase 2: Self-hosted facilitator (2-3 days)

A minimal Hono service with two endpoints:

```
POST /verify   — validate permit signature + token balance
POST /settle   — execute permit + transferFrom on-chain
GET  /health   — liveness check
```

The facilitator needs a **hot wallet** for gas (submitting the settlement tx). It does NOT hold user tokens — it gets temporary allowance via permit, immediately transfers to `payTo`, allowance is consumed.

**Environment:**
- `FACILITATOR_PRIVATE_KEY` — hot wallet for gas
- `RPC_URL` — Tenderly (per our rules)
- `SUPPORTED_TOKENS` — JSON map of chain → token addresses (optional, for allowlisting)

**Deploy:** Railway, same `jinn-shared` project as control-api.

### Phase 3: Wire into x402-gateway (1 day)

```typescript
// Before
import { createFacilitatorConfig } from "@coinbase/x402";
const facilitator = createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);

// After
const facilitator = {
  url: env.FACILITATOR_URL,  // self-hosted
  createAuthHeaders: async () => ({
    verify: { "Authorization": `Bearer ${env.FACILITATOR_SECRET}` },
    settle: { "Authorization": `Bearer ${env.FACILITATOR_SECRET}` },
  }),
};
```

Update route configs to specify non-USDC assets:
```typescript
{
  'POST /templates/:slug/execute': {
    price: { amount: '1000000', token: WETH_BASE },  // 0.001 WETH
    network: 'base',
  }
}
```

### Phase 4: Venture token support (1-2 days)

Enable payment in $AMP2 or other venture tokens:
- Add venture token addresses to ChainConfig
- Gateway queries on-chain price (Uniswap V2 LP or Doppler curve) for USD conversion
- Facilitator verifies permit and settles in the venture token
- Optional: auto-swap received tokens to WETH/USDC via the LP

---

## Token Compatibility Matrix

| Token | EIP-2612 permit | Notes |
|-------|:-:|-------|
| USDC | Yes (via EIP-3009, superset) | Still works; can use permit too |
| WETH | Yes | Base: `0x4200000000000000000000000000000000000006` |
| DAI | Yes (non-standard `permit` with `nonce` + `expiry`) | Needs DAI-specific permit type |
| EURC | Yes | Circle token, same as USDC |
| UNI | Yes | Standard EIP-2612 |
| $AMP2 | Yes (OpenZeppelin ERC20Permit) | Doppler launches include permit by default |
| USDT | No | No permit support; would need pre-approval flow |

---

## Risk Assessment

### Facilitator custody risk (Medium)

With EIP-3009, the facilitator is a pure relayer. With EIP-2612, the facilitator gets a temporary allowance. If compromised between `permit` and `transferFrom`, it could redirect tokens.

**Mitigations:**
- `permit` deadline = current block timestamp + 120 seconds (tight window)
- Settle atomically: permit + transferFrom in the same tx via multicall
- Facilitator hot wallet holds only gas ETH, never tokens
- Rate limiting on the facilitator endpoint

### Nonce management (Low)

EIP-2612 uses sequential nonces from the token contract (`nonces(owner)`). If a permit is created but never settled, the nonce is NOT consumed — it can be replayed or a new permit with the same nonce supersedes it. This is safe but the client must query the current nonce at payment time.

### Token allowlisting (Low)

Without an allowlist, anyone could request payment in a malicious token contract. The facilitator should maintain a `SUPPORTED_TOKENS` allowlist per chain. Start with USDC + WETH + EURC on Base.

### DAI permit non-standard (Low)

DAI uses a non-standard permit with `allowed: bool` instead of `value: uint256`. Requires a separate code path. Defer to Phase 4 or skip.

---

## Alternatives Considered

### A: EURC only (too narrow)
Just adding EURC to the config table. Minimal effort but doesn't solve the fundamental problem — still locked to Circle tokens and the Coinbase facilitator.

### C: Native ETH payments (too different)
Replace ERC-20 scheme entirely with ETH transfers. Natural for Jinn's wei-based pricing but breaks the gasless model and requires a new x402 scheme type. More work than B with less token breadth.

### D: ERC-20 `approve` + `transferFrom` (worse UX)
Skip permit entirely; require users to pre-approve the facilitator. Works with ALL ERC-20s but requires a separate approval transaction before each payment session. Bad UX for one-off API calls.

### E: Upstream contribution (too slow)
Contribute multi-token support back to coinbase/x402. Right approach long-term but we'd be blocked on their review cycle. Fork now, upstream later.

---

## Success Criteria

1. x402-gateway accepts WETH payments on Base for template execution
2. Self-hosted facilitator verifies and settles EIP-2612 permit payments
3. Existing USDC payments continue to work (backwards compatible)
4. Venture token ($AMP2) payments work with on-chain price discovery
5. No dependency on Coinbase CDP credentials for settlement

---

## Open Questions

- **Should we maintain EIP-3009 support for USDC?** Keeping both paths adds complexity but lets USDC users avoid the two-step permit flow. Recommendation: yes, detect at verify time based on payload structure.
- **Multicall contract or sequential?** Atomic permit+transferFrom via a multicall contract is safer but requires deploying a contract. Sequential in one tx submission is simpler. Start with sequential, upgrade if needed.
- **Price oracle for venture tokens?** Read from Uniswap V2 LP reserves, Doppler curve state, or Chainlink? LP reserves are cheapest but manipulable. Doppler `getState` is authoritative during bonding phase.
