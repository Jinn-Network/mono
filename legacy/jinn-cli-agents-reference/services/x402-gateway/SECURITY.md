# x402 Gateway Security Model

**Status:** Current Implementation + Path to Safe Public Execution  
**Last Updated:** 2025-12-16

---

## Overview

The x402 gateway (`services/x402-gateway/`) exposes Jinn job templates as x402-paid callable services. This document describes the current security model, known gaps, and path to safe public execution.

**Core Security Problem:** Jinn agents can execute arbitrary tool calls (shell commands, file writes, git operations, web requests). Public exposure via x402 creates attack surface for:
- Arbitrary code execution on the worker/mech execution host
- Cost amplification via recursive dispatch
- Data exfiltration via web tools
- Resource exhaustion

---

## Target Architecture (Private-Tier Power Tools, Safe-by-Default)

**Goal:** External callers can trigger runs that have powerful tools (shell/git/fs). Safety comes from **hard boundaries** (isolation + policy enforcement), not from “weak tools.”

### Invariants
- **No caller-provided prompt input**: callers select `templateId@version` only; no free-form `input`/`context`.
- **Allowlisted requestors**: the worker only executes jobs whose on-chain `requester` (and/or `priorityMech`) is in an allowlist.
- **Isolated execution host**: runs execute inside a container, inside a VM (or equivalent), with no host mounts and minimal secrets.
- **Default-deny network egress**: only explicit allowlisted domains/IPs; block localhost/link-local/private ranges.
- **Auditability**: every run logs template version, tool policy, tool calls, artifacts, and hashes.
- **No open-web retrieval by default**: disable web search; allow only curated/allowlisted data sources.

### Components
- **Gateway (Railway)**:
  - Receives paid requests, returns `requestId`, exposes status/result reads.
  - Does not accept prompt input; does not “shape” the run beyond selecting `templateId@version`.
- **Template Registry (governed later, env-configured now)**:
  - Stores template content + enabled tools + pinned version.
  - Later: upgrade gated by governance; now: deployed config + Ponder indexing.
- **Worker / Mech Execution Pool**:
  - Claims jobs from Ponder/chain.
  - Enforces allowlist: `ALLOWED_REQUESTERS` (env var initially).
  - Enforces tool policy at runtime (defense in depth): strip disallowed tools even if payload is malicious.
  - Runs Gemini CLI with sandbox enabled, inside container/VM boundary.
- **Policy Layer (later)**:
  - Optional marketplace-level policy to reject non-allowlisted requesters before requests exist on-chain.

### Data Sources
- **Preferred**: chain/RPC reads, Ponder, IPFS artifacts, allowlisted APIs with stable schemas.
- **Disallowed by default**: open web search and arbitrary fetch.

### “Verifiable data” rule
Verifiable means **bounded + attributable + replayable**, not “credible sites.”
- bounded: the data source is allowlisted and schema-constrained
- attributable: tied to a signer/address + run hash + artifact hash
- replayable: reproducible query (block number / tx hash / CID / API response with receipt)

### Untrusted strings (including on-chain text)
Blockchain data can contain adversarial strings (calldata/logs/messages). Treat all free-form text as untrusted data:
- quote/escape it before it enters prompts
- never interpret it as instructions
- keep tool mediation strict so untrusted text cannot trigger privileged effects

---

## Current Implementation

### Safety Tiers

Three safety tiers control tool access (`services/x402-gateway/security.ts`):

| Tier | Description | Suitable For |
|------|-------------|--------------|
| `public` | Most restricted. Read-only tools only. | Untrusted callers on shared infrastructure |
| `restricted` | Moderate. Read-only + delegation with budget limits. | Semi-trusted callers |
| `private` | Full access. All tools available. | Trusted callers on isolated infrastructure |

### Tool Allowlists

**Public Tier (ALLOWED_TOOLS_PUBLIC):**
```typescript
[
  'google_web_search',      // Read-only web search
  'web_fetch',              // Read-only web fetch  
  'create_artifact',        // Create IPFS artifact (no local side effects)
  'search_artifacts',       // Read-only artifact search
  'get_details',            // Read-only Ponder query
  'search_similar_situations', // Read-only memory search
  'inspect_situation',      // Read-only memory inspection
  'list_tools',             // Metadata only
  'read_file',              // Read-only file access (sandboxed)
  'list_directory',         // Read-only directory listing (sandboxed)
]
```

