# Design prompt — marketplace surfaces: the public work client, the consumption boundary, and the read plane

**Date:** 2026-07-30

**Shape:** `design` — output is one specification, plus an explicit amendment (or explicit
reaffirmation) of the external-consumer boundary design. No code, no package publishes, no
migration.

---

## 0. Read this first, before the objective

This session inherits a deliberate deferral. The operator-daemon composition design
([`../specs/2026-07-30-operator-daemon-composition-design.md`](../specs/2026-07-30-operator-daemon-composition-design.md)
§8) built the operator's requester side as an **extractable module** — the work client in
everything but packaging — and refused to mint the public package, because doing so would
have quietly re-opened a settled boundary: the external-consumer design
([`../specs/2026-07-24-marketplace-external-consumer-boundary-design.md`](../specs/2026-07-24-marketplace-external-consumer-boundary-design.md))
rules that **no key material or tx client lives in the SDK** — external consumers get
schemas plus the `jinn` CLI, and the CLI holds the keys.

Do not treat "publish the work client" as pre-decided. The boundary question is this
session's core, and "keep the 2026-07-24 posture unchanged" is a fully acceptable outcome —
if it survives the threat-model work of §4. The most common failure mode for this session
is shipping an ergonomic SDK that silently becomes a key-custody footgun; the second most
common is hedging so hard that integrators still assemble twelve plugs by hand.

## 1. Objective

Answer three questions, in this order. Do not start a question until the previous one's
answer is approved.

**Q1 — The consumption boundary.** Who consumes the marketplace platform surfaces, and
through what? Enumerate the consumer classes — first-party products consuming from npm
(the Autopilot adoption pass), applications inside the monorepo (benchmarking marketplace
mode), external integrators, hosted services — and for each: schemas-and-CLI, tx-capable
libraries, or read-only clients. This either amends the 2026-07-24 design (explicit,
dated, with the threat model that justifies it) or reaffirms it (explicit, dated, with the
DevX cost named).

