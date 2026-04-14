# Jinn Client Surface — Planning Pass

> Status: Planning doc, not a spec
> Date: 2026-04-14
> Branch: `ale/jinn-client-surface`
> Reference: `docs/planning/2026-04-jinn-mvl-on-olas.md` @ `6a757761` (on `ale/jinn-phase-plan`)

## Framing

The MVL-on-OLAS proposal talks about "operator UX" as if the reader is
a human who will read a runbook and click through faucets. That is
**not** the realistic user. The realistic user of the jinn client is an
AI coding agent (Claude Code / Codex / Cursor) dispatched by a human
who wants to run a service. The agent reads the repo, follows a path,
and either ends in a running daemon or ends with an actionable error.
Setup must be legible and one-shot from that agent's perspective.
Humans are the secondary user; what is good for the agent is also good
for the human.

This doc does three things:

1. Walks the path from `git clone` to "daemon running on testnet with
   at least one intent submitted," enumerating every step and the ways
   each step can fail silently or stall the agent.
2. Proposes a stable client-facing vocabulary that hides backend
   implementation details, so agent-written automations don't break
   every time a contract is renamed or a module is restructured.
3. Recommends the smallest sequence of follow-up work that closes the
   highest-leverage gaps and locks the vocabulary in.

No code or config is modified by this pass.

---

## Step 1 — Walking the path from `git clone` to first intent on testnet

Target end-state: daemon running against Base Sepolia, fleet bootstrap
complete, at least one `createRestorationJob` call landed on-chain.

### Step 1.1 — Clone and install

- Agent action: `git clone <repo>; cd jinn-mono; cd client; npm install`.
- Requirements: Node >= 20 (declared in `client/package.json:5-7`),
  native build toolchain for `better-sqlite3` (`client/package.json:30`).
- Silent failures:
  - `better-sqlite3` postinstall requires a working C++ toolchain.
    No preflight check; on failure the agent sees an npm error and
    has to infer.
  - `jinn-cli-agents/` is a git subtree and is large; not needed to
    run the client but may confuse `find`/`grep` passes.
- Automatable from one shot: **yes**, assuming toolchain is present.

### Step 1.2 — Read the README and discover there is no testnet path

- Agent action: read `client/README.md`.
- What's there: Phase 0 / Base mainnet, `JINN_PASSWORD=... npm start`,
  Anvil fork instructions. `client/README.md` shows only the
  `rpcUrl → https://mainnet.base.org` default and does not mention
  `network: testnet`, `JINN_TESTNET_L2_DEPLOYMENT`,
  `JINN_TESTNET_TOKEN_DEPLOYMENT`, `JINN_TESTNET_MECH_DEPLOYMENT`, or
  `JINN_TESTNET_STOLAS_DEPLOYMENT`.
- Silent failure: an agent following the README verbatim ends up on
  Base mainnet, not testnet. There is no documented "testnet start"
  command. The network switch exists (`client/src/config.ts:36`,
  `JinnConfigSchema.network`) but is undocumented on the operator path.
- Automatable from one shot: **no** — the agent has to read source
  (`client/src/config.ts`, `client/src/earning/contracts.ts`) to learn
  that `network: testnet` exists and what env vars drive it.

### Step 1.3 — Supply testnet deployment artifacts

- Required env vars (discovered only by reading
  `client/src/earning/contracts.ts:222-302`):
  - `JINN_TESTNET_TOKEN_DEPLOYMENT` — path to JSON with `contracts.l2Token`.
  - `JINN_TESTNET_L2_DEPLOYMENT` — JSON with `contracts.stakingToken`,
    `contracts.serviceRegistry`, `contracts.serviceRegistryTokenUtility`,
    `config.minStakingDeposit`.
  - `JINN_TESTNET_MECH_DEPLOYMENT` — JSON with `contracts.mechMarketplace`,
    `contracts.mechFactory`, optional `contracts.jinnRouter`,
    `contracts.stakingToken`.
  - `JINN_TESTNET_STOLAS_DEPLOYMENT` — JSON with `contracts.distributor`
    (required if `stakingMode: standard`, the schema default at
    `client/src/config.ts:110`).
