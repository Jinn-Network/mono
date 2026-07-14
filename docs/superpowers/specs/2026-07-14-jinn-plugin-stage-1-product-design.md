# Jinn Plugin Stage 1 — Product Design

- **Version:** 0.1 (approved in planning session 2026-07-14; written review pending)
- **Date:** 2026-07-14
- **Author:** Ritsu (planning session, Claude Fable 5)
- **Shape:** `design` — output is this product design; implementation lands as Stage 1 Issues
- **Parent direction:** PR #1651 "Jinn Plugin product lifecycle roadmap"
  (`docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md`, **unmerged — a
  blocker for dependent implementation issues**). This document is the Stage 1 interaction
  design the roadmap deliberately does not specify. It does not extend PR #1651.
- **Sibling design:** `spec/2026-07-02-jinn-harness-network.md` v0.4 (harness-first
  distribution, D1–D12). Stage 1 assembles what that spec's v0 shipped; divergences are
  recorded in §9.

## 1. Scope

Stage 1 is the **complete connected product**: assemble existing retrieval, capture, task,
evaluation, distillation, and history capabilities into one coherent, end-to-end experience a
person has while doing ordinary OSS work — plus two structural requirements that are not
deferrable: an enforceable plugin package boundary (separate design, Phase 3) and durable,
reusable evidence episodes.

The Stage 1 gate (from the roadmap):

> A person can use Jinn for real OSS work, receive shared knowledge, understand what Jinn did,
> and contribute an eligible learning signal through one coherent experience, while Jinn
> preserves the resulting evidence in a form reusable by later learning stages.

## 2. Locked product decisions

| # | Decision | Rationale |
|---|----------|-----------|
| P1 | **Host: Hermes.** The Jinn Plugin is a plugin for the user's own agent harness; the daemon-injected `client/plugins/*` are the separate marketplace-solving concern. | Open-source harness; the plugin-into-host integration already exists (`apps/jinn-agent/plugins/jinn/`). |
| P2 | **Acceptance target: stock upstream Hermes + the pip-installed plugin.** The jinn-agent fork is the batteries-included distribution and inherits everything. | Proves "keep your harness, add Jinn" honestly; cold-stock e2e already exists (`apps/jinn-agent/scripts/cold-stock-e2e.sh`). |
| P3 | **Eligible contribution: user-originated public task mint** (session-echo at true `repo@commit`, blinded provenance). Trace publication remains as the shipped consent-gated lane but is not the gate. | Faithful to the roadmap boundary: "anything leaving the machine must be independently executable against a public OSS base"; the user's own trace never leaves. |
| P4 | **Contribution is background work.** Consent decided once at onboarding (mineable-trace tiers); the first publish shows a one-time preview; thereafter minting is silent. The user inspects results (`/jinn history`, ledger) rather than being interrupted. Per-task veto remains. | The felt product moment is the boost, not the contribution. Satisfies "publication begins review-first" via consent + first-publish preview + standing visibility/veto. |
| P5 | **Trajectory source: complete the hook collector.** Subscribe `post_llm_call` and record all user turns so the existing capture buffer yields a complete trajectory via Hermes's public plugin API; the episode is assembled at session end. Hermes's sqlite session store is diagnostic backfill only, never a dependency. | Hermes has no native session-evidence seam (its `/learn` and background review distill in-context and discard the trajectory). Hooks are the stable public contract and the pattern ports to future hosts. |
| P6 | **Session-level feedback: deferred to Stage 2**, alongside attribution. Stage 1 keeps outcome status + the existing skill-scoped `jinn.distill.feedback.v1`. | Attribution is a Stage 2 concern per the roadmap; don't build a feedback surface before the analytics that consume it. |
| P7 | **Consent defaults: decline/off.** Publish consent default-decline (as shipped); mineable-trace tier-1 (retain local) asked explicitly at onboarding, default off. | Resolves the drift between harness-network spec D3 ("default-on") and shipped behavior in favor of the roadmap's review-first posture. Needs a one-line spec amendment (§9). |
| P8 | **Coexist with the host's native self-improvement.** Hermes auto-authors skills/memories per turn (`background_review.py`) and curates them when idle (`curator.py`). Jinn never disables or duplicates this; Jinn's distiller competes on cross-session patterns, provenance, and shareability. #1561 stays the open kill-test. | The host owns single-session learning; the network and durable evidence are Jinn's differentiators. `.jinn-ref` fencing already keeps the two skill populations disjoint. |

