# Paired (two-operator) SPA flow — manual runbook

**Type:** human-run spot check, NOT an automated/gating test.
**Why manual:** this flow drives two real daemons against real Base Sepolia + a
shared rate-limited RPC + IPFS + the indexer. Its timing is inherently
non-deterministic (launch confirmation, IPFS metadata resolution, cross-op
indexer propagation, RPC throttling), so as an automated test it can only ever
be flaky. A flaky red can't be distinguished from a real bug, so it would either
block nothing (and be ignored) or block on infra — exactly the un-gateable shape
the two-gate redesign (#960) deleted T2.3 to escape. Run it by hand when you want
end-to-end confidence; read the screenshots; don't wire it onto a gate.

**Gating coverage already exists, deterministically:** `join.e2e.test.ts`
(discover→join, mocked daemon) + `solvernet-flow.e2e.test.ts` (create→launch)
run in the hermetic gate via `yarn e2e:app-flow`. The real-world *protocol* layer
is covered at the API level by the environment-suite scenarios (cross-op
donation, producer/evaluator, real-harness loop). This runbook is the *manual*
way to eyeball the real *app* layer end-to-end; nothing depends on it being green.

## Goal

op-a launches a SolverNet via the Launcher Create wizard. op-b independently
discovers it in the Operator catalog and joins it — the cross-operator handshake
(one operator's on-chain launch propagating through chain + indexer + IPFS to a
*second* operator) that a single operator can't exercise.

## Two operators

You need two **distinct, funded, bootstrapped** testnet operators — two separate
on-chain identities (EOA / Safe / agentId), each a `.jinn-client` tree.

- The env-suite warm operators live at `~/jinn-dev/operators/op-b` and
  `~/jinn-dev/operators/op-c` (each is a `<dir>/.jinn-client`). These are the
  pair used below. **Do NOT use `~/.jinn-client`** — that's the Railway-hosted
  production operator; running it locally double-spends its nonce.
- To make a fresh pair, bootstrap two operators per the earning flow (CLAUDE.md
  §Earning bootstrap), each in its own HOME, each funded with testnet ETH + OLAS.

Each operator's keystore decrypts with its **own** `keystore-password` file.
`JINN_PASSWORD` env takes precedence over that file (`client/src/main.ts`), so if
the two operators have **different** passwords (they usually do), do NOT export a
single `JINN_PASSWORD` — let each daemon read its own file. (This is why the
env-suite's `spawnMultiOpDaemons` strips `JINN_PASSWORD`.)

## Spawn the two daemons (sequentially)

```bash
cd client && yarn build   # need dist/bin/jinn.js + dist/dashboard

# op-a (launcher) — HOME points at the dir whose .jinn-client is the operator
HOME=~/jinn-dev/operators/op-b JINN_API_PORT=17341 JINN_NETWORK=testnet \
  node dist/bin/jinn.js run --no-ui
#   → prints "[api] UI handshake URL: http://127.0.0.1:17341/?k=…"
#   wait until it is fully up (the SPA's "Your SolverNets" loads, not "Failed to
#   load") BEFORE starting op-b.

# op-b (joiner) — separate terminal
HOME=~/jinn-dev/operators/op-c JINN_API_PORT=17342 JINN_NETWORK=testnet \
  node dist/bin/jinn.js run --no-ui
```

**Spawn them one at a time, not concurrently.** Both daemons hit the same
rate-limited public RPC hard at startup (bootstrap resume + `getLogs`); booting
them at once draws 429s that leave a daemon's data layer degraded ("Failed to
load your SolverNets"). Let op-a finish coming up before starting op-b.

Open each handshake URL in its own browser profile (or two `chrome-devtools` MCP
pages / two Playwright contexts).

## Steps

**op-a — create + launch (Launcher Create wizard).** Navigate directly to
`<opAOrigin>/launcher` (the nav is tabs now; there is no top-level "Launcher"
link to click from `/overview`). The "Create SolverNet" CTA renders as a **link**
(`<Button asChild><Link>`), so target `getByRole('link', {name: /create
solvernet/i})`, not a button.

1. **Define** — fill name (use a unique value, e.g. `smoke-<timestamp>`) +
   description → Next.
2. **Review Contract** → Next.
3. **Configure Generator** — cadence (e.g. `60000`) → Next.
4. **Pricing** — there are **two** price inputs; target them by test id
   (`launcher-create-solutionPriceWei`, `launcher-create-verdictPriceWei`), not
   `getByLabel(/price/i)` (ambiguous). At least one must be > 0.
5. **Review + Launch** — click Launch.

The dashboard sits on **"Broadcasting tx"** until the registry tx confirms — this
can take **a few minutes** on a congested testnet (budget 300s+, not 120s).
Success = the launched dashboard shows a **LAUNCHED** badge. Note the wizard sets
**OPEN ROLES: solver + evaluator** by default.

**op-b — discover in the catalog.** Navigate to `<opBOrigin>/operator/registry`
(bare `/operator` redirects to `/operator/memberships`; the catalog is the
Registry tab). Reload until op-a's card appears.

> **Match by manifest CID, not by name.** The catalog card renders
> **"Metadata pending"** (no name) until the IPFS manifest resolves, but its
> `data-manifest-cid` attribute carries the **full** CID straight off the
> on-chain anchor, immediately. The launched dashboard only shows a *truncated*
> CID; the **full** CID is in op-a's launched record on disk at
> `<opAHome>/.jinn-client/earning/solvernets/launched/<solverNetId>.json`
> (`manifestCid` field). Key op-b's lookup on that full CID.

**op-b — join.** Click the card's Join CTA → `/operator/join/<cid>`. Clicking
Join is what triggers JoinFlow's full-manifest IPFS fetch, so the form may take a
moment to render.

> **Join as Evaluator, not Solver** (for this runbook). The Solver role gates
> "Save & Join" on a *ready* solver harness (`claude-code`), which needs live
> OAuth the test operators may not carry — the submit button stays disabled
> otherwise. The prediction evaluator is a deterministic built-in
> (`evaluationFunction.implementation` = `…/prediction-v1-evaluator`) with no such
> gate, so an evaluator join exercises the same JoinFlow + config write without
> an external-auth dependency. (Testing the real *solver* execution is T3.1's
> job, not this runbook's.)

Select the **Evaluator** role → Save & Join. Success = the in-place
`join-flow-success-card` (the SPA no longer redirects to the catalog; #333). The
join writes `joinedSolverNets[<cid>]` to op-b's config (restart-required — the
daemon does not hot-reload SolverNet config).

## What to look at

Screenshots of op-a's launched dashboard (LAUNCHED, generator enabled) and op-b's
catalog (op-a's card discoverable) + join success card. The point is human
eyeballing, not an automated pass/fail.

## Real-world gotchas (each cost a debugging cycle)

| Symptom | Cause | What it means |
|---|---|---|
| op-b never finds the card by name | catalog name lags ("Metadata pending") behind IPFS resolution | match by `data-manifest-cid`, not name |
| Solver "Save & Join" stays disabled | solver harness (`claude-code`) reports `ready:false` (no OAuth) | join as Evaluator, or provision claude-code auth |
| op-a stuck on "Broadcasting tx" >180s | real testnet tx-confirmation latency | wait longer (300s+); the launch usually did succeed on-chain |
| "Failed to load your SolverNets" | RPC 429 / indexer lag | don't boot both daemons at once; retry when the network is healthy |
| second daemon crashes at startup (exit 50) | wrong keystore password | each daemon must use its OWN `keystore-password`; don't share one `JINN_PASSWORD` |

## Cleanup

The launch is real on-chain state. Afterward, to stop op-a's generator from
resuming on its next daemon start, remove the launched record
(`…/earning/solvernets/launched/<id>.json`) and remove the joined entry you added
from op-b's `config.json` `joinedSolverNets` (leave any pre-existing entries).
