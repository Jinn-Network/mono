# Jinn Harness Network — Hermes fork, contribution economy, contributor-steered corpus

- **Version:** 0.5 (draft — open questions resolved in review, 2026-07-02; spike #1316 findings +
  envelope schema-review consequences folded into §5/§6.1/§12, 2026-07-02; **v0.4, 2026-07-09,
  issue #1487: added rung-1 local single-player distillation (§1, §5.1) + the symmetric Distiller
  interface (§5.2 — local/network backends, rung 3 = network); reconciled the moat framing to name
  the bonded economy as the durable asset (§2, §10). A Decision Record may be warranted — see §13.**
  **v0.5, 2026-07-14, issue #1657: D3 amended to default-decline/review-first (§1, §3, §5, §6.1);
  Stage 1 gate-lane note added (§14).**
  **v0.6, 2026-07-15, mono#1714: consent collapsed to ONE `shareConsent` (default decline)
  gating only mint-leaves-machine; local retention/mining/distillation unconditional; trace
  publication is no longer a distinct sharing prompt (D3, §14 amendment).**)
- **Date:** 2026-07-14
- **Author:** Oak (design session)
- **Shape:** `design` — output is this spec; implementation lands as per-phase plans and Issues

## 1. Summary

Jinn ships a **harness, not a marketplace**. We fork the Hermes agent into a Jinn-specific harness
(and later a Jinn plugin for other harnesses). Using the harness is the product; the network rides
along:

1. **Consume** — the harness reads the public corpus (verified prior solutions, skills, artifacts)
   to make the user's agent better.
2. **Contribute** — with consent (default-decline, review-first, per-task veto) the harness
   publishes **scrubbed task traces** to the corpus. Contribution is the demand signal: it tells us
   where usage concentrates.
3. **Earn** — contributions are counted by an on-chain activity checker; contributors running the
   sidecar node earn OLAS staking emissions for verified, anchored contributions.
4. **Steer** — contributors lock earned OLAS into veOLAS and steer emissions toward **their own
   task distributions**, concentrating corpus-deepening where real users work. Individual
   self-steering is desirable by design: it is users steering a commons toward their own need, not
   founders steering it toward themselves.

**Rung 1 — local distillation (the single-player entry).** Before any network verb, the harness
earns its place as a *solo* tool: a user distils their own scrubbed local captures with a frontier
model into installable skills, then runs later tasks cheaper on an open-weight model — the
frontier-distil → cheap-run **arbitrage**. Private by default (nothing published), nothing on-chain,
useful on day one. The four network verbs above are the same distillation pointed outward (§5.1–§5.2).

The corpus stays a **public good** (no enclosure, no take-rate). OLAS emissions are **bootstrap
capital**, not a self-sustenance claim. The single binding bet is **capability**: a corpus-connected
harness must measurably beat a stock harness at equal quality and lower cost on the distributions
usage selects.

## 2. Context

Phase A shipped the operational loop (corpus library, plug-in surface, campaign infra, SolverNet
launch). Extended design analysis (June–July 2026) settled the following, recorded here as
decisions rather than re-argued:

- **Marketplace-first consumption is dead.** Buyers will not route tasks through a bonded
  marketplace to get work they can self-verify; every design that led with "post a task, pay a
  bonded solver" failed on demand-side structure. Distribution must be product-first.
- **Verification is a mechanism, not a product.** It is the quality gate that keeps the corpus
  clean (only verified solutions enter), plus a secondary attestation surface — never the flagship.
