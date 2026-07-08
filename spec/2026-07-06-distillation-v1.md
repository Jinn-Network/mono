# Distillation v1 — layer-1 evidence → layer-2 consumable skills

- **Version:** 0.5 (v0.4 + quality amendments from the skill-distillation literature review —
  verified-counterfactual rule, contrastive mode, fixed skill skeleton, anti-triggers, bridged-evidence
  enrichment + `patch-only` stratification, auditability fields, two §13 deferral records; 2026-07-08.
  Note: the `ContributionActivityChecker` reconciliation previously earmarked "at v0.5" (§8) is NOT
  taken up by this bump — it moves to a later amendment.)
- **v0.4:** v0.3 + the 2026-07-07 reconciliation with the shipped #1394/#1409 substrate —
  see **Reconciliation** below; ratified with DR-2026-07-06
- **v0.3:** v0.2 + SkillRL / training-substrate framing, a failure→lessons axis,
  and an explicit build-distiller-vs-ship-retrieval fork (2026-07-06)
- **v0.2:** design session + adversarial-review amendments (workflow `wf_063fe1aa`)
- **Date:** 2026-07-06
- **Author:** opus (drafted); Ritsu (design direction)
- **Shape:** `design` — output is this spec + [DR-2026-07-06](../log/decisions/2026-07-06-layer-2-conformant-skill-packages.md); implementation lands as a per-phase plan and Issues.
- **Roadmap anchor:** [`spec/2026-07-02-jinn-harness-network.md`](2026-07-02-jinn-harness-network.md) §5 (two-layer model), §7 (seeding), §8 (v1 capability gate). This spec realises the **layer-1 → layer-2 promotion** that §5 names but does not design.

