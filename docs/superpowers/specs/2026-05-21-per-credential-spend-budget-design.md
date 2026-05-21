# Daily spend budget per credential — design spec

**Version:** 1.0
**Date:** 2026-05-21
**Author:** adrianobradley + Claude
**Tracks:** [#346](https://github.com/Jinn-Network/mono/issues/346) (feat: daily spend cap + claim-loop pause for paid-API-key harnesses)

This spec defines a daily spend budget for the Jinn client daemon. It is a **structural** design spec — the implementation plan is produced separately via `writing-plans`. It builds on PR #345 (cost surfacing + per-task confirmation gate), which landed on `next`; the implementation of this spec branches from `next`, where `client/src/harnesses/cost-estimates.ts` exists.

---

## 1. Problem

The daemon autonomously pulls paid work in a loop. An operator who confirms the per-task cost gate once (#345) and then walks away has **unbounded financial downside** — the claim loop keeps pulling fresh tasks, each spending real money against a paid API key, until the operator discovers it on next month's provider invoice.

PR #345 bounds *per-task* surprise ($1/task confirmation gate). It does not bound *accumulation*: many small tasks, or one long unattended run, still has no ceiling.

## 2. Reframe — what this cap is, and is not

Every credential already has a hard spend floor that is **not Jinn's to build**:

- **Anthropic / OpenAI API keys** — the provider console exposes monthly spend limits.
- **OpenRouter** — prepaid credits *are* a hard cap; you cannot spend credits you have not loaded.
- **Subscriptions** (`CLAUDE_CODE_OAUTH_TOKEN`, ChatGPT-auth Codex) — the flat fee *is* the cap; you cannot be billed more.

So Jinn's daily cap is **not** the last line of defense against a runaway bill — the provider is. Jinn's cap is the **graceful-pause layer**: it stops the daemon *claiming* work cleanly, *before* it begins hitting provider limits and **failing** tasks. Hitting a provider cap is a crash — every subsequent task errors, burning gas on claims, missing delivery windows, and denting on-chain standing. Hitting Jinn's cap is a clean stop.

Two consequences shape the whole design:

1. **The cap does not need to be accurate.** It is a blast-radius / graceful-stop control with a hard provider floor underneath. "Roughly right and fail-safe" is the entire requirement. Penny-accuracy is the provider invoice's job.
2. **The cap should be accompanied by a provider-cap nudge.** The highest-value, lowest-code element of this feature is telling the operator to go set a monthly limit at their provider — that is their real safety net.

## 3. Model — the credential is the unit of accounting

The unit is the **credential**: the authentication a task's work is billed against. Not the harness (the same harness flips between subscription and API by which env var is set) and not the operator (one operator may hold several credentials, each a separate wallet).

A credential is identified by a readable string:

```
CredentialId = `${provider}:${authMethod}`
  e.g. anthropic:api-key · anthropic:subscription · openai:api-key
       openai:subscription · openrouter:api-key · nous:api-key
```

No registry, no fingerprint hash, no secret handling — a v1-testnet operator runs one, occasionally two, credentials, and a readable id is one the operator can write into config directly. (If two keys of the same provider ever need to be told apart, a fingerprint suffix is a backward-compatible addition then — YAGNI now.)

There is **no `subscriptionPath` branching** in the mechanism. A subscription is just a credential whose USD figure is a quota-pressure proxy rather than real money. The subscription/API distinction survives only as UX nuance (§7): an API-key cap defaults meaningfully; a subscription cap is optional and off by default.

## 4. Architecture

Five pieces, all in `client/`. None is large; the "ledger" is two query functions over a table the daemon already writes.

### 4.1 Credential resolution — `resolveCredentialId()`

A pure function: `(harnessName, env, harnessConfig) → CredentialId | null`.

- **claude-code** — `CLAUDE_CODE_OAUTH_TOKEN` present → `anthropic:subscription`; else `ANTHROPIC_API_KEY` present → `anthropic:api-key`.
- **codex** — `OPENAI_API_KEY` present → `openai:api-key`; else (ChatGPT auth via `CODEX_HOME`) → `openai:subscription`.
- **hermes-agent** — `${hermesProvider}:api-key`, where `hermesProvider` is the configured provider (`anthropic` / `openai` / `openrouter` / `nous`).
- **prediction-v0/v1-baseline** — no LLM call → `null` → never capped.

This is the runtime auth-path detection the #346 comment asks for, reduced to one small function reading env-var presence. It is the basis for closing the #331 blind spot (§9).

### 4.2 Usage capture — per-harness parsers

Each LLM harness adapter's run result gains a `usage` field:

```ts
interface HarnessUsage {
  model: string;
  costUsd: number;
  estimated: boolean;   // false = from observed tokens / self-reported cost; true = a-priori heuristic
}
```

- **claude-code** — parse `.claude-code/stdout.jsonl` (already written by the adapter) for the terminal `result` message; take `total_cost_usd` and `usage`. `estimated: false`. Anthropic's own number — most authoritative available.
- **codex** — parse `.codex-code/stdout.jsonl` for the `turn.completed` event's `usage` (token counts); price via `tokenlens` (§4.3). `estimated: false`.
- **hermes-agent** — opaque (the daemon spawns the `hermes` binary and never sees its API calls). Fall back to the a-priori heuristic (`estimateModelCost` from `cost-estimates.ts`). `estimated: true`.

`parseClaudeCodeUsage()` / `parseCodexUsage()` are small, pure, fixture-tested functions.

### 4.3 Pricing — `tokenlens`

Add the `tokenlens` npm dependency (pure TypeScript, MIT, syncs its catalog from `models.dev`). A `priceTokens(model, tokenCounts) → usd` helper wraps it. This replaces hand-maintenance of per-model rates and avoids a stale rate table.

Pricing is load-bearing **only for the Codex path** — Claude Code self-reports USD, and hermes uses the heuristic. The `MODEL_COST_TABLE` in `cost-estimates.ts` is retained only for its *typical-token-count* shape, used by the hermes/unknown-model fallback; its per-token rates are superseded by `tokenlens`.

### 4.4 The ledger — three columns on `activity_events`, two query functions

There is **no separate ledger table**. #346 already requires recording each completed task's model and cost on its activity row. That row *is* the ledger.

Add to `activity_events` (`client/src/store/store.ts`, via the existing `addColumn` migration pattern, ~line 534):

| Column | Type | Meaning |
|---|---|---|
| `credential_id` | `TEXT` | set only on cost-bearing rows; `NULL` elsewhere |
| `cost_usd_micros` | `INTEGER` | cost in **integer micro-dollars** (no float drift) |
| `model` | `TEXT` | model the task ran |

Add index `idx_activity_events_credential ON activity_events (credential_id, ts)`.

Cost is recorded **exactly once per task, at terminal state**, deduped by `request_id`. Because `credential_id` is non-null only on cost-bearing rows, the spend query needs no `kind` filter:

```ts
spentTodayMicros(credentialId): number
  // SELECT COALESCE(SUM(cost_usd_micros),0) FROM activity_events
  //   WHERE credential_id = ? AND ts >= <UTC-midnight ISO>

recentSpend(credentialId, limit): CostedActivityRow[]   // per-task breakdown for the UI
```

Calendar-day reset is **implicit** — yesterday's rows simply stop matching the `ts >= midnight` bound. No reset job, no window-expiry logic.

### 4.5 The gate — `gateClaimBySpendCap()`

A new `client/src/daemon/spend-cap-gate.ts`, modeled exactly on `client/src/daemon/readiness-gate.ts`. Wired into `daemon.ts:_runEngineWatcherLoop`, as a sibling pre-claim gate immediately after `gateClaimByReadiness` and before the cost-mutating `adapter.claimTask()`:

```
resolve credential for the task's harness
  → null?                     proceed (no LLM cost)
  → no cap configured?        proceed
  → spentToday ≥ cap?         skip the claim (continue):
                                · emit a one-time `spend_cap_reached` activity
                                  event per (credential, UTC day), deduped
                                · the loop keeps running — other credentials
                                  and free harnesses keep claiming
  → otherwise                 proceed
```

Per-credential budgets make the pause **selective for free**: only claims routing to an exhausted credential skip; everything else flows. (This is why the earlier "what should pause" question dissolved — the model answers it.)

## 5. Data flow

```
CLAIM TIME  (engine-watcher loop, before adapter.claimTask)
  resolveCredentialId(harness, env) → credentialId
  cap = config.spendCaps[credentialId]
  if cap and store.spentTodayMicros(credentialId) ≥ cap*1e6:
      skip claim · emit spend_cap_reached (once/day) · continue

COMPLETION  (task reaches terminal state)
  usage = harness run result .usage   (parsed from the adapter's own output)
  store.recordActivityEvent({ ..., credentialId, model: usage.model,
                              costUsdMicros: round(usage.costUsd * 1e6) })
  (recorded once per task, deduped by request_id)
```

No reserve, no settle, no two-phase ledger. The running total is the **real completed spend**. Overshoot is bounded by in-flight work — and #345's per-task gate already bounds per-task cost — so on a $20 envelope the slop is a few dollars. Acceptable for a graceful-pause layer (§2).

## 6. Configuration

```jsonc
// ~/.jinn-client/config.json
{
  "spendCaps": {            // optional; default {} = no caps anywhere
    "anthropic:api-key": 20 // USD per UTC day, per credential
  }
}
```

- Config-file map; **restart-required**, like `joinedSolverNets` (the daemon does not hot-reload it).
- Env convenience: `JINN_SPEND_CAP_USD=<n>` applies a blanket cap to *every* resolved credential (handy for CI / single-credential operators). A per-credential entry in the file overrides the blanket value for that credential.
- `JinnConfigSchema` (Zod, `client/src/config.ts`) gains `spendCaps: z.record(z.string(), z.number().positive()).optional()`. Add `JINN_SPEND_CAP_USD` to `TRACKED_ENV_VARS`.
- The unknown-model fallback cost (§8) is a documented code constant, not config.

## 7. Operator-facing surface — a new OPERATOR-APP-SPEC component

`client/OPERATOR-APP-SPEC.md` models the operator app as **components**, each on four axes (Static / Streams / Actions / State messages), with the discipline that *a field belongs to exactly one component*. The spend budget cross-cuts §2.4 Network Memberships — one credential bills the work of every SolverNet on that harness — so, exactly as §2.9 Harness Readiness is surfaced component-level "so the operator fixes it once, not per SolverNet," the spend budget is **its own component**: not a per-SolverNet field, and not a §2.11 Settings value (the cap is inseparable from live spend telemetry, which Settings does not hold).

### 7.1 The Spend component

A new component, sibling of §2.3 Funds — Funds models the ETH the node consumes and its runway; Spend models the fiat it consumes and its headroom. Keyed **per credential**:

- **Static (per credential)** — credential (`provider:authMethod`); kind (paid API key / subscription); spent today (USD; subscription = USD-equivalent, informational); daily cap (USD; unset = none); claims-paused; resets-at (next UTC midnight).
- **Actions** — set / change / clear daily cap. Restart-required → raises `restart_required` (§3.2); §2.1 Daemon exposes the satisfying restart.
- **Streams** — none new. Per-task cost is added as `cost` + `model` fields on the **shared event vocabulary** (OPERATOR-APP-SPEC §3.3), annotating the existing §2.4 action stream — this is #346's "per-task breakdown."
- **State messages** — `daily spend cap reached` (warning — this credential's claims paused until UTC reset); `provider spend limit not set` (info — the provider-cap nudge, paid-API-key credentials only). `spend_cap_reached` joins the §2.10 canonical notification taxonomy.

API-key credentials present the cap as a meaningful control; subscription credentials show spend as informational USD-equivalent with the cap optional and labelled a throttle guard (§3). Same mechanism, framing differs.

### 7.2 Implementation feed

`/v1/status` (`client/src/api/server.ts`) gains a `spend` block — per-credential `{ credentialId, kind, capUsd, spentTodayUsd, paused, resetsAt }` — backing the component's Static. The per-task breakdown reuses the existing activity-events feed (rows now carry `cost` + `model`, §4.4). No new endpoint. The provider-cap nudge's acknowledgement persists in config or local SPA state; its copy: *"Set a monthly spend limit in your [Anthropic / OpenAI / OpenRouter] console — that is your hard safety net. Jinn's daily cap stops the daemon cleanly before you reach it,"* deep-linked to the provider console.

### 7.3 Canonical-doc dependency — issue #453

`OPERATOR-APP-SPEC.md` is a canonical doc; adding the Spend component is a canonical-doc amendment requiring a linked GitHub Discussion + CODEOWNERS approval (handbook, `docs` shape). It is tracked as a **separate `docs` issue, [#453](https://github.com/Jinn-Network/mono/issues/453)** — a blocked-by dependency for #346's UI work only. The daemon-side work (§4–§6; §11 steps 1–8 and 10) does not depend on it and proceeds in parallel. The amendment also gives PR #345's per-task cost surface — shipped with no spec component — its spec home, resolving that drift.

## 8. Edge cases & error handling

| Case | Behaviour |
|---|---|
| Unknown model (no `tokenlens` price) | Attribute a documented fallback cost (constant, e.g. $1.00); `estimated: true`; log once. |
| Harness output unparseable (malformed/missing jsonl, killed subprocess) | Attribute the a-priori `estimateModelCost` heuristic; `estimated: true`. |
| Credential unresolvable (bug / new harness type) | **Fail-open** — claim proceeds; log a loud warning. The provider floor backstops; a resolution bug must not silently halt a working daemon. |
| Daemon restart | Activity rows are persisted; `spentTodayMicros` is correct immediately. No reserve state to recover. The `spend_cap_reached` dedupe resets — at most one duplicate event per credential per restart. |
| Concurrency overshoot | Accepted and documented; bounded by (in-flight task count × per-task cost), and per-task cost is bounded by #345's gate. |
| Time | UTC throughout. "Today" = `ts >= ` ISO of the current UTC midnight. |

## 9. Closing the #331 / #346-comment blind spot

The #346 comment notes that `claude-code` / `codex` on a *raw API key* currently get no cost surface and no gate, because `HARNESS_BILLING` hard-codes them `subscriptionPath: true` by harness name.

`resolveCredentialId()` (§4.1) is the fix. In addition to gating the spend cap, #345's cost-surface decision (`decideCostSurface` / `harnessUsesPaidApiKey` in `cost-estimates.ts`) is **rewired to key off the resolved credential** rather than the harness-name `HARNESS_BILLING` flag. A raw-key `claude-code` then resolves to `anthropic:api-key` and receives the surface, the per-task gate, *and* the daily cap. This satisfies the comment's addition to #346's acceptance.

> **Implementation note (reverted → [#474](https://github.com/Jinn-Network/mono/issues/474)).** The cost-surface rewire described in this section was attempted (plan §11 step 10) and **reverted**. `harnessUsesPaidApiKey` / `decideCostSurface` are consumed exclusively by the browser SPA (`CostEstimatePanel`), and `resolveCredentialId` reads `process.env`, which Vite stubs to `{}` in a browser bundle — so a browser-side rewire resolves every credential to `null` and delivers nothing. The daemon-side spend cap (the substance of this spec) does not depend on it. The genuine #331-UI fix requires the daemon to *expose* paid-API status and the SPA to consume it — re-homed to **#474**.

## 10. Testing

Per `docs/runbooks/testing.md` (feat shape = TDD; integration over mocks for store/loop surfaces):

- **Unit** — `resolveCredentialId` across each harness × env-var combination; `parseClaudeCodeUsage` / `parseCodexUsage` against fixture jsonl (incl. malformed); `priceTokens` via `tokenlens`; `gateClaimBySpendCap` decision table.
- **Integration** — engine-watcher skips a claim when over budget (real store, seeded activity rows); completion records cost on the activity row exactly once; restart preserves the running total; per-credential selectivity (credential A exhausted, credential B still claims); `spend_cap_reached` emitted once per credential per day.

## 11. Build sequence

For the implementation plan to expand. Steps 1–8 and 10 are daemon-side and do not depend on the canonical-doc amendment; step 9 (UI) is blocked-by #453.

1. `tokenlens` dependency + `priceTokens` helper.
2. `CredentialId` type + `resolveCredentialId`.
3. `HarnessUsage` on harness run results; `parseClaudeCodeUsage` / `parseCodexUsage`; hermes heuristic fallback.
4. `activity_events` columns + migration + index; completion path records cost (once per task).
5. `spentTodayMicros` / `recentSpend` store query functions.
6. `spend-cap-gate.ts` + wire into `_runEngineWatcherLoop`; `spend_cap_reached` event.
7. Config `spendCaps` + `JINN_SPEND_CAP_USD`.
8. `/v1/status` `spend` block.
9. **Spend component UI** (blocked-by #453) — renders the component's four axes; provider-cap nudge.
10. ~~Rewire #345's cost-surface decision to `resolveCredentialId` (§9).~~ — **reverted → [#474](https://github.com/Jinn-Network/mono/issues/474)** (browser-SPA-only surface; see §9 implementation note). Shipped scope is steps 1–8.

## 12. Deviations from #346 as written

| # | Deviation | Rationale |
|---|---|---|
| D1 | Per-credential `spendCaps` map, not a single `paidApi.dailySpendCapUsd` | The credential is what pays; one operator may hold several. Degrades to one entry for the common case. |
| D2 | Count **actual cost at completion**, not `estimateModelCost` at claim | Claude Code self-reports `total_cost_usd`; the cap is a graceful-pause layer with the provider's monthly cap as the hard floor, so claim-time precision is unnecessary. Simpler and restart-safe. |
| D3 | Provider-API reconciliation **descoped** to a separate issue | The provider dashboard is the authoritative source; Anthropic/OpenAI reconciliation needs an Admin key most operators lack — idle code. |
| D4 | **Added:** a one-time provider-cap nudge | The provider's own monthly limit is the real hard floor; pointing the operator at it is the highest-value, lowest-code part of the feature. |

**Action:** #346's body should be updated to reflect D1–D4. The comment's subscription-detection edge case is satisfied via §9.

## 13. Out of scope

- Provider-API spend reconciliation (D3) — separate issue.
- Mainnet payment-token budgets — Phase 2.
- Org-level / cross-operator caps.
- Per-SolverNet caps.
- Rate-limit-quota-aware budgeting for subscriptions (no provider API exposes remaining quota).
- Same-provider multi-key disambiguation (credential-id fingerprint suffix) — additive later if needed.
