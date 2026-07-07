# Spike finding — claim-relayer on Railway (`jinn-claim-relayer`): health, RPC resilience, silent-failure behavior

- **Issue:** #1068 (`spike`)
- **Date:** 2026-06-13
- **Author:** Jinn contributor (Ritsu)
- **Status:** finding — escalates `needs-decision`. Spike code does not merge; this document is the deliverable.

## TL;DR

The relayer settles operator JINN reward claims L2→L1; **operator earning depends on it**. Investigation confirms:

1. **RPC resilience is *good* — the relayer already uses the same multi-RPC `fallback({rank:false})` chain the daemon uses (#592).** It is *not* a single brittle URL — provided the Railway env supplies a comma-separated chain. This part of the issue's hypothesis is **disproven by the code**.
2. **The silent-failure risk is *real* and has two distinct root causes**, neither of which is the poll loop:
   - **Boot-path fatal-exit.** `start()` runs `startupCheck()` + the first `runOnce()` **unguarded**. A transient RPC outage (or any boot error) at startup throws → process exits non-zero. The steady-state poll loop tolerates outages (errors are swallowed into in-memory `stats.lastError` and the next tick is always rescheduled) — but you only reach it if the *first* tick succeeds.
   - **No external observability.** On Railway the health surface is **publicly unreachable** (all of `/health`, `/ready`, `/status` return **502**; the service domain has `targetPort: null`), **no Railway healthcheck is wired** (`healthcheckPath: null`), and the running container is emitting **no logs**. A down or wedged relayer is therefore invisible — exactly the silent-stall the issue describes.
3. **The 35 MB→55 MB local log is a *boot-crash-loop* artifact, not a steady-state logging defect.** The relayer's own loop does not spam logs. An external supervisor restarts the crashed boot with no backoff; each boot prints one full viem stack. Locally this is unbounded (now 55 MB / 754k lines); on Railway it is capped at `restartPolicyMaxRetries: 10`, after which the service **stays down permanently and silently**.
4. **Earning wiring is correct.** The relayer's bundled artifacts point at the exact `distributor`/`emitter` pair the daemon's `JinnClaimLoop` logs.

## Acceptance-criteria answers

### Current status of the Railway `jinn-claim-relayer` service
- Project `jinn-claim-relayer` (`a6ddb0e7…`), env `production`, **service named `relayer`** (`15864e92…`).
- **Latest deployment:** `dc1a41ca…`, status `SUCCESS`, created **2026-06-04** (9 days ago), `deploymentStopped: false`, image digest `sha256:77057cb5…`, builder `DOCKERFILE` (`packages/claim-relayer/deploy/Dockerfile`), 1 replica, region `europe-west4`.
- **Restart policy:** `ON_FAILURE`, `restartPolicyMaxRetries: 10`. → after 10 crash-restarts Railway gives up; service is then down with no further restarts and no alert.
- **Disk headroom:** `/data` volume `relayer-volume`, **156.98 MB used of 5000 MB (3.1%)** — ample. Not a disk risk on Railway (logs go to Railway's log pipe, not the volume).
- **Build logs** confirm a clean build (Yarn 4.13.0, `better-sqlite3@11.10.0` + esbuild rebuilt in-image). **Deploy/runtime logs are empty** even with `railway logs -d --lines 200 --json` — the running container has produced no captured log lines.

### Same RPC `fetch failed` failure mode? Against which endpoint? Multi-RPC fallback or single URL?
- The relayer **uses the multi-RPC fallback chain** — `packages/claim-relayer/src/transport.ts` is a deliberate mirror of `client/src/rpc/transport.ts` (#592): `parseRpcUrls` splits comma-separated env, dedups, caps at `MAX_RPC_CHAIN_LENGTH = 4`; `buildFallbackTransport` builds `fallback(transports, { rank: false, retryCount: 0 })` and wraps failures as `AllRpcsFailedError`, with the same `isViemShouldThrowError` short-circuit list. So **resilience parity with the daemon exists in code.**
- **Caveat — the inner `http(u)` transports take viem's default `retryCount: 3`.** `transport.ts:119` calls `http(u)` with no options; only the *fallback* layer sets `retryCount: 0`. So a single failed request fans out to 3 backoff-retries × N providers before `AllRpcsFailedError`. This is the source of the `withRetry`/`attemptRetry` frames in the local log (111,710 `withRetry` vs 55,855 `HttpRequestError`).
- **The `fetch failed` on `eth_blockNumber`** seen locally is `runOnceInternal` calling `l2Public.getBlockNumber()` while the host has no/blocked network. It is a transport-level outage of *every* provider in the chain, not one endpoint.

### Where the relayer's RPC config lives on Railway
- Env vars `JINN_CLAIM_RELAYER_L1_RPC_URL` and `JINN_CLAIM_RELAYER_L2_RPC_URL` on the `relayer` service (both `parseRpcUrls`-parsed → comma-separated chains supported). This is **separate** from the operator's `CONFIG_TEMPLATE_JSON.rpcUrl` and the indexer's `PONDER_RPC_URL_84532`.
- *Not dumped here* — a full `railway variables` pull exposes the signer private key (`JINN_CLAIM_RELAYER_PRIVATE_KEY`). The non-secret way to verify the resolved chain is the boot log `[claim-relayer] L1/L2 transport: fallback chain (N providers) — primary=<host>` — but **the running container's logs are currently empty**, so the live chain length could not be confirmed remotely. *Open item:* read just the two RPC vars (or the boot log on next deploy) to confirm L1/L2 are multi-provider, not single-URL.

### Does the relayer self-recover from a transient RPC outage?
- **Once running: yes.** `runScheduledTick()` wraps `runOnce()` in try/catch/finally — it records `stats.lastError` and **always** calls `scheduleNext()`. A mid-run RPC blip is tolerated; the next poll (default 60 s) retries.
- **At boot: no.** `start()` → `await startupCheck()` → `await runOnce()` are **unguarded**; on failure the rejection reaches `main().catch` → `process.exitCode = 1` → exit. With Railway `ON_FAILURE`/max-10 this crash-loops then stays down. The within-run checkpoint logic is otherwise sound (it only advances the checkpoint when there is no retryable failure, so claims are not skipped).

### A cap on retry-error logging
- **The relayer's poll loop does not log per-tick errors at all** (they are swallowed to in-memory `stats.lastError`). There is therefore no steady-state log-spam defect to cap.
- The 55 MB local log is the **boot path** crashing and being restarted by an external supervisor with no backoff — each boot prints one full stack via `main().catch(console.error)`. Local head shows the boot fatal is *also* a `better-sqlite3` `NODE_MODULE_VERSION` ABI mismatch (compiled against Node 127, run under Node 115) — a **local-only** artifact (Railway rebuilds the native module in-image); the RPC `fetch failed` boot fatal is environment-independent.
- **The cap that matters is on restarts, not log lines:** guard the boot path (retry-with-backoff into the poll loop instead of exiting) so a transient outage never turns into a crash-loop in the first place.

### A health signal / monitoring so a down/wedged relayer surfaces proactively
- The code **already exposes** `/health` (process-up), `/ready` (startup-checked + ready, 200/503), `/status` (full stats: `lastError`, `checkpoint`, ticket counts by status, uptime). The building blocks for monitoring exist.
- **But as deployed they are unusable:** the public domain `relayer-production-3a3b.up.railway.app` has `targetPort: null` and returns **502** on all three paths, and **no Railway healthcheck is wired** (`healthcheckPath: null`). Nothing watches the relayer today. This is the core silent-failure gap.

### Confirm the hosted operator's earning path depends on this relayer, wired to the right distributor/emitter
- **Confirmed.** Bundled `client/deployments/deployment-jinn-mvi-l1-sepolia.json` → `JinnDistributor = 0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6`; `deployment-jinn-mvi-l2-baseSepolia.json` → `TaskClaimEmitter = 0xF60055534E377F4020eEA80356C0643E02f4f307`. These are **exactly** the `distributor=0xaC9CD847…` / `emitter=0xF60055534E…` the daemon's `JinnClaimLoop` logs (`client/src/main.ts:1920-1921`, `JINN_MVI_CONFIG`). MockMessenger = `0xd229A2C2…`.
- **Flow:** daemon emits `ClaimTicket` on the L2 `TaskClaimEmitter` → relayer scans L2 emitter logs → `setFixture` on L1 MockMessenger → `JinnDistributor.claim()` on L1 (Sepolia). If the relayer is down, ClaimTickets accumulate on L2 but **never settle to L1 JINN** — the operator dashboard still shows the daemon healthy. Earning stalls silently. (Consistent with the prior [[claim-relayer-gas-wallet-stall]] failure mode — a different head-of-line cause, same invisible-stall symptom.)

## Recommended follow-ups (proposed `fix`/`chore` issues — not implemented in this spike)

1. **`fix` — guard the boot path.** Wrap `start()`'s `startupCheck()` + first `runOnce()` in retry-with-backoff so a transient RPC/contract-read outage at boot enters the normal poll loop instead of `process.exit(1)`. This kills the crash-loop class at its source (boundary test: first tick throws → relayer stays up, `stats.ready=false`, retries). **Highest leverage.**
2. **`chore` — wire Railway observability.** Set the service domain `targetPort` to `8737` (or honor `$PORT`) and set `healthcheckPath: /ready` + a healthcheck timeout, so Railway restarts on unhealthy and the endpoint is externally probeable. Then add an external monitor (or extend the indexer/eng-day) that polls `/status` and alerts when `ready=false`, `lastError` is set, or `checkpoint` stops advancing.
3. **`fix` (optional) — set inner `http()` `retryCount`** explicitly (e.g. `http(u, { retryCount: 1 })`) so a total outage fails faster and produces fewer stack frames, rather than 3×N backoff retries per request.
4. **Local hygiene (operator runbook, not relayer code):** rebuild `better-sqlite3` for the local Node ABI, and have whatever supervises the local relayer back off on repeated boot failure (the 55 MB log is a tight no-backoff restart loop). Mirror the daemon's stale-pidfile cleanup (#805).

## Why I stopped (spike escalation)
Per the `spike` shape, the output is this finding, not code. The follow-ups above are concrete and testable but represent **product/prioritization decisions** (which to file, P-level, whether to touch the live Railway service config) that belong to the operator. **Status: `needs-decision`.**

## Evidence
- Railway: `railway status --json` (deploy `dc1a41ca…` SUCCESS 2026-06-04; `healthcheckPath: null`; `restartPolicyMaxRetries: 10`; `/data` 156.98/5000 MB); `railway logs -d/-b --lines` (build OK, deploy logs empty); `curl https://relayer-production-3a3b.up.railway.app/{health,ready,status}` → 502.
- Code: `packages/claim-relayer/src/{transport,config,relayer,http,index}.ts`, `deploy/Dockerfile`.
- Local: `~/.jinn-client/claim-relayer.err.log` 55 MB / 754,735 lines (55,855 `HttpRequestError` on `eth_blockNumber`, 111,710 `withRetry`), pidfile absent; head shows `better-sqlite3` `NODE_MODULE_VERSION 127 vs 115` boot fatal.
- Wiring: `client/deployments/deployment-jinn-mvi-l1-sepolia.json`, `deployment-jinn-mvi-l2-baseSepolia.json`, `client/src/main.ts:1920-1921`.
