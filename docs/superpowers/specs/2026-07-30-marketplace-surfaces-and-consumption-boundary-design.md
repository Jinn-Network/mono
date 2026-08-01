# Marketplace Surfaces — the Consumption Boundary, the Work Client, and the Read Plane

- **Version:** 0.2
- **Date:** 2026-07-30
- **Status:** Draft — sections approved in-session (Ritsu, 2026-07-30); two fresh reviews
  (architecture + standards/adversarial) resolved in this revision (§11); operator review of
  the written form pending
- **Shape:** `design`
- **Scope:** who consumes the marketplace platform surfaces and through what (the
  consumption boundary — amending the external-consumer boundary design of 2026-07-24); the
  shape of the public work client and the evidence read plane; the `packages/sdk` retirement
  map; the physical projector/explorer split
  ([#2296](https://github.com/Jinn-Network/mono/issues/2296)); and the DevX program (docs,
  schema-stability and semver policy, conformance-claim checklist).
- **Out of scope:** the `core`/`layer`/`plugin` disposition (plugin session); the operator
  application and daemon cutover mechanics
  ([`2026-07-30-operator-daemon-composition-design.md`](./2026-07-30-operator-daemon-composition-design.md));
  protocol or record semantics (owned by the stack designs); the publish path's mechanics
  ([#2293](https://github.com/Jinn-Network/mono/issues/2293)); benchmarking internals
  (only its marketplace-mode consumption of the surfaces designed here).
- **Depends on:** the platform architecture
  ([`2026-07-30-jinn-platform-architecture.md`](./2026-07-30-jinn-platform-architecture.md),
  DR-2026-07-30); the operator-daemon composition design (§8's extractable requester module
  and §6.1's venue-base npm-posture note); the stack design principles
  ([`2026-07-30-stack-design-principles.md`](./2026-07-30-stack-design-principles.md));
  the marketplace binding design
  ([`2026-07-28-marketplace-binding-design.md`](./2026-07-28-marketplace-binding-design.md));
  the external-consumer boundary design
  ([`2026-07-24-marketplace-external-consumer-boundary-design.md`](./2026-07-24-marketplace-external-consumer-boundary-design.md)),
  which this specification amends. The three 2026-07-30 documents live on the
  platform-architecture branch at the time of writing; this specification merges with or
  after them so its dependency links resolve.

## 1. Summary

Three postures about who may consume the marketplace surfaces coexisted before this design:
the 2026-07-24 external-consumer boundary (schemas + the `jinn` CLI only; "no key material
or tx client in the SDK"); the stack stance ("the packages are the SDK"); and the daemon
composition design's deferral (requester side as an extractable module now, public package
later). This specification ends them as **one policy keyed by consumer class and key
custody** (§4): the 2026-07-24 rule is **amended by re-derivation** — its true, preserved
content is key custody; its package-shape prohibition is replaced by a five-clause custody
law over all published packages.

On that boundary it settles the surfaces (§5–§7): **one work client** — the Request Work
application-layer client for the marketplace venue, packaged from the operator runtime's
proven requester module — and **no new read-side package**, because the read plane's
primitives plus host composition are adequate at the read side's risk level (§5.2). The
`sdk` retires in three phases to a narrow, product-owned Autopilot wire-schema package
(§6). The projector/explorer split lands in two steps, the physical half gated on the
daemon cutover's discovery-serving stage (§7). The DevX program (§8) fixes schema stability
(immutable-by-identifier, digest-bound, golden fixtures as the CI-enforced compatibility
contract with an append-only errata path), package semver, four consumer-class
quickstarts, and an honor-system conformance-claim checklist gated on the reserved profile
URIs resolving.

## 2. Ground truth

Verified by this session's research lanes against the working tree and live sources
(2026-07-30):

1. **`@jinn-network/sdk` is schemas-only.** Dependencies are `zod` + `zod-to-json-schema`;
   no viem, no signing code, no key material anywhere in the package. The 2026-07-24
   boundary is implemented as designed.
2. **The standalone [`Jinn-Network/autopilot`](https://github.com/Jinn-Network/autopilot)
   is a live, exact-pinned consumer**: `sdk@0.1.1` + `client@0.2.2`; imports exactly one
   schemas subpath (`@jinn-network/sdk/autopilot`, 21 sites — including
   `TaskSubmitRequestV1Schema`, which that subpath exports) plus one golden fixture; all
   stateful access via the `jinn` CLI subprocess (`tasks submit`,
   `tasks observe-autopilot-delivery`), gating startup on the CLI's help output. It holds
   no keys and no chain library; it forwards `JINN_PASSWORD` and network config through a
   strict env allowlist.
3. **`marketplace-binding` is tx-capable-by-composition today**: it builds calldata and
   executes Safe transactions with an injected viem `WalletClient`
   (`binding/src/venue/safe.ts`); no package under `packages/` holds key material or loads
   keys ambiently.
4. **Benchmarking marketplace mode is a shipped library consumer** of `marketplace-binding`
   + `marketplace-projector` — through the two-argument `TaskExecutionBackend.submit` and
   host-injected read ports only. It does no settlement or adoption, but its marketplace
   `submit` does post escrow-bearing tasks (§5.1 carries the consequence).
5. **The CLI carries a private copy of the requester application layer**: funds preflight
   (`client/src/tasks/submit-preflight.ts`), live-SolverNet selection, crash-safe posting,
   `TaskCreated` recovery, strict error taxonomy — none of it in the published binding
   legs. There are two escrow-posting stacks in the tree today (the client's mech/Safe
   adapter and the binding), before any external consumer exists.
6. **The read plane's primitives exist and are idle**:
   `@jinn-network/record-discovery-client` has zero in-repo consumers;
   `@jinn-network/evidence-retrieval` exposes a narrow retrieval/federation API; the HTTP
   transports are a daemon-session deliverable (`packages/discovery/transport-http`, stage
   0). `packages/marketplace/venue-base` does not exist yet.
7. **The indexer's legacy-sdk edge is one import** — the swe-rebench held-out slate
   (`packages/sdk/src/solvernets/swe-rebench-v2-held-out-slate.ts`, imported at
   `packages/indexer/src/api/explorer.ts:54`) — and the client publish pipeline couples to
   the sdk: `npm-publish.yml` pins the literal `@jinn-network/sdk@0.1.1` in four places
   (canary spec, stable gate, canary version patch, acceptance env), and the
   external-consumer acceptance script imports `@jinn-network/sdk/solvernets/jinn-repo` as
   a publish gate. Both facts gate the retirement map (§6).
8. Published state: `sdk` 0.1.0/0.1.1 + canaries; `client` through 0.2.2. None of the 45
   stack packages is published ([#2293](https://github.com/Jinn-Network/mono/issues/2293),
   open).

## 3. The threat model on the record

What the 2026-07-24 rule defended, checked against signer-injection designs (the
comparables: Safe protocol-kit and viem are signer-injection tx libraries; atproto's client
holds no keys; none of them — or anyone — ships key material or ambient key loading in a
library; the "no tx capability in published packages" posture exists nowhere in the
comparable set):

- **H1 — key material in dependency trees.** Fully preserved and strengthened: the custody
  law (§4) states it for every published package, not just "the SDK."
- **H2 — bypassing CLI-owned validations.** Real, with money attached: a consumer composing
  the raw binding legs can double-post escrow (non-durable intent store + retry), skip the
  funds preflight (IPFS uploads then a reverting Safe exec), or escrow against a dead
  target. **Closed for supported consumers** — the supported requester surface is the work
  client, which shares one preflight core with the CLI from convergence onward (§4.3) —
  and **open by construction for anyone who opts out**: the raw-leg rule (§4.2) is a
  declared support boundary, not an enforcement mechanism; npm enforces nothing. The
  money-losing scenarios are documented where the legs live. Residual accepted and named.
- **H3 — supply-chain blast radius.** The detection asymmetry is real and named: a tx
  package legitimately receives a signer, so a malicious patch hides inside its normal API
  shape, whereas a schemas package touching a signer is anomalous. Bounded
  architecturally: all writes are Safe-routed, so the mandated class-3 custody guidance
  (dedicated signer, dedicated posting Safe, capped funds) caps blast radius at that Safe's
  balance. A compromised package gains arbitrary signing as the injected account, not key
  exfiltration (viem `LocalAccount` closes over the key). Controls: trusted-publisher
  provenance, no ambient authority, small dependency cones. Residual accepted.
- **H4 — support-surface growth.** The DevX cost of the amendment; owned in §8 (schema
  stability, golden fixtures, semver).
- **H5 — wrapper phishing (new with libraries).** A malicious "jinn-quickstart" package
  wrapping the real ones and harvesting injected signers is the one hazard the library
  world makes easier; identical to the viem/Safe-SDK world. Mitigations: the mechanical
  blessed-package rule (§8.4 — `@jinn-network` scope + trusted-publisher provenance
  attesting a `Jinn-Network` repository; any list page is a rendering of that rule, never
  the rule itself), the scoped-custody guidance, and — aspirationally, labeled as such — a
  work client convenient enough that wrappers have no niche. Named residual.
- **Custody drift.** Outside our repositories it is unpreventable (quickstarts get copied,
  LLM-generated integrations converge on the shortest path). The mechanical controls where
  we own the surface: the custody tripwire guard (§4.1 C2), the docs guard (§8.3), and
  signer-object-only APIs (§4.1 C3). "Keeping the custody-safe path the easiest path" is
  the design intent those controls serve, not itself a control.

The forcing function for the amendment is ratified authority plus shipped consumers: the
extraction gate of DR-2026-07-30 requires platform dependencies to resolve from npm; the
binding is a tx-capable platform package; and benchmarking's marketplace mode is a shipped
in-repo library consumer of the binding. This amendment lands **ahead of** the 2026-07-24
design's own revisit condition (its §10 contemplated *multiple external* consumers
demonstrating process invocation was the wrong boundary; benchmarking is one consumer,
in-repo) — on DR-2026-07-30's authority, with the threat model above on the record. The
open publish-path issue (#2293) is the mechanism, not the authority.

## 4. Q1 — the consumption boundary (amends 2026-07-24, dated 2026-07-30)

### 4.1 The custody law (all published Jinn packages)

- **C1.** No published package contains key material.
- **C2.** No published package performs ambient authority acquisition: no reading
  keystores, disk, env, or config for signing authority; no network retrieval of signing
  authority material (no fetching keys or key handles from URLs named in options); and no
  ambient network selection — packages may export *named, explicit* chain configurations
  (`BASE_SEPOLIA_TODAY`) but never resolve one from the environment, and chain selection
  has no default: the host passes it explicitly. Key-loading code lives only in tier-4
  products (the `jinn` CLI, the operator runtime) — end-user tools, not dependencies.
  **C2 carries a CI tripwire**: a guard over the custody-relevant package set — the
  binding, venue-base, the work client, the pipeline, and any published package whose API
  accepts a signer — red-lines `process.env`, filesystem, and keystore access in package
  sources (binding and pipeline pass today; the guard pins it). The guard is scoped to
  signer-accepting packages because the wider stack uses the filesystem by design (the
  evidence repository *is* disk storage); it is a **tripwire, not the control** — the
  control is review plus C3's API shape.
- **C3.** Write capability enters only through injected signer parameters (viem
  `WalletClient`, scoped-signer interfaces). No package constructs a signer from
  configuration, where "configuration" includes options objects: **no published package
  API accepts private-key strings, mnemonics, or seed material in any parameter position**
  — signer objects only. (This binds every published package, not only the work client.)
- **C4.** Verification profiles fail closed — per the binding design §10's
  external-consumer row and 2026-07-24 §4.4; no published package weakens a fail-closed
  gate for ergonomics.
- **C5.** Published packages carry npm trusted-publisher provenance — SLSA build
  provenance as npm implements it (#2293). Provenance + no-ambient-authority + small
  dependency cones are the supply-chain control, not absence-of-tx-code.

The law changes by the same amendment mechanism exercised here — a dated design amendment
with the threat model on the record.

### 4.2 The consumer-class table

Any future package proposal is tested against this table: name the class it serves, the
surface it extends, and the custody column it lands in. The table governs **package and
CLI consumption** of the platform's marketplace surfaces; it is not a taxonomy of all
network participants.

| # | Consumer class | Blessed surface | Tx capability | Key custody |
| --- | --- | --- | --- | --- |
| 1 | External requester, first-touch ("post tasks, get results") | record schemas + `jinn` CLI | via CLI subprocess | CLI keystore, machine-local |
| 2 | External platform implementer (backend author, record producer/verifier, projector or archive operator) | published tier-1–3 packages + conformance kits + golden fixtures | none required | n/a |
| 3 | External production requester (custody-conscious: KMS/HSM/MPC, non-disk keys, concurrent posting) | **the work client only** (§5) | signer-injection only | integrator-owned via injected signer; scoped-custody guidance mandatory: dedicated signer, dedicated posting Safe, capped funds |
| 4 | First-party product consuming from npm (standalone Autopilot) | schemas + CLI — unchanged | via CLI | CLI keystore |
| 5 | In-repo applications (benchmarking marketplace mode, operator runtime, launcher surfaces) | tier-3 packages (portal now, npm post-#2293) | signer-injection | host-owned (operator keystore stays in the operator application) |
| 6 | Hosted read services (explorer, discovery archive, projector host) | read-plane packages | none | n/a; announcement signing via injected scoped signer |

**Honest demographics.** Class 1 is the first-touch, single-operator path; class 3 is the
expected production path for organizations with custody policy — the CLI loads keys only
from its machine-local keystore, so a KMS-holding organization cannot be class 1. The work
client is therefore load-bearing, not polish. **Until the work client mints (follow-up 5),
class 3 has no blessed surface** — that vacancy is accepted and dated, not hidden; interim
class-3 demand is served case-by-case as class-2-posture composition with the custody
guidance applied.

**External work delivery.** There is deliberately no class for external *programmatic*
Deliver Work: an external party that wants to claim and execute work runs the operator
application — the product is the supported surface for that verb. A headless
"deliver client" over the pipeline is out of scope; revisit trigger: the first external
operator demonstrating a real need to consume the pipeline without the operator product.

**Raw-leg rule (declarative).** Importing the binding's write legs or ports directly is
supported only as platform implementation (class-2 posture), outside the requester
acceptance discipline. This is a declared support-and-blame boundary, not an enforcement
mechanism — nothing technical prevents opting out of it (§3 H2). The work client is the
supported requester surface. Read-side raw package use is unrestricted.

### 4.3 Mechanical parity and convergence

**The shared preflight core is the work client's core — not a third artifact.** Its scope:
funds preflight, live-target selection, freshness, durable-intent (outbox) posting,
`TaskCreated` recovery, strict error taxonomy. Sequencing, in order:

1. **Preflight-behavior golden fixtures** (not only schema fixtures) are authored
   kit-first, against the daemon cutover's stage-3 posting flow — they pin today's CLI
   behavior as the reference.
2. The stage-3 posting flow builds this core inside the operator's extractable requester
   module (the daemon design's §8 deliverable).
3. The work client packages that module (follow-up 5; gate: stage 3 + #2293 canaries).
4. **The CLI converges by importing the work client** — one validation stack, two skins.
   Convergence is gated on follow-up 5, strictly after the mint.

Parity **becomes** a code fact at step 4; until then the two posting stacks (§2.5) are a
named, tracked risk, and the fixtures of step 1 are the drift alarm.

### 4.4 What survives of 2026-07-24 (reaffirmed)

- Schemas + CLI remain the documented first-touch on-ramp and class 4's surface; no forced
  migration for the standalone Autopilot.
- Key loading remains confined to tier-4 end-user products — the `jinn` CLI and the
  operator runtime; **the CLI remains the only such surface offered to external
  consumers**.
- The legacy `@jinn-network/sdk` package never gains tx code (it retires, §6).
- The packed external-consumer acceptance discipline (2026-07-24 §7) extends to the work
  client.

### 4.5 Co-amendments

This amendment lands with, in the same PR:

- the binding design §10 "External-consumer abuse" row restated to reference the custody
  law;
- the binding design §12's "external consumers via SDK schemas + `jinn` CLI only" restated
  as "via SDK schemas + `jinn` CLI (default) or published packages under the custody law
  (2026-07-30 amendment)";
- the binding design §4's tenet restating the CLI boundary, and its §9 sentence "new
  consumer surfaces land as SDK schemas + `jinn` CLI commands" — both annotated to the
  same effect (the boundary design of record is this specification);
- a dated amendment header on the 2026-07-24 design pointing here.

The binding design §11's twelve frozen interfaces do not include the external-consumer
boundary (verified); nothing frozen is touched.

## 5. Q2a/2b — the surfaces: the requester application layer

The backend contract excludes settlement operations (TEP §4.2), and escrow is
binding-internal (TEP §4.3) — so requester-side lifecycle (funds, escrow posting,
settlement, adoption) necessarily lives in an application layer above the backend
contract. Today that layer exists only as the CLI's private copy (§2.5). The governing
principle, scoped honestly: **one application-layer client per marketplace verb side** —
the work client for Request Work against this venue — **and no wrapper layers**: a new
package must do a job the existing layer does not.

### 5.1 The work client

**One tier-3 package** in the marketplace tree (working name
`packages/marketplace/work-client`; settled at the naming pass), the Request Work
application-layer client for the marketplace venue: *post this Submission, await the
delivery, adopt, settle, hand me the evidence* — including requester-side evaluation
Submission sealing (commissioning evidence is Request Work). It composes the binding's
posting/settlement legs, `venue-base`, the durable intent store, and the preflight core
(§4.3), strictly through public interfaces. Signer-object injection only (C3). It never
names a product.

**Build path:** packaged from the operator runtime's proven requester module after daemon
cutover stage 3 proves it end-to-end on testnet — the daemon design built that module
extractable precisely for this; the kit precedes the packaging, per the standing rule.
**Gate to mint:** stage 3 landed + #2293 canary packages. Same structure and disciplines as
the evidence tree's packages: guard trio with the tree, source-boundary allowlist,
contracts-only dependencies, plugs injected by hosts.

Consumers and layers, checked: the operator posting loop *is* the module (reference
consumer); the CLI re-platforms onto it (§4.3 step 4); the standalone Autopilot consumes
the CLI one layer up. **Benchmarking marketplace mode** stays on the backend contract for
execution — correctly, since its job is comparing backends through the uniform interface —
but its marketplace `submit` posts escrow-bearing tasks today without the preflight core's
protections (funds preflight, durable-intent posting). That exposure is a named residual,
partially compensated by benchmarking's own budget validation (`perCell`/`hardCap`), and
its disposition is recorded as a hand-off to the benchmarking program (§10 follow-up 12):
**at work-client mint, benchmarking's marketplace venue adopts the work client's posting
core** beneath its backend-contract surface — same code, no fork; per the designs-are-law
rule this is a finding with a proposed disposition for that program, not a silent patch.

### 5.2 The read plane (no new package) and the facade trigger

The read side ships **composable primitives** — `evidence-retrieval` (bounded exact-byte
retrieval, federation, candidates) and `record-discovery-client` (sync, subscribe, verify),
plus the transports when the daemon session lands them — and their composition is
host-owned (the operator's evidence join is host-owned by architecture test; drivers may
prove host-specific). This is deliberately **not** the write side's shape, and the reason
is risk asymmetry, stated plainly: bare write composition loses money (§3 H2); bare read
composition costs convenience only. At the read side's risk level and consumer count
(§2.6: zero external read consumers), primitives + a documented composition (§8.3
quickstart 4) are the right surface, and a wrapper package would be a second layer with no
job of its own.

**Recorded trigger for a Discover & Retrieve facade:** mint one only when (i) a first
external read consumer or the public hosted archive demonstrates the composition is
genuinely painful, or (ii) the daemon's evidence-driver implementation turns out generic
rather than host-specific.

## 6. Q2c — the `sdk` retirement map

The tier law forces the end state: `jinn-autopilot-session.v1` names a product, so the
`/autopilot` schemas can never enter a tier-1–3 platform package. They are a
product-to-product wire contract (Autopilot ↔ operator CLI) and their home stays a
product-owned schemas package.

Drawn against the sdk's **actual export map** (root `.`, `./harness`, `./plugins`,
`./solvernets` + per-type subpaths + held-out slate, `./autopilot` — which carries
`TaskSubmitRequestV1` — `./fixtures/autopilot/*`, `./checkpoint`, `./benchmarking`):

| Phase | Retires | Successor | Gate / owner |
| --- | --- | --- | --- |
| **R1** (now) | `./benchmarking` (zero importers, verified) | `packages/benchmarking/records` (declared superseded by the benchmarking design) | benchmarking implementation program; sdk 0.2.0. **Owns the release-train changes**: the four `@jinn-network/sdk@0.1.1` literals in `npm-publish.yml` are parameterized from `packages/sdk/package.json` (or bumped in the same PR), so the client canary/stable gates track the sdk version instead of redlining on it |
| **R2** (rides daemon stages 1–4) | root `.` (types + session-derived payloads + the pinned distill prompt), `./harness`, `./plugins`, `./checkpoint`, `./solvernets` and all per-type subpaths — each as its `client/` consumers retire per stage; the held-out slate re-homes per §7 | the task-execution profiles carry the task-typing role; SolverNet-specific content dies with SolverNets; plugin-content pieces defer to the plugin session | daemon cutover stages; one coordinated sdk minor bump per removal. **Owns migrating the publish-gate acceptance script** (`external-consumer-acceptance.mjs` imports `./solvernets/jinn-repo` today) in the same change that removes the subpath |
| **R3** (end state) | nothing further | **sdk narrows to `./autopilot` + `./fixtures/autopilot/*`** — exactly the standalone Autopilot's consumption (§2.2), unbroken. `TaskSubmitRequestV1` lives inside `./autopilot` and survives until the standalone Autopilot migrates to TEP Submission posting (gated on daemon stage 3 + the work client), after which `./autopilot` narrows to the capsule/adoption/observation schemas in a final coordinated bump | ownership transfers to the Autopilot product; whether it renames (e.g. `@jinn-network/autopilot-wire`) is that repository's call |

> **Amended 2026-07-30 (execution finding, gated-tail plan):** R2's premise — every
> SolverNet-era subpath retires with a `client/` cutover-stage consumer — is false for five
> surfaces. Grep evidence: `./harness` is consumed by the external harness-authoring
> templates and docs; `./checkpoint` by the eval orchestrator (`jinn eval` / `checkpoint`);
> `./solvernets/prediction-v1` and `./solvernets/swe-rebench-v2` by shipped harness
> implementations; root `.` by the session-derived/distill solver types. None of those
> consumers retires at any cutover stage. R2 therefore splits: **R2a** (cutover-retired:
> `./plugins` — zero importers, folds into the first bump; the held-out-slate subpath;
> `./solvernets/jinn-repo` at stage 2; the `./solvernets` barrel at stage 4) and **R2b**
> (re-homed on its own schedule: `./harness`, `./checkpoint`, the two solver-type subpaths,
> root `.` — own issue, dispositions coordinated with the plugin and eval-tooling owners).
> R3's end state is unchanged; it is reached after R2b completes rather than after stage 4.

Coordination constraints, honored throughout:

- the standalone repository's exact pins (`sdk@0.1.1`, `client@0.2.2`) mean every removal
  is a coordinated minor bump with a changelog migration note, never a silent break;
- the `npm-publish.yml` coupling (a stable client release requires the published sdk)
  survives until R3, **and its pinned version literals move with every sdk bump** (R1
  owns the parameterization);
- class 4's surface does not break at any phase.

## 7. Q2d — the projector/explorer split (#2296) and hosting

The stack projector (`packages/marketplace/projector`) is projector #1 — the indexer's
projector role is **replaced by the stack, not moved**. Disposition in two steps:

- **Step 1 (now, small):** sever the legacy-sdk edge. The held-out slate
  (`packages/sdk/src/solvernets/swe-rebench-v2-held-out-slate.ts`) **re-homes to
  `packages/benchmarking/records` as a data module** — the tree that owns evaluation
  record semantics — as the single source of truth; the indexer's `explorer.ts` and any
  remaining `client/` eval consumer import it from there until they retire (no
  indexer-local copy: the held-out boundary must not fork). Tier-reflecting package names;
  the guard trio on the projector role. Completes #2296's logical half; schedulable
  immediately.
- **Step 2 (gated on daemon cutover stage 4, discovery serving):** the explorer physically
  separates as a tier-4 product tree; the Ponder process's remaining role becomes hosted
  archive + query plane per the discovery design's projection rules; Railway deployment
  updates ride this step so the explorer re-points once, not twice.

**Hosting posture.** Jinn contributors run the canonical hosted read surfaces (archive
mirror + explorer) as first-party products — maintenance, never privilege. The static-file
archive layout is what keeps "hosting a source costs a static file host" true: any party
can mirror the archive without running Jinn code. The canonical archive first goes live
operator-served at daemon stage 4; a contributor-hosted mirror on static hosting follows as
program work.

## 8. Q3 — the DevX program

### 8.1 Schema stability: immutable by identifier, digest-bound

A sealed-record schema, once published at its identifier (media type + profile URI, e.g.
`https://jinn.network/profiles/task-execution/1.0`), is immutable — **a breaking change is
a new identifier** (`/1.0` → `/2.0`), never an in-place mutation. This is what JCS-once /
sha256 sealing already implies: the bytes are the document forever, so the schema
describing them cannot retroactively change. Additive evolution rides the existing
unknown-fields law (namespaced extensions, never overriding core semantics).

**The identifier is digest-bound, not trust-the-host.** The profile URI is the name; the
bytes are pinned: the hosted profile root serves a SHA-256 manifest of every profile and
schema document (DSSE-signed, same discipline as discovery heads), and conformance claims
cite document digests alongside URIs (§8.4). A hosting compromise or quiet redeploy is
thereby detectable; the URI is never the only binding in a stack whose every other link is
a hash.

**Golden fixtures are the compatibility contract, mechanically, with an append-only errata
path:**

- every published schema ships golden + adversarial fixtures with a SHA-256 manifest (the
  2026-07-24 §3.2 pattern, generalized);
- CI refuses a release that **changes or removes** any existing fixture byte for an
  existing identifier;
- fixtures are **append-only**: adding one (including a new adversarial fixture that
  tightens observable conformance) is at least a minor bump of the carrying package with a
  changelog note — additions are a versioned event, never a silent redefinition;
- a fixture discovered wrong is never edited: it is **superseded** by a corrected fixture
  plus a dated errata record in the manifest (the same append-only correction discipline
  the projector uses);
- authority order: the schema prose at the identifier governs; validators and fixtures
  implement it. A validator change that alters acceptance behavior is a **breaking change**
  (0.x minor, changelogged), even when it is a "fix."

### 8.2 Package semver

Record identifiers version by renaming, so npm semver governs code surface only. For the
0.x era: **minor = breaking** (removal or rename of an exported surface, or an
acceptance-behavior change, always changelogged with a migration note), **patch = additive
or fix**. Types follow the same rule as runtime surface — no type exemption, because the
types mirror schemas and schemas are the contract. Design intent, realized by #2293's
publish path: the stack publishes as a coherent set (same-sha canaries, coherent stables),
which is what prevents intra-release cross-package skew once publishing exists. (Skew
across releases is real today — the standalone repo's `sdk@0.1.1` + `client@0.2.2` are
different cuts — and is managed by the §6 coordination constraints.)

### 8.3 Quickstarts and the docs guard

One quickstart per consumer class, each an owned follow-up:

1. **Class 1:** post a task with the `jinn` CLI.
2. **Class 2:** implement a backend / produce and verify records against the kits and
   fixtures — the "you never run Jinn code" path.
3. **Class 3:** the work client with an injected signer, plus the **one marked custody
   page** (dedicated signer, dedicated posting Safe, capped funds).
4. **Read side:** compose `record-discovery-client` + `evidence-retrieval`.

**Docs guard:** no raw private keys in any documentation or example anywhere — including
the custody page. The only permitted key literals are the standard Anvil dev-account keys
(the mnemonic-derived set every reader already knows is burned; multi-party examples
legitimately need more than one); CI-grepped against that fixed allowlist, whose failure
message names the burned-key exception so a real leak is never "fixed" by allowlisting.
*(Amended 2026-07-30 during execution: originally a single account-0 literal — the guard's
first real run false-positived on Anvil account #1, proving the singular form a standing
false-positive generator.)*

### 8.4 Conformance claims: honor system now, OCI shape reserved

An external party may claim conformance only when:

1. the **published profile URIs resolve** — the reserved `https://jinn.network/…` URIs
   serve their schema/profile documents from static hosting, under the §8.1 signed digest
   manifest. This hard-blocks any external conformance claim and ties into #2293's
   "retrievable without cloning" acceptance criterion;
2. the claim names the kit version and package versions it passed against, and cites the
   profile-document digests, not bare URIs;
3. the kit's results artifact is publishable.

Enforcement is **honor system + published vectors** (the atproto model) — there is no
trademark program and no third party yet; policing would be theater. The OCI shape (claims
filed by PR to a conformance directory with a reviewed evidence bundle) is reserved as the
upgrade path, triggered by the first genuine third-party claim.

**The blessed-package rule (H5 mitigation) is mechanical, not editorial:** a package is
blessed if and only if it is in the `@jinn-network` npm scope **and** carries
trusted-publisher provenance attesting a `Jinn-Network` repository — machine-checkable via
npm provenance verification. Any published list page is a rendering of that rule; the rule,
not the page, is the authority (a lookalike page proves nothing it cannot prove).

### 8.5 Standards audit (per principles §3)

- **Schema stability — adopt atproto's rule** (immutable published schemas; breaking = new
  identifier; shared golden vectors): the one policy consistent with sealed-bytes
  discipline. Considered and not adopted wholesale: **SchemaVer** (Snowplow/Iglu
  MODEL-REVISION-ADDITION — built for immutable schema registries; its ADDITION concept is
  absorbed as §8.1's versioned fixture-addition rule, but its three-part version syntax
  duplicates what URI path versions + package semver already carry); **Confluent Schema
  Registry compatibility modes** (BACKWARD/FORWARD/FULL — the industrial vocabulary for
  "what may change under an identifier"; unnecessary once identifiers are immutable, since
  the only mode is FULL-by-construction); **JSON Schema `$id`** conventions (adopted
  implicitly — the profile URI is the `$id`); **buf-style mechanical breaking-change
  detection** (the golden-fixture CI check is its fixture-level analog; a schema-diff
  linter may be added later without policy change). Rejected: in-place schema versioning
  with package majors (contradicts sealing; makes fixtures advisory).
- **Conformance claims — compose OCI's shape, deferred**: adopt the artifact set (suite +
  results + claim registry) only when a third party exists; adopt the honor-system posture
  now. Rejected for now: trademark-backed policing (no mark, no parties).
- **Custody — the signer-injection norm** (viem, Safe protocol-kit): key-handling code in
  packages is mainstream; ambient key loading is the line libraries do not cross; key
  material in packages is universally absent. Jinn adopts the norm and adds the C2
  tripwire guard that none of the comparables has. C5's "trusted-publisher provenance" is
  SLSA build provenance as npm implements it; **OpenSSF Scorecard** is noted as the
  existing criterion set if the blessed-package rule ever needs more than provenance.
  Rejected: the "no tx capability in published packages" posture — held by no comparable
  ecosystem and already contradicted in-tree.
- **Package semver — viem's strictness without its type exemption**, since Jinn's types
  mirror schemas.

## 9. Non-goals

- No new record kinds, no protocol changes, no changes to any frozen interface (binding
  §11 verified untouched).
- No work-client implementation in this specification — it is packaged from the daemon
  cutover's proven module at its gate (§5.1); this design fixes its shape, surface, and
  law.
- No read-plane facade (§5.2) — trigger recorded.
- No external programmatic Deliver Work surface (§4.2) — the operator application is that
  verb's product; revisit trigger recorded.
- No `core`/`layer`/`plugin` disposition; no operator-app changes; no daemon cutover
  changes.
- No publish-path mechanics (#2293 is program work; this design consumes its artifacts).
- No hosted-service SLAs; hosting is a product undertaking (§7).
- No trademark or certification program (§8.4).

## 10. Follow-ups (owned)

| # | Follow-up | Shape | Gate / trigger |
| --- | --- | --- | --- |
| 1 | Profile URIs resolve at `jinn.network` (static hosting of profile + schema documents **under a DSSE-signed SHA-256 manifest**, §8.1) | `feat`, own issue | blocks any external conformance claim; rides #2293's publish artifacts |
| 2 | Golden-fixture discipline in CI: per-schema SHA-256 manifest pinning, append-only enforcement, errata records | `feat`, own issue | with #2293 stable publishing |
| 3 | Custody tripwire guard (C2, scoped to signer-accepting packages) + package-universal C3 lint + docs guard (Anvil dev-key-set allowlist) | `chore`, own issue | now — binding and pipeline pass today; pin it |
| 4 | Preflight-behavior golden fixtures (kit-first, against the stage-3 posting flow) | `test`, own issue | daemon cutover stage 3 |
| 5 | Work client package minting (from the proven requester module) | `feat`, own issue | daemon stage 3 + #2293 canaries |
| 6 | CLI convergence onto the work client (one validation stack, two skins) | `refactor`, own issue | after follow-up 5 |
| 7 | `sdk` R1: drop `./benchmarking` (sdk 0.2.0) **+ parameterize the four `npm-publish.yml` sdk-version literals** | `chore`, own issue | now |
| 8 | `sdk` R2/R3 per §6 (including the publish-gate acceptance-script migration), coordinated with the standalone Autopilot repository | rides daemon-cutover stages | per-stage |
| 9 | #2296 step 1: slate re-homed to `packages/benchmarking/records` (single source), sever sdk edge, tier names, projector guard trio | `refactor`, existing issue #2296 | now |
| 10 | #2296 step 2: physical explorer separation; Ponder as hosted archive + query plane; Railway updates | same issue | daemon stage 4 |
| 11 | Four quickstarts + custody page + conformance-claim checklist (incl. the blessed-package rule, §8.4) | `docs`, own issue | classes 1–2 now; class 3 with the work client; checklist after follow-up 1 |
| 12 | Benchmarking marketplace venue adopts the work client's posting core (finding + proposed disposition handed to the benchmarking program, §5.1) | finding hand-off | work-client mint |
| 13 | Co-amendments to the binding design §4/§9/§10/§12 + amendment header on 2026-07-24 | `docs` | same PR as this specification |

## 11. Provenance and method

Designed 2026-07-30 in worktree `marketplace-consumption-boundary-ca5071`, per the session
method of [stack design principles §12](./2026-07-30-stack-design-principles.md): four
research lanes (consumer-demand inventory from code and plans; the complete
`@jinn-network/sdk` export/importer inventory including the standalone Autopilot
repository's actual consumption; DevX comparables from primary sources — Safe, viem,
atproto, OCI; and an adversarial key-custody review run against the draft Q1 policy before
presentation), reconciled by the coordinating agent; one material question at a time (Q1
boundary; Q2a/b surfaces — re-presented at layer altitude on the operator's challenge;
Q2c/d retirement and split; Q3 DevX program), each approved in-session before the next.

The pre-presentation adversarial lane shaped the policy materially: the facade-only class-3
surface (raw legs demonstrably lose money when composed bare); the forcing function
grounded on DR-2026-07-30; the CI custody tripwire; the honest supply-chain detection
asymmetry and the Safe-scoped blast-radius bound; the CLI convergence obligation (two
posting stacks already exist); the class-1/class-3 demographic honesty; the
wrapper-phishing residual. The session ran ahead of its nominal gate (daemon stage 3 +
#2293 canaries) at the operator's initiative; every deliverable that depends on those
events carries them as its own gate.

**Review dispositions (v0.2).** The architecture review found two blockers, both resolved:
the §4.4 key-loading sentence contradicted C2 (→ restated: key loading confined to tier-4
products, CLI the only external-facing one), and the shared preflight module was homeless
with incoherent gates (→ §4.3: the module *is* the work client's core; fixtures precede,
convergence follows the mint). Its majors: benchmarking's escrow-posting exposure named
with a disposition hand-off (§5.1, follow-up 12); the read-plane "symmetry" restated as
risk asymmetry (§5.2); the external-deliverer gap closed with an explicit unsupported
statement (§4.2); the R3 map redrawn against the real export map (§6). The
standards/adversarial review found one blocker, resolved: sdk R1 as scoped would have
red-lined the client release train on `npm-publish.yml`'s four pinned `0.1.1` literals
(→ R1 owns the parameterization; R2 owns the acceptance-script migration). Its majors: the
C2 guard scoped to signer-accepting packages and demoted to tripwire (the evidence
repository uses the filesystem by design); C3 made package-universal against key-string
parameters; H2's "closed structurally" overclaim corrected to
closed-for-supported/open-for-opt-outs; the fixture errata and append-only rules added
(§8.1); the standards audit extended (SchemaVer, Confluent modes, `$id`, buf, SLSA,
Scorecard); the 2026-07-24 §10-revisit framing dropped for plain
ahead-of-condition-on-DR-authority; the held-out slate's destination named
(`benchmarking/records`, single source); the blessed-package rule made mechanical (§8.4);
profile URIs digest-bound (§8.1). Both reviews' minors (TEP citation precision, tense
corrections on parity and skew claims, the Anvil-key docs carve-out, binding §4/§9
co-amendments, the class-3 interim vacancy, per-venue scoping of the one-client principle,
the cross-branch dependency note) are applied in their sections.