- Silent failures:
  - If none of these are set, `resolveBaseSepoliaConfig`
    (`client/src/earning/contracts.ts:226-228`) silently returns the
    hardcoded `BASE_SEPOLIA_CONFIG` where `mechMarketplace =
    0x0000...0000` and `mechFactory = 0x0000...0000`
    (`client/src/earning/contracts.ts:189-190`). Bootstrap will still
    appear to run.
  - The agent then reaches `main()` which prints `"No mech
    marketplace configured for testnet. Bootstrap complete, daemon
    not started."` and exits zero
    (`client/src/main.ts:137-141`). The agent has no way to know
    *which* env var was missing without reading source.
  - If `stakingMode` defaults to `standard` and stOLAS artifact is
    missing, bootstrap instead throws `"distributorAddress not
    configured. Set JINN_TESTNET_STOLAS_DEPLOYMENT or use stakingMode:
    self-bond."` (`client/src/earning/bootstrap.ts:1232`). Better —
    the error names the fix — but only surfaces after master wallet
    generation.
- **Where do the artifacts come from?** Not checked into the repo on
  `main`. The agent has to find a recent deploy script run and scrape
  its output, or ask the human. This is the single biggest gap.
- Automatable from one shot: **no**.

### Step 1.4 — Pick a password and invoke start

- Agent action: `JINN_PASSWORD=<string> JINN_NETWORK=testnet \
  JINN_TESTNET_*_DEPLOYMENT=... npm start` (from `client/`).
- `JINN_PASSWORD` is env-only (`client/src/main.ts:38-46`,
  `client/src/config.ts:9`). For an agent this is fine — it
  generates a random password and stores it in its own secret store.
- Silent failures:
  - `JINN_PASSWORD` is used to encrypt the keystore at
    `~/.jinn-client/earning/`. If the agent loses the password it
    loses access to the fleet. No "recover from seed phrase only"
    path is surfaced at the CLI.
  - Running `npm start` from the wrong working directory silently
    picks up a different `.env` file via `dotenv` at
    `client/src/main.ts:34`.
- Automatable from one shot: **yes** if the agent manages the
  password itself, **no** if it has to prompt the dispatching human.

### Step 1.5 — Master wallet generation and funding gate

- On first invocation `FleetBootstrapper.bootstrap()`
  (`client/src/earning/bootstrap.ts:154`) generates a mnemonic, derives
  a master EOA, persists the encrypted keystore, and immediately
  checks ETH balance (`client/src/earning/bootstrap.ts:168-204`).
- Insufficient balance returns
  `{ ok: false, funding: { master_address, eth_required, eth_balance } }`.
  `main.ts` treats this as a clean exit (`client/src/main.ts:88-91`,
  `process.exit(0)`).
- Silent failures / friction for an agent:
  - The process exits **zero** on funding-required — ergonomically
    identical to "daemon started." An agent wrapper that checks exit
    codes would think it succeeded. The funding address is printed to
    stderr but parsing stderr is not robust.
  - There is no structured output (JSON) on stdout the agent can
    grep. The `message` field is embedded in a `console.error` string
    only.
  - After funding, the agent has to re-invoke `npm start`. There is
    no "watch until funded" mode.
  - For `stakingMode: standard` on testnet, the master wallet only
    needs ETH, but the flow still calls stOLAS `distributor` later in
    the service loop — a second implicit funding gate buried several
    steps further in.
- Automatable from one shot: **no**. Realistically needs two shots
  (first shot: learn master address; dispatching agent funds it;
  second shot: actually start).

### Step 1.6 — Per-service bootstrap (Safe, service, staking, mech)

- Once funded, `FleetBootstrapper` walks the 11-step state machine
  per service up to `targetServices` (default `1`, config key
  `targetServices` at `client/src/config.ts:113`). Steps are
  enumerated in `client/CLAUDE.md:154-165` and implemented in
  `client/src/earning/bootstrap.ts`.
- Idempotent: state is persisted to
  `~/.jinn-client/earning/earning_state.json` via `FleetStateStore`
  (`client/src/earning/store.ts`). Safe to re-run.
- Silent failures:
  - Every step is a Safe-executed batch against OLAS registries. Any
    revert surfaces as a generic "execution reverted" unless
    `JINN_DEBUG=1` is set (`client/src/config.ts:116-119`,
    `client/src/operator-errors.ts`). Without debug mode, the agent
    gets a one-line friendly string and must re-run with
    `JINN_DEBUG=1` to see what actually failed.
  - Orphan-sweep (`client/src/earning/orphan-sweep.ts`) runs
    automatically if the state store detects a previous aborted
    attempt. The agent has no signal this is happening beyond a log
    line.
  - `reconcileServiceAgainstChain` (`client/src/earning/reconcile.ts`)
    may silently downgrade/upgrade service step based on chain state,
    which is correct behavior but looks non-deterministic to a dumb
    agent retry loop.
- Automatable from one shot: **usually yes** once funded, assuming
  network is stable. Transient RPC errors are caught at the tx-retry
  layer (`client/src/tx-retry.ts`).

