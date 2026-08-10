# Headless Operator Re-derivation — the application tier, the control plane, and the console

- **Date:** 2026-08-04
- **Version:** 0.2 (proposed; v0.1 revised against the two §12 pre-presentation reviews —
  architecture and standards/adversarial. Six blocking findings fixed; the review log is §18.)
- **Author:** Claude (design session with Ritsu)
- **Status:** Proposed — awaiting operator approval
- **Owning documents amended by this spec:** see §15. Per the implementation charter
  (stack design principles §13.1), every ruling here that overturns an approved document
  is recorded as a dated amendment in that document, pointing back here.

## 1. Summary

The operator daemon becomes **headless infrastructure**: its durable output is schema'd
receipts, its HTTP surface is a versioned projection of those receipts plus a small
**control plane**, and its human surface is a **separate first-party console** consuming
the same contract. The application tier — SPA, HTTP API, store, earning bootstrap,
support loops — is re-derived per surface from operator needs rather than carried by
default. Execution is sequenced as **stage 6** of the operator-daemon composition
cutover, strictly after the stage-5 rename; the design and its contract discipline take
effect immediately and bind stages 1–5's operator-app deltas.

This spec also dissolves the Phase D "native default flip" framing: there is no
`verticalMode` flip and no parity table, because under the composition cutover the
application tier never leaves the one operator application. Native-v1's runtime is the
machinery the stages swap in; its parallel entry point retires when the stages complete.

## 2. What this supersedes, and why

Two approved documents held competing cutover philosophies for the same estate:

1. The **operator-daemon composition design** (2026-07-30, §3): one operator
   application; the marketplace core recomposed flow-by-flow over six stages; the
   application tier "stays where it is, untouched."
2. The **Phase D cutover plan** (2026-08-04, `~/.claude/plans/imperative-soaring-parrot.md`):
   native-v1 as a separate product selected by `verticalMode`; a D-minus phase deciding
   port/drop/separate-process per legacy surface before any default flip.

**Ruling: the composition design's frame governs.** The flip framing dissolves into
stage progression; the D-minus parity table is replaced by this spec's per-surface
dispositions. The Phase D plan's estate-retirement machinery (transition manifest,
deletion gates, usage instrumentation, observation receipts) is retained — it serves
stage-driven retirement exactly as well as flip-driven retirement.

**Findings against the composition design (surfaced per §13.1, not silently patched):**

