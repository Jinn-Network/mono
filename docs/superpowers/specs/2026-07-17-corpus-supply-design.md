# Corpus supply and data strategy — Session B design

- **Version:** 0.1
- **Date:** 2026-07-17
- **Author:** Claude Fable 5 (drafted, Session B); Ritsu (design direction)
- **Shape:** `design` — output is this spec; implementation lands via the meta session's combined issue train (issues proposed in §13, not filed)
- **Session brief:** `docs/superpowers/briefs/2026-07-17-session-b-corpus-supply.md`; framing packet `docs/superpowers/briefs/2026-07-17-stage2-framing-packet.md` (W1–W4 presumed; flags in §14)
- **Roadmap anchors:** `docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md`; `spec/2026-07-06-distillation-v1.md` (three stores, D8/D9/D11); `spec/2026-07-06-capability-eval-v0.md` (held-out boundary); DR-2026-07-14 (the trajectory is the transcript); DR-2026-07-09-a (task creator: augment `swe-rebench-v2`)

## 1. Summary

This spec defines the corpus's supply side: what enters it, through which lane, at which
visibility tier, in what shape — such that it serves retrieval now and is ready for skill
distillation and post-training later without re-capturing anything.

The design was derived greenfield from the consumers backward, then reconciled with what is
shipped. Its spine:

1. **One canonical knowledge object — the verified experience tuple**
   `(task, environment, attempt-group, verdicts)`. Every consumer the corpus will ever serve
   (retrieval now; SFT, Agent SFT, RLVR, preference optimization later) is a mechanical
   projection of this one object (§4).
2. **Two serving tiers over one corpus** (W2 made precise): a small, curated,
   **retrieval-visible** tier serving live sessions, and a **substrate-resident** tier serving
   programmatic consumers. Retrieval visibility is an **allowlist mark** set at publish;
   everything else defaults to substrate (§5). The first application of the rule retires the
   84 skills.sh seeds from retrieval as a consequence of the default, not as a special case.
