# Indexer monitoring — design note (issue #548)

- **Version:** 0.1
- **Date:** 2026-06-01
- **Author:** Jinn contributor (DESIGN stage, headless)
- **Shape:** feat · Effort: Medium
- **Issue:** [#548](https://github.com/Jinn-Network/mono/issues/548) — Indexer monitoring (alert when jinn-indexer-production stops)
- **Provenance:** Root-cause of the 2026-05-20→2026-05-23 substrate cascade. See `docs/release/v2026.05.25/handoff.md` (lines 184–221).

## 1. Problem and chosen approach

On 2026-05-20 the Ponder indexer at `jinn-indexer-production.up.railway.app` crashed at boot when its Tenderly gateway key hit a Free-plan monthly quota (`eth_chainId` → `-32004`). It stayed down for three days with no alert. The discovery-layer `fallbackToOnchain`-default-off fix (handoff §Discovery fallback) means future outages now surface to operators as `DiscoveryUnavailableError`, but the **infrastructure side is still blind** — nobody is told. This issue closes that gap with an active probe + alert.

**Chosen approach — a GitHub Actions scheduled workflow that runs a zero-dependency Node probe and raises a GitHub Issue on failure.** Concretely:

| Piece | Decision | Path |
|---|---|---|
| Scheduler | GitHub Actions `schedule` cron (two jobs, two cadences) | `.github/workflows/indexer-monitor.yml` |
| Liveness/freshness probe | Node 22 `.mjs` script, no npm deps (global `fetch`) | `.github/scripts/indexer-probe.mjs` |
| Tenderly daily probe | a second invocation of the same script in a daily-cadence mode | (same script, `--mode=rpc`) |
| Alert mechanism | open-or-update a single GitHub Issue; auto-close on recovery | inline in the workflow, mirroring `main-next-ancestor-check.yml` |

Why this shape (trade-offs considered):

- **GH Actions vs external service (Better Stack / UptimeRobot).** Chosen GH Actions. The repo already runs scheduled-cron-as-monitor (`main-next-ancestor-check.yml` runs `0 8 * * *` and opens-or-updates an alert Issue). Staying in-repo means: version-controlled probe logic, no new vendor account/secret/billing, free, and reviewable like any PR. The only cost is GH Actions' soft scheduling jitter (a `*/5` cron can slip several minutes under load) — acceptable for a multi-*day* failure mode. If sub-minute detection is ever needed, an external uptime monitor can be layered on later without removing this.
- **Issue-as-alert vs Slack/Discord webhook.** Chosen Issue-as-alert. I searched every workflow's `secrets.*` references (`grep -rhoE 'secrets\.[A-Z_]+' .github/workflows/`) and the repo — **there is no Slack, Discord, PagerDuty, or generic webhook secret anywhere**, and no mention of an on-call channel in `.github/` or `docs/runbooks/`. The house alert channel *is* a GitHub Issue: `main-next-ancestor-check.yml` opens-or-updates one tagged `[main-next-divergence]` / label `automated:divergence` and auto-closes it on recovery. This needs **no new secrets** and matches the existing pattern exactly. (If a Slack webhook is provisioned later, a notify step can be appended; out of scope here.)
- **Node `.mjs` script vs inline bash.** Chosen Node script. The freshness check parses a GraphQL JSON envelope and does a numeric block-delta comparison — awkward and brittle in bash/`jq`. `.github/scripts/` already mixes `.sh` and `.mjs` (`upsert-changelog-section.mjs`), so a committed, separately-unit-testable `.mjs` is in-convention. Node 22 (the repo's pinned version) has global `fetch`, so the script needs **zero npm install** — the workflow just `node`-runs it.
- **New monitor workflow vs extending `indexer-ci.yml`.** Chosen a new file. `indexer-ci.yml` is `pull_request`/`push`-triggered build CI; mixing a production-uptime cron into it muddies both. Separate file, separate concern.

## 2. The probe — endpoints, query, freshness logic

The script `.github/scripts/indexer-probe.mjs` takes the indexer base URL and a mode, exits `0` on healthy and non-zero with a one-line reason on failure. The workflow captures stdout/exit-code and feeds it into the alert step.

Base URL: `https://jinn-indexer-production.up.railway.app` (this is `DEFAULT_TESTNET_DISCOVERY_URL` in `client/src/config.ts:695`; pass it as a workflow env so it is greppable and overridable).

### `--mode=indexer` (every ~5 min — satisfies AC #1 and #2)

Three checks, fail-fast in order:

1. **Root liveness (AC #1).** `GET https://jinn-indexer-production.up.railway.app/` → must return a 2xx status. (Ponder serves the explorer SPA shell or the placeholder page here — see `packages/indexer/src/api/index.ts`.) A non-2xx or network error here is the exact symptom the 2026-05-20 boot-crash produced.
2. **GraphQL `_meta` freshness (AC #2).** `POST /graphql` with the Ponder-standard meta query:

   ```graphql
   query { _meta { status } }
   ```

   Ponder's `_meta.status` is a JSON object keyed by chain name; for this indexer it carries a `baseSepolia` entry whose `block.number` is the last block Ponder has indexed on Base Sepolia (chain 84532). Read `data._meta.status.baseSepolia.block.number`. If `_meta`, `status`, the `baseSepolia` key, or `block.number` is absent/null → fail (`"indexer _meta.status.baseSepolia missing — indexer not indexing"`). This is precisely the probe the handoff (line 220) said "would have surfaced it."
3. **Chain-head delta (AC #2 threshold).** Fetch the current Base Sepolia head via a single JSON-RPC `eth_blockNumber` `POST` to the RPC URL supplied by the `BASE_SEPOLIA_RPC_URL` secret (the Tenderly-backed gateway already wired into `npm-publish.yml:50`), falling back to the public `https://sepolia.base.org` if the secret is unset. Compute `lag = chainHead − indexedBlock`. **Fail if `lag > 50` blocks** (`STALE_THRESHOLD_BLOCKS = 50`, matching the AC's "within ~50 blocks of current chain head"). Base Sepolia is ~2 s/block, so 50 blocks ≈ 100 s of indexer lag — comfortably above normal indexing latency, well below a real stall. Reason string includes both numbers: `"indexer stale: head=41,893,600 indexed=41,892,900 lag=700 (>50)"`.

This mirrors logic the indexer itself already trusts: `packages/indexer/src/api/chain-head.ts` (`eth_blockNumber` against `PONDER_RPC_URL_84532`) and the freshness middleware in `packages/indexer/src/api/freshness.ts`. The probe re-implements the *comparison* externally so it survives a fully-crashed indexer (an in-process `/health` check cannot fire when the process is dead).

> Implementation note for the build stage: confirm the exact `_meta.status` field path against the live endpoint during TDD — Ponder 0.16.x (`packages/indexer/package.json`) exposes `_meta { status }` where `status` is a per-chain map; the consumer in `client/src/discovery/http.ts` reads block freshness via the `/ready` probe rather than `_meta`, so the `_meta.status.<chain>.block.number` shape should be asserted against a real response (or a recorded fixture) before pinning the parse. Treat the field path as the one place to verify, not assume.

### `--mode=rpc` (daily — satisfies AC #3, Tenderly key-health)

The literal "check the Tenderly *key*" cannot be done from this repo: **no Tenderly API/management secret exists** (searched — only `BASE_SEPOLIA_RPC_URL`, the *gateway URL with the key embedded*, is present, and that's a CI secret not a quota-inspection credential). Tenderly's Free plan also exposes no public quota-remaining endpoint. So the daily probe degrades to the **next-most-useful signal: reachability + quota-error detection of the gateway the indexer actually uses.**

`--mode=rpc` does a single `eth_chainId` `POST` to `BASE_SEPOLIA_RPC_URL` and:
- fails if the response is a network error or non-2xx;
- **fails specifically on the quota signature** — a JSON-RPC error body with `error.code === -32004` (or any message matching `/quota|rate.?limit|exceeded/i`). This is the *exact* error the 2026-05-20 key returned (`eth_chainId` → `-32004` quota limit, per the issue). Catching `-32004` daily is the early-warning the AC asks for: it surfaces quota exhaustion on the gateway before it cascades into a boot-crash.

Trade-off / honest gap: this watches the gateway URL that's in CI secrets, which is the *same* Tenderly key the indexer runs on **only if Railway and the `BASE_SEPOLIA_RPC_URL` secret are kept in sync**. They are not automatically coupled (Railway env is set out-of-band). The design accepts this: the daily RPC probe is a best-effort proxy, and the 5-minute indexer probe is the real backstop — if the key dies, the indexer goes stale within minutes and mode=indexer alerts regardless. Documented below as a provisioning note so the coupling is a conscious operational choice, not a silent assumption.

## 3. Alert mechanism, workflow shape, and acceptance-criteria mapping

### Workflow `.github/workflows/indexer-monitor.yml`

Modeled directly on `main-next-ancestor-check.yml`:

- `permissions: { contents: read, issues: write }`.
- Two cron schedules + `workflow_dispatch` for manual runs:
  - `*/5 * * * *` → `indexer-freshness` job (`--mode=indexer`).
  - `0 9 * * *` → `tenderly-keyhealth` job (`--mode=rpc`), daily at 09:00 UTC.
- Each job: `actions/checkout@v6` → `actions/setup-node@v6` (node 22) → `node .github/scripts/indexer-probe.mjs --mode=<m>` capturing exit code and reason → alert step.
- **Alert step (open-or-update Issue), copied from the divergence backstop:**
  - Ensure a label exists (`gh label create "automated:indexer-outage" --color D93F0B --force`).
  - On failure: `gh issue list --search "[indexer-outage] is:open"` to find an existing alert; if found, `gh issue comment` (still-down update with the probe reason, head/indexed/lag table, and run URL); else `gh issue create` titled `[indexer-outage] jinn-indexer-production probe failing` with the reason and a "How to fix" block pointing at `docs/runbooks/` (rotate `PONDER_RPC_URL_84532` on Railway — handoff §Substrate). Then `exit 1` so the run is red.
  - On success: if an open `[indexer-outage]` Issue exists, `gh issue close --comment "indexer healthy as of run <url>. Closing."`. This gives auto-recovery, exactly like the divergence check.
  - One alert Issue is reused across both jobs (`indexer` and `rpc`), title-distinguished by a `[indexer-outage]` vs `[indexer-rpc-quota]` tag in the search/title, so a quota warning and a freshness outage don't collide but both auto-close.
- Uses the built-in `secrets.GITHUB_TOKEN` for `gh` (no new secret). The chain-head/RPC step uses `secrets.BASE_SEPOLIA_RPC_URL` (already provisioned).

### Acceptance-criteria satisfaction

| AC | How satisfied |
|---|---|
| Probe hits root → 2xx, every ~5 min | `indexer-monitor.yml` `*/5` cron, `indexer-probe.mjs --mode=indexer` step 1 (`GET /`). |
| `POST /graphql { _meta { status } }`, `baseSepolia.block.number` within ~50 blocks of head | step 2 reads `_meta.status.baseSepolia.block.number`; step 3 fetches `eth_blockNumber` and fails if `lag > 50` (`STALE_THRESHOLD_BLOCKS = 50`). |
| Failure raises alert via existing on-call channel | open-or-update `[indexer-outage]` GitHub Issue + label `automated:indexer-outage`, the repo's only existing automated-alert channel (mirrors `main-next-ancestor-check.yml`); auto-closes on recovery. |
| Separate daily Tenderly key-health probe (quota-exhaustion early-warning) | `0 9 * * *` cron, `--mode=rpc`: `eth_chainId` to `BASE_SEPOLIA_RPC_URL`, fails on `-32004`/quota signature — the exact 2026-05-20 error. Degraded honestly to gateway-reachability because no Tenderly management secret exists. |

### Testing

Per the repo's TDD-for-feat rule, the build stage adds a small Vitest/Node-test suite for the pure logic in `indexer-probe.mjs`: parse a healthy `_meta` envelope (pass), a missing-`baseSepolia` envelope (fail), `lag = 50` (pass) vs `lag = 51` (fail), a `-32004` RPC body (rpc-mode fail), and a non-2xx root (fail). Network calls are injected via a `fetch` parameter so the suite is offline. The workflow itself is smoke-tested via `workflow_dispatch` against the live endpoint before enabling the cron (same "validate before enabling cron" discipline `broadcast-bot.yml` documents).

## Files to create / modify

- **Create** `.github/workflows/indexer-monitor.yml` — scheduled monitor (two jobs/cadences), issue-as-alert steps.
- **Create** `.github/scripts/indexer-probe.mjs` — zero-dependency Node probe (`--mode=indexer` | `--mode=rpc`), `fetch`-injectable for tests.
- **Create** a test file for the probe's pure logic (location per `docs/runbooks/testing.md`; co-located `.github/scripts/` Node test or a `packages/`-side Vitest — pick to match where the probe's deps resolve).
- *(No source changes in `packages/indexer/` or `client/` — the probe is external by design so it survives a dead indexer process.)*

## Secrets / provisioning required from a human

- **None new are strictly required.** `secrets.GITHUB_TOKEN` (built-in) drives the alert Issue; `secrets.BASE_SEPOLIA_RPC_URL` (already provisioned, Tenderly-backed) drives the chain-head and RPC-health checks. The probe falls back to public `https://sepolia.base.org` if `BASE_SEPOLIA_RPC_URL` is absent, so it cannot hard-break on a missing secret.
- **Operational note (not blocking):** for the daily `--mode=rpc` probe to actually reflect the *production indexer's* key, `BASE_SEPOLIA_RPC_URL` must be kept in sync with Railway's `PONDER_RPC_URL_84532`. They are set independently today. If a human wants the daily probe to be a true early-warning rather than a best-effort proxy, point both at the same Tenderly key. The 5-minute freshness probe is the real backstop regardless.
- **Optional future enhancement (out of scope):** if/when a Slack or Discord webhook secret is provisioned, append a notify step to the alert path — the Issue stays as the durable record.