### Step 1.7 — Mech deploy and daemon start

- After step 10 (`mech_deployed`), `main()` reads `firstComplete`
  service, derives the agent signer, builds `MechAdapter`, builds
  `ClaudeRunner`, and starts the `Daemon` with three loops
  (`client/src/main.ts:131-220`).
- **Prerequisite not enforced:** the `ClaudeRunner`
  (`client/src/runner/claude.ts`) spawns `claude` (binary name from
  `claudePath`, default `claude`) as a subprocess. If `claude` isn't
  on PATH the daemon starts but the `RestorerLoop` can't run the
  agent subprocess when it claims a request. No preflight check on
  start. The agent SDK user may or may not have Claude Code
  installed in PATH — this is an environment dependency the client
  surface does not express.
- `mechAddress` may still be undefined on testnet if the mech
  artifact was not supplied. In that case `main.ts:137-141` logs and
  returns cleanly, again with exit zero and no distinguishable signal
  from success.

### Step 1.8 — Submitting one intent

- Once the daemon is running, `CreatorLoop`
  (`client/src/daemon/creator.ts`) posts each entry in
  `config.desiredStates` via
  `JinnRouter.createRestorationJob()`. Default desiredStates is a
  single `"health-check"` entry (`client/src/config.ts:84-89`), so
  the agent reaches "at least one intent submitted" without any
  further action, provided:
  - RPC is healthy,
  - the Safe multisig has enough Base Sepolia ETH for the tx,
  - the `jinnRouter` address is set (comes from
    `JINN_TESTNET_MECH_DEPLOYMENT` when the mech artifact ships it).
- Observability: the agent must either poll `GET /v1/status` on
  `apiPort` (default 7331, `client/src/api/server.ts`) or run
  `npm run status` (`client/scripts/status.ts`). Neither is
  mentioned in `client/README.md`. `scripts/status.ts` is the
  agent-facing introspection entrypoint but is discoverable only by
  reading `package.json:13`.

### Step 1.9 — Gap list (summary)

Ordered by blast radius for an AI-agent one-shot run:

1. **No documented testnet path.** `client/README.md` does not
   mention `network: testnet` or any of the four
   `JINN_TESTNET_*_DEPLOYMENT` env vars. An agent following the
   README ends up on mainnet or stalls.
2. **Testnet deployment artifacts are not shipped.** The agent
   has no way to obtain the JSON files that resolve the testnet
   contract addresses without out-of-band coordination.
3. **Silent fallback to zero addresses.** When
   `JINN_TESTNET_MECH_DEPLOYMENT` is unset,
   `resolveBaseSepoliaConfig` returns `0x0` for `mechMarketplace`
   and `mechFactory`, and the daemon cleanly exits with "bootstrap
   complete, daemon not started." Same exit code as success.
4. **`awaiting_funding` exits zero.** Funding-required is
   indistinguishable from "running" by exit code. Agents polling
   exit status will misread this.
5. **No structured (JSON) progress output.** Every status and
   error is printed as human strings. `scripts/status.ts` does
   return JSON from the HTTP API but is not surfaced as a
   top-level contract.
6. **No preflight for `claude` binary.** Silent dependency on the
   Claude Code CLI being on PATH; only fails at
   restore-request-claim time.
7. **`JINN_DEBUG=1` gates real error context.** Non-debug mode
   collapses failures into one-liners, forcing a retry with debug
   enabled to diagnose.
8. **Two-shot funding dance.** First run → fund → re-run. No
   "watch and continue" mode, and no machine-readable signal of
   what/where to fund.
9. **`npm start` working-directory coupling.** Must be run from
   `client/`, which must contain `.env` (or not — behavior varies
   with whether `.env` exists there).
10. **Password key management is on the caller.** No recovery,
    rotation, or escrow story surfaced at the CLI.
11. **No single binary.** The surface is
    `npm run <script>` from within `client/`. There is no `jinn`
    command the agent can put on PATH.
12. **Status is HTTP-first.** `scripts/status.ts:107-127` falls
    back to an offline snapshot when the daemon API is down, but
    the path is opaque to an agent that doesn't know to look.

---

## Step 2 — A stable client vocabulary

### Constraint

The vocabulary below is what the AI-agent user should call. It must
survive backend refactors: renaming `JinnDistributor` →
`JinnDistributorV2`, moving `reward-claim-loop.ts`, swapping OLAS
bonding for stOLAS, switching the activity checker from V1 to V2,
or replacing the mech marketplace substrate entirely. An agent
written against this vocabulary in April 2026 should still work in
October 2026 even if every backend name changes.

