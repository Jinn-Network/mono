---
id: DR-2026-07-06
title: Layer-2 consumables are first-class, conformant Agent-Skill packages; seeds and distilled skills share the layer-2 store on a secret-only scrub altitude
date: 2026-07-06
verb: Steer
status: ratified
authors: opus (drafted, design session); Ritsu (design direction)
spec: spec/2026-07-06-distillation-v1.md
relates-to: >
  spec/2026-07-02-jinn-harness-network.md §5 (two-layer model) / §7 (seeding);
  docs/envelope-v0.md (frozen layer-1 envelope — untouched by this DR);
  DR-2026-05-07-d (session-derived distillation → re-solvable Tasks — the v3 network-task surface, distinct output);
  issue #1409 (seed SKILL.md defaced by trace-grade scrub — resolved by the scrub-altitude split here)
---

## Context

`spec/2026-07-02-jinn-harness-network.md` §5 names a two-layer knowledge model — layer-1 evidence
(the frozen `jinn.trace-envelope.v0`) and layer-2 consumables ("distilled skills/workflows in a
SKILL.md-compatible format") — but does not design the layer-2 shape, how it is scrubbed, or how it
is consumed. Three facts force a decision now, at the top of the distillation-v1 design:

1. **Seeds currently ride the layer-1 pipe.** Each imported skills.sh SKILL.md is wrapped as
   `steps[0].attributes['skill.md']` inside a layer-1 trace envelope
   (`client/packages/harness-layer/src/seed-import/execute.ts`). A consuming agent cannot tell a
   consumable from a raw trace, and provenance is an unstructured blob.
2. **#1409 — seeds come back defaced.** Public, licence-checked SKILL.md prose is run through
   **trace-grade secret scrub** (openredaction / entropy / trigger-word stages tuned for raw private
   traces); ordinary words become placeholder tokens (`"use"` → `[AIRPORT_2765]`). The issue leaves
   two directions open: fix the over-redaction, or stop running public seeds through trace-grade
   scrub at all.
3. **A real convention exists.** skills.sh / Vercel `skills` defines a skill as a first-class,
   installable package (a folder with `SKILL.md`, `name`/`description` required, optional
   `license` / `metadata` / supporting dirs), discovered via `npx skills find` and installed via
   `npx skills add`, working across 18+ agents. The `skills` CLI resolves sources from
   GitHub / git / URL / local — not from a content-addressed, on-chain-anchored store.

The question: what is the layer-2 shape, how is it scrubbed, and do we **adopt** the `skills`
ecosystem (publish to GitHub, consume via the CLI) or keep consumption on Jinn's anchored corpus?

## Decision

**Adopt the `skills` format fully; keep consumption on the anchored corpus for v1; name a source
resolver as the path to full CLI adoption ("option C").** Concretely:

1. **First-class layer-2 artifact.** A distilled (or seeded) consumable is a corpus artifact with
   `artifactType: 'jinn.skill.v1'`, riding the same `SignedEnvelope` wrapper + ERC-8004 anchor as
   all other corpus content (one corpus, one publish path, no new chain surface). The frozen
   layer-1 envelope is **not** amended.
2. **Conformant, not "compatible-ish."** The `jinn.skill.v1` payload is a valid `skills` package
   verbatim — `<name>/SKILL.md`, `name` lowercase-hyphen and equal to the directory, `name` +
   `description` frontmatter required. Jinn provenance (source evidence refs, verifiability tier,
   corroboration count, distill-prompt hash) lives in the standard optional `metadata:` frontmatter
   block, so it travels with the package and is anchored.
3. **Two scrub altitudes, enumerated by stage.** Layer-1 keeps trace-grade fail-closed scrub for
   raw private traces. The layer-2 / public / derived pass is **`key-policy` + the FULL `secretlint`
   stage including its Pass-2 entropy secret-shape fallback (`isSecretShapedToken`)**, and **drops
   `openredaction` and `ml-pii`**. "Drop the entropy stage" refers to **openredaction's PII
   shape-matching**, *never* secretlint's Pass-2 secret-shape fallback — stripping Pass-2 would leak
   rule-less secrets into a publicly-installable SKILL.md. Fail-closed on a genuine secret; never
   substitute placeholder tokens for non-secret words.
4. **Seeds, distilled output, and bridged public-repo evidence share the layer-2 altitude.** Public
   seeds are already-distilled content; distilled output is a fresh secret surface (gets the full
   secret net); a verified swe-rebench solve is public-repo work, not raw private-machine activity.
   All three are scrubbed at the layer-2 altitude, not through `capture()`'s trace-grade scrub. This
   is the root-cause fix for #1409 (it removes trace-grade scrub from the public paths) and the first
   population of the layer-2 store. Bridging at layer-2 also stops the redaction-health guard fighting
   defacement the bridge itself would otherwise introduce (spec §8).
5. **Consumption is corpus-native for v1.** Discovery ≈ `corpus_search`/`search()` filtered to
   `jinn.skill.v1`; acquisition ≈ `acquire_artifact`/`get()`. No new command. The **forward path**
   (out of v1 scope) is a Jinn source resolver for the `skills` CLI — `npx skills add jinn:<ref>` —
   installing from the anchored corpus with anchor verification.

## Rationale

- **The convention is a standard at the format layer.** Emitting conformant packages makes Jinn
  output drop-in installable by the `skills` ecosystem **contingent on a resolver that may not exist
  yet** — `skills add` resolves GitHub / git / URL / local only, and a custom/anchored source is an
  unverified extension point (spec §9, §16). Adopting the format now makes that path cheap *if* it
  proves feasible; the Permissionless/composability win is real but conditional, not asserted.
- **Legibility is preserved exactly where it matters — at consumption.** `npx skills add` resolves
  from GitHub, so adopting the CLI wholesale would move distribution to GitHub and make the agent
  install by *trusting a repo*, forfeiting on-chain verifiability at the moment of consumption.
  Corpus-native consumption keeps the anchor in the trust path. Jinn's ranking *signal* (on-chain
  `verifiabilityTier` + `distilledFrom` + anchor) is designed to be stronger than skills.sh's social
  telemetry — though no read path sorts on it in v1 (a future ranking surface, spec §5).
