# `feature/oauth-credential-store` — Branch Overview

**Branch:** `feature/oauth-credential-store`
**Base:** `main`
**Scope:** ~50 commits · 193 files changed

---

## TL;DR

This branch solves two fundamental problems:

1. **Agents can now use web2 APIs** (Twitter, Umami, GitHub, etc.) via a secure credential bridge — without secrets ever touching the agent process.
2. **All inter-service auth is now cryptographic** — replacing spoofable `X-Worker-Address` headers with ERC-8128 signed requests.

---

## Why This Matters

Before this branch, Jinn agents were on-chain-only actors. They could dispatch jobs and interact with the marketplace, but had no secure way to call web2 APIs that require OAuth tokens or API keys. Credentials were either hardcoded as environment variables (insecure, doesn't scale) or simply unavailable.

Meanwhile, inter-service communication relied on a plain HTTP header (`X-Worker-Address`) for identity — trivially spoofable by anyone who knew the format.

---

## What's New

### 1. Credential Bridge

A new service (hosted in the x402-gateway) that brokers **credentials** on behalf of agents. It supports three credential types:

| Type | Mechanism | Examples |
|------|-----------|----------|
| **OAuth tokens** | Nango-brokered OAuth2 flows | Twitter |
| **Static API keys** | Keys stored in the gateway's env | OpenAI, Telegram, CivitAI, Railway, Supabase, Fireflies |
| **Login-based tokens** | Gateway logs in and caches JWT | Umami |

In all cases, agents never see the raw secrets — they request credentials through the bridge, which verifies identity, checks ACLs, enforces rate limits, and audits access.

```
Agent ──ERC-8128 signed request──▶ Credential Bridge
                                         │
                                    Verifies:
                                    ✓ Signature valid
                                    ✓ Operator has ACL grant
                                    ✓ Agent has an active job
                                    ✓ Rate limit not exceeded
                                         │
                                    Resolves credential:
                                    Static key? → return from env
                                    Login-based? → cached JWT
                                    OAuth? → fetch from Nango
                                         │
                                    Returns: time-limited
                                    access token + provider config
```

**Key concepts:**

- **ACL grants** — per-operator, per-provider. An operator with a grant for `twitter` can request Twitter OAuth tokens. Grants are stored in the database and managed via an admin API.
- **Trust tiers** — operators have a trust tier (`untrusted` by default, `trusted` when admin-promoted via `tierOverride`). Global credential policies define a minimum tier for each provider, and auto-provisioning automatically creates grants when an operator is promoted.
- **Venture-scoped credentials** — venture owners can register their own OAuth connections and control access via per-operator whitelists/blocklists and minimum trust tier gates. Supports two access modes: `venture_only` (no global fallback) and `union_with_global`.
- **Paid access (x402)** — each grant can have a `pricePerAccess` in USDC. When `price > 0`, the bridge returns HTTP 402 with payment requirements. The agent must include an `X-Payment` header containing a cryptographic USDC `transferWithAuthorization` proof, which is verified via the Coinbase CDP Facilitator before the credential is issued. This enables credential providers to monetise API access on-chain.
- **Job verification** — the bridge calls back to the Control API to confirm the requesting agent actually has an active job, preventing credential exfiltration.
- **Rate limiting** — per-address request throttling via Redis.
- **Audit logging** — every token issuance is logged with operator address, provider, venture context, payment details, and cost attribution.

**Admin API** (`/admin/*`):
- Register/list/promote operators
- Manage credential policies per provider
- Register venture-scoped credentials
- Manage venture operator whitelists/blocklists
- Query audit log

---

### 2. ERC-8128 Signed Auth

Every HTTP request between services is now cryptographically signed using [ERC-8128](https://eips.ethereum.org/EIPS/eip-8128) (RFC 9421 + Ethereum signatures):

| Before | After |
|--------|-------|
| `X-Worker-Address: 0xabc...` (spoofable) | ERC-8128 `signature` + `signature-input` + `content-digest` (cryptographically verified) |
| No replay protection | Nonce-based replay protection with TTL |
| No request integrity | Full body content-digest verification |

Adopted across all service boundaries:
- **Worker → Control API** — worker identity derived from signature, not a header
- **Agent → Credential Bridge** — signature proves the agent is acting on behalf of a specific operator
- **Credential Bridge → Control API** — job verification callbacks are signed

---

### 3. Signing Proxy (Private Key Isolation)

The agent subprocess **never has access to the private key**. A localhost HTTP proxy in the worker process mediates all signing operations:

```
┌─── Worker Process ────────────────────┐
│                                       │
│  Signing Proxy (127.0.0.1:{random})   │  ← has the private key
│  Bearer-token auth, endpoints:        │
│    GET  /address                      │
│    POST /sign          (EIP-191)      │
│    POST /sign-raw      (raw bytes)    │
│    POST /sign-typed-data (EIP-712)    │
│    POST /dispatch      (marketplace)  │
│         ▲                             │
│         │ HTTP                        │
│  Agent Subprocess (Claude / Gemini)   │  ← no key access
│                                       │
└───────────────────────────────────────┘
```

Even if the agent is compromised via prompt injection from IPFS content, it cannot extract the private key — only request signatures through the proxy's constrained API.

---

### 4. Credential-Aware Job Routing

Workers discover their credential capabilities at startup by probing the bridge:

- Jobs requiring credential-backed tools (e.g. `twitter_post` needs `twitter`) are only claimed by workers with matching ACL grants
- Credential jobs get priority routing to capable operators
- Per-job re-probing supports venture-scoped credentials — a worker may have different access depending on which venture dispatched the job

---

### 5. Security Hardening

- **IPFS injection protection** — agent input from IPFS is sanitised
- **Fail-closed auth** — if signature verification fails for any reason, the request is rejected (no fallback)
- **Strict input validation** — all credential bridge endpoints validate schemas
- **x402 payment verification** — EIP-712 `transferWithAuthorization` support for paid credential access
- **Environment namespace isolation** — `JINN_JOB_*` prefix enforced for dispatch env vars, `JINN_CTX_*` for worker context, with hard-fail validation

---

### 6. E2E Test Infrastructure

Full end-to-end testing framework for the credential flow:
- Docker-based Nango setup for OAuth simulation
- Credential session lifecycle tests
- ERC-8128 auth integration tests
- Skills synced as Claude commands for manual testing

---

## What This Unlocks

| Capability | Before | After |
|------------|--------|-------|
| Agents posting to Twitter | ❌ | ✅ Via credential bridge |
| Agents reading analytics | ❌ | ✅ Via credential bridge |
| Any new OAuth API | ❌ | ✅ Add to Nango + ACL grant |
| Spoofing worker identity | ⚠️ Trivial | ✅ Cryptographically impossible |
| Agent extracting private key | ⚠️ Key in env | ✅ Key never in agent process |
| Per-venture credential scoping | ❌ | ✅ Venture owners control access |
| Credential usage auditing | ❌ | ✅ Full audit trail |
| Paid API access (x402) | ❌ | ✅ On-chain payment verification |

---

## Migration Notes

- The `X-Worker-Address` header auth is **removed**. All services must use ERC-8128 signed requests.
- Workers need `X402_GATEWAY_URL` to use the credential bridge (graceful degradation if unset).
- Test scripts and integration tests have been updated to use signed auth.
- `AGENTS.md` updated to reflect new auth requirements.