- **No enclosure.** The corpus is public by default (SPEC.md, PRINCIPLES.md). Corpus value is
  therefore *live consumption* (freshness + integration in the tool you're holding), never an
  archival asset to sell — a public archive is absorbed by frontier models (the Stack Overflow
  precedent).
- **The moat is the bonded economy — not the archive, not self-sustenance.** Two false moats stay
  rejected: the *archival-data* moat (a public corpus is absorbed by frontier models — the Stack
  Overflow precedent above) and the *self-sustenance* claim (emissions are finite bootstrap capital,
  named as such). What *is* durable is the **live bonded economy**: creators bond that a task
  matters, solvers stake an attempt, evaluators bond a verdict. Costly, money-backed human choice
  produces priority- and quality-labelled training data that raw scraped data lacks; and a live
  market of *independent parties'* financial choices cannot be reproduced by a single operator
  simulating its own demand — this is the answer to the "single-operator-simulable" objection. The
  moat holds **only insofar as a bad bond loses money**: the verification-before-eligibility /
  eviction gate (§6.1) is what makes a bond a *signal* rather than noise — without it the economy is
  farmable and there is no moat. Credible neutrality (the operator cannot be the house) and
  legitimacy sit alongside it. A native token remains parked optionality; nothing in this spec
  depends on it. (This narrows the earlier blanket "no moat claims," which contradicted naming
  bonded participation a durable asset — see §13.)
- **Empirical niching.** We do not pick a niche a priori (coding was the leading guess). We capture
  broadly and let contribution data select where to deepen — "capture broadly, deepen narrowly."
  Density in a distribution is what makes a corpus valuable (adjacency/transfer literature);
  breadth without density is a thin smear.

## 3. Design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Harness-first distribution: fork Hermes; the Jinn layer is the product surface | Adoption is product adoption; the network is a side effect of use |
| D2 | The Jinn layer is a **package**; the fork is Hermes + package pre-wired | One component, two containers: same layer becomes the plugin for other harnesses; upstream Hermes merges stay cheap |
| D3 | Contribution is **default-decline, review-first — ONE `shareConsent` asked at onboarding (default off), one-time first-share preview, per-task veto retained**. The single sharing lane is the user-originated public task mint (a reproducible OSS problem based on the user's work); local traces are input-only and never leave the machine. Local retention, mining, and distillation are unconditional. | Trust needs legibility before it needs signal — the user consents once, sees the first shared task before it's silent, and can inspect exactly what left the machine, on chain (amended v0.5, 2026-07-14 — §14; collapsed to one consent v0.6, 2026-07-15, mono#1714) |
| D4 | Pure readers allowed (consume without contributing) | Adoption over symmetry, early |
| D5 | Earn-for-contribution via staked sidecar service + contribution-counting activity checker | Reuses the entire earning bootstrap; the checker only counts **verified, anchored** contributions (quality gate wired into emissions eligibility — anti-farming) |
| D6 | Contributor self-steering: earned OLAS → veOLAS → gauge weight toward per-distribution staking programs | Makes "deepen narrowly" endogenous; manufactures the dispersed electorate that retires founder-decisive steering |
| D7 | Gas UX: user-side actions are **EIP-712 signatures**; one batched, **permissionless, proof-carrying** executor lands L1 state per epoch — built in v1b, only once manual-steering friction is demonstrated (Gall's Law) | veOLAS voting is L1-only; per-user mainnet gas kills casual participation — but manual steering works today, so automation is built on evidence, not speculation |
| D8 | Seed the corpus from open skill libraries (first: Vercel's skills.sh), licence-checked, provenance-tagged `imported` | Day-one usefulness without polluting the demand signal |
| D9 | Steerable distributions start as a **bounded, disclosed allowlist**, loosening as the electorate disperses | Whale-steering defence with the Valory seeding precedent; time-limited and stated openly |
| D10 | **Rung 1 — local single-player distillation** ships first: own scrubbed captures → frontier-distilled skills → cheaper open-weight runs, private by default, no publish. Surface is the **harness CLI** (`jinn-layer`), not the operator dashboard SPA (§4.2) | Day-one solo usefulness with zero network dependency; the frontier-distil → cheap-run arbitrage is value the user keeps whether or not they contribute outward |
| D11 | **One Distiller interface, two backends** (§5.2): `LocalDistiller` runs the merged distillation engine in-process over own captures (private sink, no anchor); `NetworkDistiller` (rung 3) rebinds source + sink to the bonded network's verified evidence and the public anchored corpus | Local and network distillation stay symmetric; rung 3 is a drop-in behind a proven local one (Gall's Law), deferred until rung 1 earns adoption |
| D12 | **Rung 2 (selling distilled skills) rejected** | A skill is a non-excludable information good — public-domain on first sale; paywalling leaks immediately and breaks corpus-as-public-good (§2 No enclosure) |

## 4. Architecture

### 4.1 Component map — existing vs new

**Existing (reused as-is or lightly extended):**

| Component | Location | Role here |
|---|---|---|
| Capture + scrub + anchor pipeline | `client/src/captures/publish.ts`, `client/src/trajectory/scrub/` (key-policy → openredaction → secretlint → ML PII, fail-closed at publish), ERC-8004 anchor via `anchorEnvelope()` | The contribution path, end-to-end. Already wired at daemon startup (`captures/live-publisher.ts`) |
| Hermes harness impl | `client/src/harnesses/impls/hermes-agent/` (`HermesHarness`, `HermesHarnessAdapter`) | Proof the Hermes integration surface exists; the fork inverts the packaging (§4.2) |
| Corpus runtime | `client/src/corpus/` (`query()`, `fetchManifest()`, `acquire()`); MCP tools `search_records`, `inspect_record`, `acquire_artifact` (x402), `publish_artifact` | The consume path |
| ERC-8004 registries | `client/src/erc8004/` (Identity, Reputation, Validation) | Anchoring + agent identity + evaluator feedback |
| Earning bootstrap + daemon loops | `client/src/earning/`, `client/src/daemon/` (incl. `balance-topup-loop.ts`, `jinn-claim-loop.ts` L2→L1 proof pattern) | Node spin-up; the L2→L1 loop is the in-house precedent for automated mainnet execution |
| Activity checker pattern | `contracts/src/staking/RestorationActivityChecker.sol` (counter-based, `getMultisigNonces()` / `isRatioPass()`) | Template for the contribution checker |
| SolverNet generators | `client/src/solvernets/launched-record-dispatcher.ts` + generator factories | How deepening is executed once a distribution is chosen |
| Eval infra | `client/src/harnesses/impls/swe-rebench-v2-evaluator/` | The capability measurement harness (coding distributions); pattern for others |

**New build:**

| Component | Contents |
|---|---|
| `@jinn-network/harness-layer` package | The three functions in one embeddable package: capture (wraps the existing pipeline), consume (wraps corpus runtime + MCP), node (spawns/attaches the existing daemon). Plus the contribution ledger UI surface (what left this machine, with anchor tx links) |
| Jinn-Hermes fork | Upstream Hermes + harness-layer pre-wired + first-run consent flow (one sharing question: "contribute tasks from your work? run a node?") . Kept as a thin patch over upstream |
| `ContributionActivityChecker` (contract) | Counts verified, anchored capture-envelope publishes per Safe (reads ERC-8004 anchoring events / an on-chain counter); same interface as `RestorationActivityChecker` so it drops into a staking program |
| Seed importer | skills.sh (and other open libraries) → per-skill licence check → scrub → anchor with `provenance: imported` metadata → corpus |
| Distribution signal surface | Aggregation over contributions (discovery API already exposes `getTaskPostCounts()`-style aggregates) → "where is usage concentrating" view driving deepening decisions |
| Steering stack (v1) | Per-distribution staking programs (deploy-staking workflow); EIP-712 steering ballots signed by the harness key; batched L1 executor; pooled locker with **provable instruction-following** (merkle of signed ballots published and verifiable against the cast vote) |

### 4.2 The packaging inversion

Today the daemon is the container and harnesses run inside it (operator-first). This product
inverts it: **the harness is the container** — the user's daily-driver agent — and the Jinn layer
rides along. The daemon becomes an optional sidecar the layer can spawn ("become a node") or attach
to. Nothing in the daemon needs to change for v0; the layer shells out to what exists.

## 5. The deal (contribution terms)

- **What is contributed:** scrubbed task/outcome traces from harness tasks — never the user's wider
  machine or dev activity.
- **Trace schema (resolved): two layers.**
  - **Layer 1 — evidence (what contributors emit):** the scrubbed trace envelope — task descriptor +
    freeform distribution tags (inferred clustering server-side; no fixed taxonomy yet), environment
    fingerprint (harness, model, tools — the config-diversity metadata), compressed steps, **outcome
    with a verifiability tier** (user-accepted < tests-passed < evaluator-verified), cost. Anchored
    as today. v0 freezes only this envelope.
  - **Layer 2 — consumable (what harnesses retrieve):** distilled skills/workflows in a
    **SKILL.md-compatible format**, with provenance links back to evidence traces. Seeds (§7)
    transit the layer-1 publish path carrying `provenance: imported` rather than landing directly
    at layer 2, and are excluded both from the demand signal (§7) and from emissions eligibility
    by the activity checker (2026-07-02 envelope schema review, PR #1324); seeded and earned
    content still share one consume path at layer 2.
  - **Verification is the promotion gate** from layer 1 → layer 2, and the outcome tier is what the
    `ContributionActivityChecker` counts against. **Distillation is itself a network task** (a
    SolverType generators run where steering points): deepening a distribution means distilling its
    evidence into consumables.
- **Scrub is mandatory and fail-closed** at publish altitude (existing pipeline: key-policy →
  openredaction → secretlint → ML PII). No scrub, no publish.
- **Default-decline, review-first, per-task veto.** First-run consent (default off), a one-time
  first-publish preview, a persistent toggle, a per-task "don't publish this" control, and a
  contribution ledger showing exactly what left, with anchor links. Legibility is the selling point.
- **Pure readers allowed.** Consumption is not gated on contribution (D4). Revisit if free-riding
  materially outpaces contribution once volumes exist.

### 5.1 Distillation rungs — local first (rung 1), network next (rung 3)

Distillation runs on a **rung ladder** — distinct from the Tier-0…3 *onboarding* ladder in §6.1
(that ladder is about when a user first touches gas; this one is about where the evidence comes from
and where the skills go):

- **Rung 1 — local single-player distillation (ships first).** The user points the distillation
  engine at *their own* scrubbed captures: a frontier model distils them into SKILL.md-compatible
  skills, installed locally, so later tasks run cheaper on an open-weight model. **Private by
  default — nothing is published, nothing is anchored, no corpus write.** The surface is the
  **harness CLI** (`@jinn-network/harness-layer` / the Jinn-Hermes fork), *not* the operator
  dashboard SPA — this follows the §4.2 packaging inversion (the harness is the container; the
  daemon is an optional sidecar). Rung 1 is a self-contained loop inside **Consume +
  Contribute-to-self**: no node, no earning, no chain. It is the wedge that makes the harness worth
  installing on day one, and the arbitrage (frontier-distil once, cheap-run many times) is value the
  user keeps whether or not they ever contribute outward.
- **Rung 2 — selling distilled skills: REJECTED.** A skill is a **non-excludable information good** —
  public-domain on first sale, trivially re-shared — so a skills market leaks immediately and prices
  to zero. Paywalling skills also violates the corpus-as-public-good principle (SPEC.md,
  PRINCIPLES.md; §2 No enclosure). Recorded as rejected so it is not re-proposed.
- **Rung 3 — bonded network distillation (same interface, deferred).** Distillation pointed
  *outward*: the operator's captures enter the bonded network (the `session-derived.v1` task path),
  independent solvers attempt and evaluators verify, and the same distillation engine deepens the
  **public, anchored** corpus where steering points (§5 "distillation is itself a network task",
  §6.2). Rung 3 is the *same Distiller interface* (§5.2) with the network backend; it is
  stubbed/deferred until rung 1 earns adoption — grow the network path from a local one that already
  works (Gall's Law).

### 5.2 The Distiller interface (one seam, two backends)

Local and network distillation are **symmetric**: one interface — *eligible evidence → verified,
installable skills, via an injected model port and a publish sink* — with two backends behind it.
The merged distillation engine already exposes this seam: its evidence source, its skill-publish
sink, and its anchor deps are all injected ports, and it already runs a sink-only local mode that
writes SKILL.md packages with no chain write.

- **`LocalDistiller` (rung 1).** Binds the evidence source to the operator's **own captures** and
  the publish sink to a **local, private** SKILL.md install — no anchor, no corpus record; runs
  in-process. The sink half already exists; rung 1 adds the own-captures source behind the same
  interface.
- **`NetworkDistiller` (rung 3).** Rebinds the evidence source to the **bonded network's verified
  evidence** (fed by the `session-derived.v1` task path) and the publish sink to the **public,
  anchored** corpus. A drop-in behind the identical interface, deferred for now.

Keeping both behind one interface is the point: rung 3 is not a second system, it is rung 1 with the
source and sink rebound to the network. What makes the network backend *worth* its extra machinery is
exactly the moat argument (§2) — bonded evidence is priority- and quality-labelled by costly,
independent human choice in a way an operator's own captures are not.

## 6. Earning and steering

### 6.1 Earn (v0.5, testnet first) — the onboarding ladder (resolved)

Design goal: **no user touches gas until they are earning, and then only cents on Base.**

- **Tier 0 — Reader.** Install, consume. Nothing on-chain; the layer silently generates a local
  keypair (free — it becomes the user's identity later).
- **Tier 1 — Contributor (default-decline, review-first; free).** Traces scrubbed → signed locally
  with the harness key → uploaded → **batch-anchored by a Jinn relayer** (many contributors'
  envelopes merkle-batched into one anchor tx; treasury pays cents per batch). **Credits accrue in
  the indexer**, attributed by envelope signature. User gas: zero, forever. Credits are an IOU with
  no protocol guarantee — the UI says so plainly ("credits become an earning position when you run
  a node").
- **Tier 2 — Node (one command, pool-bonded).** The existing 11-step bootstrap runs, with the bond
  supplied from the **stOLAS pool** (no gatekeeper approval required — we have deployed with stOLAS
  before). **Underwriting = Tier-1 credit history**: the pool bonds contributors with N verified
  envelopes, not strangers. Emissions split pool/operator as the price of the bond. User gas: Base
  dust only (testnet faucet; mainnet sponsored initially via the balance-topup pattern). Claiming is
  the existing reward-claim loop. Posture: start conservative (high-ish N, generous pool cut),
  loosen with eviction/liveness history — these two knobs are the entire Tier-2 farming defence.
  (Not "slash data": no native slash data exists — slashing is only callable by a service's own
  multisig, and the stOLAS MultisigGuard reverts it. The loosening signal is eviction/liveness
  history, or a Jinn-defined slash once the Tier-3(a) wrapper exists. See
  `docs/spikes/2026-07-02-stolas-slashing-passthrough.md`, PR #1321, issue #1316.)
- **Tier 3 — Optional funds, two independent upgrades.** (a) **Co-bond/self-bond:** a small own
  stake that slashes first → pool prices you cheaper → better emissions split; full self-bond exits
  the pool and keeps 100%. Skin-in-the-game buys margin, never required. "Slashes first" has no
  native substrate: it needs a wrapper, and the wrapper is mechanism design, not integration — it
  must introduce the slashing authority, conditions, and evidence itself (nothing in OLAS triggers
  a slash for bad work) and redesign the MultisigGuard invariant, which hard-requires the operator
  balance to equal the full security deposit (§12;
  `docs/spikes/2026-07-02-stolas-slashing-passthrough.md`, PR #1321, issue #1316).
  (b) **Steering** (§6.2).
- **Verification before eligibility (unchanged, load-bearing):** only envelopes passing the corpus
  quality gate count. The checker counting *verified* contributions only is the anti-farming line.
- Naive treasury-fronted bonds are **rejected**: fronting transfers slash exposure to treasury and
  gives farmers a free option. The stOLAS pool carries that risk instead, and credit history is
  the risk model — noting the pool's exposure is narrower than a slash: pool principal is
  currently unslashable by construction (the MultisigGuard reverts the only slash path), so what
  the pool actually risks on a bad operator is forgone yield on an evicted slot
  (`docs/spikes/2026-07-02-stolas-slashing-passthrough.md`, PR #1321, issue #1316).

### 6.2 Steer — staged manual-first (resolved; Gall's Law)

The simple system that already works is **manual veOLAS steering**: holders lock and vote on
VoteWeighting today, no new infrastructure. Steering ships in two stages:

**v1a — manual (the v1 critical path):**
- **Mapping:** one staking program per task distribution (SolverNet), deployed via the existing
  deploy-staking workflow and nominated in VoteWeighting. "Steer toward my tasks" = vote weight to
  that distribution's program; emissions there fund generators that deepen that region of the
  corpus.
- The harness documents the manual path ("steer emissions toward your distribution") and deep-links
  the existing OLAS govern flow. Nothing else is built.
- Honest cost, priced in: manual-first skews early steering to large holders (including us) —
  bounded by the allowlist (D9); dispersal arrives with v1b.
- **Graduation trigger (measured, not vibes):** earned-OLAS holders who express steering intent in
  the harness but do not execute the manual flow. When that cohort is material, build v1b.

**v1b — automation (built on demonstrated friction):**
- **Gas UX (D7):** steering preference = EIP-712 ballot signed by the harness key — free, no ETH,
  no bridging. Ballots and locker deposits aggregate **on Base**; the epoch result (merkle root of
  ballots + net steering weights) commits on Base and is **relayed to L1 via the existing L2→L1
  proof pattern** (the jinn-claim loop's machinery).
- **The L1 function is proof-carrying and permissionless**: anyone can submit the proven epoch
  result and pay the gas. This — not monitoring — is the answer to the relayer-starvation lesson:
  no party has *exclusive* ability to execute.
- **Pooled locker:** casual contributors' earned OLAS locked via a shared locker (Convex-shape)
  voting per instructions; ballots and execution both published and provably matched, so the pool
  is demonstrably a pipe, not a discretion point. Serious operators graduate to own locks,
  auto-managed (threshold-triggered top-ups when gas < x% of value).
- **Liveness insurance on the permissionless function:** primary = our own executor (monitored,
  fallback signer); backstop = Chainlink Automation (adds one LINK balance to monitor); **OLAS-native
  mech job as a dogfood experiment** — gated on verifying the Mech Marketplace exists on Ethereum
  mainnet (ours is Base) — which may replace the Chainlink backstop if it proves out. Cadence is one
  L1 tx per epoch, so this is liveness engineering, not gas engineering.
- **Allowlist first (D9):** steerable distributions start as a bounded, disclosed set. Stated
  openly: self-steering by users is by design; the allowlist stops bought-weight pointing emissions
  at farmable garbage while the electorate is small.

## 7. Seeding (day-one corpus)

- **Source:** Vercel's skills.sh registry first; other open libraries after. Licences vary per
  skill (the registry aggregates GitHub repos): check per skill, keep attribution in metadata,
  skip incompatible licences.
- **Provenance:** every seeded entry tagged `imported` — seeds provide day-one usefulness but are
  excluded from the demand signal; deepening decisions read usage only.
- **Anchoring:** same path as contributions (scrub → IPFS → ERC-8004), no new chain surface. Seeds
  run the seed-profile scrub (deterministic secret patterns only — key policy, plain-patterns,
  secretlint preset rules; no probabilistic openredaction/entropy stages) because they are public,
  licence-checked content, not operator trace data (#1409).
- **Stage 1 note (2026-07-16, mono rescope):** Stage 1 acceptance requires **evidence seeds** —
  canonical prior-work episodes published through the same scrub → publish path — because the
  plugin's Stage 1 retrieval serves evidence records only. skills.sh skill imports remain in the
  corpus for later stages (and distillation measurement) but are excluded from Stage 1
  auto-pickup. Evidence-seed imports must be idempotent and set `supersedes` on re-import. See
  `docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md` §4.

## 8. Phasing

### v0 — the harness, consuming and capturing (testnet)
1. `@jinn-network/harness-layer` package: consume + capture wrapping existing client code.
2. Jinn-Hermes fork: upstream + layer + first-run consent + contribution ledger.
3. Seed import: skills.sh, licence-checked, provenance-tagged.
4. Distribution signal surface (crude counts are enough).
5. **Rung-1 local distillation** (§5.1): `LocalDistiller` over the user's own captures → local
   SKILL.md install; private, no anchor. The single-player usefulness wedge.

**Gate:** N external users running the fork daily; contributions flowing and visible on-chain;
signal shows where usage concentrates. (N small — single digits is fine; this is a usefulness
test, not a growth test.)

### v0.5 — earn (testnet)
5. `ContributionActivityChecker` + staking program wiring; sidecar node one-command spin-up from
   the harness; bond-friction decision (Q2).

**Gate:** a contributor with zero prior crypto setup earns emissions for verified contributions,
end to end, without touching a wallet manually.

### v1a — steer, manual (mainnet)
6. Per-distribution staking programs + nominations (allowlist per D9); harness documents the manual
   veOLAS steering path and records steering *intent* (the v1b graduation metric).

### v1b — steer, automated (built when v1a friction is demonstrated)
7. EIP-712 ballots; Base-side aggregation; proof-carrying permissionless L1 execution (jinn-claim
   pattern); pooled locker with instruction-following proofs; liveness insurance per §6.2.

**Gate (capability — the binding one):** on the top usage-selected distribution,
**corpus-connected harness ≥ stock harness quality at lower total cost**, measured by the existing
eval pattern (swe-rebench-v2 for coding-like distributions; equivalent eval stood up for whatever
usage actually selects). If this number does not materialise, steering and earning are decoration —
stop and rethink before scaling v1.

Implementation plans (TDD, bite-sized, per `docs/superpowers/plans/`) are written per phase at
pick-up; each phase's items land as Issues with the appropriate shape (`feat`, mostly).

## 9. Risks

| Risk | Mitigation |
|---|---|
| Data farming (junk traces for emissions) | Verification gate before emissions eligibility (§6.1); rate caps; locked/vested earnings blunt dump-and-run |
| Whale steering (bought weight → farmable distributions) | Allowlist first (D9); loosen as contributor-earned weight disperses |
| Privacy breach in traces | Mandatory fail-closed scrub; task-traces only; per-task veto; contribution ledger; general-purpose capture is *more* sensitive than niche capture — treat scrub as load-bearing infra |
| Executor failure (the relayer-starvation lesson) | Structural: the L1 epoch function is proof-carrying and permissionless (§6.2 v1b) — no exclusive executor; monitoring + Chainlink backstop are insurance on top |
| Upstream Hermes drift | Thin-fork discipline (D2): Jinn layer as a package, fork as a patch |
| Seed licence violations | Per-skill licence check; attribution in metadata; skip on doubt |
| Corpus never proves the capability number | The v1 gate is explicit; emissions runway is finite by design — the number decides scaling, not narrative |

## 10. Non-goals

- No marketplace-first consumption; no "post a task, pay a bonded solver" as the product.
- No verification-as-product; attestations remain a secondary surface.
- No corpus enclosure, ever; no take-rate on transactions.
- No selling of distilled skills (rung 2, rejected — §5.1): a skill is a non-excludable information
  good, public-domain on first sale; paywalling it leaks immediately and breaks corpus-as-public-good.
- No *archival-data* moat and no self-sustenance claim; emissions are finite bootstrap, named as
  such. (The durable asset is the live **bonded economy** — §2. This non-goal rejects the
  archive-as-asset and runway-is-self-sustaining framings, not the bonded-economy moat.)
- No native-token dependency; JINN optionality stays parked.
- No capture beyond harness task traces.

## 11. Open questions — resolved 2026-07-02

- **Q1 — Trace schema → two-layer** (§5): layer-1 evidence envelope (frozen for v0) / layer-2
  SKILL.md-compatible consumables; verification is the promotion gate; distillation is a network
  task.
- **Q2 — Bond friction → the onboarding ladder** (§6.1): credit-first (free, gasless) as
  underwriting history → stOLAS-pool-supplied bonds at Tier 2 → optional co-bond/self-bond.
  Treasury fronting rejected (slash exposure without recourse).
- **Q3 — Executor upkeep → permissionless proof-carrying execution** (§6.2 v1b) as the design
  requirement; own executor primary, Chainlink backstop, OLAS mech job as dogfood experiment.
- **Q4 — Steering weight basis → pure veOLAS weight.** Simplest and OLAS-native; revisit only if
  bought-weight distortion is observed in practice (the D9 allowlist bounds it meanwhile).

## 12. Verifications outstanding (check before the relevant phase commits)

- **stOLAS slashing pass-through — RESOLVED 2026-07-02** (spike #1316, PR #1321,
  `docs/spikes/2026-07-02-stolas-slashing-passthrough.md`): no slash reaches the pool because, by
  construction, no slash exists — slashing is only callable by a service's own multisig, and the
  stOLAS MultisigGuard reverts it; the only native penalty is eviction (forfeited future rewards,
  never principal). The operator co-bond slice is NOT natively supported: it **needs a wrapper**,
  and the wrapper is mechanism design, not integration — it must introduce the slashing authority,
  conditions, and evidence itself (nothing in OLAS triggers a slash for bad work) and redesign the
  MultisigGuard invariant, which hard-requires the operator balance to equal the full security
  deposit. Blocks Tier-2/Tier-3 mechanics (v0.5→v1), not v0.
- **Ethereum-mainnet Mech Marketplace availability** — gates only the OLAS-native keeper
  experiment (v1b), nothing else.

## 13. Decision-record flag (added v0.4, issue #1487)

The §2 moat reconciliation is a **position change, not a wording tidy**. It narrows the former
blanket "no moat claims" — which internally contradicted the same bullet's naming of "live bonded
participation" as a durable asset — into two specific rejections (the archival-data moat and the
self-sustenance claim) and **names the bonded economy as the durable, non-mirrorable asset**. Because
this reverses a stated non-goal (§10) into an affirmative claim about the protocol's durability, it
**likely warrants a Decision Record** under `log/decisions/` (working handle
`DR-2026-07-09-bonded-economy-moat`). Flagged here; the DR is not written in this amendment.

## 14. Amendment: consent defaults + Stage 1 contribution lane (v0.5, 2026-07-14)

**Consent-default correction.** The §1 summary's Contribute item, D3 (§3), the §5 contribution-terms
bullet, and the §6.1 Tier 1 label previously stated contribution as on by default. This was wrong:
shipped behavior — and the approved Stage 1 product design — is **default-decline, review-first**.
Consent is asked explicitly at onboarding, default off (P7: "Publish consent default-decline (as
shipped); mineable-trace tier-1 (retain local) asked explicitly at onboarding, default off."). The
first publish shows a one-time preview, after which minting is silent and the user inspects results
via the ledger rather than being interrupted (P4). Per-task veto is retained unchanged. See
`docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md` §2 (P4, P7) and §9 item
1, which flagged this exact drift and required the amendment.

**Stage 1 gate-lane note.** The Stage 1 contribution lane that gates progress is the
**user-originated public task mint**, not trace publication: "Eligible contribution:
user-originated public task mint (session-echo at true `repo@commit`, blinded provenance). Trace
publication remains as the shipped consent-gated lane but is not the gate." (P3). Trace publication
as described in §5/§6.1 continues to run as the shipped, consent-gated corpus lane — it is not
retired — but it is not the Stage 1 gate. See also the roadmap's "Initial contribution and privacy
boundary" section (`docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md`),
which frames publication as review-first pending the compiler/admission boundary being proven, and
`docs/superpowers/plans/2026-07-14-jinn-plugin-stage-1-plan.md` §S1-H1, the plan item that required
this spec amendment.

**On §13.** This amendment does not reopen §13's Decision-Record flag. The consent-default reversal
was ratified in the approved Stage 1 product design (PR #1653, product design + package
architecture + decomposition plan), which explicitly required "a one-line spec amendment" here — no
separate DR is needed for this change.

### 14.1 Amendment: consent collapsed to one sharing question (v0.6, 2026-07-15, mono#1714)

**Supersedes** both the "publish scrubbed traces by default" language wherever it survived in
§1/§3/§5/§6.1 **and** the #1657 tier-1/tier-2 framing in §14 above. There is now exactly **one**
contribution consent — `shareConsent`, default decline — and it gates a single thing: whether a
**mined task leaves the machine** (the user-originated public task mint of P3 — a reproducible OSS
problem based on the user's work, at `repo@commit` with blinded provenance). Local traces are
**input-only and never leave**: local capture, mining, and distillation are **unconditional** (no
consent gate) because none of them cross the machine boundary. Trace publication is **no longer a
distinct sharing prompt** — the only lane out is the mint. Review-first safety (one-time preview +
per-task veto + ledger) still applies on top of the single consent. Where §14 (v0.5) referenced a
separate tier-1 "retain local" consent and a tier-2 "publish mined tasks" consent, read both as the
one `shareConsent`; the old tier-1 retention question is gone (retention is always on).

Context: issue #1657 (this amendment), parent #1654, roadmap PR #1651 (merged 44ac8a484), Stage 1
product design + plan PR #1653 (merged befcfdf3f).