> **Reconciliation (2026-07-07).** Issues **#1394** (first-class `jinn.skill.v1` artifact +
> structured provenance, `client/src/types/skill-artifact.ts`) and **#1409** (seed defacement fix,
> `buildSeedScrubPipeline`) shipped on `next` in parallel with this design and landed first. This
> spec's *intent* is satisfied by that substrate; where the mechanical choices differ, **the shipped
> shape governs**:
>
> 1. **Canonical stored form** is `SkillArtifactV1` with the structured `SkillProvenanceSchema`
>    object (extended additively with `skillKind` / `distillPromptSha256` / `distribution` /
>    `verifiabilityTier`), NOT provenance-in-frontmatter. `metadata.jinn` frontmatter appears only
>    in EXPORT renders of a standalone SKILL.md (`buildSkillMarkdown`, `skill-package.ts`);
>    the stored `skill.skillMd` omits it (anti-drift: provenance lives in exactly one place).
>    The "distilled from N traces" count is `sourceEnvelopeCids.length` — never stored separately.
> 2. **§10's single layer-2 altitude splits into two MODES** at that altitude: seeds are
>    **redact-mode** (output is published post-scrub; a false positive defaces prose → the shipped
>    seed profile runs deterministic detectors only, entropy fallback OFF); distilled output is
>    **check-mode** (`distillClusters` rejects on any scrub change; a false positive costs one
>    re-distill, never defaces → `buildLayer2ScrubPipeline` keeps the entropy fallback ON and adds
>    the deterministic plain-patterns set). Decision D6's "keep Pass-2" language applies to
>    check-mode; the shipped seed profile is the redact-mode realisation of the same intent.
> 3. **Consume-side recognition** is the shipped `extractSkill()` (`skill.ts`); this spec's `kind`
>    filter on `search()` is complementary and retained.
> 4. The distinct `skill:<cid>` anchor key remains the goal — producer wiring is **#1439** (A5
>    round-trip prerequisite). Until it lands, live publishes anchor under `capture:<cid>`.
>
> Distillation-v1's net-new surface is therefore: the **distilled-skill producer** (`publishSkill`,
> the producer #1394 anticipated but did not ship) + the **bridge / gate / distiller / three-arm
> measurement** pipeline (PRs #1424–#1427) + the run-time wiring. §5 and §10 below are read through
> this note.

## 1. Summary

The harness-network bet (`spec/2026-07-02-jinn-harness-network.md`) is **capability**: a
corpus-connected harness must measurably beat a stock harness. That bet closes only when the
contribution loop closes — when *real verified usage* becomes *consumable knowledge* that makes the
next agent better, beating the imported seeds. This spec designs the pipeline that does it.

**Framing — the corpus is a non-parametric, shared training substrate.** Reading the loop as
policy iteration (the parent vision, `spec/2026-07-02-jinn-harness-network.md`): **the corpus is the
policy** (a non-parametric one — knowledge, not weights); **distillation is the policy-update**
(compressing experience into reusable skills); **retrieval at solve time is the trained policy
acting**; and **the three-arm test (§11) is literally "does the policy-update (compression) beat the
raw substrate (retrieval)."** The **network is the unit of learning** — many contributors updating
one shared policy — but that is v3 (§13); this spec builds the single-node, manual version of the
loop. This framing is descriptive, not a new mechanism: the design already embodies it (D9 is the
compression-vs-retrieval test); v0.3 only makes the vocabulary and one missing axis explicit.

1. **Bridge** — copy SolverNet execution records (swe-rebench trajectories — **both verified passes
   and evaluator-confirmed failures**) out of the separate on-chain execution ledger and into
   layer-1 evidence, so they are distillable. This is the missing input pipe (§8).
2. **Promotion gate** — the corpus quality gate: only evaluator-verified, non-held-out,
   non-defaced evidence is eligible to distill (§6).
3. **Distillation** — a scripted, auditable step that turns evidence traces into
   **conformant Agent-Skill packages** (§7): successes → **strategic patterns**, evaluator-confirmed
   failures → **failure lessons** (the SkillRL decomposition, §2.4). Single-shot and flat for v1;
   recursion/hierarchy is v3.
4. **Consumption** — distilled skills are emitted as standard `skills` packages, discovered and
   acquired corpus-natively for v1, with a `skills`-CLI source resolver named as the forward path
   (§9, option C per DR-2026-07-06).
5. **Measurement** — the capability rig scores the distilled arm against **both** a seeds-only
   control **and a raw-evidence arm** (serving the same verified traces verbatim, un-distilled), on
   a held-out task set the distillation input must exclude (§11–§12). The distilled arm must add
   capability over seeds **and** justify the distillation step over raw-evidence retrieval — the
   Bitter-Lesson test the design must be able to *fail* (§11, D9). **The raw-evidence arm is not
   only a guardrail — it is the v1 product baseline we ship** (retrieval-over-anchored-evidence,
   near-free once the bridge exists); the distiller must *beat* it to justify shipping (§11, D11).

v1 is deliberately a **manual/scripted pipeline that proves the loop on a single distribution
(coding)** (CLAUDE.md Rule 2). The network-task version — distillation running as bonded SolverNet
work — is **v3 and out of scope** (§13). **The first measured run is a pilot, not a ship/no-ship
gate** (§11): an honest inconclusive or negative first result is the expected outcome given the
prior evidence (§2.4), not a pipeline failure.

## 2. Context

### 2.1 What already exists

- **Layer-1 evidence is live and frozen.** `capture()` scrubs a task into a `PendingEnvelope`;
  `publish()` uploads the `jinn.trace-envelope.v0` as an **artifact** wrapped in a signed
  `jinn.execution.v1` `SignedEnvelope`, anchored via ERC-8004
  ([`client/packages/harness-layer/src/publish.ts`](../client/packages/harness-layer/src/publish.ts),
  [`docs/envelope-v0.md`](../client/packages/harness-layer/docs/envelope-v0.md)). The envelope is
  **closed and frozen**; this spec does not amend it.
- **The consume path is corpus-native and pull-shaped.** `search()` (ref discovery via the
  DiscoveryAPI + client-side match) + `get()` (fetchManifest + acquire) return `SignedEnvelope`
  records with `artifacts[]`
  ([`client/packages/harness-layer/src/consume.ts`](../client/packages/harness-layer/src/consume.ts));
  the MCP tools `search_records` / `inspect_record` / `acquire_artifact` expose the same to an agent
  ([`client/src/mcp/`](../client/src/mcp/)). There is **no `/jinn skills install` command in this
  repo** (confirmed) — it would live harness-side.
- **Seeds ride the layer-1 pipe.** The 84 skills.sh seeds are imported by wrapping each SKILL.md as
  `steps[0].attributes['skill.md']` inside a layer-1 trace envelope with `provenance: 'imported'`
  ([`client/packages/harness-layer/src/seed-import/execute.ts`](../client/packages/harness-layer/src/seed-import/execute.ts)).
- **The execution ledger is separate.** SolverNet activity lives in Ponder tables `task` /
  `attempt` / `verdict` + `attemptEnvelopeMeta` + `verdictEnvelopeMeta`, keyed by
  `(requestId, chainId)` ([`packages/indexer/ponder.schema.ts`](../packages/indexer/ponder.schema.ts)).
  It never touches the corpus.

### 2.2 Two findings that shape this design

1. **The corpus never received the swe-rebench execution.** Verified solves land in the execution
   ledger, not the corpus. The bridge (§8) is the missing input; without it there is nothing
   coding-shaped to distill beyond seeds.
2. **Scrub over-redaction defaces published content** ([#1409](https://github.com/Jinn-Network/mono/issues/1409)).
   The 84 seeds come back defaced because public SKILL.md prose is run through **trace-grade secret
   scrub** (openredaction / secretlint-entropy / trigger-word stages) tuned for raw private traces —
   ordinary words become placeholder tokens (`"use"` → `[AIRPORT_2765]`). Distilled skills are prose
   too, and bridged coding evidence is token-dense technical prose: the pipeline **must not inherit
   this defacement** (§8, §10).

### 2.3 Prior art, reconciled

- **[DR-2026-05-07-d](../log/decisions/2026-05-07-own-solvernet-for-distilled-tasks.md)
  "session-derived distillation"** turns captured sessions into *re-solvable Tasks* on a SolverNet
  (a task generator; `SESSION_DERIVED_DISTILL_PROMPT_V1` decomposes a session into Tasks). That is
  a **different output** from this spec (a *consumable skill*, not a problem to re-solve) and is
  **network-task-shaped** — i.e. the v3 "distillation is a network task" surface. The two compose:
  session-derived tasks get solved → verified attempts land in the execution ledger → this spec's
  bridge ingests them → they distil into skills. v1 here does **not** use SolverNets.
- **The seed ride-along pattern** (SKILL.md as a step attribute) is superseded for consumables by
  the first-class layer-2 package (§5); seeds migrate onto it (§10, and it is the clean fix for
  #1409).

### 2.4 What the prior evidence says (why the first run is a pilot)

The external literature and this repo's own measurements both land on the exact cell this spec
targets — single-shot LLM distillation, coding, pre-installed, Haiku-class — and it is not a
friendly cell:

- **External (verified against live sources 2026-07-06):**
  [SkillsBench (arXiv 2602.12670)](https://arxiv.org/html/2602.12670v1) — the same SKILL.md format
  and delta-measurement shape as §11 — finds **self-generated skills give negligible/no benefit on
  average** ("models cannot reliably author the procedural knowledge they benefit from consuming")
  and **Software Engineering the smallest-gain domain (+4.5pp)** vs +51.9pp for Healthcare;
  [CTIM-Rover, "From Knowledge to Noise" (arXiv 2505.23422, REALM '25)](https://arxiv.org/abs/2505.23422)
  finds episodic memory **degraded** a SWE-bench agent (~40% vs ~42% baseline) — surface-similar
  memories actively mislead; and a 2026 cluster on skill-evolution
  ([Trace2Skill, arXiv 2603.25158](https://arxiv.org/abs/2603.25158) and related) reports that
  **raw-trajectory reuse frequently outperforms distilled skills**. (The success cases — Voyager,
  ExpeL — win with *executable, verified-before-admission* skills or *insights retrieved together
  with raw traces*, i.e. N≫1 and not single-shot prose.)
- **In-repo:** DR-2026-06-02-b (within-noise) and #986 (1/9, non-attributable) — the only two prior
  efficacy measurements on this modality+tier — were honest negatives.

**The positive prior — SkillRL — and what it diagnoses (verified against live sources 2026-07-06).**
[SkillRL: Evolving Agents via Recursive Skill-Augmented Reinforcement Learning (arXiv 2602.08234)](https://arxiv.org/abs/2602.08234)
([code](https://github.com/aiming-lab/SkillRL)) reports **state-of-the-art +15.3%** over memory-based
baselines (ALFWorld, WebShop, 7 search-augmented benchmarks) — the strongest recent *positive* result
for turning experience into consumable skills. Its winning recipe, verbatim from the abstract, is
exactly the axes v0.2's §7 lacked:

- **Both polarities.** "Successful trajectories → strategic patterns (critical decision points,
  generalizable behaviors); failed trajectories → concise failure lessons (the failure point + the
  correct counterfactual action)." v0.2's §7 was **success-only**.
- **Hierarchical.** A "SkillBank" of General Skills (universal) + Task-Specific Skills (category
  heuristics). v0.2's §7 was **flat**.
- **Recursive.** Skills co-evolve with the policy over rounds. v0.2's §7 was **single-shot**.
- **Compression.** 10–20× token compression vs raw trajectories — the mechanism by which distilled
  skills *can* beat raw-trajectory retrieval.

So the literature is not "distillation doesn't work." It is sharper: **single-shot + success-only +
flat distillation nulls (SkillsBench self-generated ≈ 0; CTIM-Rover −2.29pp; Trace2Skill raw ≥
distilled) — the exact cell v0.2's §7 occupied — while structured distillation (both polarities,
hierarchical, recursive) is SOTA.** The negatives and the positive agree on the mechanism.

**What v1 can cheaply borrow, and what it can't.** The cheap, high-value half is the
**success→patterns + failure→lessons decomposition** — no RL, no recursion, just a better prompt over
evidence the bridge already has (failures are abundant; §8). v0.3 adopts it. The expensive half —
recursion (skills co-evolving with an RL policy) and hierarchy — stays **v3** (network-task).
**Honest caveats:** SkillRL's domain is agentic-search / embodied (ALFWorld, WebShop), *not* coding,
and it couples distillation with RL policy optimization — so it is a **structural** prior (which
axes matter), not a coding-distillation proof. v1 tests whether the cheap structural half clears the
SE floor at all.

This is why the design (a) adds a raw-evidence arm so distillation must *earn* its place (§11, D9),
(b) treats the first run as a pilot with its own power calc (§11), (c) makes a Sonnet-class
replication load-bearing (a Haiku null is uninformative), and (d) **adopts SkillRL's
success-patterns + failure-lessons decomposition** (the cheap non-RL half) rather than the
single-shot success-only paraphrase the negatives already killed.

## 3. The three stores (vocabulary)

The design touches three stores. Only two are "the layers"; the execution ledger is a pre-existing
separate store the bridge reaches into. Keeping them distinct is load-bearing for the rest of the
spec.

| | **Execution ledger** | **Layer 1 — evidence** | **Layer 2 — consumable** |
|---|---|---|---|
| What it is | The on-chain protocol's receipt book: who posted a task, who attempted it, the evaluator's verdict | Scrubbed *traces* of work — the raw material of knowledge | Distilled *skills* — refined how-to an agent reads to get better |
| Shape | Indexer rows: `task`/`attempt`/`verdict` + `…EnvelopeMeta` | `jinn.trace-envelope.v0` (steps, outcome, tier) | `jinn.skill.v1` = a conformant `SKILL.md` package |
| Store | Ponder indexer tables | The corpus (artifact in a SignedEnvelope) | The corpus (artifact in a SignedEnvelope) |
| Key | `(requestId, chainId)` | envelope CID | envelope CID |
| Read by | Discovery API, reward accounting | the distiller (and the raw-evidence measurement arm) | **the agent, at solve time** |
| In the corpus? | No — separate | Yes | Yes |

**Worked example — one item through all three:**

1. **Execution ledger** (a swe-rebench solve, on-chain today): `attempt` by operator `0x1a…`, model
   `claude-sonnet-4-6`, patch for instance `django__django-12345`; `verdictEnvelopeMeta`
   `actualPassed: true`, `passedCount: 41/41`. *Means:* someone solved it, the evaluator confirmed
   it — no reusable knowledge, invisible to any consuming agent.
2. **Layer 1 — evidence** (after the **bridge**): `jinn.trace-envelope.v0` — `task.summary: "Fix
   queryset returning duplicate rows in django-12345"`, `steps: [applied patch, ran tests → 41
   pass]`, `outcome: { status: completed, verifiabilityTier: evaluator-verified }`, scrubbed +
   anchored. *Means:* corpus evidence, provenance-anchored, **eligible for distillation** — and,
   served verbatim, it is the raw-evidence measurement arm (§11).
3. **Layer 2 — consumable** (after the **distiller**): `jinn.skill.v1` — `name:
   django-queryset-dedup-debugging`, `description: "Use when a Django ORM queryset returns duplicate
   rows after a join…"`, body = the verified how-to, `metadata.jinn.provenance: [<layer-1 ref>]`.
   *Means:* an agent hitting a similar problem retrieves this and gets better — **the loop closes**
   *iff* this beats both seeds and the raw layer-1 evidence it was distilled from (§11).

Flow: **execution ledger → (bridge) → layer 1 → (distillation) → layer 2 → (consume) → better
agent.**

**In training-substrate terms (§1 framing):** layer-1 evidence is the *raw experience* (the
substrate's training data); layer-2 consumables are the *policy-update* (compressed, reusable —
patterns from successes, lessons from failures); retrieving a layer-2 skill at solve time is the
*trained policy acting*. Distillation (layer 1 → layer 2) is the update step; §11's three arms ask
whether that update (compression) beats acting on the raw substrate directly (retrieval).

## 4. Design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Layer-2 consumables are **first-class corpus artifacts** (`artifactType: 'jinn.skill.v1'`), not step-attributes buried in a trace | Lets consumers filter consumables from raw traces; provenance links become structured and on-chain-followable (Legibility). NB the current indexer has no `artifactType` column — filtering is client-side over a manifest page for v1 (§5) |
| D2 | A `jinn.skill.v1` payload is a **conformant `skills` package** (skills.sh / Vercel shape), verbatim — not "SKILL.md-ish" | Jinn output is drop-in installable by the `skills` ecosystem (Permissionless / composable), *contingent on a source resolver that may not exist yet* (§9). See DR-2026-07-06 |
| D3 | Promotion gate = **evaluator-verified, contributed, not-held-out, not-defaced; N=1 default, distinct-instance clustering** | Verification is the promotion gate (roadmap §5); evaluator-verified is the anti-farming line swe-rebench supplies. N=1 kept per operator direction; the raw-evidence arm (D9) backstops non-generalizing skills. Distinct-instance clustering stops one skewed instance dominating (§6) |
| D4 | Distillation is a **scripted, single-shot, flat LLM step with a published prompt hash** — not a SolverNet — producing **both** success→strategic-patterns and failure→lessons (D10) | v1 proves the loop minimally (Rule 2); recursion + hierarchy (the expensive half of SkillRL) are v3. Prompt-hash mirrors `SESSION_DERIVED_DISTILL_PROMPT_V1` for auditability |
| D5 | The **bridge** reads verified swe-rebench attempts from the execution ledger and emits them as layer-1 evidence via the existing `capture()`→`publishSkill`-adjacent path, scrubbed at **layer-2 altitude** (§8) | Reuses the frozen pipe; no new chain surface; bridged evidence is the SPEC.md `(task, solution, verdict)` tuple. Layer-2 altitude because a verified swe-rebench solve is public-repo work, not raw private-machine activity |
| D6 | **Two scrub altitudes.** Layer-1 keeps trace-grade fail-closed scrub for raw private traces. Public/derived content (seeds, distilled output, bridged public-repo evidence) runs a **secret-only** pass — the full secretlint stage (incl. its entropy secret-shape fallback) + key-policy — dropping openredaction and ml-pii (§10) | Resolves #1409: public/derived prose must not be defaced; secrets must still be caught. The distilled *output* is a fresh secret surface, scrubbed with the full secret net (§7, §10) |
| D7 | v1 consumption is **corpus-native** (the measurement path); a `skills` **source resolver** (`skills add jinn:<ref>`) is the named forward path, out of v1 scope | Keeps on-chain verifiability at consume time (Legibility); adopting the *format* makes full CLI adoption near-free later *if* the CLI supports a custom source (DR-2026-07-06 option C) |
| D8 | The **held-out task set is a committed shared interface** owned by capability-eval (§12); the bridge excludes it (instance_id + repo) and the distiller lexical-scans its output against it | Contamination boundary. Distilled skills generalize across repos, so instance_id+repo exclusion is necessary but not sufficient — a lexical scan over distilled bodies is the third axis (§7, §12) |
| D9 | **The distill step must beat serving the raw verified evidence it compresses, not only the seeds** | Learning Maximised: "discovery beats encoded cleverness." A distilled skill is a compression of discovered data; it earns its place only if it beats raw-evidence retrieval (§11). This is the falsification — the pipeline must be able to *return* "distillation didn't earn its place" |
| D10 | The distiller produces **both success→strategic-patterns and failure→lessons** (SkillRL, arXiv 2602.08234, §2.4); v1 does the **cheap non-RL half** (single-shot, flat, both-polarities); recursion + hierarchy are **v3** | The negatives (SkillsBench/CTIM-Rover/Trace2Skill) all null the single-shot + **success-only** + flat cell; SkillRL's SOTA adds both polarities + hierarchy + recursion. Failure lessons are the cheapest half — failures are abundant (§8) and compress 10–20× — and are the axis v0.2 dropped |
| D11 | **Ship retrieval-over-anchored-evidence as the v1 product baseline** (the raw-evidence arm, §11); the SkillRL-shaped distiller must **beat that baseline** (D9) to justify shipping | Makes D9's "else" branch constructive: a distiller null is not a dead end — retrieval-over-evidence ships as the product, and the `jinn.skill.v1` format (§5) persists for seeds and a future/better distiller. Do **not** build the single-shot success-only paraphrase the literature already killed |

## 5. Layer-2 consumable format — `jinn.skill.v1`

A distilled skill is published as a corpus artifact with **`artifactType: 'jinn.skill.v1'`**, riding
the *same* `SignedEnvelope` wrapper + ERC-8004 anchor as everything else (one corpus, one anchor
surface). The artifact **payload is a conformant `skills` package** (D2):

- **On-disk shape:** `<name>/SKILL.md` — the minimal conformant package. `name` is
  lowercase-letters/numbers/hyphens and **equals the directory name**. v1 emits **single-file**
  packages (prose + provenance; no `scripts/`); multi-file packaging (`references/`, tarball) is a
  forward extension.
- **Frontmatter (required):** `name`, `description` (the `description` is the retrieval surface — it
  must say *when to use* the skill, per the skills convention).
- **Frontmatter (Jinn provenance, in the standard optional `metadata:` block):**

```yaml
---
name: django-queryset-dedup-debugging
description: Use when a Django ORM queryset returns duplicate rows after a join or prefetch…
license: null            # SPDX id when imported (seed attribution); null for earned
metadata:
  jinn:
    schema: jinn.skill.v1
    distribution: coding
    verifiabilityTier: evaluator-verified
    distilledFrom: 3                       # N corroborating evidence traces
    provenance:                            # on-chain-followable back-links
      - <evidence-envelope-CID-1>
      - <evidence-envelope-CID-2>
      - <evidence-envelope-CID-3>
    distillPromptSha256: <hash>            # auditability (D4)
    distilledAt: <ISO-8601>
    skillKind: strategic-pattern           # strategic-pattern | failure-lesson | contrastive (§7)
    distillModel: <model-id>               # the model that ran distillation (quality is model-sensitive)
    evidenceTokens: 4200                   # est. tokens of the distiller input (deterministic ceil(chars/4))
    skillTokens: 350                       # est. tokens of the body — the compression ratio (SkillRL: 10–20×)
---
# <the verified how-to body>
```

The provenance lives in frontmatter so it **travels with the package** (install-portable) *and* is
anchored (the whole envelope is anchored — the claim "distilled from these N verified traces" is
independently verifiable, Legibility).

**Auditability fields (v0.5).** `distillModel`, `evidenceTokens`, `skillTokens` are additive optional
fields on `SkillProvenanceSchema` / `SkillPackageMetaSchema`. Distillation quality is model-sensitive
and was previously unrecorded; the token pair records the compression ratio the skill achieved
(SkillRL operates at 10–20×). The token counts are **deterministic estimates** (`ceil(utf8 chars / 4)`
over the serialized cluster input and the body) — the LLM port reports no usage, and an auditable
estimate serves the ratio's purpose better than an unreproducible exact count.

**Body skeleton (distilled skills, v0.5).** Distilled bodies use a **fixed anatomy** — `## When to
use` / `## Strategy` / `## Steps` / `## Pitfalls` / `## Verify`, each section non-empty — enforced
structurally at the distilled-publish gate (§7 step 6). Fixed structure keeps distiller output
consistent, makes future admission rubrics checkable section-by-section, and gives the consuming
agent predictable shape. Scoped to **distilled** output only: imported seeds are external skills and
stay freeform.

**Publish path.** A `publishSkill()` sibling to `publish()` anchors + wraps the skill. Two
corrections the reference builder forces (verified against `client/packages/harness-layer/src/publish.ts`
+ `client/src/captures/publish.ts`):

1. **Do not reuse `buildUnsignedCaptureEnvelope` unchanged.** It **hardcodes**
   `solverType: 'capture'` / `role: 'capture'` and exposes only executor overrides — so a skill
   published through it collapses to `capture/capture` and the D1 discriminator is lost. `publishSkill()`
   must parameterize `solverType` in the builder (or be a real sibling that sets it). **The
   discriminator is `solverType: 'distilled-skill'`, with `role` kept as `'capture'`** — `role` is a
   **closed enum** (`['solution','verdict','capture']`, `client/src/types/envelope.ts` `CanonicalRoleSchema`),
   so a `'knowledge'` role is not available without amending the execution-envelope schema + indexer
   projection (out of scope). `artifactType: 'jinn.skill.v1'` on the artifact is the primary
   consumable/trace discriminator; `solverType` is the secondary filter.
2. **Anchor under a distinct key `skill:<cid>`, not `capture:<cid>`.** The `capture:` key routes the
   payload into `captureEnvelopeMeta` enrichment, whose parser hard-requires a `jinn.trace-envelope.v0`
   artifact. **`skill:` is registered in the indexer** (`parseEnvelopeKey`, `packages/indexer/src/types.ts`)
   as a fourth envelope kind — indexed as an `Envelope` row so `corpus.query()`/`search()` surface it
   (discovery returns all kinds), and it triggers **no** enrichment (the enrichment gates are
   kind-specific). Verified by the plan's live check (types + 100 handler tests green).

**Discoverability (honest v1 mechanism).** There is **no `artifactType` column** on the indexer's
envelope table — `queryEnvelopes` builds its where-clause from `evidenceTier` + `manifestHash` only.
`artifactType` (like `solverType`) is filtered **client-side after fetching a page of manifests**
(see `consume.ts search()`). So for v1 the mechanism is an **O(page) manifest scan + client-side
filter**: a skill outside the fetched window is unfindable, and each search pays N manifest fetches.
This is acceptable for v1's small corpus. **Decision for §16:** accept the full-scan floor, or add
an indexed `artifactType` column (a real indexer change — *not* "no indexer change required").

**Ranking (future intent, not a v1 surface).** No read path sorts by `verifiabilityTier` or
`distilledFrom` (`searchCaptureMeta` returns scan order; `search()` returns first-N unordered;
`queryEnvelopes` orders by `publishedAtBlock`; `distilledFrom` has no ledger column). At the N=1
default every eligible skill also carries identical `(evaluator-verified, distilledFrom:N)`
metadata, so there is nothing to rank on yet. The metadata is present in the package for **future**
ranking; a discovery-time ranking surface is **not built in v1**.

## 6. Promotion gate (the corpus quality gate)

Evidence is **eligible to distil** iff `provenance == 'contributed'` (never `imported` — seeds are
already-distilled, not raw evidence), the source is **not in the held-out `cap-v0` slate** (§12), and
**redaction-health passes** (below) — at one of **two outcome tiers** (the failure→lessons axis, D10):

- **Pattern-eligible** (→ strategic patterns): `outcome.status == 'completed'` +
  `outcome.verifiabilityTier == 'evaluator-verified'` (`actualPassed === true`). The strongest tier;
  the anti-farming line swe-rebench supplies.
- **Lesson-eligible** (→ failure lessons): `outcome.status == 'failed'` +
  `outcome.verifiabilityTier == 'evaluator-verified'` with a **definitive `evaluatorVerdict === 'FAIL'`**
  (`actualPassed === false` — the evaluator ran and confirmed the failure). `INVALID` /
  `INDETERMINATE` / `UNKNOWN` verdicts are **noise, not lessons**, and are excluded. An
  evaluator-confirmed failure is as *verified* as a pass — the tier describes **how the outcome was
  established**, and a failed task still carries a tier (envelope-v0). Failures are abundant (§8) and
  compress 10–20× (SkillRL, §2.4), so this is the cheap half of the value that v0.2 dropped.

A pattern and a lesson for the *same* `instance_id` are **complementary, not corroborating**. In v0.5
they no longer distil into two separate skills: because both polarities exist for the instance, the
clusterer folds them into **one contrastive skill** (§7, ExpeL) whose pattern is the pass↔fail delta
and whose counterfactual is the verified pass — and that contrastive skill **suppresses** the
pattern-only / lesson-only singles for that instance (precedence). A single-polarity instance still
distils to its one pattern-only or lesson-only skill.

**N-corroboration** is a documented knob, **default `N = 1`** for v1 (a single verified trace can
seed a skill — operator direction). Two hygiene rules attach even at N=1, because the live supply is
instance-skewed (one instance, `sympy-27510`, is ~46 of ~390 verified verdicts, §8):

- **Distinct-instance clustering.** A cluster is keyed by *distinct* `instance_id`; multiple verdict
  rows for the same `instance_id` are **one** unit of corroboration, not N. This stops a skewed
  instance manufacturing false corroboration and stops the same problem being distilled repeatedly.
- The **raw-evidence arm** (§11, D9) is the backstop: a non-generalizing N=1 skill loses to serving
  the raw trace, so the gate catches it rather than the corroboration count.

**Redaction-health guard (the #1409 defence on input).** Evidence whose scrubbed fields are defaced
is **excluded from distillation input** — you cannot distil a clean skill from mangled evidence.
The guard has two corrected clauses (the v0.1 version was calibrated only to openredaction and
measured breadth not depth):

- **Depth, not breadth.** Measure **intra-value placeholder density** — placeholder characters ÷
  content characters *within each content-bearing value* — not the count of redacted keys. The #1409
  harm is one large value (a SKILL.md body or a patch diff) shredded into hundreds of placeholder
  tokens; that registers as *one* redacted key and sails through any key-count metric.
- **All placeholder shapes, driven off the receipt.** Detect the **union** of every stage's
  placeholder shape actually emitted by the layer-1 pipeline — `[SECRET:…]` (secretlint entropy
  fallback), `[PII:…]` (ml-pii), `[EMAIL]` / `/users/anon` (plain-patterns), and openredaction's
  `<TYPE>_<digits>` — and prefer to drive the guard off the **recorded redaction receipt**
  (`redactedKeys` / `truncatedKeys` name the affected keys) rather than regex-scanning output.

The guard is a filter with a logged reason (never silent), so excluded evidence is auditable and the
#1409 fix can be measured against it. Because bridged coding evidence is scrubbed at **layer-2
altitude** (§8), the guard should rarely fire on it — but §8 requires estimating guard survival on a
bridged sample before committing volume.

## 7. The distillation step

A human-run script (`yarn distill --distribution coding`), **not** a SolverNet (D4). Stages:

1. **Select** — pull eligible evidence (the §6 gate) for the target distribution from the corpus.
2. **Cluster** — group into sub-problems by *distinct* `instance_id` (§6), then by
   `distributionTags` overlap + `task.summary` similarity; **human-curated grouping is acceptable**
   for the first skills. Automated *evidence-level* clustering beyond this is out of scope (the
   opt-in stage-2 pass below groups *already-distilled* stage-1 skills by polarity — that is in
   scope; it does not auto-cluster raw evidence).
3. **Distil — both polarities (SkillRL decomposition, D10).** Run **`jinn-skill-distill-prompt-v1`**
   (a new prompt, distinct from the session-derived task prompt) over each cluster's evidence —
   `task.summary`, `outcome.summary`, step names **and step content** (patches/diffs + the solver's
   compressed step trace where available, §8), `verifiabilityTier` — producing a SKILL.md
   (frontmatter + body). The cluster input handed to the LLM **carries the evidence content**
   (patch / step-trace attributes), not step names only — a name-only projection under-feeds the
   distiller. The prompt has **three modes keyed to the cluster's tier (§6)**:
   - **Pattern-eligible clusters → a strategic-pattern skill:** the critical decision points and
     generalizable behavior that made the solve work (`metadata.jinn.skillKind: 'strategic-pattern'`).
   - **Lesson-eligible clusters → a failure-lesson skill** (`skillKind: 'failure-lesson'`; the
     `description` says *"Use when about to …"* so retrieval fires on the risky situation), under the
     **verified-counterfactual rule (v0.5):** the evidence verifies THAT the attempt failed — not
     what would have worked. Publishing an LLM-speculated "do this instead" under an
     evaluator-verified badge overstates the evidence. A lesson therefore states **diagnosis, not
     prescription** ("this approach fails because X"); suggestions must be hypothesis-marked
     ("likely", "consider"), never imperative. A counterfactual may be stated as fact ONLY when
     corroborated by a verified pass on the same instance — i.e. in contrastive mode (below).
     Enforcement is the prompt requirement plus a shallow lexical guard at the publish gate (step 6);
     deep semantic judging of lesson quality is admission-checking, deferred (§13).
   - **Both-polarity instances → ONE contrastive skill (v0.5, ExpeL).** When the same `instance_id`
     carries both an evaluator-verified pass and a definitive FAIL (retries are common — §8's supply
     is ~390 verdicts over ~92 instances), the delta between them is the most information-dense
     signal: it isolates the causal decision, while content shared by both polarities is noise. The
     clusterer pairs the polarities into a single `contrastive` cluster; the distiller runs a third
     mode fed both traces, producing one skill whose pattern is the delta and whose counterfactual is
     the **verified pass** — satisfying the verified-counterfactual rule by construction. Provenance
     links BOTH evidence refs. **Precedence: contrastive > pattern-only/lesson-only** for that
     instance — the singles are suppressed, not additionally emitted. `skillKind` gains
     `'contrastive'`; the enum extension is additive for producers, but strict consumers
     (`extractSkill`) reject the new value until upgraded — acceptable at testnet volume, named here.

   All modes emit the **fixed skill skeleton** (§5: `## When to use` / `## Strategy` / `## Steps` /
   `## Pitfalls` / `## Verify`, each non-empty) and a `description` carrying **both trigger and
   anti-trigger**: *"Use when … **Not for:** …"* (v0.5 — CTIM-Rover's failure mode is
   surface-similar retrieval firing in situationally-wrong cases; the anti-trigger names the
   nearby-but-safe situation the skill must NOT fire on. For failure-lessons the trigger targets the
   risky situation, the anti-trigger the safe lookalike). Both are enforced structurally at step 6.

   Single-shot and flat for v1 (no recursion, no General/Task-Specific hierarchy — that is v3). The
   prompt's **SHA-256 is published** in `metadata.jinn.distillPromptSha256` (auditability, mirrors
   `SESSION_DERIVED_DISTILL_PROMPT_V1_SHA256`); it is a foundation reference, not protocol canon — a
   later network-task version may substitute it, publishing its own hash. `skillKind` is an **additive
   optional field** on `SkillProvenanceSchema` (`skill.ts`) — the built format is extended, not
   changed.
4. **Secret scrub of the OUTPUT (full net, not a re-scrub).** Treat the distilled body as a **fresh
   secret surface**: the distill LLM reads patches/diffs/step names and can lift, reformat, or split
   a layer-1-slipped cleartext secret into install-portable prose. Run the **full secretlint stage
   (including its Pass-2 entropy secret-shape fallback)** over every distilled body — the same
   secret net layer-1 runs — and **forbid distilling verbatim high-entropy tokens** (drop-if-not-
   explained; a skill has no legitimate need to carry raw key material). This is the secret-only
   altitude (§10), so it never mangles prose.
5. **Contamination lexical scan (publish-time gate).** Run the capability-eval lexical gold-patch-
   token scan over every distilled body (not just its provenance repo-match), rejecting any skill
   whose prose contains a slate task's distinctive tokens (changed file paths, symbol names,
   `instance_id`, PR number). **Freeze order:** distillation output must be produced/frozen *before*
   the slate draw, or re-scanned whenever a skill is authored after freeze; the remedy is **drop the
   skill** (the slate is pinned and cannot be re-cut). This is the third disjointness axis (§12).
6. **Structural conformance gate (v0.5, publish-time).** Reject any distilled skill that does not
   carry the fixed skeleton (all five `## ` sections present and non-empty) or whose `description`
   lacks the `Not for:` anti-trigger clause. For lesson-mode skills, also reject bodies bearing an
   **imperative counterfactual** ("… instead, do/use/run X"; "the correct fix is …") — the shallow
   lexical realisation of the verified-counterfactual rule. These are **deterministic** checks (like
   the contamination scan), not an LLM judge: judging whether a *well-formed* skill is actually
   *good* is admission-checking, deferred (§13). A rejected skill costs one re-distill (check-mode,
   §10) — it is never published defaced.
7. **Publish** — `publishSkill()` (§5): artifact + signed wrapper + `skill:<cid>` anchor; write the
   `metadata.jinn.provenance` back-links to the source evidence refs.

Output of v1: a small set of coding skills, each provenance-linked to evaluator-verified evidence,
anchored, installable — and each of which must *earn its place* against raw-evidence retrieval
(§11, D9).

**Stage-2 — cross-instance meta-distill (in scope, additive/opt-in; issue #1463).** After the
single-pass distillation above, an opt-in second pass groups the stage-1 skills this run just
published **by polarity** (their `skillKind`) and asks a distinct prompt
(`jinn-skill-meta-distill-prompt-v1`, its own published SHA) for the recurring rule corroborated
across **≥2 distinct instances**. It emits a `skillKind: 'cross-instance'` skill whose provenance is
the **union** of the supporting sources' layer-1 evidence CIDs (so `distilledFrom > 1`), and reuses
the same output-scrub → contamination-scan → structural-gate → publish path unchanged. It reads only
stage-1's in-memory results — no corpus round-trip — and never groups a `cross-instance` skill (no
recursion). Disabled by default (`yarn distill … --meta` / pipeline `meta: true`).

## 8. The bridge — execution ledger → layer-1 evidence

A script (`yarn bridge-execution-ledger --distribution coding`) that turns verified swe-rebench
attempts into layer-1 evidence via the existing `capture()`→publish path (D5). Mechanics are pinned
to the actual ledger shape:

- **Source of truth is `verdictEnvelopeMeta`, both polarities (D10).** Read `actualPassed` +
  `evaluatorVerdict` — **not** the on-chain `verdict.verdictCode`, which defaults to `Pass(1)` for
  failed evaluations (a known indexer bug). Source **two** streams:
  - **Passes → patterns:** `actualPassed === true` (and `evaluatorVerdict === 'PASS'`).
  - **Failures → lessons:** `actualPassed === false` **and `evaluatorVerdict === 'FAIL'`** (a
    definitive evaluator failure). Exclude `INVALID` / `INDETERMINATE` / `UNKNOWN` — noise, not
    lessons (§6).

  Common filter: `solverType startsWith 'swe-rebench-v2'`, `enrichmentStatus === 'ok'`,
  `instanceId !== ''`.
- **Input supply is real, skewed, and larger once failures count (verified 2026-07-06).** ~**390
  verified passing** swe-rebench-v2 verdicts across ~**92 distinct instances** exist on the prod
  indexer today — and evaluator-confirmed **failures are more numerous** (most attempts on a
  contested-band instance fail), so the lesson stream materially expands supply and coverage beyond
  the 92-instance pass pool. The pass pool is instance-skewed (`sympy-27510` ≈ 46/390), so the gate
  keys corroboration on *distinct* instances (§6) and the bridge **dedups per `(instance_id, polarity)`**.
- **Exclude the held-out `cap-v0` slate** (§12) by **`instance_id` AND repo** via the capability-eval
  session's `excludeHeldOutSlate` — the contamination boundary, enforced *inside the bridge*. Repo
  exclusion matters because a different instance from a slate repo still leaks that repo's solution
  patterns; the distilled-body lexical scan (§7 step 5) is the third axis.
- For each qualifying attempt: read `attemptEnvelopeMeta` (`manifestCid`, `model`, `codeDigest`,
  `implName`) → acquire the attempt's solution artifact (the patch) + the task descriptor via the
  corpus → construct a `CapturedTask`:
  - `outcome.verifiabilityTier: 'evaluator-verified'`; `outcome.status: 'completed'` for a pass,
    `'failed'` for a lesson-eligible failure (§6),
  - `environment.model` from `attemptEnvelopeMeta.model`,
  - `environment.harness.name: 'jinn-execution-ledger-bridge'` (segmentation key; see below),
  - `task.summary` from the instance problem statement,
  - `task.distributionTags: ['coding', 'swe-rebench', <language>]`,
  - `steps`: a patch step and a verdict step — plus, **where the solution envelope carries the
    solver's own trajectory ref** (`trajectory.sources[].cid`, or an artifact's
    `metadata.producedBy.trajectoryCid`), a **solver-trajectory step** holding a compressed step
    trace (span names + `jinn.span.kind`, capped). A patch shows *what* changed, not the decision
    path; pattern-mode under-feeds without it. The trajectory content is placed in a step attribute
    and therefore passes through **the same layer-2 scrub** `capture()` applies to every attribute
    (§10) — it does **not** bypass the scrub.
- **Evidence-richness stratification (`patch-only` tag, v0.5).** When the solver trajectory is
  **unavailable** (older envelopes, or the ref does not resolve), the bridged layer-1 envelope's
  freeform `distributionTags` gains **`'patch-only'`**, so the three-arm measurement (§11) can
  stratify distillation quality by evidence richness (patch-only vs trajectory-enriched). This rides
  the freeform tag array — **no frozen-envelope change** (§2.1); the tag count stays well under the
  16-tag cap. Bridged evidence remains coarser than a native trace and this is stated honestly; the
  trajectory enrichment narrows, not closes, the gap.
- **Scrub at layer-2 altitude (D6), not trace-grade.** A verified swe-rebench solve is public-repo
  work, not raw private-machine activity, and its problem statements + patch identifiers are
  token-dense technical prose that #1409's trace-grade pipeline defaces — which the §6 guard would
  then exclude, i.e. the guard would fight defacement the bridge itself introduced. Bridging at the
  secret-only altitude sidesteps that self-conflict and preserves supply. Before committing volume,
  **estimate §6 guard-survival on a bridged sample** — supply collapse toward the N=1 floor on the
  sole v1 distribution is a named risk (§15).
- **No frozen-envelope change; emissions handling stated.** Bridged records set
  `provenance: 'contributed'` (real solver work; the closed enum has no third value and this spec
  does not amend it), distinguished from organic harness-user demand by `environment.harness.name`.
  **Emissions caveat:** the frozen `ContributionActivityChecker` anti-farming line is
  `provenance !== 'imported'` **only** — `environment.harness.name` is *not* in its contract. So a
  swe-rebench solve rewarded once on-chain, then bridged as `contributed` evidence, could be counted
  **again** as an emissions-eligible contribution (double-count). v1 declares bridged evidence
  **emissions-ineligible** and names `environment.harness.name` as the field a future checker must
  filter on (adding it to the checker contract — reconcile in a later amendment). The
  `ContributionActivityChecker` reconciliation is deferred to a later amendment, not in the v1 build order (§14), so this is not a v1
  blocker — but the positive claim is corrected here rather than left wrong.

## 9. Consumption (option C — adopt the format, keep the substrate)

Per **DR-2026-07-06**: adopt the `skills` **format** fully (D2), keep v1 discovery + acquisition
**corpus-native** (D7), and name a source resolver as the path to full CLI adoption.

- **v1 product path:** distilled skills are conformant, installable `skills` packages. The harness
  consumes them via the existing corpus MCP tools — **find** ≈ `corpus_search` / `search()`
  (client-side `artifactType: 'jinn.skill.v1'` filter over a manifest page, §5), **acquire** ≈
  `acquire_artifact` / `get()` → the SKILL.md bytes. Requires **no new command**.
- **v1 measurement path is distinct (pre-installed), and it is NOT the product loop.** Per the
  capability-eval v0 methodology (`spec/2026-07-06-capability-eval-v0.md`, PR
  [#1416](https://github.com/Jinn-Network/mono/pull/1416)), the measured arms have content
  **pre-installed** into a content-addressed corpus snapshot — **not** live `corpus_search`. This
  keeps the A/B controlled. **The v1 gate therefore measures skills-in-context, not the live-
  retrieval product**: whether the harness *retrieves the right skill at solve time* (recall@k) is a
  **separate, later gate** (inherits cap-v0 decision B, live-retrieval out of scope for v0; §16). Do
  not read §11's "this IS the roadmap §8 gate" as validating the product retrieval loop.
- **Forward path (named, out of v1 scope):** a Jinn **source resolver** for the `skills` CLI —
  `npx skills add jinn:<corpus-ref>` — that installs directly from the anchored corpus with anchor
  verification. This is the true "adopt the client, keep the substrate" move. **Open verification:**
  whether the `skills` CLI supports a custom/pluggable source (public docs show GitHub / git / URL /
  local only); confirm against the CLI source before building.

Why not adopt the CLI wholesale for v1: `npx skills add` resolves from GitHub/git/URL/local, so
adopting it would move distribution to GitHub and make the agent install by trusting a repo —
forfeiting on-chain verifiability *at the moment of consumption* (against Legibility), reintroducing
a GitHub-org gatekeeper (against Neutral / Permissionless / Governance-Minimal), and coupling the
paired A/B measurement to an external tool's telemetry-ranked discovery. See DR-2026-07-06.

## 10. Scrub altitudes (#1409 resolution)

Two altitudes, because the inputs differ in kind:

- **Layer-1 (raw private traces):** the existing **trace-grade fail-closed** pipeline (key-policy →
  openredaction → plain-patterns → secretlint → ml-pii). Aggressive is correct — the input is a
  user's private machine activity. Unchanged.
- **Layer-2 / public / derived (seeds, distilled output, bridged public-repo evidence):** a
  **secret-only** pass, enumerated by stage to remove the v0.1 ambiguity:
  - **`key-policy`** — the key-classification stage;
  - **the FULL `secretlint` stage, including its Pass-2 entropy secret-shape fallback**
    (`isSecretShapedToken`, `secretlint-stage.ts`) — this is the net for rule-less / unprefixed
    high-entropy secrets and **must not be dropped**;
  - **dropped:** `openredaction` (its PII shape-matching and trigger-word false-positives are what
    mangle prose in #1409) and `ml-pii`.

  The word "entropy" in "drop the entropy stage" refers to **openredaction's PII shape-matching**,
  **never** secretlint's Pass-2 secret-shape fallback. Stripping Pass-2 would leak every rule-less
  secret into a publicly-installable SKILL.md — explicitly forbidden.

This is the fix for #1409. Consequences:

1. **Seeds migrate to the layer-2 path.** Public, licence-checked SKILL.md is already-distilled
   layer-2 content; it is published as `jinn.skill.v1` with the layer-2 pass, not through
   `capture()`'s trace-grade scrub. Re-importing the 84 seeds this way is the **natural first
   population of the layer-2 store** and the root-cause fix for #1409 (it removes trace-grade scrub
   from the seed path). The seed importer's licence gate and attribution (`license` frontmatter)
   carry over.
   - **Residue, stated honestly.** Anchored capture/envelope records are **append-only and per-CID**;
     there is **no supersede / revoke / tombstone** mechanism for them (only `pluginPublication` has
     a `revoked` flag). Re-import mints **new** clean records; the previously-anchored defaced seed
     records **persist** and remain returned by a content-searching consumer's full-scan. The #1409
     fix is therefore **go-forward only**. Retroactive removal needs a read-path exclusion or
     tombstone mechanism that does not exist today — a decision for §16, not an implicit claim.
2. **Bridged public-repo evidence uses the layer-2 pass** (§8, D5).
3. **Distilled output uses the full-secret-net layer-2 pass** (§7 step 4) — it is a fresh secret
   surface, not a safe re-scrub of already-clean input.

## 11. Measurability — three arms, and the Bitter-Lesson test

The comparison is a **sibling of the capability-eval v0 gate** (`spec/2026-07-06-capability-eval-v0.md`,
PR [#1416](https://github.com/Jinn-Network/mono/pull/1416)), which proves *corpus (seeds) beats
stock*. **Reuse, don't rebuild** the machinery that session owns: `client/src/eval/paired.ts` (exact
McNemar), `wilson.ts`, the frozen content-addressed slate + `excludeHeldOutSlate` + `assertNoOverlap`,
the screen generator, the swe-rebench-v2 grader.

**Three arms**, all pre-installed into content-addressed corpus snapshots (§9 — pre-install, not
live search), all held-out-excluded identically:

- **Control:** harness + **seeds only**.
- **Distilled:** harness + seeds + **distilled skills** (from contributed/bridged evidence).
- **Raw-evidence (D9):** harness + seeds + the **same verified evidence served verbatim**
  (un-distilled patch + verdict), mirroring the distilled arm's cluster coverage one-for-one so the
  contrast isolates the *distillation step*, not the underlying evidence.

**Evidence-richness stratification (v0.5).** The bridge tags `patch-only` evidence (no solver
trajectory, §8); where the pilot's discordant-pair count allows, report the distilled−raw contrast
**stratified** by patch-only vs trajectory-enriched, so a null is attributable to thin evidence
rather than a failed distillation step. This is a reporting cut, not a separate gate — at v1 volume
it is descriptive (the pilot is unlikely to power a stratified test).

**Model:** pinned **Haiku-class** (matches v0), with a **Sonnet-class replication that is
load-bearing, not optional** — DR-2026-06-02-b and #986 produced Haiku-class nulls on exactly this
pre-installed-lessons modality, so a Haiku null here is uninformative.

**Gate (two results, one of them the Bitter-Lesson test):**

1. **Capability vs seeds (the ship claim).** The distilled arm's **primary** sub-claim is **strict
   resolve-rate superiority over seeds** (the capability win §1 defines), with **cost as a
   non-inferiority guard** — an intersection-union test at α=0.05. This **inverts** cap-v0's
   quality/cost roles (cap-v0's operative branch rewards cost reduction, which would pass a
   zero-capability cost-cutter and fail a genuine hard-task rescue). Because it is a *different* IUT
   with different nulls, power, and MDE, it is **not** "the same gate shape" as cap-v0 — this must be
   **confirmed with the eval session**, not asserted.
2. **Distilled vs raw-evidence (D9/D11, the Bitter-Lesson test).** Report `distilled − raw-evidence`
   as a **first-class result**. If raw-evidence retrieval matches or beats distilled prose, the
   distillation step (§7) has **not earned its place** — but this is **not a dead end** (D11):
   retrieval-over-anchored-evidence *is the v1 product we ship*, the `jinn.skill.v1` format (§5)
   persists (seeds use it; a future/better distiller uses it), and only the **distiller (§7)** is
   what's on trial. The external evidence (§2.4) says single-shot success-only distillation loses
   this; v0.3 bets the **success-patterns + failure-lessons** distiller beats it. The design must be
   able to *return either verdict*.

### 11.1 The fork, explicit (proposed resolution — for human review, Phase 1 gate)

The redirect surfaces one real fork: **build a distiller, or just ship retrieval over the anchored
evidence?** Proposed resolution (the thing this spec commits to, pending review):

- **Ship retrieval-over-anchored-evidence as the v1 product baseline.** It is near-free once the
  bridge (§8) exists — the raw-evidence arm *is* this product. It is the floor everything else must
  clear.
- **Build the SkillRL-shaped distiller** — success→patterns + failure→lessons (D10), single-shot,
  flat — as the **treatment that must beat that baseline** (D9). This is the bet worth testing
  because §2.4's positive prior says *this* structure (both polarities) is what wins.
- **Do NOT build the single-shot, success-only paraphrase.** The literature (§2.4) already nulled
  that exact cell; building it would be spending the pilot to re-confirm a known negative.
- **Recursion + hierarchy stay v3** (network-task) — the expensive half of SkillRL, out of scope here.

This keeps the falsification honest (D9) *and* guarantees v1 ships a usable product (the baseline)
regardless of the distiller verdict.

**Power / pilot (mandatory).** The `cap-v0` slate is power-sized for the first-order seeds-vs-stock
effect. Distilled-vs-seeds is **second-order and plausibly smaller**, so **slate reuse does not
transfer the power calc**: a distilled-arm-specific **pilot** (its own `p_b`/`p_c` discordance
estimate and MDE, inheriting DR-2026-06-02-b's power table, MDE + N/R pre-registered) is required
before any run is treated as a gate. **The first run is a pilot, not ship/no-ship**; an observed
effect below a budget-feasible MDE is a *valid decisive outcome* (per cap-v0 §6.4), not pipeline
failure.

This realises the roadmap §8 v1 capability gate, narrowed to distillation — but with distillation
required to beat *both* seeds and the raw evidence it compresses. If neither number materialises,
the loop is not closing and the pipeline is decoration — stop and rethink before scaling.

## 12. Shared interface — the held-out boundary (owned by capability-eval)

The held-out boundary is **owned and published by the capability-eval session** (PR
[#1416](https://github.com/Jinn-Network/mono/pull/1416), `spec/2026-07-06-capability-eval-v0.md`
§12). This spec **consumes** it — it does not define its own fixture.

- **Artifact:** the **`cap-v0` slate** — `instance_id`s + repos + hash + `corpusSnapshotCid`. It does
  **not exist yet** (built by the capability-eval rig `feat`); what is handed now is the *contract*.
- **This side's obligations — three disjointness axes:**
  1. **`instance_id` exclusion** — the bridge drops slate instances (`excludeHeldOutSlate`).
  2. **repo exclusion** — the bridge drops evidence from any slate repo (cross-repo pattern leakage).
  3. **lexical scan over distilled bodies** — the §7 step-5 publish-time gate rejects any distilled
     skill whose prose contains a slate task's distinctive tokens. This axis is *this side's* job:
     the eval side's `assertNoOverlap` checks the slate-vs-corpus overlap on the `instance_id` axis,
     it does **not** scan distilled prose.
- **Confirm back** to the capability-eval session that **no distilled skill's provenance traces to a
  slate repo** (`metadata.jinn.provenance` refs must not resolve to any `cap-v0` repo).
- Neither side may distil from the slate or leak it into a skill. The slate is a frozen interface for
  a measurement run; changing it invalidates prior comparisons.

## 13. Scope / non-goals

**In scope (v1):** single distribution (coding); **retrieval-over-anchored-evidence as the shipped
product baseline** (D11); the scripted distillation pipeline producing **success→patterns +
failure→lessons + both-polarity→contrastive** (D10 + v0.5) via `jinn-skill-distill-prompt-v1` +
published hash, under the verified-counterfactual rule and the fixed-skeleton / anti-trigger
structural gate (§7); the execution-ledger bridge for swe-rebench sourcing **both passes and
evaluator-confirmed failures** (layer-2 scrub), enriched with the solver trajectory where available
and `patch-only`-tagged where not; the `jinn.skill.v1` conformant-package format (+ additive optional
`skillKind` / `distillModel` / `evidenceTokens` / `skillTokens`) + provenance metadata + corrected
publish/anchor path; the two-altitude scrub (§10) and the seed migration that fixes #1409 go-forward;
the **three-arm** measurement (the raw-evidence arm is both the product baseline and the D9
guardrail) + the pilot + the held-out interface.

**Out of scope:**

- **The single-shot, success-only, flat paraphrase distiller** — the exact cell the literature
  already nulls (§2.4). v1 builds the both-polarities distiller instead; it does not spend the pilot
  re-confirming a known negative.
- **Recursion + hierarchy** (skills co-evolving with an RL policy; General/Task-Specific SkillBank —
  the expensive half of SkillRL, §2.4). v1 is single-shot + flat.
- **Distillation as a network task** (bonded distillers, evaluator-verified distillation output) —
  this is v3 and is where DR-2026-05-07's session-derived machinery re-enters.
- **Classification / routing** of evidence into multiple distributions (DR-2026-05-07 β/γ).
- **Multiple distributions** beyond coding.
- **Automated *evidence-level* clustering** beyond distinct-instance + tags + summary similarity (§7.2).
  Stage-2's polarity-grouping of *already-distilled* stage-1 skills is in scope (§7 Stage-2 note); auto-
  clustering *raw evidence* beyond the §7.2 grouping is not.
- **The `skills` source resolver / `/jinn skills install` command** — contract defined (§9), build
  deferred.
- **A discovery-time ranking surface** and an **indexed `artifactType` column** — v1 accepts the
  full-scan floor (§5, §16).
- **Live-retrieval efficacy (recall@k)** — a separate later gate (§9, §16).
- **Retroactive removal of #1409-defaced anchored records** — no mechanism exists (§10, §16).
- **Multi-file skill packages** (`references/`, tarball) — single-file SKILL.md for v1.
- **Admission-quality checking** (Voyager-style validate-before-admit; an LLM-judge rubric scoring a
  distilled skill before it is admitted to the corpus) — **deferred to v3**. Admission-checking a
  skill *is* evaluation work; when distillation becomes a network task (v3), skill admission becomes
  an evaluator-verified job on the SolverNet, so a local judge built now would be replaced by the
  network mechanism. v1's gate is **structural only** (§7 step 6: skeleton, anti-trigger, imperative-
  counterfactual — deterministic, not judged). The interim risk (well-formed but low-value "junk"
  skills passing the structural gate) is **accepted**: the three-arm gate (§11) catches net-negative
  distillation in aggregate, and v1 volume is tiny.
- **Skill dedup / merge** (library hygiene — collapsing near-duplicate skills, merging a lesson into
  its contrastive sibling) — deferred, pre-v3.
- **Any change to the frozen layer-1 envelope** (§2.1) or the `ContributionActivityChecker` contract
  (§8 — a later concern).

## 14. What v1 ships (minimal build order)

1. `jinn.skill.v1` format + `publishSkill()` with **parameterized `role`/`solverType` and the
   `skill:<cid>` anchor key** (§5), and the layer-2 secret-only scrub stage (§10).
2. The execution-ledger bridge (§8), scrubbing at layer-2 altitude, sourcing **both verified passes
   and evaluator-confirmed failures** (D10), dedup-per-`(instance_id, polarity)`, consuming the
   `cap-v0` slate exclusion (§12). *(This also produces the raw-evidence corpus = the shipped v1
   product baseline, D11.)*
3. The promotion gate + the corrected redaction-health guard, with **tiered eligibility**
   (pattern-eligible passes + lesson-eligible definitive-FAIL) (§6).
4. `jinn-skill-distill-prompt-v1` (**three modes**: success→patterns, failure→lessons under the
   verified-counterfactual rule, and both-polarity→contrastive; D10 + v0.5) + the additive optional
   `skillKind` (`strategic-pattern` | `failure-lesson` | `contrastive`), `distillModel`,
   `evidenceTokens`, `skillTokens` fields + the `yarn distill` script, incl. the **full-secret-net
   output scrub**, the **publish-time lexical contamination scan**, and the **structural conformance
   gate** (fixed skeleton + anti-trigger + imperative-counterfactual guard) (§7). Distillation pins
   the strongest available model (opus-class) by default (`JINN_DISTILL_MODEL`-overridable).
5. Seed re-import onto the layer-2 path (fixes #1409 go-forward) (§10). *(Built — Plan A.)*
6. The **three-arm** measurement wiring: pre-installed control / distilled / raw-evidence snapshots +
   the `cap-v0` slate run, **reusing** the capability-eval rig (`paired.ts`/`wilson.ts`/slate/grader;
   PR #1416); the distilled-arm **pilot power calc**, the raw-evidence arm (= the product baseline),
   and the confirm-back check (§12) are the new pieces (§11).

Build order note (Phase-2 sequencing): item 2 (bridge) unblocks the raw-evidence baseline *and* the
distiller's input; the distiller (4) is the bet that must beat the baseline. Each item lands as an
Issue (mostly `feat`, one `fix` for #1409) with a TDD plan under `docs/superpowers/plans/` at pick-up.

## 15. Risks

| Risk | Mitigation |
|---|---|
| **Encoded cleverness (against Learning Maximised)** | The distill step is a hand-authored compression of *discovered* evidence — encoded cleverness. It must empirically beat serving the raw verified evidence (§11 raw-evidence arm, D9) or **it does not ship**; the claim is falsifiable, not asserted |
| **Distillation adds nothing over raw evidence** (the literature's prior) | The raw-evidence arm makes this the explicit second result; a null/negative is an expected pilot outcome (§2.4, §11), and the fallback (retrieval-over-evidence) **ships as the product baseline** (D11). The both-polarities bet (D10) is *why* v0.3 expects to beat the success-only null — but the measurement, not the bet, decides |
| **Failure-lessons mislead (negative transfer)** — CTIM-Rover's exact finding: surface-similar memories misguide on new problems | The D9/D11 measurement is the arbiter: if lessons hurt net, distilled loses to raw-evidence and does not ship. Mitigations: the lesson `description` is situation-specific ("Use when about to …") so retrieval fires narrowly; lessons and patterns are separate skills (a bad lesson doesn't poison a good pattern); `skillKind` lets the measurement ablate lessons-vs-patterns if the aggregate is a null |
| **Measurement underpowered** (the DR-2026-06-02-b pathology) | Distilled-vs-seeds is second-order — a distilled-arm-specific pilot power calc is mandatory before gating; first run is a pilot; Sonnet-class replication is load-bearing (§11) |
| **Supply collapse on the sole distribution** | Bridge at layer-2 altitude so the §6 guard does not exclude bridged evidence it defaced (§8); estimate guard-survival on a sample first; ~390 verified verdicts / 92 instances exist today (§8) |
| Distilling from defaced evidence (garbage in) | Corrected redaction-health guard on input (depth + all placeholder shapes, §6); full-secret-net scrub on output (§7, §10) |
| **Contamination via distilled prose** (skill from a non-slate repo encodes a slate task's gold-patch shape) | The publish-time lexical scan over distilled bodies is the third disjointness axis (§7 step 5, §12); instance_id + repo exclusion alone is insufficient because skills generalize across repos |
| Secret leak through the weaker layer-2 pass | Layer-2 keeps the FULL secretlint stage incl. Pass-2 entropy fallback; distilled output gets the full net + drop-if-unexplained high-entropy tokens (§7, §10) |
| #1409-defaced records persist after re-import | Fix is go-forward; retroactive removal is a named open question needing a mechanism that does not exist (§10, §16) |
| Emissions double-count of bridged solves | Bridged evidence declared emissions-ineligible; `harness.name` named as the future checker filter (§8); checker reconciliation deferred to a later amendment, not v1 |
| Bridged evidence too coarse to distil well | Honest limitation (§8); if `(task, patch, verdict)` under-distils, the fix is richer attempt envelopes upstream, not a bridge hack |
| Forward-path resolver / 18+ agent reach may not be feasible | Contingent on an unverified `skills` CLI extension point (§9, §16, DR); v1 does not depend on it — corpus-native consumption stands alone |

## 16. Open questions / verifications outstanding

- **`cap-v0` slate** — owned by capability-eval (PR #1416); not built yet. This side consumes the
  contract (exclude by instance_id + repo; lexical-scan distilled bodies; confirm-back). Blocks the
  measurement run, not the bridge/distiller build (§12).
- **Gate estimand confirmation** — the distilled arm inverts cap-v0's IUT to resolve-superiority-
  primary (§11); confirm with the eval session that this distinct IUT (not "same gate shape") is
  acceptable and pre-register its MDE.
- **Discoverability floor** — accept the O(page) manifest-scan + client-side `artifactType` filter
  for v1's small corpus, or add an indexed `artifactType` column (a real indexer change) (§5).
- **Live-retrieval efficacy (recall@k)** — the v1 gate measures skills-in-context (pre-installed),
  not the product retrieval loop; retrieval efficacy is a separate later gate (§9).
- **#1409 residue** — go-forward fix only; retroactive removal of anchored defaced records needs a
  read-path exclusion / tombstone mechanism that does not exist (§10).
- **Bridged-evidence emissions eligibility** — declared ineligible for v1; adding `harness.name` to
  the `ContributionActivityChecker` contract is deferred to a later amendment (§8).
- **`skills` CLI custom-source support** — gates the forward-path resolver only (§9); verify against
  the CLI source before building.
- **Supersede-lineage operator trust (#1462)** — head-resolution's same-operator check keys off the
  on-chain-derived `operator.agentId` the DiscoveryAPI supplies on each hit (IdentityRegistry event →
  indexer `row.agentId`, carried through `corpus.fetchManifest` untouched), NOT the forgeable envelope
  `participant.safeAddress`. A record can only be indexed under its publisher's real `agentId`, so a
  forged `participant.safeAddress` cannot retire a victim's skill (the successor is attributed to the
  attacker's own operator, so the same-operator check does not fire). Residual (narrower): the check is
  fail-safe when `agentId` is absent (a backend that does not attribute the hit collapses nothing rather
  than mis-collapsing), and the supersede intent is not yet signature-verified end-to-end — but
  same-operator is now enforced on a non-forgeable identity, closing the grief vector.
- **skill envelope discriminator** — `role: 'capture'` (closed enum) + `solverType: 'distilled-skill'`
  + `artifactType: 'jinn.skill.v1'` (§5). RESOLVED: `skill:<cid>` is registered in the indexer's
  `parseEnvelopeKey` so skills are indexed and discoverable with no enrichment (live-checked). A full
  on-chain publish→anchor→index→`corpus get` round-trip against a live testnet indexer remains the
  final integration proof (Plan A5), but the indexing path is code-verified.