**Q2 — The surfaces.** Given Q1: the shape of the public work client (one package or
verb-paired work/evidence clients; what it composes; what it refuses to hold); the evidence
read plane (do `discovery/client` + `evidence/retrieval` + the transports suffice, or does
Discover & Retrieve deserve a facade); the `packages/sdk` retirement map — which of its
surfaces retire onto which stack packages, on what schedule, given that the standalone
Autopilot consumes `@jinn-network/sdk` today; and the projector/explorer split
([#2296](https://github.com/Jinn-Network/mono/issues/2296)) — logical split is decided,
this session owns the physical shape and timing.

**Q3 — The DevX program.** Docs, quickstarts, schema-stability and semver policy for the
published packages (golden fixtures as the compatibility contract), and the external
conformance-claim checklist — including the program follow-up that the reserved profile
URIs under `https://jinn.network/` must resolve before any external conformance claim.

Q1 without Q2 is a policy nobody can use. Q2 without Q1 re-opens the boundary by accident.
Q3 without either is documentation for a surface that doesn't exist.

## 2. What is settled — treat as law

- **The platform architecture**
  ([`../specs/2026-07-30-jinn-platform-architecture.md`](../specs/2026-07-30-jinn-platform-architecture.md),
  DR-2026-07-30): the platform/network/products triad, the four verbs + four properties, the
  tier law, and the per-tree dispositions. The work client is Request Work's facade; it
  never names a product.
- **The operator-daemon composition design** and its hand-offs (§8, §12): the requester
  module exists as the proven reference composition; this session starts from it, not from
  a blank page. Its §7 standards audit rulings stand.
- **The external-consumer boundary design (2026-07-24) is current law** until and unless
  this session amends it — explicitly, with a dated amendment note, never by implication.
- **The marketplace binding's frozen decisions** (binding design §11), including: no
  subcomponent imports; verification profiles fail closed; the CLI boundary posture as
  restated in its §14.
- **The publish path** ([#2293](https://github.com/Jinn-Network/mono/issues/2293)) is the
  enabling precondition for every npm-consumption answer. This session designs against it;
  it does not implement it.
- **The collected principles**
  ([`../specs/2026-07-30-stack-design-principles.md`](../specs/2026-07-30-stack-design-principles.md)):
  §3 (standards audit — required for Q3's versioning/DevX choices), §8 (built for
  implementers outside this repo), §12 (the session method).

## 3. What is explicitly unsettled — bring a conclusion, not a summary

- Whether tx capability in an npm package is acceptable per consumer class — and whether
  the line is actually **key custody** rather than package shape: `venue-base` will already
  be a published, tx-capable-by-composition package whose ports take injected signers.
  If signer-injection-with-host-side-custody is the real boundary, say so and re-derive the
  2026-07-24 rule from it; if it is not, say what is.
- Whether the CLI remains the sole key-holding surface for external integrators, and what
  that costs them in DevX terms.
- One work client or verb-paired clients (work / evidence) — and what the evidence side
  actually needs beyond the existing read packages.
- The `sdk` retirement map and its coordination with the standalone Autopilot repo (which
  imports `@jinn-network/sdk` today — retirement cannot strand it).
- The physical projector/explorer split: what moves, when, and against which gate
  (#2296 couples it to the `sdk` retirement).
- Hosting: who runs the canonical hosted read surfaces (discovery archive, explorer), and
  how that squares with "hosting a source costs a static file host."
- Schema-stability policy: what semver means for sealed-record schemas whose bytes are
  frozen by construction; whether golden fixtures are the versioning contract.

## 4. The reconciliation that matters most

Three postures currently coexist and must end as **one policy keyed by consumer class and
key custody**:

1. the 2026-07-24 design: schemas + CLI only, no tx client in the SDK;
2. the stack stance: "the packages are the SDK";
3. the daemon spec's §8: extractable module now, public package later.

The threat-model work is mandatory, not decorative: state precisely what hazard the
2026-07-24 rule was defending against (key material in dependency trees? tx construction in
untrusted contexts? supply-chain blast radius of a signing-capable package?), check each
hazard against signer-injection designs, and only then decide. An adversarial review lane
must attack whatever policy Q1 produces.

## 5. Session gates and triggers

- **Gate to open this session:** daemon cutover **stage 3** (posting flow live — the
  requester module proven end-to-end on testnet) per the daemon spec §10, **and** #2293
  delivering canary packages. Whichever consumer forces the question first — the Autopilot
  adoption pass needing the client, or stage 3 landing — is the trigger.
- **This session must not gate:** the daemon cutover (it proceeds independently), the
  plugin session, or benchmarking work.

## 6. Method

Per principles §12. Suggested research lanes:

1. **Consumer-demand inventory** — what the Autopilot adoption pass, benchmarking
   marketplace mode, and any known external integrator actually need, verb by verb, from
   real code and plans, not assumption.
2. **`sdk` surface inventory** — every export of `@jinn-network/sdk`, every importer
   (including the standalone Autopilot repo), mapped to its stack successor or to "dies
   with SolverNets."
3. **DevX comparables** — how Safe, viem, atproto, and OCI ship SDK + docs + versioning +
   conformance claims; what they publish as the compatibility contract.
4. **Adversarial key-custody review** — attacks the Q1 policy before it is presented.

One material question at a time; section-by-section approval; one specification; two fresh
reviews (architecture + standards/adversarial) before presenting; commit only on explicit
approval.

## 7. Scope discipline — what this session does not own

- The `core`/`layer`/`plugin` disposition — plugin session.
- The operator application and daemon cutover — the daemon spec owns them.
- Protocol or record semantics — owned by the stack designs; findings get dispositions,
  never patches.
- The publish path's mechanics (#2293) — program work, not design work.
- Benchmarking internals — only its marketplace-mode consumption of the surfaces designed
  here.

## 8. Success criteria

1. One specification under `docs/superpowers/specs/`, sections approved one at a time.
2. The 2026-07-24 boundary either amended or reaffirmed — explicitly, dated, with the
   threat model on the record either way.
3. A consumer-class table any future package author can test a proposal against.
4. The `sdk` retirement map with owners and gates, coordinated with the standalone
   Autopilot repo.
5. A disposition for #2296 concrete enough to schedule.
6. The DevX program as owned follow-ups, not aspirations.