The vocabulary is deliberately **not** an SDK yet — it's the
surface a well-designed CLI or JSON-RPC wrapper would expose.

### Verbs (what the agent calls)

| Client verb | Shape | Today's binding | What can change underneath |
|---|---|---|---|
| `jinn init` | One-shot; generates wallet + password, prints fleet addresses as JSON | `FleetBootstrapper.ensureMasterWallet` | Wallet derivation scheme (BIP-39 word count, HD path); keystore file layout |
| `jinn status` | JSON; bootstrap step, funding requirements, activity counters, pending rewards | `scripts/status.ts` + `GET /v1/status` | Which contracts are read; how rewards are computed; whether state comes from chain or cache |
| `jinn fund-requirements` | JSON; `{ address, asset, amountWei, reason }[]` — exhaustive list of what must be funded before the next step | `client/src/earning/bootstrap.ts:168-204` funding branch | Asset set (ETH only / ETH+OLAS / ETH+stOLAS / JINN); which wallet each requirement targets |
| `jinn bootstrap` | Idempotent; advances the state machine one or more steps and prints the new step | `FleetBootstrapper.bootstrap` | The 11-step list; per-step contract calls; orphan-sweep triggering |
| `jinn run` | Foreground; starts the daemon loops and exits only on SIGINT/SIGTERM | `Daemon.start()` in `client/src/daemon/daemon.ts` | Loop count, loop names, which substrate hosts the loops |
| `jinn submit-intent` | One-shot; publishes a desired state | `CreatorLoop.tick` → `JinnRouter.createRestorationJob` | Router contract name/address; intent encoding; whether it's one contract or several |
| `jinn claim-rewards` | One-shot; pulls any pending protocol rewards for the fleet to the master wallet | `client/src/earning/stolas-claim.ts`, `client/src/earning/jinn-rewards.ts` | Whether rewards are OLAS, stOLAS, JINN, or a mix; which distributor contract; which mint function |
| `jinn withdraw` | Interactive/confirmed; sweeps wallets back to an external address | `client/scripts/withdraw.ts` | Which wallets exist; in what order they can be swept |
| `jinn stop` | Signals a running `jinn run` process to shut down gracefully | SIGINT/SIGTERM handler `client/src/main.ts:208-215` | Loop shutdown order; DB flush semantics |
| `jinn logs` | Streams structured events | (not implemented — `console.log` only today) | Log transport, format, retention |

### Nouns (the JSON shapes the agent reads)

| Client noun | Today's backend shape | What could change |
|---|---|---|
| **Fleet** | `FleetState` in `client/src/earning/types.ts` | Adding multi-service, multi-chain, multi-tenant variants |
| **Service** | `ServiceState` in `client/src/earning/types.ts` + `FleetBootstrapper` step | OLAS `ServiceRegistry` going away; a non-OLAS service model replacing it |
| **Wallet** | master EOA vs agent EOA vs Safe multisig (three kinds, today named differently in logs) | Safe replaced by Privy/another AA primitive; master/agent split collapsed |
| **Funding requirement** | `FundingRequirement` / `SelfBondFundingRequirement` (`client/src/earning/types.ts`) | Asset list expanding/shrinking; new bond tokens |
| **Intent** (aka "desired state") | `DesiredState` schema in `client/src/config.ts:24-28` | The word "intent" may replace "desired state" entirely; schema may gain `deadline`, `evidence`, `reward` fields |
| **Activity counter** | Per-role counts from `JinnRouter` read by `activityChecker` | Router rename, counter granularity, per-channel breakdown |
| **Pending rewards** | `body.rewards.pendingStakingRewardsWei` from status API | Token symbol (OLAS → stOLAS → JINN); multi-channel rewards |
| **Bootstrap step** | 11-value enum from `ServiceStep` | Steps renamed/merged/split across phases |
| **Network** | `mainnet | testnet` at `client/src/config.ts:36` | Adding `anvil-fork`, `arbitrum`, `base-sepolia-phase-1b`, etc. |
| **Deployment** | A JSON artifact path env var per contract family | Replaced by a single manifest, or by on-chain discovery |

### Exit codes (what the agent greps for)

Today there is effectively one exit code (`0` on clean exit, `1` on
throw). Propose:

| Code | Meaning | Today |
|---|---|---|
| `0` | Command completed as requested | Same |
| `10` | Funding required — see `fund-requirements` output | Currently `0` (bug from agent POV) |
| `11` | Missing deployment artifact / config | Currently `0` or `1` depending on path |
| `20` | Bootstrap advanced but not complete — re-invoke to continue | Currently `0` |
| `30` | Chain state conflict — reconcile recommended | Currently `1` |
| `40` | Transient RPC / network error — caller should retry | Currently `1` |
| `50` | Fatal, unrecoverable | Currently `1` |

