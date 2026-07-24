# Jinn Plugin Stage 1 Rescope — evidence retrieval and the complete contribution loop

- **Date:** 2026-07-16
- **Author:** Ritsu (rescope planning session, Claude Fable 5)
- **Shape:** `design` — output is this plan; implementation lands as new sub-issues of #1654
- **Parent:** #1654 (Stage 1 tracking). Amends the Stage 1 documents landed in PR #1653 and the
  delivery plan `docs/superpowers/plans/2026-07-14-jinn-plugin-stage-1-plan.md`; does not replace
  them.
- **Trigger:** the #1654 manual walkthrough (2026-07-16). Decision: **iterate**. The capture and
  contribution half passed; the consumption half exposed product drift (§0).

## 0. Walkthrough record (the evidence this plan responds to)

One real Hermes session against real OSS work, sharing off, on the shipped Stage 1 build
(`next @ 1f6cba79`):

**Worked** — one canonical `jinn.episode.v1` retained with complete trajectory; one
`jinn.contribution-candidate.v1` recorded with repository diff and test evidence; one history row;
sharing off held: zero outbound publication.

**Drifted** — auto-pickup searched crude terms (`implement`, `github`); the corpus returned two
duplicated seed records for an installable `implement` skill (verified live: two distinct CIDs,
identical `mattpocock/skills/…/implement` summary/tags, both `imported`/`user-accepted`); the
injection contained only skill metadata plus an installation instruction; the fetched skill content
was discarded rather than supplied; the user-facing states (`surfaced / fetched / installed`)
presented skill installation as the product's "applied" moment. Shared-skill installation and
auto-adoption are Stage 3 concepts (roadmap §Stage 3; distillation-v1 D11) that leaked into the
Stage 1 surface.

Root causes, located in code:

| Symptom | Cause | Location |
|---|---|---|
| Crude search terms | `derive_terms` keeps the first two ≥4-char non-stopwords of the first line | `apps/jinn-agent/plugins/jinn/pickup.py:147-163` |
| Only skill records surface | Tier asymmetry: skills surface at any tier; evidence traces require `evaluator-verified` (nothing in the corpus clears it) | `pickup.py:273-321`; threshold `pickup.py:92` |
| Duplicated seeds | Seed import is not idempotent (fresh CID per run), never sets `supersedes`; no content dedup downstream | `client/packages/harness-layer/src/seed-import/execute.ts:128-193`; `consume.ts:281-320`; `packages/indexer/src/api/routes.ts:418-448` |
| Metadata-only injection | Pickup fetches and verifies full record content, then injects slug + tier + 120-char summary + `install:` hint | `pickup.py:263` (fetch) vs `pickup.py:297-333` (compose); TS side: `CorpusPort.get` returns metadata-only `KnowledgeHit` (`packages/plugin/src/ports/corpus-port.ts:6`) |
| Corpus has no evidence to serve | Day-one seeding imported skills.sh packages only (harness-network D8); no path publishes a user episode to the corpus (mint-only outbound, by design); verified live: `pytest`/`fix`/`error` return zero hits | `seed-import/`; §3.1 below |
| The gate pins the drift | Acceptance driver seeds a skill record and asserts the `skills install` journey | `apps/jinn-agent/scripts/stage1-stock-product.py:84-121, 353-360` |

The corpus reality makes the last point structural: retrieval could not have returned evidence,
because the shared corpus contains almost none — the seeding decision, the tier gate, and the
skill-shaped injection are one connected drift, not three bugs.

## 1. Corrected product definition

### Promise

Stage 1 proves the complete end-to-end knowledge loop on evidence, in one coherent experience:

> Start ordinary OSS work; Jinn understands the task, searches the shared corpus, and supplies
> relevant evidence from previous agentic work directly into the agent's context; the agent works
> normally; Jinn captures one canonical episode and records one contribution candidate from
> eligible public OSS work; the user can inspect what was supplied, what was retained, and what may
> be shared; sharing and privacy controls behave correctly.

Stage 1 is about **retrieval of relevant evidence and production of new reusable evidence**. It is
not the shared-skills product. The knowledge unit is evidence derived from prior work: how a
similar task was solved, trajectory excerpts, useful commands/tests/patterns/diffs, failures and
their corrections, outcome and provenance, and a concise task-linked synthesis — supplied as
content, in context, at the moment of use. Jinn never merely announces that a record exists or asks
the user to install something.

This matches decisions already on the books: the roadmap places skills at Stage 3, and
`spec/2026-07-06-distillation-v1.md` D11 ratifies **retrieval-over-anchored-evidence as the v1
product baseline** that a future distiller must beat. The shipped consumption path inverted D11 in
code; this rescope restores it.

### Lifecycle (user-visible)

1. First user message → Jinn searches the corpus (`searched`).
2. Relevant evidence found → a bounded knowledge packet, with attribution, is injected into the
   agent context (`provided to agent`). Nothing relevant → Jinn says so, honestly, once.