**Blocked for Public (BLOCKED_TOOLS_PUBLIC):**
```typescript
[
  'run_shell_command',      // Arbitrary code execution
  'process_branch',         // Git write operations
  'write_file',             // Filesystem write
  'replace',                // Filesystem modification
  'delete_file',            // Filesystem deletion
  'dispatch_new_job',       // Recursive dispatch (cost amplification)
  'dispatch_existing_job',  // Re-dispatch (cost amplification)
]
```

### Enforcement Points

1. **Gateway Level** (`index.ts` lines 309-324):
   - `canExecutePublicly()` validates template's tools against safety tier
   - `filterToolsForTier()` strips disallowed tools before dispatch
   - Returns 403 if template requests restricted tools

2. **Worker Level** (`gemini-agent/toolPolicy.ts`):
   - `computeToolPolicy()` determines available tools per job
   - `isCodingJob` flag controls whether coding tools (write_file, process_branch, etc.) are included
   - MCP server only exposes tools in the computed policy

3. **Budget Validation** (`pricing.ts` lines 114-141):
   - Callers can specify `callerBudget` in execute request
   - Gateway rejects execution if estimated cost > budget
   - Prevents unbounded cost amplification for restricted tier

### Rate Limiting

Per-tier rate limits (not yet enforced at gateway):

| Tier | Requests/Min | Requests/Hour | Max Concurrent |
|------|-------------|---------------|----------------|
| public | 10 | 100 | 2 |
| restricted | 30 | 500 | 5 |
| private | 100 | 2000 | 20 |

---

## Security Gaps

### Critical (Must Fix Before Public Launch)

1. **No Runtime Sandboxing**
   - Current: Gateway is a thin dispatcher (e.g., Railway). The security boundary is the **worker/mech host** (today this can be local, which is unacceptable for public execution).
   - Risk: Public callers can trigger code/tool execution on a machine that has developer credentials, local network access, and persistent state.
   - Fix: Run mechs/workers on **cloud execution hosts** (not local). Isolation can be achieved by either:
     - **Ephemeral per-run instances** (fresh VM/instance per execution), or
     - **Per-template/per-tier dedicated hosts** with hardened OS + strict egress + least-privilege secrets.

2. **Tool Filtering at Gateway Only**
   - Current: Gateway filters tools, but IPFS payload is attacker-controlled input to workers.
   - Risk: Malicious payload could attempt to reintroduce blocked tools.
   - Fix (Implemented): Worker filters tools by `safetyTier` before agent execution (`worker/security/toolValidation.ts`) and logs a security audit record.

3. **No x402 Payment Verification**
   - Current: `// TODO: In production, verify x402 payment here` (line 341-343)
   - Risk: Execute endpoint is effectively free
   - Fix: Integrate x402 payment middleware

4. **Rate Limits Not Enforced**
   - Current: `RATE_LIMITS` defined but not applied
   - Risk: DoS via request flooding
   - Fix: Add rate limiting middleware (e.g., `hono/rate-limit`)

### High Priority

5. **`web_fetch` Allows SSRF**
   - Current: Public tier includes `web_fetch` without URL validation
   - Risk: Agent can fetch internal services (localhost, metadata endpoints)
   - Fix: Allowlist external domains only, block private IP ranges

6. **Caller-Provided Input Enables Prompt Injection**
   - Current: Execute endpoint accepts `input` and free-form `context` and injects them into the prompt context.
   - Risk: Caller-controlled prompt contamination (instruction hijacking, tool misuse attempts, policy bypass attempts).
   - Fix (Implemented for `public` tier): **Non-parameterized execution**. Public templates reject `input` and `context` and must be runnable without caller input (`services/x402-gateway/index.ts`).

7. **`read_file` Sandbox Unclear**
   - Current: Listed as "sandboxed" but no sandbox implementation visible
   - Risk: Could read sensitive files if agent has filesystem access
   - Fix: Explicit path allowlist or chroot jail