### Log line shape

Today: freeform `[main] ...`, `[config] ...`, `[bootstrap] ...` via
`console.log`. Propose a single-line JSON form the agent can grep:

```
{"ts":"2026-04-14T...","level":"info","component":"bootstrap","step":"service_staked","service_id":42,"msg":"advanced"}
```

The bindings inside that object are free to change. The shape isn't.

### Vocabulary boundary principles

1. **The word "OLAS" should not appear in the client vocabulary.**
   Substrate is swappable; the client says "bond" or "staking" and
   hides the token identity behind a resolved funding requirement.
2. **The word "Safe" should not appear.** Say "service multisig" or
   just "service wallet." The AA primitive is an implementation
   choice.
3. **Contract names are private.** `JinnRouter`, `JinnDistributor`,
   `ExternalStakingDistributor`, `MechMarketplace` — none belong in
   client output.
4. **File paths under `~/.jinn-client/` are private.** Agents should
   not know where the keystore lives; they should ask `jinn status`.
5. **Env vars are private.** `JINN_TESTNET_*_DEPLOYMENT` should be
   internal knobs, not the primary interface. The primary interface
   is a command and a config file.

---

## Step 3 — Recommendation

Smallest sequence of follow-ups that closes the highest-leverage
gaps and locks the vocabulary in. Each is one item.

1. **Ship a testnet start path in `client/README.md`** — concrete
   command + required env vars + a checked-in example of each of
   the four deployment artifact shapes. *One session. Not blocked on
   Oak's review.*

2. **Check testnet deployment artifacts into the repo** (or publish
   them somewhere the client can fetch by default) so that
   `JINN_NETWORK=testnet npm start` works with no extra env vars.
   *One session. Not blocked on Oak's review, but Oak should weigh
   in on whether the Phase 1b artifacts are the right ones to ship.*

3. **Introduce a `jinn` CLI binary** — a single entrypoint in
   `client/bin/jinn` that dispatches the verbs from the vocabulary
   table. Each verb is a thin wrapper over existing code; no
   behavior changes yet, just the surface. *Multi-session.
   Not blocked on Oak's review.*

4. **Distinct exit codes + JSON progress output** from `bootstrap`
   and `run`. Make `awaiting_funding` exit `10`, print funding
   requirements as JSON on stdout. *One session. Not blocked.*

5. **Preflight check for the `claude` binary** at daemon start —
   error early with a clear message if the subprocess can't be
   located. *One session. Not blocked.*

6. **Turn `JINN_DEBUG=1` errors into the default.** Keep the
   friendly message, but always append the full cause chain. Agents
   need the cause; humans can ignore the trailing lines. *One
   session. Not blocked.*

7. **Document the vocabulary from Step 2 as a spec** in
   `spec/YYYY-MM-DD-client-surface.md` so future refactors treat it
   as a compatibility contract. *One session. Depends on Oak's
   MVL-on-OLAS review — the vocabulary should align with whatever
   operator verbs Oak's proposal eventually blesses (notably
   `claim(serviceId)`).* 

8. **Stretch: a `watch` mode that polls for funding and continues
   the state machine without requiring a re-invocation.** Removes
   the two-shot dance entirely. *Unknown size; touches the funding
   branch of `FleetBootstrapper.bootstrap`.*

---

## Unclear from the repo alone

- Whether stOLAS is the intended permanent bond path on testnet or
  just a temporary stand-in. `stakingMode: standard` is the schema
  default (`client/src/config.ts:110`), but `self-bond` is still
  supported and the phase 1b hardening timeline is not explicit in
  the files read.
- Whether `JINN_TESTNET_*_DEPLOYMENT` artifacts exist on any branch
  of this repo today. Not found on `ale/jinn-client-surface`; would
  need a wider branch scan.
- Whether the "intent" terminology from Oak's MVL proposal is
  intended to replace "desired state" in the client surface, or
  whether they will coexist.
- Whether the client is expected to remain `npm run`-invoked or
  whether a packaged binary is planned elsewhere.

---

## The one-line summary

**The single biggest friction point: an AI agent cloning this repo
today cannot get a testnet daemon running without first reading
source code** — the README has no testnet path, the four required
`JINN_TESTNET_*_DEPLOYMENT` env vars are undocumented, the
deployment artifacts they point to aren't checked in, and the
silent fallback path exits cleanly as if everything worked.