3. **One tuple schema, two producers**: the live solve path emits tuples natively
   (post-#1473 solves already carry the full conversational trajectory); history is covered by
   one-time **derivation** through the distillation bridge — never by migrating immutable
   records (§6).
4. **Four supply verbs**: **mint** problems (benchmarks → marketplace → native verified
   tuples), **curate** episodes (hand-authored, per early-user repo, retrieval tier),
   **derive** history (the bridge, lazily, on consumer demand), **reference** external
   datasets (anchored pointers, never mirrored bytes) (§7–§8).
5. **Contamination and license discipline as record-level invariants**: the cap-eval
   instance+repo exclusion extended with date-based freshness and public-dump provenance
   joins; generator-model identity and a distribution-safety class as first-class fields
   (§8.3–§8.4).
6. **Tiered anchoring**: per-record anchors remain for retrieval-tier and contributed
   records; bulk substrate batches anchor via one **manifest record** enumerating member CIDs
   (§9).

Under W1/W3, seeding — not user contribution — is the growth mechanism, so this spec is the
corpus's de-facto growth strategy for the coming stages.

## 2. Context: what exists (verified live, 2026-07-17)

Facts below were verified this session against the live testnet indexer
(`https://jinn-indexer-production.up.railway.app/graphql`, Base Sepolia, block ~44,259,542),
the codebase at `6609b3e37`, and GitHub state.

- **The corpus is 4,268 anchored records in three anchor namespaces**: 2,704 attempt
  envelopes (`envelope:`) + 1,465 evaluation verdicts (`evaluation:`) — the execution ledger,
  all swe-rebench, evidence-tier `committed` — plus **99 `capture:` records** (the namespace
  retrieval reads): ~84 skills.sh skill seeds and the Stage 1 seed episodes. The two-tier
  structure already exists physically as namespaces; this spec makes it deliberate.
- **The brief's "~2,676 backfilled trajectories exist in-house" is a misread.** 2,677 is the
  indexer's attempt count (the source population). The #1672 backfill machinery merged
  (PR #1724) but has never run — `derived_trajectories` holds 0 rows — and its output shape
  deliberately discards the verdict/instance/repo/test joins. The honest promotion vehicle is
  the distillation bridge (`spec/2026-07-06-distillation-v1.md` §8), which re-derives from
  the execution ledger with the verdict join and held-out exclusion built in (§6).
- **#1473 shipped** ("the trajectory is the transcript", DR-2026-07-14): `jinn.trajectory.v1`
  now has 8 span kinds including `jinn.agent_turn` and `jinn.tool_call`; the engine parses the
  solve transcript into typed spans at `pack()`. New solves are Agent-SFT-grade at capture
  time. Known gap: the hermes *solve* adapter writes no usable transcript (interactive lane
  unaffected).
- **Retrieval pickup is consumer-side and already exclusionary**: ranking drops skill hits,
  post-fetch guards drop content-classified skills and empty packets (#1782/#1794);
  `RELEVANCE_FLOOR = 2`, `MAX_SELECTED_PACKETS = 2`. The supersede/lineage primitive is
  shipped read-side (#1462, `resolveHeads`); the testnet hygiene sweep (#1776) is open.
- **F2P/P2P test contracts exist only in task specs** (`client/src/solver-types/`), not on
  attempt or verdict records — recoverable by join, not carried (§8.2, requirement to C).
- **Anchoring is one EOA `setMetadata` transaction per record** on the ERC-8004
  IdentityRegistry; no batching exists (the merkle-batch relayer is designed in
  `spec/2026-07-02-jinn-harness-network.md` but unbuilt); **no measured gas figure exists
  in-repo**; discovery is anchor-event-driven — `search()` cannot see an unanchored record,
  though `get()` by known CID needs no anchor (§9).
- **The 2026 public-data landscape** (web survey, this session): SWE-rebench-V2 has 32,079
  dockerized tasks across 20 languages (+120k install-instruction tier); 600k+
  permissively-licensed agent trajectories now exist as open dumps (NVIDIA SWE-Zero 318k,
  Open-SWE-Traces 207k — built on SWE-rebench/V2 instances; nebius 67k+80k), all from
  open-weights teachers; **no public purpose-built grouped/preference dataset exists** —
  grouped verdict-labeled attempts is a named white space and is exactly what the marketplace
  emits natively (#1478/#1479).

## 3. Aims and quality function

The corpus's aim, per the operator's steer: **optimal knowledge for retrieval now,
developing into a base for fine-tuning later.** "Optimal" is consumer-relative, and the two
consumer classes want opposite physics:

- **Retrieval** (plugin pickup in live sessions; engine autoload at solve time) wants
  *precision*: vocabulary match with the user's actual repo and task, transferable content,
  trust. Volume past the match frontier actively hurts — the Stage 1 walkthrough produced a
  lexical false positive at three records, and the skill-transfer pilot's null showed both
  failure modes (content that matched but did not help; content that never matched).
- **Training** wants *coverage, structure, honest labels*: field completeness per method,
  contamination hygiene, verified outcomes.

Any candidate record is ranked on five axes — the corpus's quality function:

1. **Delta over the weights.** Knowledge the base model cannot already have: post-cutoff,
   repo-specific, environment-specific. Pretraining-era public content scores near zero.
2. **Verification strength.** Executable tests > independent evaluator > same-fleet
   evaluator > self-report. Unverified knowledge injected into sessions is negative-value.
3. **Trajectory fidelity.** Complete typed turns/tool calls/observations; token counts when
   the source stream provides them (never synthesized).
4. **Group structure.** K>1 attempts per task. Singletons cannot feed preference methods and
   cannot distinguish skill from luck.
5. **Join completeness.** The tuple's links are the value; trajectories with the
   verdict/instance/repo joins stripped are near-worthless (proven negatively by the
   backfill's output shape).

## 4. The canonical object: the verified experience tuple

> **Tuple = (task, environment, attempt-group, verdicts).**

- **Task** — statement; repo (`owner/name`); base commit; source (`benchmark | minted |
  user`); `instanceId` when benchmark-derived; `createdAt` (freshness key, §8.3); repo
  license posture.
- **Environment** — image name+digest, install config, platform; **verifier** when one
  exists: type (`f2p-p2p | command | none`), F2P/P2P test lists, `evalSemanticsVersion`.
- **Attempt-group** — every attempt on the task; per attempt: operator/agentId; harness
  name+version; **generator-model identity** (id, provider, open-weights flag — sourced from
  the stream, flagged `unreliable` when not); **distribution-safety class** (§8.4); typed
  trajectory (span vocabulary per DR-2026-07-14, with `sourceFormat`/parser/parserVersion);
  raw transcript ref (snapshot); produced solution/patch; token counts (optional).
- **Verdicts** — per attempt: outcome (passed; F2P/P2P results), verifier identity,
  verification-strength tier, `evalSemanticsVersion`, evaluation cost (field reserved;
  unmetered today).
- **Group fields** — groupId (the task), `groupSize`, `nPass`, `nFail` (today computed at
  distill time from the attempt group; requirement: deterministically derivable or
  materialized, §8.2).

Every consumer is a mechanical projection:

| Consumer | Projection |
|---|---|
| Retrieval episode | Compressed, human-readable view of one attempt+verdict: synthesis, tags, failure→fix excerpts |
| SFT | (task, best passing attempt's patch) |
| Agent SFT | Passing attempts' full typed trajectories |
| RLVR | (task, environment) — attempts discarded; the verifier is the reward |
| Preference | The attempt-group with per-attempt labels and group fields |

One capture, five derivations; nothing re-captured. **This tuple is a requirement statement,
not a schema.** Session C owns schema unification; §8.2 hands C the field-level checklist.
The tuple does not require a single materialized record kind — it requires that the fields
exist and the joins are first-class.

## 5. The two-tier serving rule (W2 made precise)

**Rule.** Every record is **substrate-resident by default**. A record is
**retrieval-visible** iff it carries an explicit retrieval mark set at publish time.
Retrieval pickup operates as an **allowlist**: it serves only marked records. There is no
denylist to maintain and no way for bulk supply to flood retrieval by accident.

- **The mark.** A deterministic, scrub-safe marker carried **in the record content** at
  publish (episodes: alongside `seed.attribution`; unified schema: a named field). B
  specifies the semantics; **C decides where the field lives** in the unified schema and
  whether the indexer ever indexes it (not required for v0 — enforcement is consumer-side,
  where all visibility logic already lives: pickup ranking + post-fetch guards).
- **Who marks.** The publishing curator — by hand or by policy. In the W1/W3 era the
  operator running the curated seed lane is the only marking producer. *Amended by
  DR-2026-07-17 Decision 4:* the mark may also be set by a **declared admission policy over
  record facts** (verdict, evidence tier, repo tags, freshness) as those signals mature on
  bulk records — hand-marking is the day-one policy, not a standing obligation; the policy
  hook lands with the mark's semantics. Marking criteria (the curation bar): repo-targeted
  vocabulary, authored synthesis and tags (the walkthrough proved these determine
  retrievability), scrub-clean, evidence-backed (an episode projecting a real tuple or a
  re-performed merged fix per the seed runbook).
- **Promotion.** A substrate record is promoted by publishing a retrieval **projection** of
  it — an episode derived from the tuple, carrying the mark, with provenance pointing at the
  source envelope CIDs (not a supersede of the original). The immutable original is never
  edited.
- **Demotion.** Publish a superseding record without the mark (read-time collapse via the
  shipped supersede mechanics, #1462), or — interim, for records that need no replacement —
  simple absence of the mark under allowlist posture. Records are never deleted.
- **Sequencing guard.** The rule ships **before** any bulk derivation (§6) lands in the
  `capture:` namespace. Bridged records simply never carry the mark.
- **First applications.** (a) The Stage 1 episodes are re-published carrying the mark when
  the curated lane re-runs post-#1784 (their current unmarked versions collapse via
  supersede). (b) The 84 skills.sh seeds never receive the mark — **retirement from
  retrieval falls out of the default**. Rationale, recorded for the register: our only
  measurement of this content class returned a null (skill-transfer pilot: found-but-did-not-
  help, and never-matched); first principles predict it (pretraining-saturated content with
  maximally generic vocabulary — false-positive magnets under lexical retrieval); and the
  main consumer already excludes them ad hoc (#1782/#1794) — the tier rule promotes that
  per-consumer hack into a corpus-level classification. Retirement ≠ deletion: they remain
  fetchable, in provenance history, available to the distiller as reference material; the
  open hygiene sweep (#1776) supersedes the duplicated/defaced ones. In tuple terms an
  imported skill seed is a lesson with no experience under it — an assertion, not evidence.
  A *distilled* skill with provenance into verified tuples remains a legitimate projection
  that must earn its place per distillation-v1 D9/D11.
- **The second retrieval surface, scoped.** Engine autoload
  (`docs/superpowers/plans/2026-07-04-1393-engine-corpus-autoload.md`) is a solve-time,
  solver-type-keyed consumer of solution records. It reads **substrate** directly (top-3 by
  solverType, higher evidence tiers preferred) and is **not** governed by the retrieval mark:
  its precision risk is bounded by solver-type keying, and its failure mode (irrelevant prior
  solution at solve time) is cheap relative to polluting an interactive session. If autoload
  later shows the same false-positive pathology, the mark extends to it — flagged as a watch
  item, not built now.

## 6. Producers: one schema, two producers; derive, don't migrate

The tuple has exactly two producers, both writing the same output contract; a provenance
field distinguishes them.

- **Native (the live path).** Task minted with its verifier → harness solves → `pack()`
  parses the transcript into typed spans (#1473) → solution envelope publishes → evaluator
  grades → verdict publishes. Every tuple component is captured at the moment it exists. The
  local plugin capture lane is native-*shaped* (same span vocabulary) but machine-local under
  W1 — it becomes a corpus producer only by a consent flip, with no re-capture (flag on W1,
  §14).
- **Derived (the bridge, for history).** The ~4.1k pre-existing execution-ledger records are
  immutable and stay untouched as ground truth. The bridge walks the ledger after the fact:
  join attempt↔verdict on requestId; pull instanceId/repo/base-commit/F2P-P2P from the task
  row; parse the `system_snapshot` transcript into the same typed spans (the #1473 parsers
  over the #1472 read path); emit a **new** record in the same schema, `provenance:
  derived-from-history`, citing its source envelope CIDs. Parser name/version recorded — a
  parse is a claim someone may audit.

**Materialization is lazy.** Retrieval never reads these records; distillation pulls through
the bridge per-cluster already; training consumers do not exist yet. Bulk derivation runs
when a consumer demands it (first expected demand: the distillation pilot), lands
substrate-tiered, batch-anchored (§9), and held-out-excluded (the bridge's built-in gate).

**Honest gaps history carries** (recorded, not papered over):

1. Generator-model attribution on old attempts is unreliable (`attemptEnvelopeMeta.model`
   was demonstrated untrustworthy during fleet debugging) → historical tuples default to the
   conservative distribution class (§8.4). Since the fleet was predominantly Claude-harness,
   the restricted class would apply regardless — which bounds the training value of history
   and is itself a reason not to materialize eagerly.
2. Hermes-solve attempts have no usable transcript → those tuples degrade to patch+verdict
   (SFT/preference-usable; not Agent SFT).
3. ~1,700 of the 2,677 snapshots are not local — bulk derivation is IPFS traffic, and the
   existing enumeration path caps at 1,000 per pass; the bridge run needs paging.
4. Where a snapshot is missing or unparseable, the tuple degrades the same way — never
   fails.

The #1672 backfill lane (local `derived_trajectories` table) is retired as a third shape:
its parsers are reused by the bridge; the lane itself is dropped.

## 7. Supply roadmap — the engines, in order

Engines ranked by what they produce against §3's quality function; then the first three
moves.

- **The marketplace is the only engine that produces the whole tuple natively.** Its two
  policy levers outweigh any import decision: **mint with K>1 attempts deliberately** (group
  structure is a minting choice, and grouped verdict-labeled attempts is the public white
  space) and mint tasks whose distribution matches what the corpus should know.
- **Benchmark ingestion is task supply for that factory** — import problems, not solutions.
  Cost profile (verified this session against the rebench build-out): SolverNet wiring is
  generic and cheap (1–2 days); the cost is evaluator fidelity + environment hardening +
  admission gating + held-out construction, and it transfers only when the verification
  substrate is shared. Ordering that follows: **task-creator minting inside
  `swe-rebench-v2`** (per DR-2026-07-09-a, not a new benchmark — near-zero marginal cost) →
  **SWE-rebench-V2** (same substrate, 6x supply, 20 languages — days) → same-substrate
  datasets → new substrates (Terminal-Bench-class — weeks) only when domain coverage
  justifies.
- **Curated episodes are a precision instrument for the retrieval projection only.** Zero
  training mass by design. Authoring cost is real (hours per episode); the walkthrough proved
  synthesis/tag quality determines retrievability.
- **Local plugin sessions are the future distribution-matched goldmine** (real user repos =
  maximal delta-over-weights), parked under W1; the standing requirement is shape
  compatibility, not activation.
- **Mirrored external trajectories/solutions produce nothing the tuple values** — no delta
  over weights, no verification we performed, usually no group structure, joins to
  fabricate. They enter only as references (§8.1).

**The first three supply moves:**

| # | Move | What it unblocks | Cost | Owner |
|---|---|---|---|---|
| 1 | **Ship the tier rule** (§5): allowlist mark + pickup enforcement; re-publish Stage 1 episodes marked, post-#1784; skills unmarked (retirement); #1776 sweep in parallel | Everything — no bulk supply is safe before it; A's first-session aha depends on a clean index | Small (plugin filter + seed-lane field + re-publish) | Eng (impl) + operator (curation) |
| 2 | **Author curated seeds for the repos actual early users touch** (per-repo batches; the A↔B guarantee, §10) | Onboarding: retrieval has something honest to serve in the user's own repo | Hours per episode, recurring; #1784 first | Operator (authoring); eng (lane fixes) |
| 3 | **Grow native tuple supply on the same substrate**: K>1 minting policy + SWE-rebench-V2 expansion; bridge derivation deferred until the distillation pilot demands it, then run batch-anchored (§9) with gas measured on that batch | The moat data (grouped, verdict-labeled, multilingual); the training substrate | Days (V2 port; minting config); bridge run = compute + IPFS traffic | Eng |

The HF/import policy (§8) is a policy artifact of this spec — zero build beyond guards.

## 8. Import policy and record-level invariants

### 8.1 Per source type

| Source type | Policy | Rationale |
|---|---|---|
| Benchmark tasks with verifiers (rebench-V2, Multi-SWE-bench/RL, SWE-smith-machinery targets) | **Mint** as marketplace tasks (subject to §8.3) | The factory manufactures fresh, verified, group-structured tuples from them |
| Public trajectory/solution dumps (SWE-Zero, Open-SWE-Traces, nebius, smith-trajectories) | **Never mirrored.** Enter as **reference records** only | Commodity (600k+ free, permissive); no verification we performed; several are built on our own task instances — they are a contamination surface to *track*, not content to host |
| Issue+patch pair corpora | Use **directly at train time**; reference record if a training run consumes one | Anyone can `load_dataset()`; hosting adds nothing |
| Episode-shaped content | **None exists to import** (verified) — the curated lane cannot be outsourced. The conditional lane: where an early user's repo is covered by public issue+fix data, auto-transformed episodes may be proposed — substrate-resident, repo-keyed, entering retrieval only via the same mark and provide-rate test as hand-curated seeds. The set behind this rule is empty today |
| Held-out eval sets (SWE-bench Verified/Pro, cap-eval slate) | **Never minted, never imported** — reserved as capability gates | Minting them as supply destroys their measurement value |

**Reference records** carry: dataset name, revision hash, license, split, shape mapping to
the span vocabulary, and contamination overlap against our task sources. They make training
runs reproducible and boundary-safe while bytes stay at the source. (Mechanically they are
small records; if published as a batch they ride the §9 manifest.)

**Curated *derived* datasets** (cleaned, span-normalized, verified subsets — new value, not
laundering) are named as a legitimate knowledge-pricing-era product and deferred (§11).

### 8.2 Post-training readiness contract (requirements handed to C)

Per method, the fields the tuple must make available. **C owns the schema; B owns this
checklist.**

| Method | Requires |
|---|---|
| SFT | task statement; repo + base commit; best passing attempt's patch; verdict.passed; license posture + distribution class |
| Agent SFT | the above + full typed trajectory (`jinn.agent_turn`/`jinn.tool_call` + observations) with `sourceFormat`/parser/parserVersion; token counts when stream-provided; raw transcript ref retained |
| RLVR | task + environment: image+digest, install config, verifier type, **F2P/P2P lists**, `evalSemanticsVersion`; contamination keys; attempts unused |
| Preference | attempt-group with ≥2 attempts on the same task; per-attempt verdicts; `{groupSize, nPass, nFail}`; per-attempt harness/model identity |

**Delta vs today** (each is a B→C requirement):

1. F2P/P2P + base commit are not on attempt/verdict records (solver-type specs only) — the
   tuple must materialize or first-class the join.
2. Group fields are computed at distill time only — make deterministically derivable from
   record links, or materialize.
3. `generatorModel` — first-class, stream-sourced, with an honesty flag for unreliable
   history.
4. `distributionClass` — new field (§8.4).
5. `task.createdAt` — carried for date-based contamination (§8.3).
6. `instanceId` — carried on the record for exclusion joins.
7. The two tier vocabularies (`evidenceTier` committed/self-signed/attested vs
   `verifiabilityTier` user-accepted/tests-passed/evaluator-verified) need reconciling into
   one verification-strength axis in C's unification.

### 8.3 Contamination invariants

- **I1 (existing, hard):** no record whose `instanceId` OR `repo` intersects the active
  held-out slate enters distillation input or any training-visible export (cap-eval D8
  discipline; `excludeHeldOutSlate` at the chokepoints).
- **I2 (extension):** every tuple carries `task.createdAt`; capability claims prefer
  date-based freshness (task created after the evaluated model's cutoff). Rationale: public
  dumps built on our task sources appear monthly; static exclusion lists go stale on
  arrival — date-based freshness is the only defense that survives the trajectory-dump era
  (it is SWE-rebench's own method).
- **I3 (extension):** the contamination tracking key is `(repo, baseCommit, instanceId)` +
  generator-model + source-dump provenance; training-visible exports declare an overlap
  manifest against known public dumps.
- **I4:** imports/minting restricted to permissive-license repos (the rebench/NVIDIA
  pattern); repo license recorded on the task.

I2/I3 *extend* the cap-eval boundary; they do not relax I1. Because they touch a constraint
the framing packet marks hard, they required meta-session ratification — **ratified,
DR-2026-07-17 Decision 5**.

### 8.4 Distribution-safety classes (license discipline)

Model-output terms (Anthropic, OpenAI) bar using outputs to train competing models; a
permissive dataset license cannot launder upstream ToS. Therefore every attempt carries:

- `distributionClass: open` — generator is open-weights (or human), repo permissive: usable
  in redistributable training exports.
- `distributionClass: restricted-tos` — generator under restrictive ToS (Claude/GPT
  harnesses): serviceable as retrieval/episode content and for operators' own use; **never**
  in redistributable training exports.
- `distributionClass: unknown` — treated as `restricted-tos`.

Consequence, stated openly: today's fleet is predominantly Claude-harness, so the corpus's
existing and near-term native tuples are mostly `restricted-tos` — retrieval-safe, not
sellable training rows. **The sellable training tier wants open-weights harness operators**
(the Hermes lane with open models). This is a strategy-level lever the operator holds; the
spec's job is to make the class visible per record so the choice is explicit.

## 9. Anchoring economics

Facts (§2): one EOA `setMetadata` per record; no batching; no measured gas number exists
in-repo (the "cents on Base" line in the harness-network spec is aspirational); discovery is
anchor-event-driven; fetch-by-CID needs no anchor.

**Position — tiered anchoring (ratified, DR-2026-07-17 Decision 5):**

- **Per-record anchors stay** for retrieval-tier records and genuinely contributed evidence
  (low volume; the full Legibility ceremony is the point).
- **Bulk substrate batches** (bridge output, reference-record batches) anchor via **one
  manifest record per batch**: an anchored record (its own namespace, e.g. `manifest:`,
  keeping it out of `capture:`) whose body enumerates member CIDs and carries a merkle root
  over them. Members are fetchable by CID; discovery sees the manifest and consumers
  enumerate members from its body; any single member is provable against the anchored root.
  One transaction per batch, no new contract (still `setMetadata`).
- The already-designed merkle-batch relayer (harness-network v0.5) is the eventual
  generalization; the manifest record is its minimal realization and is forward-compatible
  with it.

**Legibility reconciliation** (PRINCIPLES.md): every substrate record remains
content-addressed, signed, and provable on demand via manifest inclusion — the on-chain
commitment exists; what bulk records give up is only *per-record* anchor ceremony, a
property no training consumer reads per-record. Claims about substrate contents cite the
manifest anchor + member CID.

**Measurement before scale-up:** the first bridge batch doubles as the gas measurement —
record per-anchor and per-manifest cost then; no figures are asserted until measured.

## 10. Supply quality measurement and the A↔B guarantee

- **Retrieval (the tier's health): provide-rate** — fraction of real sessions in target
  repos where pickup serves ≥1 marked record judged relevant (operator-assessed at Stage 2
  scale; the walkthrough protocol is the instrument). Secondary: false-positive rate (served
  and irrelevant), which the allowlist posture should drive toward zero.
- **"Enough corpus for onboarding" (the A↔B seam), defined:** for each early-user repo
  named by Session A, at least **K = 3** retrieval-marked records whose tags hit that repo's
  vocabulary, verified by a **probe search** (a fixed query set per repo, run via the corpus
  search path). **The doctor's "corpus has relevant content" check runs that same probe** —
  the guarantee and the check cannot drift. B owns probe definition and content; A states the
  repo list; placement of the doctor check is the A↔C seam.
- **Substrate health:** field-completeness rate per §8.2 checklist; verified-outcome rate;
  group-structure rate (share of tasks with K≥2 attempts); contamination-key coverage.
- **Distillation yield** (when the pilot runs): eligible clusters, skills produced, D9/D11
  outcome — measured by the distillation rig, consumed here as a supply signal.
- **Training lift:** reserved; no consumer exists yet.
- **Cost visibility gap:** per-eval cost is unmetered (`evaluator_cost_usd: 0`) — proposed
  issue; without it, cost-per-verified-tuple cannot be computed.

## 11. Non-goals

- Knowledge pricing / selling corpus access (Phase 3); curated derived datasets as product.
- Network distillation rung 3 (distillation as bonded SolverNet work).
- Evaluator economics / independence (Phase B.2) — verification-strength tiers name the
  trust step; fixing it is out of scope.
- Embeddings or any model call in the retrieval path (W4 stands; corpus-side quality fixes
  preferred).
- Building SFT/RLVR/preference training pipelines — this spec supplies data contracts only.
- New verification substrates (Terminal-Bench-class) this stage.
- Un-parking outbound contribution (W1 stands).
- A dataset-hosting service — references, not mirrors.
- Indexer schema changes for the tier rule (consumer-side for v0; C may index the mark
  later).

## 12. Verification moment (recommended)

After moves 1–2 (§7): **a live retrieval session against the first curated seed batch, run
by the operator** — a real task in a named early-user repo. Success: pickup serves a marked,
relevant seed (no skill hits, no false-positive noise); the doctor probe for that repo
passes; the session's provide-rate observation becomes the measurement baseline for §10.
This is the A↔B first-session-aha check executed for real.

## 13. Proposed issues (not filed — meta session reconciles)

| Title | Shape | Packages | Depends on | Effort |
|---|---|---|---|---|
| Retrieval-visibility mark: allowlist semantics + pickup enforcement | feat | `packages/plugin`, `client/packages/harness-layer` | — | M |
| Seed lane: emit the retrieval mark; re-publish Stage 1 episodes (supersede unmarked) | feat | `client/packages/harness-layer` | #1784, mark issue | S |
| Curated seed batches for named early-user repos + per-repo doctor probes | docs/feat | fixtures, `packages/plugin` | #1784, A's repo list | M (recurring) |
| Bridge derivation run v0: paged ledger walk, tuple output, held-out gate, batch manifest | feat | `client/packages/harness-layer`, `client/src` | tier rule; manifest record | L |
| Manifest anchor record type (`manifest:` namespace) + consumer enumeration + gas measurement | feat | `client/src/erc8004`, `client/packages/harness-layer`, indexer (read-only) | — | M |
| Native-path tuple fields: `generatorModel`, `distributionClass`, `task.createdAt`, `instanceId` on new solves | feat | `client/src`, `packages/sdk` | C's unification (pairing) | M |
| K>1 group minting policy for the rebench generator | feat | `client/src/solver-types` | — | S |
| SWE-rebench-V2 source expansion (pool/admission port, multilingual images) | feat | `client/src/solver-types`, evaluator | — | M |
| Evaluator cost metering (`evaluator_cost_usd`) | chore | evaluator harness | — | S |
| Dataset-reference record convention + overlap-manifest tooling vs public dumps | feat | `client/packages/harness-layer`, docs | manifest record | M |
| Retire #1672 backfill lane (keep parsers), drop `derived_trajectories` writes | chore | `client/scripts`, `client/src/store` | bridge run v0 | S |

(#1776 — hygiene sweep — already open; not re-filed.)

*Banding per DR-2026-07-17 Decision 7:* the mark, seed-lane, curated-batch (scoped to the
charter's named repo: mono), native-fields, and evaluator-metering rows are gate-blocking;
the **bridge wave** (bridge run v0, manifest anchor record, #1672 retirement) files as
trailing, non-gate-blocking; K>1 minting, source expansion, and the dataset-reference
convention are deferred. See `docs/superpowers/plans/2026-07-17-stage2-umbrella-plan.md` §3.

## 14. Seams & assumptions register

**Assumes from other tracks**

- From **A**: the named early-user repo list (drives §7 move 2 and §10 probes); A surfaces
  the doctor's corpus-probe check in first-run UX (placement is A↔C).
- From **C**: the unified schema carries §8.2's fields and the retrieval mark survives
  unification; the two producers (§6) converge on C's one schema; the
  `evidenceTier`/`verifiabilityTier` reconciliation.
- From the shipped substrate: supersede read-side collapse (#1462) remains the demotion
  mechanism; seed lane (post-#1784) remains the curated producer.

**Provides to other tracks**

- To **A**: the "enough corpus" guarantee — K=3 marked records per named repo, probe-verified
  — and the probe definition the doctor executes.
- To **C**: the tuple field checklist (§8.2), the tier-rule semantics (§5), the manifest
  anchor record requirement (§9), the distribution-class vocabulary (§8.4).
- To the **meta session/DR**: the four-verb supply strategy (§1), the engine ordering (§7),
  and the invariants (§8.3–8.4) as ratifiable positions.

**Would renegotiate**

- **W2, strengthened:** this spec turns "curated and targeted" into an *allowlist* — bulk
  content cannot enter retrieval even accidentally. If the meta session prefers the softer
  reading (default-visible with exclusions), §5's flood-risk argument (false positive at
  three records; ~1,500 bridged records pending) is the evidence against it.
  **Ratified in the strengthened form, amended with policy admission — DR-2026-07-17
  Decision 4 (§5 amended in place).**
- **Cap-eval boundary, extended not relaxed:** I2/I3 (date-based freshness + dump-provenance
  joins) added on top of I1. Touches a packet-hard constraint — **ratified, DR-2026-07-17
  Decision 5**.
- **W1, one addition:** local capture must stay tuple-shaped (span vocabulary — already
  true via #1658/#1473 alignment) so un-parking is a consent flip, not a re-capture. No
  gating change requested. **Accepted as a rider on W1 — DR-2026-07-17 Decision 1.**
- **"Parked" semantics needed by B:** mint→preview→publish stays *code-present behind the
  consent gate* (not deleted) — the local capture store is the future supply; deleting the
  lane would forfeit it. **Resolved — DR-2026-07-17 Decision 1: stores and machinery are
  retained (this bullet's rationale is fully satisfied — nothing store- or lane-side is
  deleted); the plugin's UX surfaces are deleted and a consent moment is rebuilt at
  un-park.**
- **Anchoring:** substrate residency without per-record anchors (§9) is a Legibility
  position the meta session should explicitly ratify, since "anchored per record" has been
  the implicit norm. **Ratified — DR-2026-07-17 Decision 5.**