8. **No Output Size Limits**
   - Current: Agent output goes directly to IPFS
   - Risk: Unbounded output exhausts storage/bandwidth
   - Fix: Cap artifact size at gateway level

### Medium Priority

9. **Template Registration Not Gated**
   - Current: Templates come from Ponder (chain-indexed)
   - Risk: Anyone can create malicious templates
   - Fix: Template review process or reputation system

10. **No Caller Authentication**
   - Current: Execute endpoint accepts any request with payment
   - Risk: Can't track/block abusive callers
   - Fix: Optional API key or wallet signature for restricted tier

11. **Pricing Based on Historical Data**
    - Current: `computeTemplatePrice()` averages past delivery rates
    - Risk: First runs have no data, underpriced; malicious jobs manipulate history
    - Fix: Floor price per tool category, anomaly detection

---

## Path to Safe Public Execution

### Phase 1: MVP (Current)
- [x] Safety tier definitions
- [x] Tool allowlists
- [x] Gateway-level filtering
- [x] Budget validation
- [ ] **x402 payment verification** ← BLOCKING

### Phase 2: Production Hardening
- [ ] Cloud execution hosts (no local execution) + strong isolation (ephemeral instances or hardened dedicated hosts)
- [x] Worker-side tool validation (defense in depth)
- [ ] Rate limit enforcement
- [ ] SSRF protection for web_fetch
- [ ] Filesystem sandbox for read_file
- [ ] Output size limits

### Phase 3: Scale & Trust
- [ ] Template reputation/review
- [ ] Caller authentication for restricted tier
- [ ] Pricing anomaly detection
- [ ] Usage analytics and abuse detection
- [ ] Service-level SLAs

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        x402 Gateway                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Request Validation                                       │   │
│  │  ├── x402 payment verification (TODO)                     │   │
│  │  ├── Rate limit check (TODO)                              │   │
│  │  └── Budget validation ✓                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Security Policy Enforcement                              │   │
│  │  ├── Fetch template from Ponder                           │   │
│  │  ├── canExecutePublicly() ✓                               │   │
│  │  └── filterToolsForTier() ✓                               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Dispatch (mech-client-ts)                                │   │
│  │  ├── IPFS upload (blueprint + filtered tools)             │   │
│  │  └── On-chain marketplace request                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        OLAS Worker                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Job Claim                                                │   │
│  │  └── Fetch IPFS payload (includes tools from gateway)     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Tool Policy (gemini-agent/toolPolicy.ts)                 │   │
│  │  ├── computeToolPolicy(jobEnabledTools)                   │   │
│  │  └── ⚠️  TRUSTS IPFS payload - should re-validate         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Agent Execution (Gemini CLI)                             │   │
│  │  ├── MCP server with filtered tools                       │   │
│  │  └── ⚠️  NO SANDBOX - runs on worker host                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Security Guidelines for Template Creators

### Public Templates
- Use only read-only tools (`google_web_search`, `web_fetch`, `search_artifacts`)
- Do not request shell access or file writes
- Avoid recursive dispatch to prevent cost amplification
- Keep output deterministic and schema-validated

### Restricted Templates
- Delegation allowed but budget-capped
- No shell access or direct file manipulation
- Suitable for research and analysis workflows

### Private Templates
- Full tool access - use on isolated infrastructure only
- Not suitable for public x402 marketplace
- Requires trusted caller authentication

---

## Incident Response

If a malicious template is discovered:

1. **Immediate:** Update Ponder index to set template status = "hidden"
2. **Block:** Add template ID to gateway denylist (manual config for now)
3. **Investigate:** Review execution logs for scope of impact
4. **Remediate:** Fix security gap, deploy updated gateway
5. **Communicate:** Notify affected parties if data exposure

---

## References

- `services/x402-gateway/security.ts` - Safety tier definitions
- `services/x402-gateway/index.ts` - Gateway implementation
- `services/x402-gateway/pricing.ts` - Budget validation
- `gemini-agent/toolPolicy.ts` - Worker-side tool policy
- `docs/reference/blood-written-rules.md` §57 - Hackathon direction notes