3. Work proceeds normally; corpus tools (`corpus_search`/`corpus_fetch`, `/corpus`) remain
   available mid-task.
4. Session end → one episode (whose activity records the searched terms and provided refs), one
   eligibility verdict, at most one contribution candidate, one history row, one summary line set.
5. Inspection: `/jinn session`, `/jinn history`, `/jinn ledger`, `/jinn preview`, `/jinn veto`.

User-facing activity states are exactly **`searched → provided to agent`**. Internal fetching and
parsing are still recorded (episode activity, degraded reasons) but are not presented as product
value. Stage 1 never claims the provided evidence *helped* — attribution and efficacy are Stage 2.

### Graduation gate

Unchanged in substance from the roadmap, now honest about the knowledge unit:

> A person can use Jinn for real OSS work, receive relevant prior **evidence** in their agent's
> context, understand what Jinn supplied and where it came from, and contribute an eligible
> learning signal through one coherent experience, while Jinn preserves the resulting evidence in a
> form reusable by later learning stages.

Observable form in §6.

### Explicit non-goals (additions to product design §8)

- Shared-skill discovery, installation, uninstall, counts, or auto-adoption anywhere in the user
  surface (Stage 3).
- Any claim that provided knowledge helped (Stage 2 attribution).
- Ranking beyond deterministic term-overlap + tier + recency; no embeddings, no model calls in the
  retrieval path, no new services.
