# OPERATOR-APP-SPEC

> **Amended 2026-08-04** by the
> [headless operator re-derivation design](../docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md):
> **(1)** §2.7's "no manual claim step … rewards are collected automatically" is corrected —
> a manual claim action shipped (`POST /api/admin/claim-rewards` / `jinn claim-rewards`) and
> stays; the automatic reward-claim loop's default flips to **on** in standard staking mode
> (it ships off today). **(2)** §2.10's notification taxonomy is canonical at **16 kinds, 14
> implemented** — the two RPC-health kinds (`rpc_all_failed`, `rpc_primary_degraded`) become
> implementable when the derivation moves server-side (`GET /v1/notifications`, that spec
> §6.5); the derivation leaves the browser bundle. **(3)** `restart_required` changes
> semantics from browser-session state to *config-file-newer-than-boot*, server-derived.
> **(4)** This document migrates to the separate operator console at cutover stage 6 and
> remains its domain model; the daemon-side contract it implies becomes the versioned read
> contract + control plane defined in that spec.

> Canonical specification of the operator app — the user-facing surface an operator interacts with to run a Jinn node.
>
> **What this doc is.** A model of *what* the operator app shows, *what* the operator can do, and *how* the app surfaces things that need attention. Spec, not implementation. Changes go through CODEOWNERS review with a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions); see [`../spec/2026-04-28-canonical-docs.md`](../spec/2026-04-28-canonical-docs.md).
>
> **What this doc is not.** It is not an API contract, a screen wireframe, or a state map of the daemon's internal loops. Implementation lives in [`ARCHITECTURE.md`](ARCHITECTURE.md). Protocol roles live in [`../SPEC.md`](../SPEC.md). UI tokens and posture live in [`../BRAND.md`](../BRAND.md) and [`../DESIGN.md`](../DESIGN.md).

## 1. Modelling discipline

The operator app is a set of **components** — top-level concepts the operator works with. Each component is described along four axes:

- **Static** — point-in-time values shown to the operator.
- **Streams** — append-only event series the operator can subscribe to or scroll through.
- **Actions** — verbs the operator (or an agent acting on their behalf) can invoke against the component.
- **State messages** — banners or notices the component raises when it needs the operator's attention.

A spec field belongs to exactly one component. If a field could plausibly belong to two, the model is wrong and needs reshape, not duplication.

This is **UI domain modelling** with a state-machine flavour. It is not REST API design and not screen design — both happen downstream of the model. Adding a screen, endpoint, table, or event kind without a corresponding field in this spec is a sign the spec is stale, not that the field is novel.

## 2. Components

### 2.1 Daemon

The long-running daemon process.

The *node* is the union of every component in this spec — daemon, identity, funds, memberships, and so on. This component is the daemon process specifically: the thing that has a binary, a PID, loops, logs, and a lifecycle separate from the operator app's other state.

- **Static**
  - status
- **Actions**
  - stop
  - restart
- **Streams**
  - type
  - datetime
- **State messages**
  - misconfigured
  - restart required

### 2.2 Identity

The operator's on-chain identities — separate from the funds they hold.

Operators have multiple addresses serving distinct purposes. The spec separates *identity* from *funds* because they have different lifecycles and raise different state messages (e.g. "Safe not yet bound" is identity; "balance low" is funds).

- **Static**
  - master address — the EOA that holds custody and seeds the node
  - agent address — the per-node EOA the daemon signs with
  - Safe address — the fleet Safe; the on-chain identity for ERC-8004 binding
  - service ID — assigned by the staking layer
  - agent ID — assigned by the IdentityRegistry
- **State messages**
  - Safe not bound
  - agent ID not minted
  - identity migration pending

Agent-key rotation without re-bootstrapping is out of scope for v1.

### 2.3 Funds

ETH the operator holds.

OLAS held in staking or as bonds is system-internal once committed and does not appear on the operator-facing surface. The node wallet's ETH is what funds gas; that is what Funds shows.

ETH actually lives across three roles — the **agent address** (gas float for the signing key), the **Safe** (operations float for Safe-executed batches), and the **master address** (refill pool). Funds presents a single rolled-up total with a per-role drill-down. This is the simplest model that does not lie about where the ETH is.

