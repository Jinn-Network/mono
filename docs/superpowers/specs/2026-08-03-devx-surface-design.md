# DevX Surface — Agent-First Docs, SDK Journeys, and the Web Property

- **Version:** 0.1
- **Date:** 2026-08-03
- **Status:** Draft — designed section-by-section in session (operator: Ritsu, 2026-08-03);
  written form pending operator review
- **Shape:** `design`
- **Scope:** the market-facing layer of the ratified platform boundary: the jinn.network web
  property (landing, docs, hosted profiles root), the journey-first information architecture,
  the agent-consumable onboarding artifacts (pasteable prompts, installable plugin + skills,
  MCP server, `llms.txt`), the docs-as-code machinery that keeps all of it honest, the
  program sequencing, and the positioning-spine v2 charter
- **Out of scope:** the work client itself
  ([marketplace surfaces](./2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md)
  follow-up 5); publish-path mechanics
  ([#2293](https://github.com/Jinn-Network/mono/issues/2293)); the explorer; any
  evidence-consumer application; protocol or record semantics; operator-daemon cutover
  mechanics
- **Depends on:** the platform architecture
  ([`2026-07-30-jinn-platform-architecture.md`](./2026-07-30-jinn-platform-architecture.md),
  DR-2026-07-30 — the boundary, four verbs, four properties, §11 newcomer paragraph); the
  marketplace surfaces design
  ([`2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md`](./2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md)
  — §4 consumer classes and custody law, §8 DevX program, whose execution design this is);
  the Phase C capability boundaries
  ([`2026-08-03-phase-c-capability-boundaries.md`](./2026-08-03-phase-c-capability-boundaries.md));
  [`BRAND.md`](../../../BRAND.md), [`GROWTH.md`](../../../GROWTH.md), and the
  [positioning spine v1](../../positioning/2026-07-07-jinn-positioning-spine.md) (which §10
  charters for a v2 update)

## 1. Problem statement

The platform boundary is ratified and machine-enforced: tiers 1–3 are the platform, tier 4 is
products, the pitch is four verbs backed by four guaranteed properties, package consumption is
governed by six consumer classes under a custody law, and a DevX program (schema stability,
semver, quickstarts, conformance claims) exists on paper. What does not exist is the layer
that makes any of it reachable from outside the repository:

- there is no docs surface; the journeys exist only as specifications;
- the landing page is a one-page brochure whose copy derives from a positioning spine
  (2026-07-07) written for a superseded identity — "Jinn is a personal agent", Hermes-user
  beachhead, single CTA to Telegram;
- the hosted profiles root (`jinn.network/profiles/…`) that the conformance policy requires —
  and that stable npm publication is mechanically blocked on — does not exist;
- and the whole surface, as previously imagined, addressed a developer persona that predates
  agents: a human reading prose and typing commands.

This specification is the owning design for that layer. Where it restates a policy another
approved design owns (custody law, schema stability, quickstart scope), the owning design
wins; the surfaces, artifacts, machinery, sequencing, and spine-v2 charter defined here are
owned here.

## 2. Organizing principle: the agent is the reader

**Every Jinn journey is executed by an agent; the human's job is to decide, point, and
approve.** Someone who does not work through an agent is outside the target audience — an
assumption Jinn is uniquely entitled to, because its own participants are agents doing work.

The unit of DevX is therefore not a docs page a human follows step-by-step. It is an
**onboarding artifact an agent can ingest and act on**, in three forms (§6):

1. the **pasteable prompt** — the universal, harness-agnostic path; each door's CTA is a copy
   block ("paste this into your agent");
2. the **installable plugin** — skills plus the MCP server, for harnesses that support it;
3. **machine-legible docs** — `llms.txt` / `llms-full.txt` and the digest-bound schemas,
   which are what the pasted prompt tells the agent to read.

The prose site still matters, but its job changes: **pages persuade the human and ground the
agent.** The human-readable journey sits below each door's copy block — for trust,
verification, and the people who want to understand before they delegate.

Two consequences, named so they are never relaxed by convenience:

- **Custody does not relax because an agent is driving.** Agent-executed journeys inherit
  class-1 posture (marketplace surfaces §4.2): keys live in the `jinn` CLI's machine-local
  keystore; onboarding prompts instruct the agent to gate funding and spend actions on human
  approval; the custody page is written to be agent-facing as well as human-facing ("never
  accept a raw key into context").
- **Onboarding prompts are records.** An artifact that tells an agent to act with money
  attached is versioned, hosted at a canonical digest-bound URL, and minimal — the same
  sealed-bytes discipline the platform applies to everything else, applied to its own
  onboarding surface.

## 3. Session decisions (recorded)

Resolved in the 2026-08-03 design session, in order:

1. **Role model correction.** SolverNets are dissolved and "launcher" is not a role; the
   participant verbs resolve to requester / operator / evaluator, and package consumption is
   governed by the consumer-class table. This design targets that model, not the older one.
2. **Requesters are mostly machines.** No one browses to jinn.network to hand-post a task;
   the requester surface is an agent's tool call (hence the MCP server, §6.3). Evidence
   consumers are likewise served through applications, not through this surface directly.
3. **Two human doors; builder first.** The immediate human journeys are the **builder**
   (whose app or agent becomes the requester) and the **operator**. The builder door is
   polished end-to-end first: it works fully on testnet today, and builders generate the
   demand operators need. The operator door's "earn" promise is partly aspirational until
   mainnet (Phase 2) and its door says so.
4. **One site.** Landing, docs, and the static profiles root all live under jinn.network in
   one Next.js app replacing the static brochure (`apps/website`, whose own README's
   "revisit if it grows beyond one page" trigger this is).
5. **Spine v2 in this program.** The platform framing won; the positioning spine gets a
   versioned update chartered here (§10), and the site's copy derives from v2.
6. **Agent-first reframe** (§2) — adopted as the organizing principle over the whole surface.

## 4. The web property

One Next.js App Router application (per the repository frontend rules: shadcn/ui primitives;
this spec carries the domain model, §5.4), deployed to the existing Vercel project serving
jinn.network.

- **`/`** — the landing page, rewritten as the two-door router: platform framing from
  DR-2026-07-30 §11, "Build on Jinn" and "Run an operator" as the primary CTAs, each door a
  pasteable prompt block plus a plugin install line, prose below. Telegram is demoted to a
  community link, not the CTA.
- **`/docs/**`** — MDX content in-repo, built with **Fumadocs** (docs framework native to the
  App Router, shadcn-compatible, search/TOC out of the box) rather than hand-rolled MDX
  plumbing. Every docs page is PR-reviewed and CI-checked like code.
- **The digest-bound document root** the conformance policy requires (marketplace surfaces
  §8.1, §8.4): immutable schema/profile documents plus a DSSE-signed SHA-256 manifest.
  **Generated by the publish path, never hand-edited; the site hosts the bytes.** Shipping
  this unblocks stable npm publication and external conformance claims — which is why it
  sequences first (§8).

  *Corrected 2026-08-04 during execution: this section originally said the root was
  `/profiles/**` with its manifest under it. It is not. `jinnIdentifierServedPath()` strips
  exactly `https://jinn.network/`, so the served root is the **origin root** and the manifest
  is at **`/manifest.json`**. Documents occupy six apex namespaces — `profiles/`, `records/`,
  `schemas/`, `task-profiles/`, `profile/`, and `@jinn-network/` (fixtures, the large
  majority). Re-rooting under `/profiles/` was rejected: it would re-identify 24 sealed
  documents, including three task profiles whose URI is inside their sealed bytes, to
  normalize seven — a breaking change under the platform's own identifier law. Which URIs
  must dereference is now a declared `resolvableIdentifiers` register in the catalog,
  enforced at build time.*
- **`/llms.txt`, `/llms-full.txt`** — compiled from the docs tree at build time (§7.1).

The explorer remains a separate application; the site links to it.

## 5. Information architecture

Journey-first navigation; the four verbs are the conceptual model taught on page one.

### 5.1 Door 1 — Build on Jinn (polished first)

1. **Quickstart** — post a task with the `jinn` CLI on testnet, observe delivery, retrieve
   the result and its evidence. Class 1. Delivered as pasteable prompt + prose. Success
   criterion in §11.
2. **Request work from your app** — the work client with an injected signer, plus the one
   custody page (dedicated signer, dedicated posting Safe, capped funds). Class 3. Publishes
   when the work client mints; until then the page exists and carries a dated interim note
   ("today: CLI subprocess"), never papering over the gap.
3. **Consume evidence** — compose `record-discovery-client` + `evidence-retrieval`. Read
   side; no keys, no stake.
4. **Implement the platform** — kits, golden and adversarial fixtures, the "you never run
   Jinn code" path, and the conformance-claim checklist. Class 2 — the credibility track
   that proves replaceability.
5. **Reference** — generated from schemas and fixtures (§7.3); never hand-authored.

### 5.2 Door 2 — Run an operator

Install → fund → stake → deliver → earn. Runbook-shaped, near-zero code, honest about
testnet-vs-mainnet economics. Deepened as mainnet approaches (§8 stage 6).

### 5.3 The machine surfaces

Not a nav entry; a first-class deliverable set: the MCP server and plugin (§6), `llms.txt` /
`llms-full.txt`, and the `/profiles` root. The pasted prompts point agents at these.

### 5.4 Site domain model (per the frontend spec rule)

- **Landing router** — state: none (static content + copy blocks). Collections: none.
  Actions: *copy prompt* (`idle → copied`, transient), *outbound links* (docs, explorer,
  GitHub, community; no lifecycle). No state messages.
- **Docs tree** — state: current page, search query. Collections: pages (nav order from the
  content tree), search results. Actions: *navigate*, *search*, *copy prompt / copy code*
  (same transient lifecycle). No state messages.
- **Document root** — state: none (immutable static bytes + manifest). Collections: profile
  and schema documents, digest manifest entries. Actions: none (retrieval only). State
  messages: unknown document → 404. Purely read-only; stated per the rule that silence is
  ambiguous. Served at the origin root across six apex namespaces, not under `/profiles/`
  (§4).

No component mutates on-chain state or moves funds; the site holds no keys and no wallet
connection.

## 6. Onboarding artifacts

All artifacts live in the repository, versioned and tested (§7.2).

### 6.1 Pasteable prompts

One per door (builder, operator), each a short, versioned prompt carrying: the goal, the
canonical URLs (`llms-full.txt`, `/profiles`, the quickstart page), and the guardrails
(testnet only; keystore stays machine-local; gate funding and spending on human approval).
Hosted at stable URLs with their digests in the site's manifest. Harness-agnostic by
construction — plain text, no tool assumptions beyond "can run commands and fetch URLs."

### 6.2 The Jinn plugin (skills)

An installable plugin for harnesses that support one, bundling the door skills ("build on
Jinn", "run an operator") and the MCP server registration. Same content as the prompts,
deeper integration. This is the repo's existing plugin/skill muscle pointed outward.

### 6.3 The MCP server

A tier-4 end-user tool (same station as the `jinn` CLI in the consumer-class table; class-1
custody: machine-local CLI keystore, no key material in any package). Tools: **request work /
observe / retrieve evidence** — so a builder's agent does not just set Jinn up; it uses Jinn
as tools from day one. It wraps the same posting stack as the CLI (and converges on the work
client when the CLI does, per marketplace surfaces §4.3 — one validation stack, three skins).
The custody law's C1–C5 apply unamended.

### 6.4 Machine-legible docs

`llms.txt` / `llms-full.txt` are build outputs of the docs tree — there is no separately
maintained "agent version", so divergence is structurally impossible.

## 7. Docs-as-code: the anti-rot machinery

The repository's own history motivates this section (220 references to a deleted path, found
by the 2026-07-23 audit). Nothing in this surface is prose-only; everything is generated,
tested, or guarded.

### 7.1 One source, two compilations

Docs are MDX in-repo; the site build emits the HTML pages and the `llms*.txt` corpus from the
same tree.

### 7.2 Artifacts are tested, two tiers

- **Deterministic tier (every CI run):** the commands the prompts instruct an agent to run
  are executed literally against the Anvil-fork e2e harness (the existing `yarn e2e`
  muscle). CLI drift breaks the quickstart red, not silently.
- **Agent tier (scheduled, budgeted):** an actual agent (cheap model) receives the pasted
  prompt cold and must reach the quickstart success criterion — task posted, delivered,
  evidence retrieved. The quickstart is an eval with a pass/fail, run nightly or
  pre-release, not per-push, because it costs inference.

### 7.3 Reference is generated

Zod schemas → JSON Schema → reference pages, with golden fixtures embedded as the examples.
A hand-written reference page for a schema is a rejected PR.

### 7.4 Guards

- the no-raw-keys docs guard (marketplace surfaces §8.3) extends to prompts and skills;
- an internal-link and path checker fails the site build on stale references;
- `/profiles` is append-only under its DSSE-signed digest manifest; the site serves those
  bytes and never edits them;
- landing-page claims check against spine v2 (§10) the way the current page checks against
  v1.

## 8. Sequencing

Ordered by leverage-per-effort; each stage independently shippable.

1. **`/profiles` hosting + digest manifest.** Smallest deliverable; unblocks stable npm
   publication and external conformance claims.
2. **Site v1.** Next.js app replaces the brochure: two-door landing, builder quickstart page
   with pasteable prompt v1, `llms.txt`, operator door as an honest stub. Spine v2 copy
   lands with it.
3. **Builder plugin + MCP server.** Skills plus request/observe/retrieve tools.
4. **Generated reference + evidence-read journey + implementer (class 2) track.**
5. **Work-client journey** — gated on the work client minting (owned elsewhere); dated
   interim note until then.
6. **Operator door polish** — runbook + operator prompt, deepened as mainnet economics
   approach.

## 9. What this program does not build

- No marketplace front end and no evidence-consumer application — both are products other
  sessions may design; this surface links to them when they exist.
- No headless "deliver client": external programmatic Deliver Work remains deliberately
  class-less (marketplace surfaces §4.2); the operator product is that verb's surface, and
  the operator door routes to it.
- No changes to custody law, schema-stability policy, consumer classes, or any frozen
  interface.

## 10. Spine v2 charter

A versioned update to the positioning spine, landing before or with site v1 (its copy source):

- **Identity:** Jinn is the open platform for work and the evidence work creates
  (DR-2026-07-30 §11 is the source paragraph). The personal-agent story is re-homed as a
  flagship product built on Jinn — kept, not killed, but no longer the identity of "Jinn"
  unqualified.
- **Naming:** "Jinn — the platform. Jinn Network — the canonical deployment on Base.
  Products carry product names." Supersedes v1's "Jinn — the agent."
- **Audience:** agent-equipped builders (beachhead) and operators; the agent-first
  assumption stated explicitly — someone not working through an agent is not the target.
- **Carried over unchanged:** the proof posture ("prove it" honesty, "what this does not yet
  prove"), earn-not-paid verb discipline, plain words on money and consent, and the
  messaging guardrails.

The spine remains standing infrastructure in `docs/positioning/`; the update follows the
spine's own versioned-update rule. `BRAND.md` and `GROWTH.md` are canonical and unchanged by
this program; if spine v2 surfaces a conflict with either, that conflict goes through the
canonical-doc process, not this spec.

## 11. Success criteria

1. A stranger's agent, given only the pasted builder prompt, completes post → deliver →
   retrieve on testnet in ≤ 15 minutes with no terminal touch by the human, spending nothing
   beyond faucet funds.
2. Schemas and kits resolve at jinn.network without cloning the repository — the stable-
   publication blocker is cleared.
3. Every claim on the landing page traces to spine v2, and spine v2 to the ratified
   boundary.

## 12. Provenance

Produced by the 2026-08-03 DevX-surface design session (operator: Ritsu). The session
corrected a stale role model (SolverNets dissolved; launcher retired), settled deliverable
shape, door ordering, site topology, and positioning disposition by explicit operator
choices, and adopted the agent-first organizing principle from the operator's direction that
"everyone using this has an agent — if they aren't, they're probably not our target."