- Publishing episodes or raw traces to the corpus (mint remains the only outbound lane).
- Local rung-1 distillation as a Stage 1 *network* deliverable — it continues to exist as an
  independent local capability (#1486 owns it), and its surfaces must not expand the Stage 1
  product story.

## 2. Current-state audit

Topology (for orientation): Hermes host → Python plugin (`apps/jinn-agent/plugins/jinn/`) →
subprocess `jinn-layer` CLI (`client/packages/harness-layer/`) → TS product core
(`packages/plugin/`) wired to harness-layer adapters; optional sidecar daemon (`client/src/daemon/`)
for mint validation/publication.

| Component / surface | Files (load-bearing) | Classification | Rescope action |
|---|---|---|---|
| Auto-pickup: term derivation, selection, injection | `pickup.py:147-333`; `packages/plugin/src/pickup.ts`, `plugin.ts:310` (`firstTurnPickup`) | **Modify** | Rebuild evidence-first (§3); single implementation in the TS core; Python delegates (`session pickup` verb exists, `cli.ts:872,910`) |
| `CorpusPort` contract | `packages/plugin/src/ports/corpus-port.ts` | **Modify** | `get` must return record content, not metadata-only |
| Corpus tools `corpus_search` / `corpus_fetch`, `/corpus` | `__init__.py:770-855` | **Keep** | Already content-capable (`corpus_fetch` returns 8 KB of content); record activity internally |
| Activity states `surfacedRefs/fetchedRefs/installedSkillRefs` | `episode.ts:39-43`; `__init__.py:182-243`; `session-summary.ts` | **Modify** | Add `searchedTerms`, `providedRefs`; legacy fields accepted on read; skill fields leave the user surface |
| Session summary + `/jinn session` + `◇ corpus` marker | `session_view.py:23-144`; `onboarding.py:411-448` | **Modify** | `searched → provided` rendering; drop `installed`; keep nothing-found honesty |
| History | `history.ts:94`; `history-entry.ts`; `history_view.py` | **Modify (small)** | `knowledgeSurfaced/Used` → searched/provided counts; keep derived-view invariant; keep local `distilledSkills` provenance |
| `/jinn skills install\|list\|uninstall` | `__init__.py:726-749`; `skills_install.py` | **Hide until Stage 3** | Unregister the command branch; module retained (the distill install path uses it) |
| Auto-adopt rail + tier gate + payload adopters | `pickup.py:83-94,130-134,168-191,273-321`; `pickup-config.ts` | **Hide until Stage 3 / delete from pickup** | Remove adopt branch and skill classification from pickup; `autoAdopt`/`autoAdoptTier` config leaves the pickup path. Closes #1729 by removal |
| `SkillsPort` + in-memory kit | `ports/skills-port.ts`, `testing/in-memory-skills.ts` | **Retain internally** | Quarantined: not reachable from pickup or commands; consumed only by the local-distill install path; package-architecture doc marks it later-stage (with #1755) |
| jinn-layer `skills install` verb | `cli.ts` (skills verbs) | **Retain internally** | Used by distill staging install; not user-advertised in Stage 1 |
| `/jinn distill` surface (rung 1) | `distill.py`; harness-layer distill verbs | **Keep (independent)** | No expansion; remove skill-payoff phrasing that implies network skills; owned by #1486, not Stage 1 |
| `/jinn status` | `__init__.py:574-595` | **Modify (small)** | Keep sharing/bridge/pending; keep distill line as local-learning status; no installed-skill counts |
| Onboarding + consent copy | `onboarding.py` (rewards blocks :346-405, `/jinn rewards` refs :370,401); `consent.py:69-76,390` | **Modify** | Remove OLAS-earning promises, node stub, and the dangling `/jinn rewards` reference (Stage 3 economy); consent copy stays mint-focused |
| Episode capture (hooks, buffer, assembly, fallback) | `__init__.py:247-540`; `capture_buffer.py`; `episode.ts` | **Keep** | Proven in the walkthrough. One rider: `plugin.yaml` declares 4 hooks, code registers 5 (`post_llm_call` missing) — fix the manifest |
| Contribution: candidate, store, preview, veto, ledger | `session_bridge.py`; `contribution-candidate.ts`; `contribution-store.ts`; `contribution-adapter.ts` | **Keep** | Proven. `skillEvents` on the candidate stays (local provenance input; not user-facing) |
| Mint lane (harvest, session-echo, sidecar publish) | `harvest-loop.ts`; `_swe-rebench-v2-session-echo.ts` | **Keep** | Out of the acceptance gate's scenario set (sharing-off gate covers the boundary); #1742 owns its evolution |
| Seed import (skills.sh) | `seed-import/{fetch,plan,execute}.ts` | **Modify** | Add idempotency + `supersedes`; add an evidence-episode seed source (§4); skill seeds remain in the corpus for later stages but leave the Stage 1 pickup |
| Acceptance gate (driver + static pin + CI job) | `scripts/stage1-stock-product.py`; `tests/plugins/test_jinn_stage1_acceptance_gate.py`; `.github/workflows/jinn-agent-ci.yml` `cold-stock-e2e` | **Modify** | Consumption scenarios rewritten per §4/§6; contribution/privacy scenarios kept |
| Tests pinning the drift | Python: `test_jinn_pickup.py:104,109-174`, `test_jinn_session_view.py:44-149`, `test_jinn_onboarding.py:226-278`, `test_jinn_skills_install.py`, `test_jinn_history.py:41-58`; TS: `packages/plugin/test/pickup.test.ts:67-96`, `test/plugin/first-turn-pickup.test.ts:45-73`, `test/history.test.ts:34-134`, `test/schemas/{knowledge-hit,session-summary}.test.ts` | **Modify** | Rewritten with the units that change their subjects (both suites mirror each other 1:1 and both run in the blocking gate) |
| Episode retention (declared `maxEpisodes: 200`, unenforced) | `evidence-adapter.ts:40` | **Modify (small, independent)** | Enforce the declared prune; product design calls it a stated policy |
| Legacy `jinn.trace-envelope.v0` pending/publish verbs | `publish.ts`, `envelope.ts` | **Retain internally** | Already retired from the session path; remains the published-evidence wire shape the corpus serves |
| Delete list | — | **Delete** | The skill-suggest/install composition inside pickup (Python and TS), the `install:` injection line, `Adopted automatically (verified)` copy, `/jinn rewards` copy references, `payloadKind` skill preference in selection. Nothing else deletes; later-stage code quarantines |

## 3. Retrieval design

Deliberately small: deterministic, no embeddings, no model calls, no new services. One new schema,
one extended port, one rewritten policy function.

### 3.1 Canonical source evidence

The retrieval source is the **published corpus evidence record**: a `jinn.execution.v1` signed
envelope whose artifact payload is trajectory-bearing evidence (`jinn.trace-envelope.v0` shape:
task summary, ordered steps with commands/results, outcome, `verifiabilityTier`, provenance,
tags), indexed by the capture-meta search (`taskSummary` + `tags`) with the manifest floor as
fallback. This is already what `corpus search` / `corpus get --json` serve, with full
`contentBase64`.

What is canonical vs derived:

- **Canonical:** the signed envelope (network) and `jinn.episode.v1` (local). Unchanged.
- **Derived, presentation-only:** the knowledge packet below — a versioned pure projection,
  re-derivable from the record at any time, cacheable, never stored as new truth.

Evidence reaches the corpus today only via seeds, the distillation bridge, or network solves of
minted tasks — never from a user's episode (mint-only outbound; the privacy boundary). Stage 1
therefore stands up its retrievable evidence via the seeded set (§4); organic marketplace evidence
joins the same shape over time.

### 3.2 Knowledge packet (the unit supplied to the agent)

New schema `jinn.knowledge-packet.v1` in `packages/plugin/src/schemas/knowledge-packet.ts`:

- `ref` — source record CID (the manifest ref `corpus_fetch` accepts).
- `task`: `{ summary, repositorySlug? }` of the source episode.
- `outcome`: `{ status, verifiabilityTier }`.
- `synthesis?` — the record's own concise how-it-was-solved text, when the record carries one
  (authored at capture/seed time; never generated at retrieval time).
- `excerpts[]` — ordered `{ label: 'failure' | 'fix' | 'command' | 'diff' | 'note', text }`,
  selected deterministically from the record's steps: failing commands with their key output,
  the correction that followed, the final passing command, a diff excerpt when present.
- `attribution`: `{ provenance: 'imported' | 'contributed', capturedAt, origin }` — `origin` is
  the seed attribution or contributor identity already on the record.

**Producer:** `projectKnowledgePacket(record, budget)` — a pure function in `packages/plugin`
(the product core), fed by the extended `CorpusPort`. It selects and truncates; it never
paraphrases. Truncation is line-boundary-aware and ends with
`[truncated — full episode: corpus_fetch <ref>]`.

Answering the scope questions directly: the knowledge unit is a **combination** — a deterministic
projection (excerpts) plus the record's own stored synthesis when present; raw full content stays
one `corpus_fetch` away; nothing is model-generated in the hot path.

### 3.3 Search and ranking

- **Terms (lexical v2 — #1791, #1790, #1789):** `deriveSearchTerms(firstMessage, repositorySlug?)`
  replaces the 2-token heuristic. Up to 10 terms, in priority order: backticked/quoted tokens
  (edge-stripped through the same leading/trailing `_-./` strip as other terms, #1789);
  identifier-shaped tokens (contains `_`, `-`, `.`, `/`, a digit, or CamelCase) — a `/`-bearing
  token also contributes its path segments (each cleaned, ≥3 chars, stopword-filtered,
  deduplicated), right after the full token; the session repository's **name** — the segment
  after the last `/` of `repositorySlug` (known at session start from
  `session_bridge.snapshot_repository`), ≥3 chars — not the full slug, which can never appear in
  a record's text (#1790); the remaining non-stopword tokens (≥4 chars) in **message order**
  (order of first appearance, not longest-first — length is not a retrievability signal against a
  corpus of short summaries and tags, #1791). Whole first message, not just line one.
  Deterministic.
- **Search:** per-term `CorpusPort.search` (capture-meta first, manifest floor fallback — existing
  rails), results merged.
- **Selection:**
  1. Filter to evidence: drop `kind: 'skill'` hits and any hit whose payload classifies as a
     skill package. (Skill records stay in the corpus for Stage 3 and distillation measurement;
     they are simply not what pickup serves.)
  2. Dedup by ref **and** by content key `(taskSummary, origin)` — kills the duplicated-seed
     symptom at the consumer even before store hygiene lands.
  3. Score = count of matched terms across `taskSummary + tags`; **every match counts 1** — the
     old repository-slug +2 bonus is gone (#1790, #1791) now that the repository's name is a
     normal derived term. A term matches verbatim or, for a term ending in a simple plural `s`
     (length > 3), by its singular form (plural fold, #1791). **Relevance floor: score ≥ 2**,
     otherwise honest nothing-found. Tier is a ranking preference, not a filter: sort score desc
     → tier desc (`TIER_ORDER`) → recency desc.
  4. Take the top 2; fetch full content; project packets.

Escalation ladder if lexical v2 proves insufficient: lexical v2 (above) → two-stage content
re-scoring for near-miss candidates against synthesis/steps (#1792, deterministic, model-free) →
embeddings only with Stage 2 evidence.

### 3.4 Injection

Composed by the core, returned by `jinn-layer session pickup`, rendered verbatim by the host
adapter into the first user message (cache-safe, as today):

```
[jinn corpus] Prior evidence relevant to this task:
<packet 1 rendered: summary · outcome/tier · synthesis · excerpts>
  source: <ref> · <origin> · captured <date> · full episode: corpus_fetch <ref>
<packet 2 …>
```

Point-of-use marker: `◇ corpus — provided 1 evidence packet (searched: dashboard, vitest, …)`.
When nothing clears the floor: no injection, and the session records honest
`searched · nothing relevant found`.

### 3.5 Size limits and failure behavior

- ≤ 2 packets; ≤ 3,500 characters per packet; ≤ 7,000 characters total injected.
- Retrieval budget unchanged (15 s, fail-open). Any search/fetch/projection failure degrades to
  nothing-found plus a typed degraded reason (`PortResult`), never a crash into the host session;
  corpus unavailable (e.g. HTTP 503) behaves identically. Missing/incompatible `jinn-layer`
  disables pickup with the existing degraded note (search already requires the layer today).

### 3.6 User-facing activity states and lineage

- Episode activity gains `searchedTerms: string[]` and `providedRefs: string[]`
  (`SessionActivityFactsSchema`); the legacy `surfacedRefs/fetchedRefs/installedSkillRefs` remain
  accepted on read so existing local episodes still parse; `fetchedRefs` continues to be recorded
  as internal detail. `SessionSummary` drops `installedSkillRefs`/`surfacedHits` in favor of
  `searchedTerms` + `providedPackets: [{ ref, title }]` + `nothingFound`.
- Renderings: session-end summary and `/jinn session` show
  `knowledge searched <terms> · provided N` (or `· nothing relevant found`); history shows a
  provided count. No installed state, no "applied" claim anywhere.
- **Lineage:** the consumer episode's `activity.providedRefs` is the durable link from the new
  session back to the supplied source evidence — visible in `/jinn session` and history detail,
  and available to Stage 2 attribution.

"Provided to the agent" is a fact about context injection, observable in the transcript;
"helped" is a Stage 2 measurement. No Stage 1 surface may imply the latter.

## 4. Seed and acceptance design

### 4.1 Source and target tasks (the positive pair)

- **Repository:** `Jinn-Network/mono` — the dogfooding contributors' actual daily OSS work,
  public, license-clean, with a standing supply of related-but-distinct small tasks. (The pair is
  concrete for the first walkthrough; the criteria below let later walkthroughs swap repos.)
- **Source task A (seeded episode):** re-perform a real, already-merged small fix at its
  pre-fix `repo@commit` — default: the dashboard version-status flake fix
  (`163e070d test(dashboard): await version status fetch`): run the failing
  `yarn --cwd client test` target, observe the unawaited-fetch failure, apply the await fix,
  re-run green. One real Hermes+plugin session performs it; its captured `jinn.episode.v1` is the
  origin of the seed.
- **Target task B (walkthrough):** a *different* open dashboard/SPA test-or-async issue in the
  same subsystem, chosen from the live backlog at walkthrough time. Related (same repo, same
  subsystem, same test-runner and async-assertion domain) but distinct (different file, different
  defect). The source genuinely helps: repo test incantations, the flake's failure signature,
  the await/waitFor correction pattern.
- Selection criteria (stated so the pair can be re-chosen): public OSS; fast scoped test command;
  source and target share subsystem vocabulary but not the defect; target not solvable by quoting
  the source; repo not on the mint denylist (held-out ∪ cap-v0 slate) so the contribution lane
  stays exercisable later.

### 4.2 The canonical seeded episode and its retrieval view

The seed **originates as a real completed episode** (task A's recorded session), then is
transformed offline into a seed evidence file: paths normalized to repo-relative, machine/user
material removed, seed-profile scrub applied, a 3–6 sentence `synthesis` authored, `taskSummary`
and `tags` written with the subsystem vocabulary (`mono`, `dashboard`, `vitest`,
`version-status`, `async`, `flake`). Shape: the canonical published-evidence contract of §3.1
(steps with real commands/outputs/failure/fix, outcome `completed`, tier `tests-passed`,
`provenance: 'imported'` with attribution to the recording session). Its retrieval view is exactly
the §3.2 packet projected from it — no bespoke fixture format anywhere.

### 4.3 Distractor and no-result fixtures

Committed alongside the source seed (one directory, used by both the seed lane and the gate):

- **D1** same-repo/different-module evidence (`operator claim-registration warning`) — proves
  selection is finer than repository match.
- **D2** different-domain evidence (`sympy latex printer regression`) — proves domain relevance.
- **D3 + D4** two skill seeds, one a duplicate of the other (the real `implement` seed shape) —
  prove skills are excluded from pickup and duplicates collapse.
- **No-result:** a second scripted session whose message shares no terms with any fixture.
- **Unavailable:** the existing 503 scenario, retained.

### 4.4 How fixtures enter the real corpus path

Two deployments of the same files:

- **Automated gate:** the existing `CorpusFixture` local HTTP server in
  `stage1-stock-product.py` serves them over `/capture-meta`, `/ipfs/{ref}`, and the artifact
  endpoints — the **real built `jinn-layer`** performs search, get, and packet projection against
  it. No plugin stubs.
- **Manual walkthrough / dogfood:** a new `seed episodes` source in the seed-import lane
  publishes the same files to the real testnet corpus via the production `capture() → publish()`
  path (seed-profile scrub, idempotent, `supersedes` on re-import), so `/jinn` retrieval in a
  live session exercises indexer + IPFS end to end.

### 4.5 Automated assertions (mapping the seven scenarios)

1. **Relevant evidence provided:** target-message session's injected context contains a
   distinctive source-episode *content* string (an excerpt line that is not any search term) and
   the packet header — proving content, not metadata, was supplied.
2. **Most relevant wins:** source ref present; D1/D2 refs absent from the injection.
3. **Honest no-result:** no-result session injects nothing; summary and `/jinn session` render
   `nothing relevant found`.
4. **Retrieval unavailable:** 503 session proceeds; degraded reason recorded; no injection.
5. **Attribution:** injected block carries `source: <ref>` + origin + `corpus_fetch <ref>`
   pointer; `/jinn session` lists the provided ref.
6. **Exactly one episode / candidate / history row** per completed session, with
   `activity.searchedTerms` and `activity.providedRefs` populated in the episode.
7. **Sharing off:** publication state `disabled`; the fixture server records **zero** outbound
   POSTs; everything retained locally.

Plus the boundary assertions: injected context contains no `skills install`; session summary,
`/jinn session`, `/jinn status`, and history default output contain no installed-skill state;
skill fixture refs never appear in any injection.

### 4.6 Manual walkthrough and retained evidence

On stock pinned Hermes + pip wheel + built layer, testnet corpus seeded via §4.4: perform task B
for real; confirm the packet appears, is attributed, and reads as useful; complete the session;
inspect `/jinn session`, `/jinn history`, `/jinn ledger`; run the sharing-off variant. Retain and
attach to #1654: the injected context block verbatim, the episode file (path + `providedRefs`),
the candidate JSON (redacted diff acceptable), history output, the searched-terms line, and the
proceed / iterate / stop decision.

## 5. Work decomposition

Eight units. Every unit is one GitHub issue → one PR → `next`, independently green. Ownership
boundaries are package-disjoint where units run in parallel; convergent contract changes are
sequential.

| # | Shape / Effort | Title | Depends on | Parallel with |
|---|---|---|---|---|
| R0 | docs / Low | File walkthrough record; amend Stage 1 docs to the evidence scope | — | — (first) |
| R1 | feat / High | Evidence-first pickup core: terms, selection, knowledge packet, activity states (`packages/plugin`) | R0 | R4 draft |
| R2 | feat / Medium | Content-capable corpus adapter + `session pickup` response; seed-import idempotency (`harness-layer`) | R1 | R4 draft |
| R3 | feat / Medium | Host switch: delegated pickup, `searched → provided` surfaces, skills/rewards surface removal (`apps/jinn-agent`) | R2 | R4 |
| R4 | feat / Medium | Evidence-episode seed lane + curated Stage 1 seed set + testnet runbook | R0 (final tags after R1) | R1–R3 |
| R5 | test / Medium | Acceptance gate rewrite: evidence scenarios, boundary assertions, static pins | R3 + R4 | — |
| R6 | docs / Low | Walkthrough re-run; record proceed/iterate/stop on #1654 | R5 (+ R4 testnet seeding) | — (last) |
| R7 | chore / Low | Corpus seed hygiene on testnet (dedupe/supersede duplicated + scrub-defaced skill seeds) | R2 | R3–R6 |

Merge order: **R0 → R1 → R2 → R3 → R4 → R5 → R6**, with R7 floating after R2. The E2E-critical
chain (question 15's "smallest complete implementation") is R1 → R2 → R3 with one seed fixture and
R5's scenario 1 — everything else in R4/R5 completes coverage, and no unit ships partially.

Two small riders are folded rather than filed separately: the `plugin.yaml` `post_llm_call`
manifest fix rides R3 (same files); episode-retention enforcement (`evidence-adapter.ts:40`
declares `maxEpisodes: 200`, nothing prunes) rides R2 (same package, ~20 lines + test).

### R0 — docs: file the walkthrough, ratify the rescope

- **Context:** the drift evidence exists only in the operator session; the Stage 1 docs still
  specify the skill-flavored consumption surface.
- **Deliverables:** §0 posted to #1654 as the walkthrough record with the **iterate** decision
  (AC3 stays open for R6's re-run); this plan committed; amendments landed in the same PR:
  - `docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md` §4.2 (evidence
    retrieval, `searched → provided`, skills bullet removed, corpus content = evidence), §4.5
    (history vocabulary), §4.6 (retrieval failure wording), §7 (acceptance journey), §8
    (non-goals per §1 above), §9 (record this drift and its resolution).
  - `docs/superpowers/plans/2026-07-14-jinn-plugin-stage-1-plan.md` §3 "Host product experience"
    (states) and §4 coverage lines.
  - `docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-package-architecture.md` §3/§4/§10:
    `SkillsPort` and `plugin.skills.*` marked later-stage/quarantined; reconciles the shipped API
    subset (**Closes #1755**).
  - `spec/2026-07-02-jinn-harness-network.md` §7 note: Stage 1 acceptance requires evidence
    seeds; skills.sh seeds remain for later stages but are excluded from Stage 1 pickup.
- **Completion:** docs merged; #1654 comment posted; new sub-issues R1–R7 filed and linked.
- **Tests:** none (docs). Human review (canonical-adjacent docs).

### R1 — feat: evidence-first pickup core (`packages/plugin`)

- **Files:** `src/pickup.ts` (rewrite: `deriveSearchTerms`, selection policy, floor, dedup),
  `src/schemas/knowledge-packet.ts` (new), `src/schemas/knowledge-hit.ts` (evidence-first hit
  shape; drop the skill-preference semantics), `src/schemas/episode.ts`
  (`SessionActivityFactsSchema` + `searchedTerms`/`providedRefs`, legacy fields accepted),
  `src/schemas/session-summary.ts` (new fields), `src/ports/corpus-port.ts` (`get` returns a
  content-bearing `CorpusRecord`), `src/plugin.ts` (`firstTurnPickup` returns
  `{ contextBlock, packets, searchedTerms }`; no skill-install path), `src/testing/in-memory-corpus.ts`,
  `src/history.ts` + `src/schemas/history-entry.ts` (provided counts).
- **Interfaces produced:** `projectKnowledgePacket(record, budget)`;
  `FirstTurnPickupResult = { contextBlock: string | null, packets: KnowledgePacket[], searchedTerms: string[], degraded?: string }`.
- **Completion criteria:** §3.2–§3.6 behaviors on in-memory ports; skill hits never selected;
  floor produces honest empty; budgets enforced; **Closes #1729** (the adopt-claim path no longer
  exists).
- **Tests (rewrite in place):** `test/pickup.test.ts`, `test/plugin/first-turn-pickup.test.ts`,
  `test/schemas/{knowledge-packet,knowledge-hit,session-summary,episode}.test.ts`,
  `test/history.test.ts` — scenario shapes mirroring §4.5 items 1–5 at unit level.

### R2 — feat: real adapters + process contract (`client/packages/harness-layer`)

- **Files:** `src/adapters/corpus-adapter.ts` (get → full decoded content via existing
  `consume.get`), `src/cli.ts` (`session pickup` response envelope gains
  `packets`/`searchedTerms`; additive, `contractVersion` stays 1),
  `src/seed-import/execute.ts` (+`plan.ts`): idempotency by seed identity (skip when already
  published; set `supersedes` on re-import), `src/adapters/evidence-adapter.ts` (enforce the
  declared newest-200 episode prune).
- **Completion criteria:** contract kit passes against the real adapter with network mocked;
  `process-contract.test.ts` asserts the response is additive-v1 and includes the new fields;
  re-running seed execute twice publishes once.
- **Tests:** harness-layer port contract kits, `process-contract.test.ts`, seed-import tests,
  evidence-adapter retention test.

### R3 — feat: host switch + surface cleanup (`apps/jinn-agent`)

- **Files:** `plugins/jinn/pickup.py` (thin delegation to `jinn_layer` `session pickup`; render
  returned `contextBlock` verbatim; record `searchedTerms`/`providedRefs`; treat a v1 response
  *without* `packets` as degraded-nothing so a stale layer cannot reintroduce install hints),
  `plugins/jinn/__init__.py` (drop the `/jinn skills` command branch and pickup's skill wiring;
  activity keys), `plugins/jinn/session_view.py` + `history_view.py` (`searched → provided`),
  `plugins/jinn/onboarding.py` + `consent.py` (remove rewards/OLAS/node-stub copy and `/jinn
  rewards` references), `plugins/jinn/plugin.yaml` (declare `post_llm_call`), `_JINN_HELP`.
  `skills_install.py` stays (distill install path); its command surface goes.
- **Completion criteria:** pickup path has one implementation (the core); **Closes #1732**;
  disabled/stock behavior unchanged; degraded paths keep their existing honest lines.
- **Tests (rewrite in place):** `test_jinn_pickup.py` (delegation + rendering + degraded),
  `test_jinn_session_view.py`, `test_jinn_history.py`, `test_jinn_onboarding.py`,
  `test_jinn_layer_verbs.py`, `test_jinn_plugin.py` (command set), `test_jinn_skills_install.py`
  trimmed to the distill-install path.

### R4 — feat: evidence seed lane + Stage 1 seed set

- **Files:** `client/packages/harness-layer/src/seed-import/` (episodes source: read seed-episode
  JSON, seed-profile scrub, publish via `capture() → publish()`), curated fixtures under
  `apps/jinn-agent/scripts/fixtures/stage1-seeds/` (source episode per §4.2, D1–D4, authored
  after recording task A), `docs/runbooks/stage1-evidence-seeding.md` (record → transform →
  publish → verify retrievable), CLI verb wiring in `cli.ts`.
- **Completion criteria:** the seed files round-trip the real publish path onto a local corpus
  and the testnet corpus; re-execution is idempotent; the source seed's packet projection (R1
  function) contains the failure/fix excerpts; no absolute paths or private material in any
  fixture (scrub-verified).
- **Tests:** seed-import episode-source tests; a fixture-lint test (schema-valid, scrubbed,
  deterministic ordering).

### R5 — test: acceptance gate rewrite

- **Files:** `apps/jinn-agent/scripts/stage1-stock-product.py` (CorpusFixture serves the R4 set;
  scenarios per §4.5 including the boundary assertions; skill-journey steps removed),
  `apps/jinn-agent/tests/plugins/test_jinn_stage1_acceptance_gate.py` (static pins updated),
  `.github/workflows/jinn-agent-ci.yml` only if step names change.
- **Completion criteria:** the blocking `cold-stock-e2e` job runs all §4.5 scenarios green on
  pinned stock Hermes + wheel + real layer; contribution/privacy scenarios retained unchanged;
  grep-level boundary assertions in place.
- **Tests:** the gate is the test; the static contract test pins it.

### R6 — docs: the walkthrough, again

- Run §4.6 against the seeded testnet corpus on task B; attach the retained evidence to #1654;
  record proceed / iterate / stop. #1654's final AC closes only here.

### R7 — chore: testnet seed hygiene (floating)

- Re-import the skills.sh seed set through the R2 idempotent path with the current (#1409)
  scrub profile; mark the duplicated and scrub-defaced legacy rows superseded; verify
  `resolveHeads` collapses them and capture-meta stops returning duplicates. Not on the gate's
  critical path (pickup excludes skills from R1 on); it repairs the shared corpus for the corpus
  tools and later stages.

## 6. Final Stage 1 acceptance gate

Automated (blocking `cold-stock-e2e`, pinned stock Hermes `9df5f879…` + pip wheel + real built
`jinn-layer` + fixture corpus over the real rails):

1. Target-task session: agent context contains ≥1 knowledge packet whose body includes
   source-episode content (an excerpt string that is not a search term), with `source: <ref>`
   attribution and a `corpus_fetch` pointer; distractor and skill refs absent.
2. States: `◇ corpus — provided …` at point of use; session summary and `/jinn session` show
   `searched <terms> · provided N`; the episode's `activity.searchedTerms`/`providedRefs` match.
3. No-result and corpus-503 sessions proceed and say so honestly.
4. Session end: exactly one episode, one contribution candidate, one history row.
5. Sharing off: publication `disabled`, zero outbound writes observed by the fixture server.
6. Boundary: no `skills install` text in any injection; no installed/applied skill state in
   summary, session, status, or history default output; disabled plugin remains stock-silent.

Manual (closes #1654): the §4.6 walkthrough on real task B with the seeded testnet corpus,
evidence attached, decision recorded.

This gate proves relevant prior knowledge reached the agent, the session became reusable
evidence, contribution and privacy behaved, and no shared-skill workflow was required or exposed.

## 7. Contradictions register (roadmap ↔ design ↔ implementation ↔ tests)

1. Roadmap (skills are Stage 3) and distillation-v1 D11 (retrieval-over-evidence is the v1
   baseline) vs Stage 1 product design §4.2 (skills install as a during-work surface; corpus
   content "seeds + prior traces + distilled skills") — the design drifted; R0 amends it.
2. D11 vs code: pickup's tier asymmetry made skills the only surfaceable content — inverted the
   ratified baseline. R1 restores it.
3. Product promise (evidence retrieval) vs corpus reality (skill seeds only; verified live) —
   D8 seeding was built for a different stage's content. R4/R7 fix supply.
4. The acceptance gate itself encodes the skill journey (driver + static pin) — the gate pinned
   the drift. R5 re-points it.
5. Package-architecture §3 public API (`plugin.skills.*`) vs Stage 1 scope — already flagged as
   #1755; R0 resolves.
6. "Searched" was never a recorded fact anywhere despite being the product's first claim — R1/R3
   add it.
7. `plugin.yaml` declares 4 hooks; code registers 5 (`post_llm_call`) — R3 rider.
8. Evidence retention declared (`maxEpisodes: 200`) but unenforced — R2 rider.

## 8. Execution plan (multi-agent, via GitHub)

- File R1–R7 as sub-issues of #1654 (issue type per shape; bodies = context + impact + acceptance
  criteria from §5, linking this plan; Project fields: Blocked-on `Another issue` per the table,
  Effort per §5). R0 is the filing PR itself.
- Ownership is package-disjoint: after R0, R1 (`packages/plugin`) and R4-draft (fixtures +
  runbook) run as two agents without file overlap; R2 → R3 → R5 are sequential hand-offs on the
  contract chain (each cut from `next` after its dependency merges — the convergent files are
  `cli.ts`, `pickup.py`, and the gate driver, so they must not run concurrently); R7 follows R2
  and floats beside R3–R6 (testnet ops + `seed-import` only).
- Every PR targets `next`, independent review, no self-merge; R0 and R6 are human-surface.
- Existing issues folded: #1729 closes with R1, #1732 with R3, #1755 with R0. #1486/#1561
  (local distillation) and #1742 (mining evolution) stay independently owned. #1754 (plugin-ci
  client-compat job) remains open and is worth landing before R1 since R1–R2 exercise exactly
  that seam.

The loop this plan restores is the one the roadmap promised: evidence in, evidence out, one
coherent experience in between — and nothing user-facing that Stage 1 cannot honestly claim.