## 3. Primary user and use case

A developer doing ordinary day-to-day coding on **public OSS repositories** inside stock
upstream Hermes. Initial cohort: the dogfooding contributors, then single-digit external
users (the epic's usefulness bar). No benchmark workflow, no Jinn-specific task format.

## 4. The product experience

### 4.1 Install and onboarding
`pip install` the plugin (repo subdirectory today; PyPI later) → `hermes plugins enable jinn`
→ `npm i -g @jinn-network/client` (the `jinn-layer` CLI). First session: existing onboarding
asks publish consent (default decline) and mineable-trace consent tiers (default off).
Stage 1 adds a `jinn-layer` version-compatibility check (the #1380 gap) and keeps `/jinn
status` as the install doctor.

### 4.2 During work — the boost, made visible
- First turn: auto-pickup searches the corpus from the first user message; suggestions inject
  as `[jinn corpus]` context (cache-safe, user-message injection).
- Mid-task: `corpus_search` / `corpus_fetch` agent tools and `/corpus <q>`.
- Skills: `/jinn skills install <ref>` into the host's native skills dir (`.jinn-ref` fenced).
- Auto-adopt stays tier-gated (`evaluator-verified`) and therefore dormant in Stage 1;
  the experience is **suggest-first**. Corpus content: seeds + prior traces + distilled skills.
- **Legibility (new build):** the point-of-use `◇ corpus` marker fires on *suggestions* (today
  it fires only on auto-adopt, i.e. never); a session-end Jinn summary states what was
  surfaced/fetched/installed, capture status, and the eligibility verdict; `/jinn session`
  shows the current session's Jinn activity on demand. When Jinn found nothing, it says so.

### 4.3 Session end — evidence
The episode is assembled at session end from the completed hook collector (P5) and retained
locally: **all turns** (user, assistant, tool calls/results), environment (harness, model,
tools, **skills loadout** — new), outcome status, cost (duration + **tokens** — new), a
**per-record privacy/retention field** (new; today gating is implicit external state), and
lineage hooks (episode → mint → eventual marketplace evidence). Private by default; the
existing tee to the distill captures dir continues under its current gating. Retention (prune
newest 200) becomes a stated, user-visible policy. The frozen `jinn.trace-envelope.v0` publish
format is untouched; episode-schema mechanics are Phase 3 design.

### 4.4 Contribution — silent, inspectable
If the session produced an accepted diff on a public repo, the plugin records a mineable
trace (tier-1 consent). Background machinery (the daemon-sidecar `HarvestLoop` + session-echo
miner) validates eligibility — public repo, resolvable `repo@commit`, empirical F2P/P2P echo,
no private facts (blinded provenance, lineage hash only) — and mints a task into the pool;
publication is gated by the standing tier-2 consent, applied automatically per record (no
per-mint interaction). Publication to chain runs through the **optional
daemon sidecar**; without it, approved mints queue locally with an honest status. First
publish shows a one-time preview; after that, silence + inspection surfaces. Gasless relayer
intake is Stage 2+.

### 4.5 History
Net-new but small: a local, plugin-owned session history — per session: task summary,
knowledge surfaced/used, capture status, eligibility verdict, contribution state (queued /
published + anchor), distilled skills produced. Surfaces: `/jinn history` (TUI) and
`jinn-layer history` (CLI). `/jinn ledger` remains the what-left-this-machine receipt trail.
**Invariant: history is a derived view** over episodes + ledger + mint pool; it owns no facts.

### 4.6 Fallbacks and failure behavior
No network → retrieval degrades to nothing-found (fails open), work proceeds. `jinn-layer`
missing → commands degrade with instructive errors. Publish failure → local retention with
honest status. Sidecar absent → mints queue. Rule: every adapter failure surfaces as a typed
plugin-level outcome; never a crash into the host session.

### 4.7 Privacy and permissions
The roadmap boundary, unchanged: raw traces stay local; scrub is fail-closed on anything
outbound; mints carry blinded provenance; consent tiers per P7; per-task veto; the ledger is
the receipt. Private and public episodes share one semantic evidence contract; storage,
retention, scrubbing, and permitted derived views differ.

### 4.8 Disable and rollback
As shipped: `hermes plugins disable jinn`, `pip uninstall jinn-plugin`, `HERMES_SAFE_MODE=1`;
consent-off = zero capture; separate state home. The acceptance gate asserts the host returns
to stock behavior.

## 5. Outcome model

Interactive sessions end `completed` / `abandoned` / `failed` at tier `user-accepted`. No
evaluator verdict exists for interactive work — by design: the path to verified evidence from
a session is the mint lane (fresh marketplace attempts on the minted task receive evaluator
verdicts and become verified corpus evidence). For eligibility, the outcome that matters is an
accepted diff at a public `repo@commit`.

## 6. Marketplace-side evidence requirement

Fresh attempts on minted tasks must carry a **typed, discoverable transcript** instead of
hiding it in `system_snapshot`. #1473's design fork is resolved by **DR-2026-07-14**
(`log/decisions/2026-07-14-trajectory-is-the-transcript.md`): **one record** — the span-kind
enum is extended so `jinn.trajectory.v1` carries the agent's conversational spans (turns,
tool calls) alongside the operational ones, making the envelope's trajectory slot truthful.
The distiller's snapshot-extraction workaround (#1472) remains as the compatibility path for
historical evidence.

## 7. Minimum acceptance journey (formalized in the Phase 5 gate design)

On stock upstream Hermes + plugin: enable → OSS session where seeded corpus knowledge is
surfaced and visibly attributed → complete work → episode retained with complete trajectory →
eligibility verdict → mint validated and queued/published via sidecar → session appears in
history → private-session variant proves nothing leaves → disable returns the host to stock.

## 8. Stage 1 non-goals

- Proving Jinn beats stock Hermes (the harness-network spec §8 capability gate, later).
- Multi-host portability (Claude Code / Codex adapters).
- Auto-adopt activation; evaluator economics; Skill Factory / network distillation (rung 3).
- Gasless contribution relayer; marketplace UX beyond what mints need.
- Session-level feedback and attribution (Stage 2, P6).
- Per-user cloud accounts — history is local.
- Publishing private work — never.

**Stage-1-adjacent, coordinated not re-planned:** the rung-1 distillation stack (#1486, open
PRs #1543–#1554) including the #1553 gate fix — local learning is part of the product, but its
issues already exist and stay owned there.

## 9. Recorded drifts and required amendments

1. `spec/2026-07-02-jinn-harness-network.md` D3 says contribution is default-on; shipped
   behavior and this design (P7) are default-decline/review-first per the roadmap. Needs a
   spec amendment PR (docs shape) once PR #1651 merges.
2. PR #1646 (session-echo real-usage mining) was closed 2026-07-14 pending rebase onto merged
   #1485; its scope is load-bearing for P3/P4 and must be re-landed (tracked in Phase 4
   decomposition; #1648/#1649 ride along).
3. Task Creator harvest today assumes the operator daemon; Stage 1 frames the daemon as the
   **optional sidecar** for contribution (packaging inversion, harness-network §4.2) — mints
   queue without it.