- **Neutral / Permissionless / Governance-Minimal.** GitHub-org distribution reintroduces a
  gatekeeper; the anchored corpus is permissionless. Keeping distribution on the corpus keeps the
  operator from becoming the house.
- **First-class beats ride-along.** A distinct `artifactType` lets consumers filter consumables from
  raw traces and gives provenance a structured, anchored home — the seed ride-along pattern offered
  neither.
- **Scrub altitude, not scrub fix.** #1409 is not a bug in one stage; it is a category error —
  trace-grade paranoia applied to prose that is public or already-scrubbed. The fix is to run the
  right scrub for the altitude, which also protects distilled output from being defaced after it is
  produced.
- **Minimal (Rule 2).** v1 builds no new consumption command and no resolver. The product path is
  corpus-native retrieval; the *measurement* reuses the capability-eval rig (PR #1416) with skills
  **pre-installed** into content-addressed corpus snapshots (no live search in the A/B). The
  resolver is named, not built.

## Alternatives considered and rejected

- **Ride the layer-1 pipe (keep the seed pattern for consumables).** Rejected: consumers cannot
  distinguish a consumable from a raw trace; provenance stays unstructured; and it perpetuates the
  #1409 defacement by keeping consumables on the trace-grade scrub path.
- **Adopt the `skills` CLI wholesale (publish to GitHub, consume via `npx skills add`).** Rejected
  for v1: it moves distribution off the anchored substrate and forfeits on-chain verifiability at
  consumption (against Legibility), reintroduces a GitHub-org gatekeeper (against Neutral /
  Permissionless / Governance-Minimal), and couples the paired capability measurement to an external
  tool's telemetry-ranked discovery that cannot be held fixed. Retained as the *eventual* end-state,
  reached via the source resolver rather than by abandoning the corpus.
- **Amend the frozen layer-1 envelope to add a `distilled` provenance value.** Rejected: the
  envelope is frozen by operator sign-off; a schema amendment for this is unnecessary — layer-2 is a
  distinct artifact type, and bridged evidence is distinguished by `environment.harness.name`.
- **Verified-evidence-as-consumable (no distiller): serve the raw patch + verdict verbatim by ref,
  let the solve-time model read it directly.** Deferred, not dismissed. At v1 scope — substring
  retrieval, coarse `(task, patch, verdict)` bridged tuples — a crafted `description` / *when-to-use*
  surface is plausibly more *retrievable* than a raw patch, which is the case for a distiller. But
  PRINCIPLES (Learning Maximised: "discovery beats encoded cleverness") makes this do-nothing
  baseline a first-class candidate, and the external evidence favours it for coding. So the spec's
  **raw-evidence measurement arm (spec §11, D9)** is exactly the test of whether this alternative
  wins: if raw-evidence retrieval matches or beats distilled prose, this becomes the v1 primitive and
  §5/§7 are dropped.

## Consequences

- **New:** `artifactType: 'jinn.skill.v1'`; a `publishSkill()` sibling to `publish()` that
  **parameterizes `role`/`solverType`** (the reference `buildUnsignedCaptureEnvelope` hardcodes
  `capture`/`capture`, which would defeat the discriminator) and anchors under a **distinct
  `skill:<cid>` key** (the `capture:` key routes payloads into capture-enrichment that rejects a
  skill payload); a layer-2 secret-only scrub stage; a provenance `metadata.jinn` frontmatter block.
- **#1409 fix is go-forward only.** Re-importing the 84 seeds onto the layer-2 path mints **new**
  clean `jinn.skill.v1` records; the previously-anchored defaced seed records **persist** (anchored
  capture/envelope records are append-only and per-CID — no supersede/revoke/tombstone exists) and
  remain returned by a content-searching consumer. Retroactive removal needs a read-path exclusion /
  tombstone that does not exist today (spec §10, §16). Tracked as the `fix` item in the build order.
- **The consume `search()` gains a consumable filter** (`artifactType: 'jinn.skill.v1'`) — but the
  indexer has **no `artifactType` column**, so v1 filters **client-side over a manifest page**
  (O(page) scan; a skill outside the window is unfindable). Accept the full-scan floor for v1's small
  corpus, or add an indexed column (a real indexer change — *not* "no indexer change required")
  (spec §5, §16).
- **A forward-path verification is opened:** whether the `skills` CLI supports a custom/pluggable
  source (for `skills add jinn:<ref>`). v1 does not depend on it.
- **Seed importer changes:** seeds stop transiting `capture()` (trace-grade). The licence gate,
  attribution, and provenance carry over; `provenance: 'imported'` maps to the `license` frontmatter
  and `metadata.jinn` marks the import.

## Reconciliation with the shipped #1394/#1409 substrate (2026-07-07)

Issues **#1394** (first-class `jinn.skill.v1` artifact + structured `SkillProvenanceSchema`,
`client/src/types/skill-artifact.ts`) and **#1409** (seed defacement fix, `buildSeedScrubPipeline`)
shipped on `next` in parallel with this design and landed first. This DR's intent is satisfied by
that substrate; where the mechanical choices differ, **the shipped shape governs**:

