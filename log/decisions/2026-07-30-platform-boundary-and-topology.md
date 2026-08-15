---
id: DR-2026-07-30
title: The Jinn platform boundary — platform/network/products triad, tiers 1–3 as the platform, in-monorepo enforcement with a mechanical extraction gate
date: 2026-07-30
verb: Decide
status: ratified
authors: Fable (drafted), Ritsu (steer; sections approved in-session 2026-07-30); ratified on the operator's explicit commit approval — 2026-07-30
spec: docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md
amends: "docs/superpowers/specs/2026-07-28-benchmarking-application-design.md §2 (four-tier taxonomy — graduated to its owning home in the new spec; benchmarking text remains valid as origin); docs/superpowers/specs/2026-07-30-stack-design-principles.md (gains a pointer to the new owning spec for architecture); docs/2026-07-23-jinn-mono-architecture-map.md (superseded as a boundary proposal — its inventory remains useful history; its dispositions are replaced by the new spec §7)"
relates-to: DR-2026-06-30 (tokenless, OLAS-native — the network's on-chain posture this DR builds on); docs/superpowers/specs/2026-07-25-evidence-layer-architecture.md (executable-architecture discipline, generalized); docs/superpowers/specs/2026-07-23-autopilot-oss-maintainer-product-design.md §6.7 (the extraction-gate precedent); docs/superpowers/prompts/2026-07-30-platform-boundary-design-prompt.md (the session brief); issue #2252 (vendored Autopilot removal)
---

> **Historical snapshot (2026-07-30).** Package counts, paths, and dependency figures below record
> the topology used to make this decision. They are not current inventory authority. Use the
> [generated live platform topology](../../architecture/generated/platform-topology.md) for the
> catalog-derived package set, release policy, runtime graph, public surfaces, ownership, and
> transitions.

## Context

The 2026-07 stack designs established a layered architecture whose governing ideas lived in
four places with no owning home, while two framings arrived from an earlier conversation
without repository access: "Jinn is responsible for exactly four contracts" (Request Work,
Deliver Work, Deliver Evidence, Request Evidence) and "the platform repo should become a thin
kernel with production applications extracted." The session brief required testing both rather
than elaborating them.

Ground truth established by research lanes (figures at stack head `82e20064a`): the repository
is 13,795 tracked files, 58% of which are a dependency-disconnected host fork
(`apps/jinn-agent`) and an inert archive (`legacy/`); the 45 new stack packages form a fully
guarded dependency regime with zero edges to the unguarded legacy product estate; none of the
45 is published to npm (their version pins resolve only through 204 stack-internal `portal:`
links — 218 repo-wide — built from source in CI); and the comparables
record (primary sources: OLAS, atproto, Farcaster, Matrix, libp2p, Cosmos, Sigstore, in-toto)
shows kernel-layer multi-repo as the best-documented regret, app extraction after proof on a
release-mechanics trigger as the best-documented success, and formats + conformance machinery —
not repo count — as what actually holds "official but not privileged."

Tested mechanically against the eight approved specifications, the four-contract framing
placed 31 of 127 record families and interfaces cleanly, with 44 genuine remainders (lifecycle
observation, trust's three record families, discovery's kind-agnostic planes, half the backend
contract, all of tier 2).

## Decision

1. **The triad.** Jinn is three kinds of thing: the **platform** (code and record disciplines
   anyone can run anywhere), the **network** (the canonical Base deployment — contracts,
   escrow, OLAS staking — an instance, not a tier), and **products** (opinionated compositions
   built on the platform; first-party status confers maintenance, never privilege).
2. **The boundary.** The platform is **tiers 1–3 of the layering law plus the machinery that
   makes them independently verifiable** (kits, fixtures, guards). Everything in tier 4 is a
   product above the boundary. The four-tier layering law is graduated from benchmarking §2 to
   the new specification as its owning home.
3. **Verbs and properties.** The four contracts are retired as a definition and preserved as
   the functional pitch — four market verbs ({work, evidence} × {request, deliver}) —
   supplemented by four guaranteed properties: **attributability, exactness, observability,
   replaceability**. Observation is deliberately a guarantee, not a fifth verb.
4. **Topology.** The platform boundary is enforced **inside the monorepo** (the guards already
   do this); components leave only through a **mechanical extraction gate**: all platform
   dependencies resolve from the published registry; CI green from a clean clone of the tree
   alone; deploy artifacts build without sibling trees; no tier-1–3 kit references the
   component. Extraction is a consequence of readiness, never a goal.
5. **Dispositions** (full table: spec §7): stack packages and the marketplace binding stay (the
   kernel); `contracts/` stays as the network's venue; `client/` stays as a tier-4 product
   pending the daemon recomposition; `core`/`layer`/`plugin` disposition belongs to the plugin
   session; `sdk` deprecated in place; the indexer splits logically (projector re-derived onto
   the stack as `sdk` retires, explorer SPA out); the vendored `packages/autopilot` is removed
   (already extracted to `Jinn-Network/autopilot` — one precedent of the gate's shape, against
   the legacy published packages; #2252); `legacy/` leaves as a true chore (zero inbound
   edges); `apps/jinn-agent` leaves first as a **small extraction against a three-item
   checklist** (plugin mirror source-of-truth, `layer-runtime.json` re-homing, cold-stock gate
   re-homing — it has zero package-dependency edges but three operational inbound edges;
   spec §7).

## Alternatives considered and rejected

- **Four contracts as the definition.** Rejected on the mechanical test: 44 remainders of 127,
  including a full record family (observation) with its own distribution channel, and no slot
  for tier 2. Preserved as the pitch.
- **Five (or more) verbs.** Admitting Observe on record-family grounds admits Announce, Cancel,
  Recover, and Revoke on the same grounds; the framing dies of enumeration. The verb/property
  split keeps the pitch honest without it.
- **Thin-kernel multi-repo now.** Mechanically impossible today (nothing platform-dependent can
  build outside the repo before the publish path exists) and contraindicated by the record:
  libp2p spent ~2 years re-consolidating 50+ kernel repos; OLAS's audit-driven contract split
  required a synthetic umbrella repo; Sigstore achieved neutrality by adding shared formats +
  a cross-client conformance suite, not by repo arithmetic — machinery Jinn already has
  in-repo. The gate preserves every benefit extraction was meant to buy, payable per component
  when actually ready.
- **Extract the production operator now.** Reversed on sequencing: the operator cannot pass
  gate item 1 until the stack publishes and the daemon recomposition lands; moving it earlier
  manufactures version skew for zero boundary gain.

## Consequences

- One owning home for the boundary and the layering law; the derived principles index points
  to it; the 2026-07-23 architecture map is superseded as a proposal.
- The stack publish path becomes the single enabling workstream for the extraction gate, the
  operator-daemon session, and the plugin session (follow-up issue).
- Two removal chores (`apps/jinn-agent`, `legacy/`) shrink the active tree by ~58% of tracked
  files without touching a dependency edge.
- The running stack-implementation program (PR #2292) is untouched.
- PRINCIPLES.md and README rewrites (both stale) proceed through the canonical-doc process
  with spec §11's newcomer paragraph as input.

## Ratification

**Ratified 2026-07-30 on the operator's (Ritsu's) explicit approval to commit this DR and its
specification** — the single event this DR named as its ratification trigger. At this commit
the specification's ownership effects take effect: the layering law is graduated to
`docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md` §3, and the supersessions in
the `amends:` line stand. The pointer notes in the amended documents
(`2026-07-28-benchmarking-application-design.md` §2 and `docs/2026-07-23-jinn-mono-architecture-map.md`)
land in this same commit, per the specification's follow-up 7a.

Sections were approved one at a time in the 2026-07-30 design session. Canonical-doc changes
this DR implies (PRINCIPLES.md, README — both stale) go through Discussion + CODEOWNERS
separately and are **not** gated by this ratification.
