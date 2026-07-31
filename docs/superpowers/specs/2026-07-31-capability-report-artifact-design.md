# Capability Report Artifact — badge, card, report

- **Version:** 0.1
- **Date:** 2026-07-31
- **Author:** Ritsu (design session, Claude Fable 5)
- **Shape:** `design` — output is this document
- **Status:** approved in session (Ritsu, 2026-07-31); pending written review
- **Parent:** [`2026-07-30-skills-factory-mvp-design.md`](2026-07-30-skills-factory-mvp-design.md)
  v0.2 (author-first distribution; Jinn as neutral evaluation infrastructure). This document
  specifies the deliverable that v0.2 §1 calls "the capability report" and does not restate its
  reasoning.
- **Supersedes:** v0.2's assumption of a public-evaluation / private-optimization split. Per the
  2026-07-31 call, delivery is via a GitHub issue on the author's repository, which is public by
  construction; **everything is public.** Neutrality is asserted through disclosed methodology and
  reproducibility, not through withholding the annex.

---

## 1. What an author receives

Three artifacts, one identity: every one is pinned to `<skill>@<sha>`, where `sha` is the short
form of `pin.json.commit` (the resolved upstream commit, not a branch).

| Artifact | Form | Lives |
|---|---|---|
| Badge | small SVG | author's README, if they choose to embed |
| Card | large SVG | top of the delivery issue; top of the hosted report; author's README optionally |
| Report | markdown | body of the delivery issue; hosted in full |

**Both badge and card are SVG images, not markup.** GitHub issues strip HTML and CSS, so a card
built as markup cannot render where it is delivered. Serving both as images from one endpoint
family also makes the card embeddable by the author, not merely viewable on our page.

**The card carries the numbers; the report does not repeat them.** This is the load-bearing
division. The report is the narrative layer — cohort position, diagnosis, evidence, and the
suggested change — and is materially shorter for it.

---

## 2. Field contract

Every field below already exists in the rig or is named as new work. No field may be rendered from
an estimate where a measurement exists.

| Field | Source |
|---|---|
| `skill`, `skillSha256` | `pin.json` `name`, `sha256` (vendored bytes) |
| `skillSource` | `pin.json` `source@commit` |
| `license`, `repoLicense` | `pin.json` (frontmatter-only, and repo-root fallback) |
| `model`, `agent` | `ReceiptProfile.model`, `.agent` |
| `measuredOn` | `ReceiptProfile.measuredOn` |
| `taskSetSha256`, `sourceKind` | `ReceiptProfile.slateSha256`, `.sourceKind` (`slate` \| `task-set`) |
| `domain` | `SkillTaskSetV1.domain` |
| `n`, `excluded` | `ReceiptData.n`, `.excluded` |
| baseline / treatment resolved + interval | `ReceiptData.baseline`/`.treatment` `{passed, scorable, lo, hi}` (Wilson) |
| `improved`, `regressed` | `ReceiptData.paired` |
| cost per task | `ReceiptData.meanCostUsd.{baseline,treatment}`; overhead = ratio − 1 |
| **trigger rate** | trigger-rate extraction from session JSONL — loads **measured**, never self-reported |
| discrimination provenance | discrimination gate: task set screened baseline-only, failing tasks kept |

**Derived, never stored:** concordant counts (`n − improved − regressed`, split by outcome) and
cost overhead percentage.

---

## 3. Badge

**Variant C — three axes.** Chosen over effect-only, cohort-rank-only, and letter grade.

```
[ jinn ][ +2 tasks ][ loads 9/12 ][ +17% cost ]
```

Reasoning, recorded so it is not relitigated: **the effect number is the rig's least reliable
measurement.** At n≈12 the paired delta is noisy and its interval wide, while trigger rate is a
direct observation from session logs and cost overhead is exact. A badge leading with effect alone
leads with the weakest number. Segment 2 takes the success tint when positive, the danger tint when
negative, neutral at zero.

**Cohort rank badge** ships alongside, only where a niche cohort was measured:

```
[ jinn · <domain> ][ 2nd of 6 ]
```

Rank is a defensible ordinal claim even when magnitudes are noisy. It may never be the only badge —
alone it hides whether second place means +2 or −5.

