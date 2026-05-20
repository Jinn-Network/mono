# OPERATOR-APP-SPEC

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

### 2.1 Node

The running daemon itself.

- **Static**
  - status
- **Actions**
  - stop
  - restart
- **Streams**
  - type
  - datetime
- **State messages**
  - misconfigured node
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
- **Actions**
  - rotate agent key *(open question — see §4)*
- **State messages**
  - Safe not bound
  - agent ID not minted
  - identity migration pending

### 2.3 Funds

ETH and OLAS the operator holds across master, agent, and Safe.

- **Static**
  - eth amount
  - runway
    - **Actions**
      - request funds from faucet
  - last password cycle
    - **Actions**
      - change password
- **Streams**
  - transactions
    - time
    - recipient
    - amount
    - explorer URL
- **State messages**
  - runway low
  - password rotation due
  - faucet rate-limited

### 2.4 Network Memberships

The SolverNets this operator has joined. One entry per joined SolverNet, keyed by manifest CID.

- **Static (per joined SolverNet)**
  - participation health
  - last action at
  - environment
    - harness
    - model
    - plugin
    - etc.
    - **Actions**
      - change environment
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
  - evicted from staking
  - restake pending
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
  - join SolverNet
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
- **Actions**
  - cancel task *(open question — see §4)*
- **Streams**
  - progress updates
- **State messages**
  - task stalled
  - harness crashed mid-task
  - evaluation overdue

### 2.7 Rewards

JINN and OLAS the operator has earned or is owed.

- **Static**
  - claimable
    - **Actions**
      - claim
  - claimed
- **Streams**
  - epoch history
    - txn
    - datetime
    - txn url
  - claim history
    - txn
    - datetime
    - txn url
- **State messages**
  - claim available
  - claim failed
  - cross-chain claim pending

### 2.8 Bootstrap

The state of joining the network for the first time.

A separate component because it is a finite, single-pass state machine with its own blocking states. Once complete, the component is dormant; until then, the operator app treats it as a takeover surface — the operator should not be navigating to Memberships or Tasks while Bootstrap is blocked.

- **Static**
  - current step
  - prior steps
  - fleet stage
  - blocking reason (if any)
- **Actions**
  - retry step
  - rebind Safe
  - change network
- **Streams**
  - step transitions
- **State messages**
  - awaiting funding
  - awaiting stake
  - Safe binding failed
  - bootstrap blocked
  - ready to start

### 2.9 Harness Readiness

Whether each supported execution harness is installed, authenticated, and ready to run.

Cross-cuts §2.4 Memberships because a single harness gates many SolverNets. Surfaced at the component level so the operator fixes "harness not authenticated" once, not per SolverNet.

- **Static (per harness)**
  - name
  - installed
  - authenticated
  - ready
- **Actions (per harness)**
  - re-check
  - re-authenticate
- **State messages**
  - harness not installed
  - auth expired
  - version mismatch

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
- `password_rotation_due`
- `harness_not_ready`
- `bootstrap_blocked`
- `service_evicted`
- `restart_required`
- `update_available`
- `rpc_unreachable`
- `no_solvernets_joined`
- `safe_binding_pending`
- `claim_available`
- `claim_failed`

### 2.11 Settings

Operator-tunable configuration.

- **Static**
  - RPC URL
  - peer list
  - default harness
  - faucet endpoint
  - other operator-tunable values
- **Actions**
  - edit setting
  - reset to default
- **State messages**
  - invalid value
  - restart required to apply

Every Settings field declares whether changes hot-apply or require a daemon restart. See §3.2.

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

- **Launcher** — when the operator has launched at least one SolverNet. Drafts, launched records, lifecycle transitions.
- **Artifact Serving** — when the operator serves paid artifacts. Inventory, pricing, access events.
- **Peers** — when the operator connects to a peer network. Peer list, sync status.

## 3. Cross-cutting concerns

### 3.1 Explorer URLs

Streams carry transaction hashes. Constructing an explorer URL from a hash is a single concern, not a per-component one. The operator app keeps a single chain-to-explorer mapping; components reference the mapping rather than baking literal URLs into their stream shapes.

### 3.2 Hot-apply vs restart-required

Some settings and environment changes hot-apply; most require a daemon restart. Every action in this spec that mutates state declares which.

When any restart-required mutation is pending, §2.10 Notifications raises `restart_required` and §2.1 Node exposes the action that satisfies it.

### 3.3 Shared event vocabulary

Streams across components share a single event vocabulary — kinds, fields, and semantics are common across the app. Components do not invent component-local stream shapes; new event kinds are added by amending this spec.

This means: if two components appear to need the same event with different fields, the spec is wrong and one of them needs a different event kind.

### 3.4 Severity

State messages have one of three severities, used by §2.10 Notifications for ordering and by every component for local rendering:

- **blocking** — the operator cannot meaningfully use this component (or the app) until resolved.
- **warning** — the operator should resolve this soon but can continue.
- **info** — passive surface; no action required.

A component cannot invent a new severity. If a message does not fit one of the three, the model is wrong.

## 4. Open questions

These are unresolved spec questions, not implementation TODOs. They are pinned here until ratified.

- Whether `last action at` on a Membership is the most-recent claim, delivery, or any loop tick.
- Whether Notifications persist across daemon restarts, or are recomputed from current state on boot.
- Whether `participation health` is a derived metric or a first-class field; if derived, what its inputs are.
- Whether per-task progress in §2.6 Tasks is a stream of structured events or a single mutable current-state field.
- Whether Identity rotation — rotating the agent key without re-bootstrapping — is in scope for v1.
- Whether `cancel task` in §2.6 is in scope for v1, or strictly future.
- Whether the operator app surfaces a *master vs agent* funds split, or a single rolled-up runway figure with a drill-down.
