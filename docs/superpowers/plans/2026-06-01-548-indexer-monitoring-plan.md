# Indexer monitoring — implementation plan (issue #548)

- **Version:** 0.1
- **Date:** 2026-06-01
- **Author:** Jinn contributor (PLAN stage, headless)
- **Shape:** feat · Effort: Medium · TDD
- **Issue:** [#548](https://github.com/Jinn-Network/mono/issues/548) — Indexer monitoring (alert when jinn-indexer-production stops)
- **Design note:** `docs/superpowers/specs/2026-06-01-548-indexer-monitoring-design.md` (read in full before executing)
- **Branch:** `feat/548-indexer-monitoring-alert-when-jinn-indexer-production-stops`

## What we are building

A zero-dependency Node 22 probe (`.github/scripts/indexer-probe.mjs`) plus a scheduled
GitHub Actions workflow (`.github/workflows/indexer-monitor.yml`) that:

1. Every ~5 min: checks the Ponder indexer is alive (`GET /` 2xx) and fresh
   (`POST /graphql { _meta { status } }` → `baseSepolia.block.number` within 50 blocks of the
   Base Sepolia chain head).
2. Daily: checks the Tenderly-backed `BASE_SEPOLIA_RPC_URL` gateway for quota exhaustion
   (`eth_chainId` → fail on `-32004`/quota signature) — the exact 2026-05-20 failure signature.
3. On any failure: opens-or-updates a single GitHub Issue (label `automated:indexer-outage`),
   auto-closes on recovery — mirroring `.github/workflows/main-next-ancestor-check.yml`.

No new secrets. Uses built-in `secrets.GITHUB_TOKEN` and already-provisioned
`secrets.BASE_SEPOLIA_RPC_URL` (falls back to public `https://sepolia.base.org` if unset).

## Test-runner decision (resolved)

**Test runner: `node --test` (Node 22 built-in), co-located in `.github/scripts/`.**

Rationale:
- There is **no root `package.json`** in this repo. The only vitest harness lives inside
  `packages/indexer` (`"test": "vitest run"`, `vitest ^2.1.9`). Wiring the probe's test into
  that package would couple an external, intentionally-process-independent monitor to the
  indexer package's dep tree — the opposite of the design's "external so it survives a dead
  indexer process" intent.
- The probe is zero-dependency by design (global `fetch`). `node --test` is also zero-dep and
  ships with the pinned Node 22. Matching the probe's posture keeps the whole thing installable
  with **no `yarn install`** in the workflow.
- `.github/scripts/` already carries standalone `.mjs` (`upsert-changelog-section.mjs`) with no
  local package manifest; a sibling `*.test.mjs` run by `node --test` is the lightest in-convention fit.

Test invocation (locally and in CI):

```bash
node --test .github/scripts/indexer-probe.test.mjs
```

No install step. The test imports the probe's pure functions directly from
`./indexer-probe.mjs` and injects a fake `fetch`.

## Probe structure for testability

`indexer-probe.mjs` must separate **pure logic** (unit-tested, no I/O) from the **I/O shell**
(thin, exercised only via injected `fetch` + integration smoke). Export the pure functions so
the test file can import them without triggering any network call or `process.exit`.

Pure, exported functions (no network, no `process.exit`):

- `parseMetaEnvelope(json) -> { indexedBlock: number } | { error: string }`
  Reads `json.data._meta.status.baseSepolia.block.number`. Returns `{ error }` if `data`,
  `_meta`, `status`, `baseSepolia`, or `block.number` is absent/null. Does **not** throw.
- `computeLag(chainHead, indexedBlock) -> number` — returns `chainHead - indexedBlock`.
- `isStale(lag, threshold = STALE_THRESHOLD_BLOCKS) -> boolean` — `lag > threshold`.
- `detectRpcQuotaError(json) -> boolean` — true when `json.error?.code === -32004` OR
  `/quota|rate.?limit|exceeded/i` matches `json.error?.message`.
- `parseBlockNumberHex(hexString) -> number` — parse `eth_blockNumber` `"0x..."` result.
- Constant `STALE_THRESHOLD_BLOCKS = 50` (exported).

I/O shell (network-touching, `fetch` injected as a parameter, default `globalThis.fetch`):

- `checkRoot(baseUrl, fetchImpl)` — `GET baseUrl/` → throws/returns reason on non-2xx or network error.
- `fetchIndexedBlock(baseUrl, fetchImpl)` — `POST baseUrl/graphql` meta query → `parseMetaEnvelope`.
- `fetchChainHead(rpcUrl, fetchImpl)` — `POST rpcUrl` `eth_blockNumber` → `parseBlockNumberHex`.
- `checkRpcQuota(rpcUrl, fetchImpl)` — `POST rpcUrl` `eth_chainId` → `detectRpcQuotaError`.
- `runIndexerMode({ baseUrl, rpcUrl, fetchImpl })` / `runRpcMode({ rpcUrl, fetchImpl })` —
  orchestrate the checks, **return** `{ ok: boolean, reason: string }` (do NOT call
  `process.exit` inside these; the CLI entry does that).

CLI entry (only runs when invoked as `main`, guarded so `import` is side-effect-free):

```js
if (import.meta.url === `file://${process.argv[1]}`) { /* parse --mode, call runner, print, process.exit */ }
```

This guard is what lets the test file `import` the module without running the probe.

---

## Tasks (TDD-ordered)

### Task 1 — Write the failing test for the probe's pure logic

**File:** `.github/scripts/indexer-probe.test.mjs` (create)

Write a `node --test` suite that imports from `./indexer-probe.mjs` and covers the pure
functions + I/O shell with an injected fake `fetch`. Cases (each from the design's testing list):

1. `parseMetaEnvelope` — **healthy envelope** `{ data: { _meta: { status: { baseSepolia: { block: { number: 41892900 } } } } } }` → `{ indexedBlock: 41892900 }`.
2. `parseMetaEnvelope` — **missing `baseSepolia`** `{ data: { _meta: { status: {} } } }` → `{ error: /baseSepolia missing/ }` (assert it returns an error object, does not throw).
3. `parseMetaEnvelope` — **null `_meta`** and **absent `data`** → error object (defensive).
4. `isStale(50)` → `false` (lag exactly at threshold passes); `isStale(51)` → `true`.
5. `computeLag(41893600, 41892900)` → `700`; with that lag, `runIndexerMode` returns `ok:false`
   and a reason containing `head=`, `indexed=`, `lag=`.
6. `detectRpcQuotaError({ error: { code: -32004, message: 'quota exceeded' } })` → `true`;
   `detectRpcQuotaError({ result: '0x14a34' })` → `false`.
7. `parseBlockNumberHex('0x27f9b60')` → `41893600`.
8. **`runIndexerMode` healthy path** — fake `fetch` returns: root `{ ok: true, status: 200 }`,
   graphql healthy `_meta`, rpc `eth_blockNumber` head within 50 of indexed → `{ ok: true }`.
9. **`runIndexerMode` non-2xx root** — fake `fetch` returns `{ ok: false, status: 503 }` for `GET /`
   → `{ ok: false, reason: /root .*503|not 2xx/ }` and **graphql is never called** (fail-fast).
10. **`runRpcMode` quota fail** — fake `fetch` returns `{ error: { code: -32004 } }` → `{ ok: false }`.
11. **`runRpcMode` healthy** — fake `fetch` returns `{ result: '0x14a34' }` → `{ ok: true }`.

The fake `fetch` is a function returning `{ ok, status, json: async () => <body> }`. Assert on
the `reason` strings loosely (regex) so wording changes don't break tests.

**Verify:** `node --test .github/scripts/indexer-probe.test.mjs` runs and **fails** (module not
yet implemented / functions undefined). This is the red state required by the feat TDD rule.

### Task 2 — Implement the probe to make the tests pass

**File:** `.github/scripts/indexer-probe.mjs` (create)

Implement exactly the functions enumerated in §"Probe structure for testability". Constraints:

- Zero npm deps. Global `fetch` only. `#!/usr/bin/env node` shebang, `chmod +x` to match the
  other executable scripts (the two `.sh` are `-rwxr-xr-x`; `upsert-changelog-section.mjs` is not
  executable but has the shebang — set the bit so the file is directly runnable).
- All network functions take `fetchImpl = globalThis.fetch` as the last argument so tests inject.
- Pure functions never throw on bad input — they return `{ error }` / booleans.
- `runIndexerMode` order (fail-fast, matches design §2): (1) `checkRoot` → (2) `fetchIndexedBlock`
  via `parseMetaEnvelope` → (3) `fetchChainHead` + `computeLag` + `isStale`. Each failure returns
  `{ ok:false, reason }` immediately without doing later steps.
- `fetchChainHead` reads RPC URL from arg sourced (in CLI) from `process.env.BASE_SEPOLIA_RPC_URL`,
  defaulting to `https://sepolia.base.org` when unset (design §2 step 3 / provisioning note).
- Base indexer URL read (in CLI) from `process.env.INDEXER_BASE_URL`, defaulting to
  `https://jinn-indexer-production.up.railway.app` (greppable + overridable per design §2).
- `STALE_THRESHOLD_BLOCKS = 50` exported constant.
- CLI entry guarded by the `import.meta.url === file://${process.argv[1]}` check; parse `--mode=indexer|rpc`
  from `process.argv`, run the matching runner, `console.log` a single-line reason, and
  `process.exit(result.ok ? 0 : 1)`. On healthy print a short `OK` line too (for the workflow log).

**Verify:** `node --test .github/scripts/indexer-probe.test.mjs` — all cases green.

### Task 3 — Verify the `_meta.status` field path against reality (design's one "verify-not-assume")

**No new file.** The design (§2 implementation note, line 52) flags the exact `_meta.status.<chain>.block.number`
path as the one thing to confirm, not assume. During this task:

- Run the live meta query once to confirm the shape:
  ```bash
  curl -s https://jinn-indexer-production.up.railway.app/graphql \
    -H 'content-type: application/json' \
    -d '{"query":"query { _meta { status } }"}' | node -e 'process.stdin.once("data",d=>console.log(JSON.stringify(JSON.parse(d),null,2)))'
  ```
- Confirm `data._meta.status.baseSepolia.block.number` exists and is the indexed block.
  If the live shape differs (e.g. status keyed by chain id `84532` instead of `baseSepolia`, or
  block under a different field), update `parseMetaEnvelope` AND the Task-1 fixture to match, and
  re-run the test. If the endpoint is unreachable at plan-execution time, record a recorded fixture
  from `packages/indexer` codegen/schema instead and note the assumption in the PR body.

**Verify:** the fixture in `indexer-probe.test.mjs` matches a real (or schema-derived) response;
test still green.

### Task 4 — Write the monitor workflow

**File:** `.github/workflows/indexer-monitor.yml` (create)

Model on `.github/workflows/main-next-ancestor-check.yml` (the canonical issue-as-alert pattern).
Shape:

- Header comment: purpose, provenance (2026-05-20→23 substrate cascade,
  `docs/release/v2026.05.25/handoff.md` §Substrate / §Discovery fallback), reference to this plan.
- `name: indexer monitor`
- `on:`
  - `workflow_dispatch:` (always present, for smoke validation).
  - `schedule:` with **both crons commented out initially** plus an inline comment
    `# enable after a manual workflow_dispatch run validates the probe + alert path`
    (mirrors `broadcast-bot.yml` lines 16–17 discipline). Crons to enable:
    `'*/5 * * * *'` (freshness) and `'0 9 * * *'` (rpc daily).
- `permissions: { contents: read, issues: write }`.
- Two jobs:
  - **`indexer-freshness`** — runs on the `*/5` cadence (gated below). Steps:
    `actions/checkout@v6` → `actions/setup-node@v6` (node-version: 22) →
    `Run probe` step that runs `node .github/scripts/indexer-probe.mjs --mode=indexer`,
    capturing exit code into `steps.probe.outputs.result` (`pass`/`fail`) and stdout into
    `steps.probe.outputs.reason` (write to `$GITHUB_OUTPUT`; use `set +e` so the step itself
    doesn't abort before recording the reason). Env on the step:
    `BASE_SEPOLIA_RPC_URL: ${{ secrets.BASE_SEPOLIA_RPC_URL }}`,
    `INDEXER_BASE_URL: https://jinn-indexer-production.up.railway.app`.
    Then the alert steps (below) with title tag `[indexer-outage]`.
  - **`tenderly-keyhealth`** — same scaffold, runs `--mode=rpc`, title tag `[indexer-rpc-quota]`.
    Env: `BASE_SEPOLIA_RPC_URL` only.
- Gate each job to its own cadence so a single `*/5` tick doesn't run the daily job and vice
  versa. Use an `if:` on the job/steps keyed off `github.event.schedule` (e.g. freshness runs when
  `github.event.schedule == '*/5 * * * *' || github.event_name == 'workflow_dispatch'`; keyhealth
  when `github.event.schedule == '0 9 * * *' || github.event_name == 'workflow_dispatch'`). On
  `workflow_dispatch` both jobs run (smoke covers both modes).
- **Alert steps per job** — copy structure from `main-next-ancestor-check.yml` lines 53–159, parameterized by a `TAG` env (`indexer-outage` / `indexer-rpc-quota`) and `LABEL` (`automated:indexer-outage`, reused across both jobs per design §3 "one alert Issue reused, title-distinguished by tag"):
  1. **Ensure label** (`if: probe == 'fail'`): `gh label create "automated:indexer-outage" --color D93F0B --description "Surfaced by the indexer monitor workflow" --force --repo "${{ github.repository }}" || true`.
  2. **Find open alert issue**: `gh issue list --repo "$REPO" --search "[<TAG>] is:open" --json number --jq '.[0].number // empty'` → `steps.find-issue.outputs.number`.
  3. **Open or update** (`if: probe == 'fail'`): build a body file (probe reason; for indexer mode a `head / indexed / lag` table; a "How to fix" block pointing at rotating `PONDER_RPC_URL_84532` on Railway, referencing `docs/release/v2026.05.25/handoff.md` §Substrate; run URL). If `EXISTING` set → `gh issue comment` "still failing as of run <url>" + reason; else `gh issue create --title "[<TAG>] jinn-indexer-production probe failing" --body-file ... --label "automated:indexer-outage"`. Then `exit 1` so the run is red.
  4. **Auto-close** (`if: probe == 'pass'`): if `EXISTING` set → `gh issue close "$EXISTING" --comment "indexer healthy as of run <url>. Closing."`; else notice "nothing to close".
  - All `gh` steps env: `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, `REPO: ${{ github.repository }}`.

**Verify (static):** `node -e "const y=require('node:fs').readFileSync('.github/workflows/indexer-monitor.yml','utf8')"` parses; optionally `yamllint`/`actionlint` if available. Confirm the two crons are present-but-commented, `permissions` is `issues: write`, no `secrets.*` references beyond `GITHUB_TOKEN` and `BASE_SEPOLIA_RPC_URL`.

### Task 5 — `workflow_dispatch` smoke validation (before enabling cron)

**No new file.** This is the "validate before enabling cron" step the design calls for (§testing,
mirroring `broadcast-bot.yml`).

1. Commit Tasks 1–4 on the feature branch and push.
2. Trigger a manual run against the live endpoint:
   ```bash
   gh workflow run indexer-monitor.yml --ref feat/548-indexer-monitoring-alert-when-jinn-indexer-production-stops
   gh run watch "$(gh run list --workflow=indexer-monitor.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```
3. Expected outcomes:
   - Indexer currently **healthy** → both jobs green, no alert Issue opened, log shows `OK` lines.
   - To prove the alert path **without** a real outage, do one of:
     a. temporarily set `INDEXER_BASE_URL` to a known-bad URL via a throwaway commit, dispatch,
        confirm a `[indexer-outage]` Issue opens with the label, then revert and dispatch again to
        confirm the Issue **auto-closes**; OR
     b. (lighter) trust the unit tests for the fail path and only smoke the healthy path live,
        noting in the PR body that the alert open/close path is covered by tests + the proven
        `main-next-ancestor-check.yml` template it copies.
     Prefer (a) if GH Actions quota allows — it exercises the real `gh issue` open→close cycle.
4. Only after a clean dispatch: **uncomment the two `schedule` crons** in the workflow (final commit
   on the branch) so cron is enabled only post-validation.

**Verify:** a green `workflow_dispatch` run exists; if the alert path was exercised, the alert
Issue was opened and then auto-closed; the final commit enables both crons.

### Task 6 — PR + traceability

- Open PR targeting `next` (per AI workflow rule 10), Conventional-Commit title
  `feat(indexer): scheduled monitor + alert for jinn-indexer-production (#548)`, body with
  `Closes #548`, the AC→task table below, the snowflake/secrets note ("no new secrets"), and the
  Task-3 field-path verification result.
- Co-author trailer per CLAUDE.md commit convention.

---

## Acceptance-criteria → task traceability

| AC | Requirement | Task(s) |
|---|---|---|
| **AC1** | Probe `GET /` returns 2xx, every ~5 min | Task 2 (`checkRoot` + `runIndexerMode` step 1); Task 1 case 9 (non-2xx fail); Task 4 (`*/5` cron + `--mode=indexer` job) |
| **AC2** | `POST /graphql { _meta { status } }` → `baseSepolia.block.number` within ~50 blocks of head | Task 1 cases 1–5,7 (parse + lag + threshold); Task 2 (`parseMetaEnvelope`, `computeLag`, `isStale`, `STALE_THRESHOLD_BLOCKS=50`); Task 3 (verify field path live); Task 4 (`indexer-freshness` job) |
| **AC3** | Failure raises alert via existing on-call channel (issue-as-alert) | Task 4 (open-or-update `[indexer-outage]` Issue, label `automated:indexer-outage`, auto-close on recovery — mirrors `main-next-ancestor-check.yml`); Task 5 (smoke the open→close cycle) |
| **AC4** | Separate daily Tenderly key-health probe (quota early-warning) | Task 1 cases 6,10,11 (`detectRpcQuotaError`); Task 2 (`runRpcMode` / `checkRpcQuota`); Task 4 (`0 9 * * *` cron, `tenderly-keyhealth` job, `[indexer-rpc-quota]` tag) |

## How to verify the whole thing

**Unit tests (offline, zero-dep):**
```bash
node --test .github/scripts/indexer-probe.test.mjs
# expect: all cases pass; no network access (fetch is injected)
```

**Probe against live endpoint (manual, optional sanity):**
```bash
node .github/scripts/indexer-probe.mjs --mode=indexer   # exit 0 if indexer healthy + fresh
echo $?
node .github/scripts/indexer-probe.mjs --mode=rpc       # exit 0 if BASE_SEPOLIA_RPC_URL gateway healthy
echo $?
```

**Workflow smoke (no waiting for cron):**
```bash
gh workflow run indexer-monitor.yml --ref feat/548-indexer-monitoring-alert-when-jinn-indexer-production-stops
RUN_ID="$(gh run list --workflow=indexer-monitor.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID"
# expect: both jobs run on dispatch; green when indexer healthy; no spurious alert Issue
```

**Alert-path proof (recommended, via throwaway bad URL — see Task 5a):**
- Point `INDEXER_BASE_URL` at a bad host, dispatch → a `[indexer-outage]` Issue opens with label `automated:indexer-outage`.
- Revert, dispatch → the Issue auto-closes with a "healthy … Closing." comment.

**Static checks on the workflow:**
- `permissions` is `contents: read, issues: write`.
- Both `schedule` crons present (enabled only after Task 5 validation).
- Only `secrets.GITHUB_TOKEN` and `secrets.BASE_SEPOLIA_RPC_URL` referenced — no new secret.

## Files to create / modify

- **Create** `.github/scripts/indexer-probe.test.mjs` — `node --test` suite (Task 1).
- **Create** `.github/scripts/indexer-probe.mjs` — zero-dep probe, fetch-injectable (Task 2).
- **Create** `.github/workflows/indexer-monitor.yml` — scheduled monitor + issue-as-alert (Task 4).
- *(No source changes in `packages/indexer/` or `client/` — external by design.)*

## Notes / decisions carried from design

- No new secrets. `GITHUB_TOKEN` (built-in) drives the alert Issue; `BASE_SEPOLIA_RPC_URL`
  (provisioned) drives chain-head + rpc-health; falls back to public `https://sepolia.base.org`.
- The daily `--mode=rpc` probe is a **best-effort proxy** for the production indexer's Tenderly key
  (Railway `PONDER_RPC_URL_84532` and CI `BASE_SEPOLIA_RPC_URL` are set independently). The
  5-minute freshness probe is the real backstop. Surface this in the PR body as a conscious
  operational choice, not a silent assumption.
- One alert Issue model per tag: `[indexer-outage]` (freshness) and `[indexer-rpc-quota]` (quota),
  both under label `automated:indexer-outage`, both auto-closing — so a quota warning and a
  freshness outage don't collide.
