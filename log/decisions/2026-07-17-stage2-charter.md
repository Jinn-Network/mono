---
id: DR-2026-07-17
title: Stage 2 charter — parked semantics, two-tier corpus with policy admission, zero-consent onboarding, the attribution-anchored gate, and the reconciled Stage 2 program
date: 2026-07-17
verb: Decide
status: ratified (operator, in-session, 2026-07-17 — each decision taken individually in the meta session's decision queue)
authors: Fable (drafted, Stage 2 meta session M); Ritsu (decisions)
spec: docs/superpowers/specs/2026-07-17-jinn-plugin-onboarding-design.md (A), docs/superpowers/specs/2026-07-17-corpus-supply-design.md (B), docs/superpowers/specs/2026-07-17-stage2-architecture-design.md (C)
amends: "docs/superpowers/briefs/2026-07-17-stage2-framing-packet.md (W1–W4 presumptions → ratified, W2 in amended form); docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md (P4/P7 parked-era posture note, §9 drift entry); spec/2026-07-02-jinn-harness-network.md (v0.7 — D3/D5 sequenced behind the un-park boundary; D8 seeds substrate-only under W2); the three Stage 2 specs (small deltas in this PR where reconciliation changed them)"
relates-to: "#1654 (Stage 1 close-out, ratified proceed 2026-07-17); docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md §Stage 2 (the requirements this charter covers); docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md (execution precedent); docs/superpowers/plans/2026-07-17-stage2-umbrella-plan.md (the program this charter authorizes); spec/2026-07-06-capability-eval-v0.md (held-out boundary, extended here); DR-2026-07-14 / mono#1714 (single-consent model, preserved as the un-park contract)"
---

## Context

Stage 1 closed 2026-07-17 (#1654, walkthrough #4, ratified proceed). Three parallel design
sessions produced the Stage 2 specs — A (onboarding), B (corpus supply), C (architecture) —
against the framing packet's working assumptions W1–W4, each ending in a seams & assumptions
register. This meta session reconciled the three registers (register diff first, per the
session brief), resolved every framing-packet seam row, and took the decisions below one by
one with the operator. Decisions land here and as same-PR doc amendments — never chat-only.

The register diff's headline: the three designs are compatible almost everywhere. One genuine
three-way conflict (parked semantics), one circular ownership gap (the named early-user repo
list), and two conflicts the packet's table did not predict — the roadmap's own Stage 2 gate
vs C's deferred attribution tier, and the packet's "chores are autopilot-bound" claim, which C
verified false.

## Decisions

### 1. Parked semantics — the capture/outbound split in code

"Parked" (W1) means exactly, per layer:

- **Stores — unconditional, tuple-shaped.** Local capture, episode recording, candidate
  recording, and distillation keep running with zero gating; the capture lane stays
  native-shaped (same span vocabulary as the marketplace tuple, #1658/#1473 alignment) so
  un-parking is a consent flip, never a re-capture. (B's rider, accepted.)
- **Machinery — retained behind the daemon and ports.** The scrub/publish/mint code paths
  (`client/packages/harness-layer/src/publish*.ts`, `preview.ts`, `envelope.ts`,
  `contribution-store.ts`, migrating into `packages/core`/`layer` per C) stay alive with
  their outbound consumer off; the mineable contribution store slims to a reference-only
  eligibility queue keyed by `episodeId` — no divergent second store. (C's definition,
  adopted.)
- **Surfaces — deleted, fail-closed.** The plugin's consent wizard, `/jinn consent`,
  `/jinn preview`, `/jinn ledger`, `skills_install.py`, and the plugin-side
  `jinn_layer.publish()` wrapper are deleted per A §3.5. `/jinn status` gains one line:
  `contribution: parked — nothing leaves this machine`. The file-level boundary was
  verified in-session: A's deletions are Python plugin surfaces; B/C's retained machinery
  is TypeScript layer/daemon code — disjoint sets.

**Duration:** parked through Stage 2. The un-park decision is re-taken no earlier than the
Stage 3 boundary, with C12's attribution evidence in hand and the evaluator/reward-era lane
design (harness-network D3/D5) as its own session. When outbound returns, what returns is
surfaces — a newly designed consent moment — not stores; the single-`shareConsent`,
default-decline contract (mono#1714, D3 v0.6) is preserved as the un-park semantics.

**Consequence: zero-consent onboarding is ratified.** With nothing to gate, first run asks
nothing — one-time banner plus loud-on-failure doctor (A §3.2). The privacy promise is
carried by the parked status line and docs, backed by the fail-closed structure.

### 2. Attribution and the Stage 2 gate

C12 (marketplace attribution instrument: corpus-autoload on/off arms over the existing
three-arm machinery) is **required Stage 2 scope**. The roadmap gate sentence "Jinn can
determine whether its intervention helped, harmed, or made no difference" is read as a
capability claim: **the instrument is live and has produced its first readout** — not a
demand for a conclusive causal verdict this stage. C13 (interactive randomized holdback)
is deferred pending C12's finding; its posture is decided at that review. C14 (feedback
verb) stays optional. C's claim-boundary policy (Facts → Descriptive → Causal) is ratified
as the language rule for any surface that mentions efficacy.

### 3. Install path — the gate waits for C6

The one-command install's layer-acquisition mechanism is decided: **the plugin acquires the
published `@jinn-network/jinn-layer`** (C Phase 3). A1 collapses from a standalone scoping
session into the plugin↔layer handshake spec carried on C6 (bin-discovery convention,
version pinning, layer resolution order per A §3.1). Onboarding stays dogfooder-grade
(repo-based layer) until C6; **one shared fresh-machine walkthrough after C6 closes both
A's acceptance and C's install verification**. No interim bundled-layer artifact ships —
that fallback re-introduces the bespoke bundler and re-single-sources the #1797 class.
Consequence, stated openly: C's spine (C1→C2→C5→C6) is the program's critical path; A3/A4/
A6 are mechanism-agnostic and land early so only ratification waits on the spine.

### 4. Two-tier corpus (W2) — ratified in amended form: default-out + policy admission

B's rule is ratified: every record is substrate-resident by default; retrieval serves only
records carrying an explicit visibility mark set at publish time (allowlist — no denylist to
maintain; bulk supply cannot flood retrieval by accident). **Amended over B's spec:** the
mark is not editorially exclusive. It may be set by hand (the curated seed lane — the only
marking producer today) **or by declared admission policy over record facts** (verdict,
evidence tier, repo tags, freshness) as those signals mature on bulk records. Hand-marking
is the day-one policy, not a standing obligation; policy admission is the designed evolution
and lands with the mark's semantics (B1).

Consequences ratified with it: the 84 skills.sh seeds leave retrieval as a consequence of
the default (retirement ≠ deletion — substrate-resident, distiller-visible, provenance
intact); Stage 1 episodes re-publish carrying the mark post-#1784; #1342-class bulk imports
become safe as substrate-only supply. **Watch item, with tripwire:** engine autoload reads
substrate directly, ungoverned by the mark; if autoload exhibits the same false-positive
pathology the walkthrough showed at three records, the mark extends to autoload.

**Retrieval escalation ladder (W4) — held, and accelerated one rung.** No model calls in
the live retrieval path this stage. #1792 (content re-scoring for near-miss candidates —
deterministic, model-free) becomes **required Stage 2 scope**. The embeddings step stops
being an open-ended deferral: **when C12 produces its first readout, the embeddings design
session runs against that data** (local-model feasibility, offline index shape, the 15-second
host deadline budget). Corpus-side quality fixes remain preferred meanwhile.

### 5. Constraint touches — both ratified

- **Cap-eval boundary extension.** I2 (every tuple carries `task.createdAt`; capability
  claims prefer date-based freshness) and I3 (contamination tracking key
  `(repo, baseCommit, instanceId)` + generator-model + source-dump provenance; training-
  visible exports declare an overlap manifest against known public dumps) are ratified.
  They extend I1; nothing relaxes. I1 stays hard.
- **Tiered anchoring.** Per-record anchors remain for retrieval-visible and genuinely
  contributed records; bulk substrate batches anchor via one `manifest:` record per batch
  (merkle root over member CIDs — every member independently verifiable by inclusion
  proof). This consciously amends the implicit one-record-one-anchor norm; Legibility is
  preserved because verification stays independent, two steps instead of one. No gas figures
  are asserted until measured; the first bridge batch doubles as the measurement.

### 6. Named early-user repos

The A↔B circular assumption is resolved by naming the list here: **`Jinn-Network/mono`** —
the one repo with live usage evidence (walkthrough #4; PR #1802). Owner: the operator.
Changes are one-line amendments to this DR, not re-designs. The K=3 guarantee, B's curated
batches, the doctor's `corpus-content` probe, and the supply-quality probes all key on this
list.

### 7. Program banding — the bridge wave trails

The gate-blocking core is the product+contract+instrument program (~29 items; see the
umbrella plan §3). The **bridge wave** — bridge derivation run v0, the `manifest:` anchor
record, and the #1672-lane retirement — files as **trailing, non-gate-blocking** supply
work: it serves training-consumer volume, not the Stage 2 gate, and runs on slack after the
visibility mark lands. Deferred outright (filed as deferrals, not issues): K>1 group
minting, SWE-rebench source expansion, dataset-reference/overlap tooling, C13, C14, #1342.

## Working assumptions — disposition

| W | Disposition |
|---|---|
| W1 outbound parked | **Ratified**, with B's tuple-shape rider and C's machinery placement (Decision 1). |
| W2 two-tier corpus | **Ratified in amended form** — default-out + policy admission (Decision 4). |
| W3 seeding, not contribution | **Ratified** (follows W1; supply = curated seed lane + trailing bridge). |
| W4 no model calls in retrieval | **Ratified**, ladder accelerated: #1792 required; embeddings design session committed at C12's first readout (Decision 4). |

## Seam resolutions (framing-packet rows + rows the diff surfaced)

| Seam | Resolution |
|---|---|
| First-session aha (A↔B) | Agree, with the gap closed by Decision 6 (repo list named). B provides K=3 marked records per named repo + the probe definition; the doctor's `corpus-content` check runs the identical probe. |
| Evidence contract evolution (B↔C) | Agree. Every B §8.2 delta has a named home: deltas 1–6 (F2P/P2P+base-commit join, group fields, `generatorModel`, `distributionClass`, `task.createdAt`, `instanceId`) land via the paired B6+C11 train; delta 7 (`evidenceTier`/`verifiabilityTier` reconciliation into one verification-strength axis) is assigned to C11. C3 carries only the local-episode deltas. Full table: umbrella plan §6. |
| Process contract + doctor placement (A↔C) | Agree. A owns checks + the `{name, ok, detail, remedy}` contract; placement per the umbrella plan §7 table (identity/handshake checks plugin-side in A3; corpus probes layer-side in A5, landing pre-C5 so the C5 move carries them mechanically). C's readable-episode-count primitive joins the doctor after C4. |
| "Parked" semantics (all↔DR) | Resolved — Decision 1. |
| Retrieval visibility mechanics (B↔C) | Agree — B specifies semantics (amended per Decision 4), C guarantees the mark survives unification as record metadata (C §3.4); enforcement consumer-side for v0. |
| Stage 2 gate vs attribution tier (roadmap↔C) | Resolved — Decision 2 (C12 required; gate = first readout). |
| Install critical path (A↔C) | Resolved — Decision 3 (gate waits for C6; A1 folds into C6). |
| Chore triage (packet↔board) | The packet's "already filed, autopilot-bound" claim was false. This session owns triage: all eight chores are boarded with routing fields at filing; folds and closures per the umbrella plan §9. |

## Ratified letter amendments

- Product design **P2**: "stock upstream Hermes + the pip-installed plugin" → "stock
  upstream Hermes + the **`hermes plugins install`ed** plugin" (spirit intact; the pip path
  never worked on the locked target — A §2 finding 1).
- Session A brief's gate: "one install command per ecosystem" → "**one install command,
  total**."

## Record corrections

- The meta-session brief's "nine defects were CI-invisible" under-counts: **thirteen**
  distinct items (six unnumbered root causes from the 2026-07-16 walkthrough that drove the
  rescope + seven filed issues — #1786, #1787, #1789, #1790, #1791, #1782, #1795 — across
  walkthroughs #2–#4).
- The rescope plan never used the phrase "merge-pairing"; the pattern the umbrella plan
  carries forward is how the rescope *ran* (paired PR trains on convergent files), expressed
  as native `blocked_by` edges (plan §4) that the autopilot dispatcher's stacked dispatch
  reproduces mechanically.

## Amendment list (executed in this PR)

1. `docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md` — P4/P7
   parked-era posture notes; §9 drift entry pointing here.
2. `spec/2026-07-02-jinn-harness-network.md` — v0.7 header entry: D3 (consent ask) and D5
   (earn-for-contribution) sequenced behind the un-park boundary (no earlier than Stage 3);
   D8 seeds substrate-only under the W2 allowlist.
3. `docs/superpowers/specs/2026-07-17-jinn-plugin-onboarding-design.md` — §3.1 layer-
   acquisition open question resolved (Decision 3); P2/gate renegotiations marked ratified.
4. `docs/superpowers/specs/2026-07-17-corpus-supply-design.md` — §5 "Who marks" gains policy
   admission (Decision 4); §8.3/§9/§14 renegotiations marked ratified; §13 banding note.
5. `docs/superpowers/specs/2026-07-17-stage2-architecture-design.md` — §9 sequencing note
   amended (C12 required; C13/C14 deferred pending C12; C6 absorbs the A1 handshake);
   §5 instrument preference marked decided.

## Consequences

The Stage 2 program is authorized as specified in
`docs/superpowers/plans/2026-07-17-stage2-umbrella-plan.md` (tracks, gates, banded issue
train, dependency graph, operator verification moments). **Execution is autopilot-first**
(operator's call, this session): the train files dispatcher-ready per the plan §11 — typed
sub-issues, board routing, native `blocked_by` edges with the `Blocked on` field set to
match, operator-anchored units parked in the Human lane. Housekeeping at filing: close #1775 (stale — its acceptance was
satisfied when #1654 closed); note on #1654 that AC3's checkbox remained unticked in the
body while ratified in comments; #1754 folds into C1's acceptance criteria; #1799/#1800
close via C3; #1811 keeps its own fix, C4 coordinates.