- **Static**
  - eth amount (rolled-up; drill-down per role: master / agent / Safe)
  - runway
    - **Actions**
      - request funds from faucet — issues a *batch* of faucet drips up to the daily cap in one click (issue #560). Action states: `idle → batching → complete | cooldown_blocked`. A concurrent batch for the same wallet is rejected (`batch_in_progress`, HTTP 409); the in-flight click owns the cap until it settles.
  - faucet top-ups remaining today (`callsRemaining: number`) — how many batched faucet top-ups the wallet may still issue before the daily cap (issue #560)
  - faucet cap reset (`cooldownExpiresAt: number | null`) — epoch-ms when the daily cap resets, or null when the cap has not been hit
  - last password cycle
    - **Actions**
      - change password
- **Streams**
  - transactions
    - time
    - originating address (master / agent / Safe)
    - recipient
    - amount
    - explorer URL
- **State messages**
  - runway low — **warning**. Native ETH runway is below the low threshold (under 3 days at the daily burn estimate) on a given chain. Raised per chain — both the L2 (Base Sepolia) and L1 (Ethereum Sepolia) master wallets carry their own threshold. Names the wallet and chain. Maps to the faucet top-up action.
  - cannot cover next transaction — **blocking**. The wallet's balance has fallen below the configured minimum (`balanceWei < minEthWei`) on a given chain, so it can no longer fund the next transaction. Distinct, higher-severity counterpart to *runway low*; surfaces `funding_empty` (§2.10).
  - password rotation due
  - faucet rate-limited
  - daily cap reached · resets in &lt;T&gt; — informational; the daily faucet top-up cap is spent and the "request funds from faucet" action is disabled until the cooldown elapses (issue #560)

### 2.4 Network Memberships

The SolverNets this operator has joined. One entry per joined SolverNet, keyed by manifest CID. As of the stage-1 cutover, membership no longer gates claiming — claim eligibility is governed by §2.15 Claim policy & wiring, derived from these memberships by the one-time boot migration; this page remains the legacy view of who the operator has joined until stage 5.

**Onboarding-essential.** Joining at least one SolverNet — with a ready harness (§2.9) and a selected model for its solver role — is part of the Bootstrap completion criterion (§2.8), not a post-onboarding optional step. A node with zero memberships is not eligible to claim any tasks, so onboarding does not report complete until the first membership exists. Evaluator-only joins follow §2.9's evaluator rule (no solver-harness selection required).

- **Static (per joined SolverNet)**
  - last action at — the timestamp of the most recent loop tick that produced an event for this SolverNet (claim attempt, delivery, evaluation, or no-op check). This is the operator's liveness indicator for the membership; the spec deliberately does not expose a derived "participation health" metric on top.
  - environment
    - harness — *(onboarding-essential for the solver role; selected via the §2.9 Harness Selection surface)*
    - model — *(onboarding-essential for the solver role)*
    - plugin
    - etc.
    - **Actions**
      - change environment *(uses the §2.9 Harness Selection surface; see §2.11 Settings for the post-onboarding home)*
  - **Actions**
    - leave SolverNet
    - browse SolverNets *(jumps to §2.5 Registry)*
- **Streams (per joined SolverNet)**
  - actions
    - type
    - result
    - content
    - datetime
    - explorer txn url
    - SolverNet
    - task
- **State messages**
  - harness not ready
  - no roles enabled
  - SolverNet paused upstream
  - SolverNet retired upstream

### 2.5 SolverNet Registry

The catalog of launched SolverNets the operator can discover and join.

Distinct from §2.4 Memberships: the Registry lists SolverNets the operator *could* join; Memberships lists SolverNets the operator *has* joined.

- **Static**
  - launched SolverNets
    - manifest CID
    - name
    - description
    - open roles
    - lifecycle status
- **Actions**
  - join SolverNet — *the first join is onboarding-essential (§2.8); the Registry is the surface from which onboarding's SolverNet-selection step is satisfied*
  - view manifest
- **Streams**
  - new SolverNets registered
  - lifecycle transitions (paused, retired)
- **State messages**
  - registry unreachable

### 2.6 Tasks (in-flight)

The tasks currently mid-execution on this node.

Distinct from the per-membership stream in §2.4: streams are historical; the in-flight view is live.

- **Static (per task)**
  - SolverNet
  - role
  - current step
  - claimed at
  - harness
  - expected completion
- **Streams**
  - progress updates
- **State messages**
  - task stalled
  - harness crashed mid-task
  - evaluation overdue

Cancelling an in-flight task is out of scope for v1.

### 2.7 Rewards

The OLAS the operator has earned. In standard staking mode the daemon's periodic reward-claim loop collects `stOLAS ExternalStakingDistributor.claim` for each staked fleet service automatically (`rewardClaimIntervalMs`, on by default — see amendment banner). A manual claim action also exists (`POST /api/admin/claim-rewards`, `jinn claim-rewards`) for an operator who wants to force a claim between loop ticks, or who has set `JINN_REWARD_CLAIM_INTERVAL_MS=0` to opt out of the automatic loop and claim manually instead.

- **State**
  - lifetime OLAS earned (`claimedStakingRewardsWei`)
  - OLAS earned in last 24 h (`claimedStakingRewardsLast24hWei`)
- **State messages**
  - none
- **Collections**
  - none
- **Actions**
  - claim rewards now — `idle → claiming → claimed` (`failed` terminal alternative); a manual trigger of the same claim logic the automatic loop runs

### 2.8 Bootstrap

The state of joining the network for the first time.

A separate component because it is a finite, single-pass state machine with its own blocking states. Once complete, the component is dormant; until then, the operator app treats it as a takeover surface — the operator should not be navigating to Memberships or Tasks while Bootstrap is blocked.

**Completion criterion.** Bootstrap is complete when the node is **running and eligible to claim tasks** — not merely when the earning state machine (wallet → Safe → service → stake → mech) reaches its terminal `complete` step. Eligibility means the operator has, by the end of the takeover:

- at least one **joined SolverNet** (§2.4); and
- for that SolverNet's **solver** role, a **ready solver harness** (§2.9, installed + authenticated) and a **selected model**.

The earning state machine reaching `complete` is necessary but not sufficient; a node that finished the state machine with zero memberships is *live but idle* and has not finished onboarding.

**Evaluator role is not gated in onboarding.** The node joins as solver **and** evaluator by default, but the evaluator harness is **manifest-bound and runs automatically** (§2.9) — it is not surfaced as an operator choice and its readiness does not gate onboarding completion. Onboarding gates only the solver harness + model.

**Onboarding narrowing (#983).** During the takeover the SolverNet step presents a single launched SolverNet — `swe-rebench-v2` — preselected and joined ("pick your first SolverNet; you can add more later"). The full registry (§2.5) remains the post-onboarding surface for browsing and joining other nets.

**No separate restart.** These onboarding-essential selections are part of the takeover and land config *before* the bootstrap→running flip. The first running-mode boot composes the readiness registry and generators from the resulting `joinedSolverNets`, so a successfully-onboarded node enters running mode already eligible to claim — without a separate operator-initiated restart. (Cross-ref §3.2; this is why onboarding sequences join + harness/model selection ahead of the flip rather than deferring them to the post-onboarding join flow.)

The onboarding-essential fields are **owned by their home components** and referenced here, not duplicated: join → §2.4 / §2.5; harness readiness + selection → §2.9; harness + model on the membership environment → §2.4.

- **Static**
  - current step
  - prior steps
  - fleet stage
  - blocking reason (if any)
  - onboarding-essential selections (gate completion; each owned elsewhere)
    - joined SolverNet (≥1 required) — §2.4 / §2.5
    - solver harness + model per joined SolverNet's solver role — §2.9 (selection + readiness), §2.4 (environment)
- **Actions**
  - retry step
  - rebind Safe
  - change network
  - join SolverNet — *onboarding-essential; satisfied via the §2.5 Registry surface rendered inside the takeover*
  - select harness + model — *onboarding-essential for the solver role; uses the §2.9 Harness Selection surface*
- **Streams**
  - step transitions
- **State messages**
  - awaiting funding
  - awaiting stake
  - Safe binding failed
  - bootstrap blocked
  - join a SolverNet to finish — onboarding-local; raised when the state machine is otherwise done but no membership exists. Distinct from §2.10 `no_solvernets_joined`, which is the *running-mode* "left all SolverNets" case and never fires for a node still in the Bootstrap takeover.
  - harness setup required — onboarding-local; the selected solver harness is not yet ready (§2.9). Resolved in-flow via the §2.9 install/auth action.
  - ready to start

### 2.9 Harness Selection

The surface for choosing an execution harness for a SolverNet's solver role and getting it ready (installed + authenticated) to run.

**Not a standalone dashboard surface.** This component is *not* a first-class card on the overview. Its only useful moments are *while selecting or readying a harness*, so it renders in exactly two places, sharing one model: **(a) onboarding** (the harness + model step of the Bootstrap takeover, §2.8) and **(b) §2.11 Settings** (the canonical post-onboarding home, reached via §2.4 "change environment"). Harness readiness for a joined SolverNet still cross-cuts §2.4 Memberships — a single harness gates many SolverNets, so the operator fixes "harness not authenticated" once — but the operator reaches that fix *through* this selection surface, not via a buried readiness card.

**Scope (#983).** The **onboarding rendering** (a) ships in #983. The **Settings home** (b) and the **removal of the legacy standalone overview readiness card** ship as a separate follow-up (the #983 split). Until that follow-up lands, the legacy overview card may persist; #983 itself only adds the onboarding rendering and clears the post-onboarding `no_solvernets_joined` residue for a freshly-onboarded node (§2.10).

**Three-tier availability.** A harness an operator can actually pick is the intersection of three tiers; the surface makes the distinction legible so an operator understands *why* a harness is or isn't offered:

1. **Available in the protocol** — declared solver-compatible by the SolverNet's manifest. Varies per SolverNet.
2. **Supported by this node build** — compiled into this daemon binary. Static for a given build; a protocol-available harness this build does not ship cannot be selected here.
3. **Installed & authenticated on this machine** — present on the host and passing its readiness check. The operator-actionable tier; an in-tier harness may still be not-installed or auth-expired until the operator runs its install/auth action.

The pickable set is tier 1 ∩ tier 2; selecting a pickable harness then drives it to tier 3 via the install/auth action below.

**Onboarding rendering (#983) — collapsed to one harness.** In the onboarding takeover the surface collapses to a **single solver harness + model** choice; the solver/evaluator split is **not** surfaced. The default is **Codex** with model **GPT-5.4 Mini** (`gpt-5.4-mini`); the Codex model set is GPT-5.4 Mini, GPT-5.5, GPT-5.4, GPT-5.3 Codex, GPT-5.3 Codex Spark (`client/src/dashboard/spa/src/pages/configuration/claudeModels.ts`). The three-tier model above still governs which solver harnesses are offered.

**Evaluator harness.** The evaluator harness is **bound by the manifest**, not operator-chosen, and runs **automatically** — for `swe-rebench-v2` it is the manifest's Docker evaluator, distinct from the operator's solver harness. Onboarding does **not** surface it as a choice and does not gate completion on it (§2.8). The Settings rendering MAY surface its readiness for diagnostics; there is no operator evaluator-harness *selection* anywhere.

- **Static (per harness)**
  - name
  - protocol-available (tier 1, relative to the SolverNet in context)
  - node-supported (tier 2)
  - installed (tier 3)
  - authenticated (tier 3)
  - ready (tier 3 — installed ∧ authenticated ∧ passing its check)
  - role — solver (operator-selected) or evaluator (manifest-bound)
- **State (per harness, auth source — read-only) (#564)**
  - auth source — the credential location: a file path (e.g. `~/.hermes/.env`), an env var, a CLI session, or "no auth required"
  - key suffix — last 4 chars of the credential, masked to `—` when absent or shorter than 8 chars; the full key is never shown
  - last modified — mtime of the credential file (`—` for session/env sources)
  - auth state — `loaded` (credential present & non-empty), `missing` (file/key absent), or `unknown` (CLI-session auth, e.g. claude-code, or probe error)
  - Rendered in §2.11 Settings → Security as a read-only table; each row deep-links to `docs/runbooks/rotating-harness-keys.md`. Data source: `GET /v1/harnesses/auth-status` (suffix + metadata only).
- **Actions (per harness)**
  - select — choose this harness for the solver role of the SolverNet in context (writes to the §2.4 environment)
  - install / authenticate — the per-harness setup action that drives the harness to ready; generalises the existing precheck pattern (install command / auth step, then re-check). Optional per harness: pure-compute harnesses are ready with no action. For the auth store and rotate command/file behind each harness's auth step (and why `client/.env` is not it), see [`docs/operator/rotating-harness-keys.md`](../docs/operator/rotating-harness-keys.md).
  - re-check
- **State messages**
  - harness not installed
  - auth expired
  - version mismatch
  - not supported by this node build — the harness is protocol-available for this SolverNet but not compiled into this build; informational, not operator-fixable from this surface

### 2.10 Notifications

The aggregated state-message surface across all components.

Components raise state messages locally. The Notifications component is the union of all currently-active messages, ordered by severity. It is the place the operator looks when they do not know what is wrong.

- **Static**
  - active notices grouped by severity
    - blocking
    - warning
    - info
- **Actions**
  - dismiss
  - jump to source component
- **Streams**
  - notification raised
  - notification cleared

**Canonical notification taxonomy.** New notifications are added to this list, not invented ad-hoc. The list is the source of truth for what a "kind of thing being wrong" is.

- `funding_low`
- `funding_empty` — a wallet's native balance can no longer cover the next transaction (`balanceWei < minEthWei`), per chain (L2 Base Sepolia and L1 Ethereum Sepolia). Severity: **blocking**. Distinct higher-severity counterpart to `funding_low`. Names the wallet and chain. Derived from `/v1/status` `masterGas` / `l1MasterGas`; clears on the next poll after top-up (§3.4).
- `password_rotation_due`
- `harness_not_ready`
- `bootstrap_blocked`
- `restart_required`
- `update_available` — a newer `@jinn-network/client` has been published. Backed by the daemon's start-time (and 6-hourly) npm-registry check (#641), surfaced on `/v1/status` as `latestVersion` (with the running `version`). The daemon makes the semver comparison: `latestVersion` holds the latest published version **only when it is strictly newer than the running `version`, else `null`**. The banner derives directly from a non-null `latestVersion`. Gated by `JINN_VERSION_CHECK` (default enabled; opt out with `0`/`false`/`no`/empty). Severity: info.
- `rpc_unreachable`
- `rpc_all_failed` — every slot in the RPC fallback chain has failed (`AllRpcsFailedError`). Severity: action_required. The masked host list is included.
- `rpc_primary_degraded` — slot 0 returned HTTP 429 / 5xx during the boot probe or steady-state traffic; a secondary slot served. Severity: informational.
- `no_solvernets_joined` — fires **only** for a running node that has left all its SolverNets *after* onboarding. It is **never** shown to a freshly-onboarded node: onboarding's completion criterion (§2.8) guarantees ≥1 joined SolverNet, so a node that has just finished onboarding always has a membership. The onboarding-local "join a SolverNet to finish" prompt (§2.8 state messages) is the takeover-phase counterpart and is a distinct, non-taxonomy message.
- `safe_binding_pending`
- `claim_failed`
- `config_migrated` — the operator's config was migrated to shape v2 on this boot: a claim policy and execution wiring were derived from the existing SolverNet memberships, beside the legacy keys. Severity: info. Names how many wiring and posting entries were created, and whether per-claim caps are unset (in which case the USD spend gates remain the operative bound). Jumps to §2.15 Claim policy & wiring. Fires once per migrating boot; a re-run is a no-op.
- `unreleased_attempt` — an attempt was claimed on chain but not settled by this daemon; it occupies its `maxClaims` slot until the venue reaps it. Severity: info. Jumps to §2.15 Claim policy & wiring.
- `evidence_indexing_failed` — one or more evidence records failed to index. Severity: info. No action yet; the driver retries automatically.

### 2.11 Settings

Operator-tunable configuration.

**Harness Selection home.** Settings is the canonical *post-onboarding* home for the §2.9 Harness Selection surface — the same model onboarding renders during the Bootstrap takeover, rendered here once the node is running. An operator changes a membership's harness/model (§2.4 "change environment") or readies a harness through this hosted surface, not through a standalone overview card. Onboarding and Settings share one §2.9 model so the operator learns it once. **Scope:** this Settings home ships in the #983 follow-up (alongside removing the legacy overview readiness card), not in #983 itself — #983 delivers only the onboarding rendering.

**Harness auth status (#564).** Settings → Security also hosts a read-only **Harness auth status** table — per-harness auth source, masked key suffix, credential mtime, and a `loaded`/`missing`/`unknown` state — sourced from `GET /v1/harnesses/auth-status` (suffix + metadata only, never full keys). See §2.9's "State (per harness, auth source)" sub-group and `docs/runbooks/rotating-harness-keys.md`.

- **State** (read-only)
  - task posts (last 1h / 6h / 24h) — chain-wide count of on-chain `TaskCreated` events on the active chain's TaskCoordinator / JinnRouter, the protocol-observable task-post rate for this network (#918). Computed backend-side as a **block-window approximation** (Base ~2s blocktime → 1h≈1800, 6h≈10800, 24h≈43200 blocks back from head); the windows nest (1h ⊆ 6h ⊆ 24h) and counts are approximate (a per-call scan cap makes the 24h figure a lower bound on a very high-volume chain). Sourced through the daemon's `DiscoveryAPI.getTaskPostCounts`; polled every 30s.
  - current chain — read-only chain identity (`base` chain id 8453 / `base-sepolia` chain id 84532). Switching chains is a separate fleet-reset flow, not editable here.
  - RPC fallback chain — the live ordered `rpcUrls` chain (slot 0 = primary/head). Each slot renders **slot index + masked host + per-slot health**. Health comes from the boot-time `probeFallbackChain` probe (`rpcSlotHealth`, index-aligned to `rpcUrls`): `healthy` (+ latency) / `degraded · <http-status>` (e.g. 429) / `unreachable`. The probe is boot-time only — the RPC chain is restart-required, so health cannot drift without a re-probing restart. Hosts are masked (path + api-key query strings never render); only hostnames appear.
- **Static**
  - RPC URL — single URL OR an ordered list of URLs (the fallback chain). On testnet the default is a two-provider chain (publicnode + sepolia.base.org). When a list is configured, the daemon builds a viem fallback transport: primary → secondary on network error / HTTP 429 / 5xx; capped at 4 providers. Surface format: provider count + primary host (e.g. `fallback chain (3 providers) — primary=my-alchemy-key.example`). The full chain stays masked in any operator-visible artifact (paths and api-key query strings never appear); only hostnames do. See `CLAUDE.md` "RPC fallback chain" for the full contract.
  - peer list
  - default harness
  - faucet endpoint
  - other operator-tunable values
- **Collections**
  - RPC slots — the ordered `rpcUrls` chain. Item shape: `{ slot: number; host: string (masked); health: 'healthy' | 'degraded' | 'unreachable'; latencyMs?: number; code?: number }`. Ordering: by slot index (0 = primary). No pagination (capped at 4 slots). Read-only.
- **Actions**
  - edit setting
  - reset to default
  - Set Primary — write a single Primary RPC URL via the labeled input. Prepends to the runtime chain: persisted shape becomes `[primary, ...publicDefaults]`. Lifecycle: `idle → saving → saved (restart pending)`; terminal `failed` on write error. Restart-required to apply.
  - Clear Primary — clear the Primary RPC input. Persisted shape reverts to `[...publicDefaults]` (the bundled public backup chain). Same lifecycle and restart semantics as Set Primary.
- **State messages**
  - invalid value
  - restart required to apply
  - Primary RPC missing — informational: no operator-provided primary is configured; the node is on the shared public chain (fine for setup, not reliable under load). Maps to the optional Set Primary action; links to free-key providers.
  - Primary RPC unhealthy — the boot probe saw slot 0 fail (HTTP 429 / 5xx / unreachable). Informational; a secondary slot served. Operators with a paid primary may want to inspect the key's quota; no forced action.
  - RPC fallback chain (N providers) — informational; no action required when every slot is healthy.
  - RPC primary degraded — the boot-time probe (or steady-state traffic) saw HTTP 429 or 5xx from slot 0 but a secondary slot served. Informational; no action required, but operators with a paid primary may want to inspect their key's quota.
  - All RPCs failed — `AllRpcsFailedError` raised on a recent call. Action: check internet, then either confirm the chain hosts are up or update the `rpcUrl` chain in Settings. The masked host list is included for diagnostics.
  - No task posts in the last 24h — informational; the task-post-rate panel renders this zero-state copy (never a blank panel) when the 24h count is zero. No action required.
  - Task-post rate unavailable — the indexer is unreachable (`discovery_unavailable` / `subsystem_not_ready`); the panel shows an explicit "unavailable while the indexer catches up" line. When the underlying cause is `rpc_rate_limited`, it reuses the shared-RPC degraded message (add your own key) rather than the generic outage copy — same taxonomy as the other discovery-backed surfaces (§2.4, registry catalog).

Every Settings field declares whether changes hot-apply or require a daemon restart. See §3.2. The RPC chain is **restart-required** (transport construction happens once at boot).

This RPC-transport fallback is distinct from `discovery.fallbackToOnchain` (one layer up at the read-API: Ponder indexer → direct `eth_getLogs` floor). The RPC fallback operates beneath both layers.

### 2.12 Updates

Daemon version and update lifecycle.

- **Static**
  - current version
  - latest available
  - channel (canary / latest)
- **Actions**
  - check now
  - apply update
- **State messages**
  - update available
  - update failed
  - restart required to apply update

### 2.13 Optional components

These appear only when the operator opts into a corresponding mode. Each follows the same four-axis shape; each is fully specified in its own follow-up when activated.

- **Launcher** — when the operator has launched at least one SolverNet. Drafts, launched records, lifecycle transitions. The owned-SolverNets list (Collection: one row per launched record) exposes a per-row **recent posts (1h / 6h / 24h)** state — the windowed count of on-chain `TaskCreated` events filtered to that row's manifest CID (digest join via `manifestDigestForCid`), sourced through `DiscoveryAPI.getTaskPostCounts` (#918). Scope is per-SolverNet; the same **block-window approximation** as the §2.11 Network task-post panel applies (Base ~2s blocktime; counts approximate). All rows are served by **one batched query** keyed by every owned row's CID (never one query per row), polled every 30s. Zero / unavailable handling matches §2.11: a row with no counts or a 24h count of zero renders "No recent posts" (never blank), and a query error renders a terse "posts unavailable".
  - **Spend & runway** (per launched-SolverNet detail view; `SpendPanel.tsx`).
    - **State** — Safe address, Safe balance, solution price, verdict price, **per-Task cost** (`solutionPriceWei + verdictPriceWei + claim-tx gas`), and **projected runway** (Safe balance ÷ per-Task cost, in Tasks at current prices). The claim-tx gas term is a fixed honest-conservative estimate (~175,000 gas × ~0.0115 gwei ≈ 2,000 gwei/claim, #573); there is no live gas feed in the SPA. Excluding it previously over-stated runway by ~100× (133,333 vs ~1,000 Tasks).
    - **State messages** — `runway low` — **warning** severity (rendered with the `--wane` warning token, matching §2.3 Funds' own operator-wallet `runway low` precedent). Raised when projected runway is under 100 Tasks. Maps to **no local action**: top-up lives on §2.3 Funds' operator-wallet faucet, not this panel — the operator tops up their wallet from the Overview faucet and the daemon's balance-topup loop forwards ETH to the Safe automatically. Distinct from §2.3 Funds' own `runway low` (which is about the operator's gas wallet, not the launcher Safe's Task budget).
    - **Collections** — none.
    - **Actions** — none; read-only projection.
- **Artifact Serving** — when the operator serves paid artifacts. Inventory, pricing, access events.
- **Peers** — when the operator connects to a peer network. Peer list, sync status.

### 2.14 Generator panel (added in #570)

Rendered inside a launched-SolverNet detail view, this panel surfaces the live state of the auto-generator that posts Tasks against the SolverNet's launched contract. Configuration edits are handled by the sibling config form (see `GeneratorPanel.tsx`); this entry models only the read-side state surface.

- **State**
  - generator enabled (yes/no)
  - last poll timestamp
  - solver type
  - admission mode (`required` / `python-floor`, swe-rebench-v2 only)
  - pool size
  - entry counts (posted / unposted / live / repostable / saturated / abandoned)
  - total posted (cumulative Tasks the generator has posted this process, swe-rebench-v2 only)
  - last posted instance (most recent instance id the generator posted, swe-rebench-v2 only)
  - publication timestamp (most recent vetted-pool publication, swe-rebench-v2 only)
- **State messages**
  - `vetted_pool_republished` — **info** severity. Raised when `generatorState.poolPublicationUpdatedAt` is defined. Carries prior pool size, current pool size, and the publication timestamp. Purely informational — no action; the daemon has already re-published the vetted-pool artifact and pinned the new CID. (swe-rebench-v2 only.)
  - `vetted_pool_stale` — **warning** severity. Raised when `generatorState.poolPublicationStale` is `true` (an on-disk vetted-pool publication exists under an older `evalSemanticsVersion` than the running daemon's `EVAL_SEMANTICS_VERSION`). Rendered as a one-line notice **distinct from** `vetted_pool_republished` and from the no-publication case (which surfaces no notice). Informational with implicit resolution — no action; the daemon auto-re-publishes under the current version on the next generator tick. (swe-rebench-v2 only.)
  - `vetted_pool_publication_failed` — **warning** severity. Raised when `generatorState.lastError.message` starts with `"vetted pool publication failed"`. Rendered as the existing `GeneratorError` block; the daemon retries on the next tick. (swe-rebench-v2 only.)
- **Collections** — none. The pool is a derived view rendered inline; the panel does not own a paginated collection.
- **Actions** — none in v1. Hot-applyable config edits are owned by the sibling generator-config form on the same panel.

### 2.15 Claim policy & wiring

How this operator decides what to claim and what runs it. Replaces `joinedSolverNets` as the
claim authority at cutover stage 1; memberships (§2.4) remain the legacy view until stage 5.

- **Static**
  - claim predicate mode — `claim-nothing` | `every-runnable` | `match-legacy-manifest-digest`
  - spend cap (wei) — optional per-task ceiling enforced before every claim. Absent means the
    host's USD rolling-window gates (§6.5) remain the operative spend bound — the same behavior
    as before this cutover.
  - AI-unit cap — optional per-task ceiling enforced before every claim. Same absent-is-permissive
    rule as the spend cap.
  - shape version — `2` once the boot migration has run
  - **Actions**
    - edit claim predicate mode *(restart-required)*
    - edit spend cap *(restart-required)*
    - edit AI-unit cap *(restart-required)*
- **Collections**
  - execution wiring entries — one per work kind. Item shape: work kind, harness, model,
    plugins, credential reference, isolation policy, legacy manifest digest (bridge era only).
    Ordered by work kind. No pagination.
    - **Actions**
      - edit wiring entry *(restart-required)*
      - remove wiring entry *(restart-required)*
- **State messages**
  - claim policy migrated from SolverNet memberships — one-time, **informational**, never
    action-required (coordinator amendment 1: an operator with no per-claim caps set is a normal,
    safe posture — the host's USD spend gates remain the operative bound). Names how many wiring
    entries were created and whether per-claim caps are unset; no action maps to this message.
    See §2.10 `config_migrated`.
  - caps at zero — the spend cap or AI-unit cap is **explicitly** set to zero (distinct from a cap
    being merely absent/unset, which is the informational case above): no tasks will be claimed
    until both are raised above zero. Action: raise both caps above zero.
  - unreleased attempt — an attempt was claimed on chain but not settled by this daemon; it
    occupies its `maxClaims` slot until the venue reaps it. Informational in the today
    generation (there is no on-venue release); gains a release action with the revised
    generation. See §2.10 `unreleased_attempt`.
  - evidence indexing failed — one or more evidence records failed to index. Action: none yet;
    the driver retries. Informational. See §2.10 `evidence_indexing_failed`.

### 2.16 Record Archive

The operator's signed, append-only record-discovery archive — the public read surface over the
work this operator has completed and announced. It is served on its OWN listener when the
operator opts in (headless design §6); the operator API is never widened to publish it. Surfaced
read-only on the Network tab (§2.11). Serving is a config opt-in (`publicArchive.enabled`,
default off; `JINN_PUBLIC_ARCHIVE*`), restart-required — the SPA renders the posture, it does not
toggle it.

- **Static**
  - evidence indexing — the driver's cached count of records pending indexing and its cached
    indexing-failure list (`/v1/status` `evidenceIndexing`). Absent until the native evidence
    driver runs.
  - public serving posture — off by default. When enabled, the archive is served on a separate
    listener (default loopback host, port 7332); enabling a non-loopback bind discloses this
    machine's IP address to every consumer.
  - **Actions** — none in the SPA. Public serving is a config opt-in (restart-required); the app
    shows the posture and the IP-disclosure tradeoff, it does not enable serving.
- **Collections** — none. The archive's own entries are protocol data (records, heads, archive
  pages, the SSE tail), consumed by other daemons over the serving plane, not an operator event
  stream rendered here.
- **State messages**
  - evidence indexing degraded — one or more evidence records failed to index; the announcement
    stream stalls until they clear (contract 6). Action: none; the driver retries automatically.
    Warning. Derived server-side and delivered as §2.10 `evidence_indexing_failed` — the card
    renders the server's severity and message, never a client kind→copy map (headless design §8).
  - serving discloses your IP — when public serving is enabled, anyone who fetches the archive
    learns this machine's IP address. Plain-speech safety copy shown wherever the serving posture
    is described; names the mirror/static-host alternative. Informational, no action.

## 3. Cross-cutting concerns

### 3.1 Explorer URLs

Streams carry transaction hashes. Constructing an explorer URL from a hash is a single concern, not a per-component one. The operator app keeps a single chain-to-explorer mapping; components reference the mapping rather than baking literal URLs into their stream shapes.

### 3.2 Hot-apply vs restart-required

Some settings and environment changes hot-apply; most require a daemon restart. Every action in this spec that mutates state declares which.

When any restart-required mutation is pending, §2.10 Notifications raises `restart_required` and §2.1 Node exposes the action that satisfies it.

### 3.3 Shared event vocabulary

Streams across components share a single event vocabulary — kinds, fields, and semantics are common across the app. Components do not invent component-local stream shapes; new event kinds are added by amending this spec.

This means: if two components appear to need the same event with different fields, the spec is wrong and one of them needs a different event kind.

### 3.4 Notifications are derived, not durable

Notifications are recomputed from current component state on daemon boot. They are not persisted across restarts.

Notifications are derivable from the state of the components they describe: `funding_low` is a function of current Funds; `harness_not_ready` is a function of current Harness Readiness. Persisting them risks showing a stale notice after a state change the operator made offline. Recomputing means the notice surface is always current.

The trade-off is that a dismissed-but-still-valid notice does not survive a restart — the operator may need to re-dismiss it. That is acceptable: dismissal is a UI gesture, not a fact about the world.

### 3.5 Severity

State messages have one of three severities, used by §2.10 Notifications for ordering and by every component for local rendering:

- **blocking** — the operator cannot meaningfully use this component (or the app) until resolved.
- **warning** — the operator should resolve this soon but can continue.
- **info** — passive surface; no action required.

A component cannot invent a new severity. If a message does not fit one of the three, the model is wrong.

## 4. Open questions

These are unresolved spec questions, not implementation TODOs. They are pinned here until ratified.

- Whether per-task progress in §2.6 Tasks is a stream of structured events or a single mutable current-state field.