- **Provenance** lives in the structured `SkillProvenanceSchema` object (extended additively with
  `skillKind` / `distillPromptSha256` / `distribution` / `verifiabilityTier` for distilled skills),
  not in `metadata.jinn` frontmatter. Frontmatter provenance appears only in EXPORT renders of a
  standalone SKILL.md; the stored `skill.skillMd` omits it (one canonical home, no drift). The
  "distilled from N" count is `sourceEnvelopeCids.length`, never stored twice.
- **Decision 3's single layer-2 pass splits into two modes at the layer-2 altitude:** seeds are
  redact-mode (published post-scrub; false positives deface → the shipped seed profile runs
  deterministic detectors only, entropy fallback OFF); distilled output is check-mode (rejected on
  any scrub change, nothing redacted publishes → entropy fallback ON plus the deterministic
  plain-patterns set). "Keep Pass-2" applies to check-mode.
- **Carrier invariant by kind:** imported seeds publish alongside the seeded trace (shipped);
  distilled skills publish a skill-only wrapper — their evidence is the referenced layer-1
  envelopes in `sourceEnvelopeCids`.
- The distinct `skill:<cid>` anchor key remains the goal; producer wiring is issue #1439 (until it
  lands, live publishes anchor under `capture:<cid>`).

Distillation-v1's net-new surface: the distilled-skill **producer** (`publishSkill` — the producer
#1394 anticipated but did not ship) + the bridge/gate/distiller/three-arm-measurement pipeline.

## Status

**Ratified 2026-07-07** (Ritsu, after reading the DR; ratification includes the Reconciliation
section above). Proposed in the design session 2026-07-06; ratification is CODEOWNER sign-off on
the distillation-v1 spec (`spec/2026-07-06-distillation-v1.md`), given here. Implementation lands
as the reviewed PR stack #1423 (this foundation) → #1424–1427.