- Its §3 "application tier untouched" ruling was pragmatic scope-bounding, never a
  derivation. The research lanes (§17) found the tier accreted rather than designed:
  three auth regimes; a deliberately unauthenticated status endpoint carrying addresses,
  balances, and (via verbatim viem errors on the status error path) paid RPC keys; one
  unauthenticated mutating route; a reward-claim loop off by default against a spec that
  says rewards collect automatically; the CLI reading SQLite directly as a second,
  undesigned contract; a browser-resident notification taxonomy that is spec-canonical;
  and a dead surface set (§4's dead-on-arrival list).
- Its §11 non-goals — "no operator-app redesign" and "no earning/staking recomposition"
  — are binding under stack principles §11, and this spec overturns both. They are
  narrowed by dated amendment (§15), not ignored: the redesign is exactly the stage-6
  disposition this spec adds, and the earning recomposition is exactly §11's surface
  repairs plus §12's *candidacy naming* (not scheduling).
- Its §6.2 mounts the public archive on the operator API by default, separate bind
  optional. This spec **reverses that default** (§6): the public archive is a separate
  listener, mandatorily. To avoid building the mounted shape at stage 4 and rebuilding
  it at stage 6, the split lands **at stage 4** — the §6.2 text and the §10 stage-4 row
  are amended (§15).

## 3. Posture

**Headless node first.** The daemon is infrastructure: machine-readable status, durable
receipts, config files. This formalizes the fleet's existing reality — hosted mutations
are already env vars + redeploy, and `/v1/status` was built expressly to end
`railway ssh` spelunking (deploy/README.md §Headless observability).

**The human surface is a separate first-party console** (§9), a pure client of the
daemon's published contract. Dashboard capability survives, relocated; the daemon stops
serving its own human surface.

**What "headless" does NOT mean:** no writes over HTTP. The adversarial lane refuted
CLI-only mutation with three facts that close a ring: the halted-bootstrap boot path's
only manual unblock is an HTTP route (`client/src/main.ts:1160-1249`); the daemon-guard
correctly refuses broadcasting CLI verbs while `daemon.pid` is live (nonce-collision
class #525/#562/#897); and a hosted node that exits cleanly is never restarted by
Railway's `ON_FAILURE` policy. Deleting mutating routes would promote `railway ssh` to
the production write plane — a root shell with no schema, no audit trail, and no way to
scope "retry bootstrap" apart from "read the keystore." The defensible claim is §4's:
**no application logic in HTTP.**

## 4. The control/application split

Every mutating route is classified. **Control routes** survive; **application routes**
die with their machinery.

### 4.1 The intent-module law

A control route is: idempotent, operator-intent-shaped, schema'd, token-gated, and a
thin front-end over a **pure intent module** — config + signer + store in, result out,
no `CommandContext`, no argv parsing, no `checkDaemonGuard`. The CLI verb is the other
front-end over the same module. **Neither front-end may invoke the other.** The
daemon-guard is a property of the *CLI front-end alone* (it exists to stop an external
process broadcasting beside the daemon; a route running inside the daemon has nothing
to guard against). A guard test asserts no API route constructs or invokes a CLI
`CommandModule` (§8 artifact 5).

This law is currently violated by its own would-be exemplar: `POST /api/admin/claim-rewards`
invokes the CLI module (`admin-endpoint.ts:94` → `runCommandJson(claimRewardsCommand …)`),
whose signer context runs `checkDaemonGuard` with `willBroadcast` defaulting true
(`cli/execution-context.ts:58-60`) — so the route trips the daemon-guard precisely when
the daemon is alive, i.e. always. It has no test. Repair §14.6 re-points it at an intent
module; it is the first intent extracted and the template for the rest.

### 4.2 Disposition table

| Intent | Today's route | Class | Disposition |
| --- | --- | --- | --- |
| Bootstrap retry | `POST /v1/setup/bootstrap/retry` | Control | Keep; dual front-end |
| Agent-binding retry | `POST /v1/setup/agent-binding/retry` | Control | Keep; dual front-end |
| Restart / stop | `POST /api/admin/restart`, `/stop` | Control | Keep; add missing `jinn restart` |
| Claim rewards | `POST /api/admin/claim-rewards` | Control | Keep — after repair §14.6 |
| Claim policy / execution wiring | `PUT /v1/operator/claim-policy`, `/execution-wiring` | Control | Keep — this is the post-stage-1 claim authority; add CLI twin (today none exists) |
| Onboarding-complete latch | `POST /v1/operator/onboarding-complete` | Control (permanent) | Keep with dual front-end. The *route* is permanent operator control; only its **criterion** is bridge-era — restated against claim-predicate + wiring readiness when stage 1 retires `joinedSolverNets` gating |
| Primary RPC set/clear | `POST /v1/setup/network` | Control | Keep; dual front-end |
| Keystore password change | `POST /v1/setup/change-password` | Control | Keep (CLI twin exists) |
| Token pairing / rotation | *(new)* | Control | `jinn auth rotate` + a pairing intent that prints/rotates the operator token (§9) — the one intent that must also work daemon-down |
| Faucet drip (+cap/cooldown) | `POST /v1/setup/drip`, `GET …/quota` | Control (testnet) | Keep on testnet builds |
| Debug report | `POST /v1/debug-report` | Control | Keep; add CLI twin |
| Pricing | `POST /v1/operator/pricing` | Control | Keep (config write) |
| Join / leave SolverNet | `POST/DELETE /v1/operator/join/:cid` | Application | **Retire at stage 1** with `joinedSolverNets` gating (composition §9: gating retires stage 1, registry client stage 4, legacy keys stage 5). No CLI twin is scheduled — the eligibility authority becomes claim policy + wiring, which has its own row |
| Captures approve/skip/trust | `POST /api/captures/*` | Application | Retire from HTTP when the capture flow's owner surface moves (dogfooding surface; CLI `jinn capture` remains) |
| SolverNet drafts / launch / lifecycle / generator | `/v1/solvernets/*`, `PATCH /v1/launcher/*` | Application | **Dissolve with the machinery** — stage 3 retires the creator loop, launched-record generators, and lifecycle publishing; the residual requester capability is the posting loop's work-client module (composition §8). Nothing relocates to the console |
| Requester posting surface (stage 3's delta) | *(new at stage 3)* | Application | The composition design mandates an operator-app posting delta at stage 3. Ruling: posting **status** joins the read plane (receipts/status projection); posting **mutations** are config + `jinn tasks` (which gains the lifecycle exits per composition §9); the console gets a read-only posting view at stage 6. No mutating posting routes are built |
| Claude install / auth spawn | `POST /v1/setup/claude/install`, `/v1/auth/claude/spawn` | Application | Retire; harness auth lives in the harness's own store (docs/operator/rotating-harness-keys.md); onboarding re-points at the doctor probes |
| Embedded-agent WebSocket | `ws /api/agent/ws` | Application | Retire with its feature flag (default off; cookie-only auth that §9 removes from the contract) |
| Legacy per-net toggle | `POST /v1/setup/solvernets/:name` | Application | Retire with the legacy shape |
| Stop-hook ingest | `POST /api/stop-hook` | Application (external tool) | Keep but **gated with a compat path** (§14.1) |
| Artifact insert / acquire | `POST /artifacts`, `POST /v1/artifacts/acquire` | Application (MCP) | Keep bearer-gated as today; owned by the corpus/MCP surface, not the console |

**Dead on arrival** (delete, no successor): the unmounted leaderboard route + pages; the
`not_implemented` loop pause/resume stub; the route-less `updateHarnessMode` SPA client
method; the unregistered `jinn checkpoint` CLI module (its staking namesake, the
checkpoint loop, stays); the never-returned `'live-closure-validated'` readiness value
(`native-vertical-mode.ts:32`) until the closure verifier exists (§7); the unreachable
`config.requireAuth` ERC-8128 branch (`server.ts:397` — nothing ever sets it; artifact
auth is re-decided when the corpus surface needs it, not carried dead).

### 4.3 Listener inventory

The daemon runs more than one listener; each is named and classed — nothing is implied:

| Listener | Class | Ruling |
| --- | --- | --- |
| Operator API (`apiPort`, default 7331) | `operator` | Token-gated per §6; loopback default |
| Public discovery archive (stage 4+) | `public` | Separate listener, archive records only (§6) |
| OTLP trajectory receiver (`/v1/traces`) + LLM proxy | harness-facing | Loopback-bound **asserted** (today unauthenticated); part of the execution plane, not the operator contract; out of console scope (§16) |

## 5. Fail-closed on integrity, degrade-open on economics

Boot-time verification distinguishes two condition classes:

- **Integrity — fail closed.** Continuing would be unsafe or unsound: missing/undecryptable
  keystore; RPC chain-id mismatch; a trust-catalog/genesis-digest mismatch; an expired
  compatibility bridge; and — new — a **resolved broadcast-target address set that does
  not match the pinned per-network deployment digest** (one hash of the resolved
  {staking proxy, distributor, marketplace, router, token} set compared against a
  checked-in per-network constant). Without that last check, degrade-open keeps a
  misconfigured broadcaster broadcasting — address fields are presence-checked only
  today, and deployment-artifact paths are env-overridable.
- **Economics / compatibility — degrade open, loudly.** The condition is merely
  unprofitable or version-skewed: service evicted, Safe under-funded, service unstaked,
  agent unbound, bootstrap halted mid-way, and `configShapeVersion` newer than the
  binary. (Shape-version-newer is deliberately *not* integrity: the composition design
  §9 made migration additive/atomic expressly so a pinned previous canary boots from a
  migrated file — fail-closed here would break the ratified rollback posture and turn a
  stall into a dead daemon.) The daemon boots into **`degraded`** readiness, emits the
  state message, and applies per-loop admission.

**Per-loop admission, defined:** the loop registry gains an `admission: 'always' |
'ready-only'` field consulted in `runLoop` before each tick. `ready-only` loops (the
work/claim path) do not tick in `degraded`; `always` loops — eviction-check, checkpoint,
balance-topup, the bootstrap retry/funding poller, and reward-claim once §11's default
flip lands (until then the default-config degraded set is the first four) — keep
running so the condition can self-heal. Metrics: `jinn_loop_last_tick_seconds{loop}`
and `jinn_loop_admitted{loop}` (§6.2).

This ratifies, rather than reverses, the decision recorded at
`client/src/earning/bootstrap.ts:1225-1245` (#773/#789/#917): eviction recovery belongs
to the running eviction loop, never to inline boot-time broadcasts. Fail-closed boot
would convert every self-healing economic condition into an absorbing state. Native-v1's
current all-or-nothing readiness gate is re-derived into this model when its machinery
is swapped in.

> **Scope note (2026-08-05, from PR #2420 review finding R4):** degrade-open boot
> engages only where a bootstrap halt is *raised* rather than fatal — i.e. interactive
> and local operators. Hosted headless fleets (`JINN_NO_UI=1`) take the fatal-exit path
> and rely on supervisor restart (`ON_FAILURE`) as their recovery loop; that is the
> intended headless answer, not a gap — the supervisor restart re-enters the same
> idempotent bootstrap. The two mechanisms are the same invariant ("an economic halt
> must not produce a dead node") realized per deployment shape.

## 6. The read plane

**Receipts are the truth; the API is a projection of them — plus a declared live-health
class.** A guard test enforces "no unreceipted **durable** fields": everything served
either traces to a receipt/store field or belongs to the typed **live-health class**
(readiness + reason, loop heartbeats/admission, RPC slot health) — process-transient
values that are meaningless to persist. Nothing else.

Composition (from the standards audit; every carrier is an adopted standard, only the
semantics are Jinn's):

1. **`GET /health` + `GET /ready`** — liveness always-200; readiness with an explicit
   mapping: **200** for `ready` *and* `degraded` (both mean "do not restart me" — a 503
   here would restart-loop a daemon correctly waiting for funding, the exact absorbing
   state §5 prevents), **503** for `bootstrapping` and integrity-failed. The machine
   `reason` code is the discriminator; work admission is a separate `accepting_work`
   boolean, never overloaded onto readiness. Shallow, unauthenticated-safe: booleans +
   reason codes only. (No Railway healthcheck exists today; this defines the contract
   before one is pointed at it.)
2. **`GET /metrics`** — Prometheus text exposition, `jinn_` prefix, labels from the loop
   registry (which gains the admission field, §5). Counters and gauges only; every value
   derivable from receipts or the live-health class; `/metrics` is never a source of
   truth. Balances as whole-token floats; exact `bigint` strings stay in documents.
3. **Status head + receipt reads** — the transport profile of composition §7.3 as
   refined 2026-07-30: `Cache-Control: immutable` on digest-addressed sealed receipts,
   weak ETag + `no-cache` on the mutable status head. The indexer's `freshness.ts` is
   the pattern but hardcodes one cache policy — it is generalized to take a policy
   argument, not reused as-is.
4. **Lifecycle tail** — SSE with `Last-Event-ID`, events enveloped as CloudEvents
   structured JSON following **TEP's observation profile** (reverse-DNS versioned types,
   required `datacontenttype`, bounded payloads — `packages/task-execution/protocol/src/schemas/observation.ts`),
   *not* discovery's announcement profile (single frozen type, no version, and its own
   header rules out observation streams). Types are `network.jinn.operator-lifecycle.<kind>.v1`
   with an explicit snake→kebab mapping table; `subject` is the operator/service URI.
   Precondition: the `LifecycleKind` vocabulary is currently **forked in-tree** (16
   values in `observability/emit-event.ts`, 12 in the SPA's `event-kinds.ts` under a
   comment claiming alignment); it is de-duplicated to one exported list before any CE
   `type` is minted from it (§8 artifact 6) — identifiers cannot be un-minted
   (DR-2026-08-04 §6 vocabulary rules apply to the segment naming).
5. **Notification derivation moves server-side** at `GET /v1/notifications`, as a pure
   function over receipts + the live-health class. The canonical vocabulary is
   OPERATOR-APP-SPEC §2.10's **16 kinds, of which 14 are implemented** — the two
   unimplemented RPC-health kinds (`rpc_all_failed`, `rpc_primary_degraded`) become
   implementable exactly here, since the live-health class carries slot health. Three
   derivations change semantics or stay client-side, named explicitly: `restart_required`
   becomes *config-file-newer-than-boot* (a semantic change from today's browser-session
   flag — server-derived, so all consumers see it); the *daemon-offline* condition is a
   console/CLI-local overlay by construction (a server cannot report its own
   unreachability); connection-state dedupe residue in today's hook disappears once the
   SSE tail honors `Last-Event-ID`.

   > **Amended 2026-08-05 (PR #2424 review finding F1):** the *mechanism* parenthetical
   > above ("config-file-newer-than-boot") is superseded — mtime inference falsely fires
   > forever on the daemon's own hot-applied config writes (onboarding-complete, pricing).
   > The semantic stands ("a restart-requiring change is pending, server-derived"); the
   > mechanism is an explicit daemon-held flag set by the restart-required write paths
   > (claim policy, memberships, RPC config) and cleared at boot. Out-of-band manual
   > config edits do not raise it — the accepted trade, matching the browser-era scope.
6. **OpenAPI 3.1, generated** from the Zod schemas — never handwritten. SSE and
   Prometheus surfaces are referenced as external profiles.

**Payload classes and the split listener.** Two named classes, typed in code: `public`
(archive records only) and `operator` (everything else, status included). The public
archive is a **separate Hono app on a separate listener** — this reverses composition
§6.2's mounted-by-default ruling (amended, §15) and lands **at stage 4** so the split is
built once. Operator-class payloads are token-gated **regardless of bind address**;
the localhost bind is defense-in-depth, not the auth model. `/v1/status` loses its
deliberate auth exemption (§14.5). `/health`, `/ready`, `/metrics` are the only ungated
operator-listener routes and carry no identity, path, or credential material.

## 7. Receipts: authority classes

Two classes, and the class must match the discipline:

- **Class O — observation.** Unsigned versioned-Zod JSON, `0600`, atomic rename —
  emitted only through a `writeObservation()` helper in the container library, with the
  mode as a tested assertion, not a convention (the one existing Class O writer,
  `phase-d-transition-usage.ts`, omits the mode today — repaired in §14.7). Never read
  by a gate — enforced two ways: a guard test asserts no gate-path module imports an
  observation reader, and Class O data crossing into `/v1/status` is tagged
  (`class: 'observation'` on the payload subtree) so a consumer cannot silently promote
  it. The transition-usage counters and the rolling status snapshot live here; the
  observation-window receipt (merged in #2385) is Class O whose *container* is brought
  up to the profile (it currently uses hand-rolled validators and pretty-printed JSON).
- **Class A — authority.** Anything a gate reads: DSSE-sealed signed records using the
  trust core (`packages/trust/core`), JCS-canonical bytes, `documentDigest`, and any
  field asserting an external fact (a tx hash, `finalized: true`) **resolved against
  that external source**, never self-consistency-checked. The chain-anchored
  `native-canonical-observations` journal is the natural anchoring substrate.
  **Class A is a target state, not a present discipline** — today no closure-receipt
  writer runs in production and no closure verifier exists (`native-vertical-mode.ts:115-117`
  says exactly this); the Phase B closure receipt therefore cannot gate mode selection
  until the verifier ships, and `'live-closure-validated'` stays dead vocabulary (§4.2)
  until then.

**The human gate is in scope.** The deletion gate reads the checked-in transition
manifest, so the receipt→deletion link is a human editing a PR — and the class system
must bind that hop or it is cosmetic: **a PR that flips a transition-manifest row to
`deleted` must cite Class A evidence in its body; Class O counters may inform the
decision but may not be the cited basis.** The deletion test asserts the citation field
is present and resolves.

## 8. The contract artifact

Today's only skew defense between daemon and SPA is co-packaging; the SPA's types are a
1,093-line hand-maintained duplicate with no contract test. Before the console exists:

1. Every read payload carries **`contractVersion: { major, minor }`** — the handshake
   fails on major mismatch and warns on minor-ahead-of-console; minors are additive.
2. The response schemas are published as a **schema module both sides import**; the
   acceptance test is deleting `client/src/dashboard/spa/src/api/types.ts`.
3. The console performs the version handshake at startup and renders an explicit
   incompatibility state rather than a half-broken dashboard.
4. A **contract conformance test** joins the release tiers.
5. A guard test asserts **no API route constructs or invokes a CLI `CommandModule`**
   (the §4.1 law).
6. **`LifecycleKind` is de-duplicated** to one exported vocabulary before the CE types
   mint from it (§6.4).

**The unknown-kind rule (contract clause, not advice):** every notification and
lifecycle item carries server-supplied `severity` and human-readable `title`; consumers
MUST render unknown kinds from those fields rather than from a client-side kind→copy
map, and unknown SSE `type`s render from envelope fields, never dropped. This is what
makes kind-addition genuinely additive against a fleet that demonstrably runs stale
images for weeks — without it, the handshake passes by construction on exactly the
change class that actually occurs.

The console's departure (stage 6) is gated on artifacts 1–6. Stages 1–5's operator-app
deltas build against this contract from now on, so stage-6 relocation is cheap.

## 9. The console

A separate tier-4 product, **operator persona only**, at `apps/operator-console/`
(the website's "run an operator" door stays docs-only). `client/OPERATOR-APP-SPEC.md`
migrates with it and remains its domain model (amended per §15; it moves with the tree
at stage 5's rename and to the console at stage 6). Per repo frontend rules it is a
**new frontend: Next.js + shadcn**, with its own spec — stage 6 is a port, not a
lift-and-shift, and the dead surfaces stay behind.

- Consumes only the versioned read contract + control routes; never files, never the DB.
- v1 is single-node. A fleet view is deliberately out of scope (the Phase D fleet
  manifest is its seed when it comes).
- The requester-side surfaces (today's "Launcher"/curator pages — vocabulary per
  DR-2026-08-04: *requester*) do **not** move here — they dissolve with the SolverNet
  machinery (§4.2). The console inherits: overview, events, notifications, claim policy
  + wiring, network, security, and (read-only, stage 6) the posting view.

**Remote access is a code gate, not prose.** The current token is a local 0600 file
exchanged same-origin for a cookie; §9 does not silently promote it to a network
credential. Preconditions for any non-loopback operator-class response:

1. The daemon serves operator-class payloads to a non-loopback peer **only** behind a
   configured trusted-proxy assertion (`X-Forwarded-Proto: https` from a declared proxy)
   or an explicit `apiInsecureRemote: true` opt-in — the daemon itself never terminates
   TLS, so "TLS-or-localhost" is enforced as *proxy-attested-or-loopback-or-explicitly-waived*.
2. Token transport is **header-based** (`x-jinn-ui-token`), with CORS narrowed from
   today's wildcard to a configured origin allowlist and **no**
   `Access-Control-Allow-Credentials` — the cookie handshake survives only as a local
   convenience outside the contract. (Cookie-with-credentials across origins was the
   alternative and is rejected: it opens every allowed origin to credentialed
   control-plane calls.)
3. The token gains `expiresAt`; `jinn auth rotate` wires the existing dead
   `rotateUiToken()`; comparison moves to `timingSafeEqual` (the bearer path already
   does this; the UI-token path uses `!==` today); the cookie sets `secure` when the
   request arrived over attested TLS.
4. **Token acquisition and location:** the token file lives beside the daemon's state
   (`earningDir`-derived), not `homedir()`-derived — N daemons on one host must not
   share one token — and the CLI resolves `JINN_UI_TOKEN`, else that file. The pairing
   intent (§4.2) prints/rotates it and must work daemon-down.

DEPLOY.md's **daemon/SPA same-origin** ruling is superseded at stage 6 by this section.
(Distinct from DR-2026-08-04's *spec-origin* ruling — `spec.jinn.network`, identifier
namespaces — which is unaffected; §15 records the no-conflict note.)

## 10. The store and CLI contract

Three tiers, replacing the CLI's accidental direct-SQLite contract:

1. **Daemon up** → the CLI reads the HTTP read plane and mutates via control routes,
   exactly like the console — resolving its token per §9.4. A 401 must surface as an
   explicit `unauthorized` error; today's status fetch swallows all failures into a
   silent local-gather fallback (`introspection-context.ts:38-40`), which §14.5 fixes.
   Delegation narrows `daemon-guard` to the true daemon-down broadcast case — the guard
   is not "dissolved," it becomes a CLI-front-end property (§4.1).
2. **Daemon down** → the CLI reads receipts (Class O snapshot gives an honest offline
   `jinn status`) and may execute mutation intents directly — safe precisely because
   the daemon is down.
3. **Direct DB access is diagnostic tooling**, never contract: `client/scripts/*`
   forensics keep it; CLI verbs migrate off it. Single-writer rule: the daemon owns its
   DB files; nothing else writes them.

The `task_runs` deletion and derivation-first recovery stay as the composition design
ruled (stage 5); the native `solver.sqlite`/`evaluator.sqlite` split resolves when the
stages unify the runtime — the read plane, not the file layout, is the contract.

## 11. Bootstrap surfaces

The 11-step machine is kept — it is the OLAS fleet-operations capability candidate
(§12.1) — with surface repairs, **sequenced in §13's "now" bucket** (§5's degrade-open
boot depends on them):

- **One state list.** Today there are two lists at different granularities: the
  machine's 11 `ServiceStep`s (per-service) and the endpoint's 14 display steps
  (fleet-phase; adds the four pre-service steps but **omits `awaiting_stake`** — the
  actual sync bug). The repair is a single typed **fleet bootstrap phase list** =
  pre-service steps ∪ `ServiceStep`, defined once; the endpoint's parallel list is
  deleted only when that union exists.
- **Degrade-open boot** (§5): a halted bootstrap leaves a live daemon in `degraded`
  with the retry intent, funding poller, and recovery loops running — never a dead
  process holding a pidfile.
- **Dual front-ends** for bootstrap retry and onboarding-complete (join/leave retires
  at stage 1 and gets none — §4.2).
- **Reward-claim default flips to on** in standard staking mode. This knowingly
  overturns a recorded rationale (`config.ts:97-99`: manual claiming from the app was
  the intended UX) — that rationale's premise leaves with the SPA, and off-by-default
  contradicts OPERATOR-APP-SPEC §2.7 while silently costing operators money.
  OPERATOR-APP-SPEC is simultaneously amended to admit the manual claim action that
  shipped (the spec currently denies it exists).

## 12. The capabilities the operator composes

Per the layering law these are **tier-3-shaped capability candidates** living inside a
tier-4 product — *candidates* because tier-3 membership is an executable test (platform
architecture §5: allowlist source-boundary guard, frozen dependency direction, no
product-naming identifiers, kit proven by an in-tree fake), asserted only when a
candidate is extracted and its inclusion test goes green. Every extraction deliverable
is "package + guard trio + kit," not package alone.

**Extraction discipline: a candidate is extracted only when a second consumer exists or
is scheduled.** Each keeps an extractable boundary regardless.

| # | Capability | Second consumer | Extraction |
| --- | --- | --- | --- |
| 1 | **OLAS fleet operations** — bootstrap machine, checkpoint, eviction recovery, stOLAS claims | The OLAS ecosystem (external) | Named extractable-by-design; scheduling is a product/positioning call, not taken here |
| 2 | **Notification derivation** — receipts + live-health → the §6.5 vocabulary, pure function | Console + CLI + alerting | Extract at stage 6 |
| 3 | **Read-plane kit** — health/ready, cache-policy freshness middleware, SSE tail, auth-in-constructor, payload classes, OpenAPI generation | indexer-enrichment (health/ready shape only today — a partial precedent, not a full duplicate); the indexer projector/explorer split's tier assignment is an open platform follow-up | Extract at stage 6 |
| 4 | **Supervised-loop runtime** — registry (+ admission field), heartbeats, watchdog, `/metrics` projection | Claim-relayer (#1068 silent-stall is the motivating incident), indexer, Autopilot dispatcher | Extract when relayer work is scheduled |
| 5 | **Receipt containers** — Class O/A profile, `writeObservation()` | Relayer, benchmarking, Autopilot | Extract at stage 6 (small; lands next to trust core) |
| 6 | **Keystore + wallet ops** | Claim-relayer | **Boundary only.** Packaging is the marketplace-surfaces session's call (composition §8/§12.1 route the key-material question there, against the 2026-07-24 external-consumer boundary); no schedule is set here |
| 7 | **Harness doctor probes** | Benchmarking app, Autopilot | Extract when either asks |

The broadcast capability already followed this path (venue-base, D0a) and is the
precedent; the relayer is its unserved consumer too.

## 13. Sequencing

**The design binds now; the surface execution is staged.** Rationale is mechanical:
stage 4's archive-mount task assumed the SPA fallback; stages 1 and 3 ship operator-app
deltas with same-PR OPERATOR-APP-SPEC updates; the two CI e2e gates (`e2e:app-flow`,
`e2e:funding-sequence`) centrally assert that mutations fired — removing the surface
mid-cutover voids the gates guarding the cutover.

> **Amended 2026-08-05** per
> [DR-2026-08-05](../../../log/decisions/2026-08-05-cutover-one-swap-collapse.md)
> decision 5: the one-swap retires the surfaces `e2e:app-flow`'s current specs exercise,
> so the gate's **composition** changes inside the swap train (this section's ruling —
> never a green-less commit — is unchanged): a train PR before the retirement wave
> authors replacement specs (mutation-asserting claim-policy/execution-wiring; read-plane
> posting-status) and re-points `e2e:app-flow` while the old specs still pass; the
> retirement PR then deletes the old specs with their surfaces. `e2e:funding-sequence`
> is untouched. Stage 6's re-home precondition is unchanged in kind and ranges over the
> re-scoped spec set.

- **Now:** contract discipline (§8) binds all new work; §11's bootstrap repairs
  (degrade-open boot, the unified phase list, the reward-claim default) land as
  ordinary work — §5's runtime model takes effect with them; security repairs land per
  §14 **in §14's stated internal order**; stage plans 1/3/4 gain addendum notes (deltas
  build against the versioned contract; stage-4 builds the split listener per §6).
- **Stage 4 change:** the public archive lands on its own listener (§6), amending the
  stage-4 row.
- **Stage 5 addition:** the transition-manifest rows referencing the `verticalMode`
  branch flip to `deleted` in the same PR that deletes the branch, or the
  platform-architecture-control workflow goes red.
- **Stage 6 (new):** SPA departs to the console (gated on §8's six artifacts and on
  re-homing the two e2e gates onto the console's pipeline); application routes retire
  per §4; the remaining read plane lands per §6; CLI migrates per §10; extractions per
  §12.

## 14. Security repairs promoted from findings

Ordinary fixes landing ahead of stage work, **in this order** (3 and 5 before 4 —
fixing the dead bind-host knob *activates* whatever operators have written into it, so
the gates must be unconditional first):

1. **Gate `POST /api/stop-hook` — with its compat path.** The route is unauthenticated
   with wildcard CORS. But the hook binary only *conditionally* sends
   `Authorization: Bearer $DAEMON_API_TOKEN` and the server never checks it; hooks
   installed into operators' own harness configs get no token at all. The repair: the
   route requires the bearer the daemon-spawned path already forwards;
   `jinn-stop-hook` **fails loudly** when the token is absent (today it silently omits
   the header); the same PR rewrites out-of-daemon hook configs via the existing
   install-hooks path. "Gate it" without these is a silent-breakage instruction.
2. **Mask credential-bearing error strings on the response/receipt path.**
   `maskRpcHost` exists with three call sites — all on the boot/preflight *log* path;
   the status error path (`gather-status.ts` returns verbatim `error.message`, and viem
   embeds full RPC URLs) bypasses it. Route API/receipt error strings through it; add a
   lint/guard over the error-shaping helpers in `api/`.
3. **Auth gate moves into the server constructor**, unconditional, routes declaring
   their class. Precondition: inventory the `daemon.ts:453` construction sites (which
   today mount six route families only under `config.ui` and leave `/v1/events`
   ungated) and give the embedded/test path an explicit token.
4. **Fix the dead `apiBindHost` config knob** (`main.ts:505` reads only the env var).
   Ships with a loud boot warning whenever the resolved bind host is non-loopback,
   because the fix activates operator-written config for the first time.
5. **`/v1/status` loses its auth exemption** once §6's health/metrics land. Named
   consumers migrate in the same change: Railway/probes → `/health`+`/ready`;
   `client/scripts/status.ts` and `cli/introspection-context.ts` gain the token — and
   the CLI's silent catch-all around the status fetch becomes an explicit
   `unauthorized` surface (§10.1).
6. **Re-point `POST /api/admin/claim-rewards` at a pure intent module** (§4.1) with a
   test proving it broadcasts with the daemon alive — it is broken today (daemon-guard
   fires through the route's CLI-module call).
7. **`phase-d-transition-usage` writer gains `mode: 0o600`** (its temp file is
   world-readable today; the atomic rename preserves the bad mode).

## 15. Amendments to owning documents

Executed with this spec's approval, each a dated note pointing here:

1. **Operator-daemon composition design** — §3 (application-tier "untouched"
   superseded); §6.2 (separate-listener default reversed, effective stage 4); §10
   (stage-4 row amended; stage 6 row added; stage-5 row gains the `verticalMode`
   manifest-disposal line); §11 (both non-goals narrowed as §2 states).
2. **`client/OPERATOR-APP-SPEC.md`** — rewards drift (§11); notification derivation
   server-side with the reconciled 16/14 kind inventory (§6.5); the two RPC-health
   kinds marked implemented-at-relocation; marked as migrating to the console at
   stage 6 (single logical move; the stage-5 tree rename carries it in place).
3. **Phase D plan** (out-of-repo plan file + `phase-d-cutover-program` memory) —
   D-minus dissolved into stage progression; parity table replaced by this spec.
4. **`DEPLOY.md`** — the daemon/SPA same-origin ruling marked superseded-at-stage-6 by
   §9. No-conflict note: DR-2026-08-04's `spec.jinn.network` one-origin ruling is a
   different axis (spec/identifier origin) and stands.
5. **Stage plans 1/3/4** — addendum notes per §13 (stage 4: split listener; stage 3:
   the posting-surface ruling in §4.2).
6. **Decision record** — `log/decisions/2026-08-04-headless-operator-reconciliation.md`
   recording: composition-frame-governs, control/application split + intent-module law,
   degrade-open economics + the address-set integrity check, receipt authority classes
   + the human-gate citation rule, console separation + remote-access preconditions,
   stage-6 sequencing.

## 16. Non-goals

- No fleet-management console (single-node v1; the fleet manifest is the later seed).
- No change to the marketplace core, the stack packages, or the six-stage cutover's
  flow ordering — this spec adds stage 6, moves one stage-4 deliverable onto its own
  listener, and amends the app-tier ruling.
- No OLAS fleet-ops extraction scheduling (named extractable; the call is Ritsu's), and
  no keystore packaging decision (routed to the marketplace-surfaces session, §12.6).
- No new evidence kinds; receipt Class A reuses the existing trust core.
- No protocol surface: everything here is tier 3/4; TEP, profiles, trust, discovery are
  untouched.
- No redesign of the harness-facing execution plane: the OTLP trajectory receiver and
  LLM proxy stay loopback-bound as-is (now asserted, §4.3) and outside the operator
  contract; their auth posture is a follow-up owned by the execution plane, not this
  spec.
- No multi-tenant or remote-authenticated daemon administration beyond the operator
  token + §9 preconditions; RBAC is out of scope.

## 17. Provenance and method

Produced by the §12 session method (stack design principles): four read-only research
lanes — application-tier inventory, standards audit, operator requirements register,
adversarial boundary review — reconciled by the coordinating session; one material
question at a time (frame → app-tier scope → persona → console); section-by-section
approval; this document; two fresh reviews before presentation. The adversarial lane
materially changed the design pre-draft (it refuted CLI-only mutation and boot-time
fail-closed verification, corrected the receipt-authority premise, and forced the
stage-6 sequencing); the two §12 reviews then reshaped the draft itself (§18). Lane
and review transcripts live in the session records of 2026-08-04.

## 18. Review log (v0.1 → v0.2)

Architecture review: 3 blockers — the control-plane law's exemplar inverts the
dependency and is broken in production (→ §4.1 intent-module law, §8 artifact 5,
§14.6); composition §11's binding non-goals overturned unamended (→ §2, §15.1); the
split listener reverses §6.2's default and voids stage 4 as written (→ §2, §6, §13,
§15.1). Ten importants: unreceiptable notification inputs (→ §6's live-health class);
taxonomy cardinality (→ 16/14 throughout); vacuous bridge-era rows (→ §4.2 split:
onboarding-complete permanent, join/leave retires at stage 1); `configShapeVersion`
fail-closed breaking rollback (→ §5 degrade-open); tier-3 membership asserted without
the test (→ §12 "candidates"); keystore packaging preempting a routed hand-off (→
§12.6); the stage-3 posting surface orphaned (→ §4.2 row); the CLI's own status
consumer and its silent 401 (→ §14.5, §10.1); token location/acquisition unspecified
(→ §9.4, §4.2 pairing intent); the bootstrap state-list repair losing states (→ §11).

Standards/adversarial review: 3 blockers — the remote token as an unscoped network
credential with unenforceable transport (→ §9's four preconditions); Class O's false
0600 property, missing enforcement, laundering hop via `/v1/status`, and the unbound
human gate (→ §7 rewritten, §14.7); the stop-hook repair breaking externally-installed
hooks (→ §14.1 compat path). Importants: §5/§11/§13 describing different daemons (→
§13 "now" bucket, §5's staged loop set); the wrong-address gap in degrade-open (→ §5's
address-set integrity check); `degraded` readiness HTTP semantics (→ §6.1 mapping);
the wrong CloudEvents profile and the forked `LifecycleKind` vocabulary (→ §6.4, §8
artifact 6); no unknown-kind rule and a self-contradictory `contractVersion` (→ §8);
§14's internal ordering and the bind-host activation hazard (→ §14 order); per-loop
admission underspecified (→ §5). Minors folded throughout (listener inventory §4.3,
`freshness.ts` generalization, DR-2026-08-04 vocabulary and no-conflict notes, console
placement, ERC-8128 dead branch, Class A target-state honesty).