**No letter grades.** A grade implies precision twelve tasks cannot support, converts a measurement
into a judgment (materially harder to post unsolicited on someone's repository), and invites
optimization against a rubric rather than against real work. Revisit only if task-set size grows
enough to support it.

---

## 4. Card

Sections, in order:

1. **Identity** — `<skill>@<sha>`, "evaluated by jinn", date. Date is on the face; an undated
   capability claim is the classic stale-badge failure.
2. **What was evaluated** — task count, domain, that tasks were screened so the agent fails them
   unaided, the agent and model. Without this a badge is an assertion; with it a reader knows the
   claim's shape before clicking.
3. **Three metrics** — tasks solved (`baseline → treatment` of `n`), skill loaded (`x of n`), token
   cost (`±y%`). Effect tinted by sign; the other two neutral.
4. **Cohort line** — rank within niche, plus any superlative the data supports (e.g. best result per
   token). Omitted entirely when no cohort was measured.
5. **Footer** — the honesty line (`n=<n>, intervals overlap — direction, not proof`) and a link to
   the full report.

Visual rules follow `DESIGN.md`: softened-brutalist corners, no gradients, no emoji, sentence case.

---

## 5. SVG endpoints (new work)

```
GET /badge/<skill>@<sha>.svg        variant C
GET /badge/<skill>@<sha>-rank.svg   cohort rank, 404 when no cohort
GET /card/<skill>@<sha>.svg         the card
GET /r/<skill>@<sha>                hosted report (HTML)
```

Requirements: deterministic render from stored report data (same input, same bytes); immutable per
`skill@sha` — a revised skill gets a new sha and therefore a new evaluation, never an updated one in
place; `Cache-Control` long-lived since content is immutable; unknown `skill@sha` returns 404 rather
than an empty badge.

---

## 6. Report structure

Issue body, beneath the card image. Sections in order:

1. **Title** — the most interesting true finding, not the flat number. Cohort position and any
   superlative belong here.
2. **Opener** — one sentence: what was measured, that it is public and reproducible, that nothing is
   asked of the author.
3. **Cohort table** — one row per skill measured in the niche: skill, installs, loaded on, net
   tasks, cost vs baseline. Focal skill bolded.
4. **Result in words, not numbers** — the card holds the figures; here state what the paired outcome
   means in plain language ("solved 3 the baseline missed, missed 1 it solved"), and state the
   uncertainty honestly.
5. **Where it did not load** — the trigger-rate diagnosis, with the specific `description` gap.
6. **Pattern worth testing** — any conditional signal, **explicitly labelled as hypothesis, not
   finding**, with a transcript excerpt as evidence.
7. **What we would change** — at most three concrete edits.
8. **Scope** — one model, one agent, n tasks, one domain; what it does not tell you.
9. **Reproduce** — report URL, rerun command, and the invitation to substitute their own task set.
10. **Re-evaluation offer** — revise and reply; re-measured on freshly drawn tasks that were not
    used to derive the diagnosis.
11. **Footer** — "Evaluated by [Jinn](https://jinn.network)." Nothing further.

**No closing neutrality claim.** Earlier drafts ended "we don't publish skills and don't sell
placement." Removed: a self-asserted neutrality claim is exactly the kind of unverifiable statement
this product exists to replace. Neutrality is demonstrated by the disclosed method and the rerun
command, or it is not demonstrated at all.

### 6.1 Null variant

Roughly four reports in five will show no measured effect (see §7). The null is the design's primary
case, not its exception, and the structure is unchanged except:

- **Title** leads with the diagnosis, not the zero: `measured, no effect found (trigger rate 3/12)`.
- **§4** states the finding plainly and immediately hands over to the trigger-rate reading — where
  the skill loaded on few tasks, the null is a discoverability result, not a quality result, and the
  report must say so in those words.
- **Base rate is cited**: most publicly measured skills show no pass-rate improvement
  (SWE-Skills-Bench, 39 of 49; arXiv 2603.15401). This makes a null the normal result rather than a
  verdict, which matters when it lands unsolicited on someone's repository, and it makes a positive
  result mean something.
- Where trigger rate is high **and** effect is null, say that too: the skill was given its chance and
  did not change outcomes. That is the honest hard case and must not be softened.

### 6.2 Degrading variant

Deferred. A report for a skill that measurably harms performance needs the most careful wording of
the three and should not be drafted from a specimen — write it against the first real instance.

---

## 7. Consequences the artifact imposes

**Niche-batch evaluation, not one-off skills.** The cohort table is the report's most engaging
element and the strongest reason for an author to read it. It exists only if a whole niche is
measured together. This makes cohort batching a product requirement, not a scheduling preference.

**The specimen exceeds the modal outcome.** Any sample report used in outreach sits above what most
authors will receive. Until real reports exist, the offer must label the sample as illustrative and
cite the base rate; switch to leading with a real report — dull or not — as soon as the pilot
cohort produces one.

**Claim discipline** (inherited, restated because this artifact is the public surface): no
significance language; intervals always shown; conditional patterns labelled as hypotheses;
trigger rate measured from logs and never inferred; scope stated on every artifact.

---

## 8. Open questions

1. **Installs column provenance.** The cohort table shows install counts sourced from a registry we
   do not control and cannot verify. Cite the source and date, or drop the column.
2. **Cohort membership.** How a niche is defined and who is included — an omitted competitor is an
   implicit claim, and an included one that was never contacted may object to appearing.
3. **Re-evaluation task draw.** "Freshly drawn tasks not used to derive the diagnosis" needs a
   concrete rule: a reserved partition of the authored set, or newly authored tasks. Reserved
   partition is cheaper; newly authored is stronger. Unresolved.
4. **Hosting.** `reports.jinn.network` does not exist. Endpoint, storage, and immutability guarantees
   are unscoped work.
