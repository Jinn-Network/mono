# Colophon GTM Execution Program v1

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-08-10 |
| **Author** | GTM execution design session (Ritsu + Claude Fable 5) |
| **Shape** | `design` (output: this execution program) |
| **Depends on** | [`2026-08-10-benchmark-product-gtm-plan.md`](./2026-08-10-benchmark-product-gtm-plan.md) (the strategy this executes), [DR-2026-08-10](../../../log/decisions/2026-08-10-product-led-gtm-and-first-market.md) (commitment-gated discovery, default beachhead), [`2026-08-05-benchmark-product-design.md`](../specs/2026-08-05-benchmark-product-design.md) (the product, §7.1 venue honesty, §8.1 must-not-imply, §9 branding), [`GROWTH.md`](../../../GROWTH.md) §4–§8 (the engine) |
| **Does not do** | Ratify GROWTH.md decision 1 (that is the linked Discussion + CODEOWNERS PR); change pricing beyond the nominal design-partner fee; build product beyond Lane A's readiness items; build substrate machinery (Lane E records gaps, it does not close them) |

The three-week program that starts executing the Colophon GTM plan. Strategy
lives in the GTM plan; this document is who does what, in which order, with
which gates. The program shape is **spearhead + ammunition**: shortest path to
one real customer report used in one real decision, with demo reports
manufactured first as outbound ammunition, and every other channel staged
around that spine.

## 1. Program frame

- **Product:** Colophon — display name, category descriptor ("Benchmark
  publishing for agent configurations"), tagline ("Compare agents on the same
  work."), promise ("Publish benchmark claims people can check."), attribution
  ("Built on Jinn.") — per the colophon design-system branch's
  `branding.ts`.
- **Duration:** 3 weeks, reviewed twice weekly (Mon/Thu) against the engine
  log.
- **Operating model:** Ritsu fronts every human-contact surface — sends,
  calls, campaign operation, publish decisions. Agent sessions do everything
  behind that line: trigger scanning, prospect research, outreach drafting,
  list building, campaign prep, demo-report production, record sealing.
  Autopilot stays on engineering.
- **Fee posture:** nominal design-partner fee ($250–$1k), collected
  out-of-band (invoice or crypto; billing is deferred product-side). A costly
  signal, not revenue.

### Gates (controllable) vs outcomes (pursued)

End-of-program gates — all within our control:

1. Merge train closed: #2541 → colophon design-system → #2551 ratified.
2. Public surface live on Colophon's own origin.
3. ≥2 published demo reports.
4. ≥15 Track-1 conversations logged across ≥3 of the five pools (revised
   from 20 with the 2026-08-10 cold-only amendment — no warm-network day-1
   volume; 20 remains the stretch).
5. ≥5 one-page campaign proposals delivered to proposal-qualified prospects
   (live claim + real deadline; see Lane C).
6. Every attempt recorded per Lane D/E — written prediction first, no
   exceptions.

Pursued outcomes — not gates, because prospects control them:

- ≥2 committed design-partner campaigns underway (the four-element bar).
- 1 customer report published (stretch).

## 2. Lane A — readiness close-out

**Merge train (days 1–3).** #2541 merges to `integration/evidence-v1`; the
colophon design-system branch (local `codex/colophon-design-system`) is
pushed, PR'd, and merged on top; #2551 ratifies alongside. Anything blocking
#2541 is the program's first fire. Campaign *setup* may start on a branch
build; official campaign runs happen on merged code.

**Public surface (days 1–5).** Colophon gets its own origin — separate
branding per product design §9 means not a jinn.network path. Minimum
viable: one page carrying the category descriptor, promise, the demo
reports, the quickstart, and a contact/interest route; plus hosted report
bundles (the static-bundle export exists — hosting is "where static files
live under the Colophon domain," not new product work). Domain choice is
Ritsu's; the build is agent work inside the landed design system.

**Demo-topic spike (days 1–2, `spike` shape).** Agents generate ~10
candidate comparisons and score them on five criteria:

1. **No horse** — nothing that ranks Jinn's own stack against competitors.
2. **Live community** — a group that already argues about this question
   (distribution built in).
3. **Runnable now** — current capabilities only: local venue, shipped
   launchers/evaluators, or Inspect-importable tasks.
4. **Genuinely open** — a non-obvious result is shareable; a foregone
   conclusion is not.
5. **Days, not weeks** — runnable at nominal compute inside the program.

Seeded directions: skill/plugin efficacy claims ("does skill X actually help
on task class Y" — a rigorous null is itself interesting);
harness-version regressions; thinking-effort tradeoffs on agentic tasks; MCP
tool-loadout comparisons; **a policy-optimization campaign over harness
loadout variants** (native sealed-Run output; nichest and most
differentiated; carries integration risk — the live host sits on an
unmerged branch). Fallback if the spike fizzles: generic model-inside-one-
harness and configuration comparisons. Ritsu picks two.

**The ammunition (days 2–5).** Two demo reports produced by dogfooding the
real product end-to-end — locked method, complete accounting, disclosed
limitations, published bundle. Each leads with the §7.1 self-run
disclosure: the honesty is the demo. Every derived asset passes the §8.1
must-not-imply list before publication.

## 3. Lane B — demand (Track 1)

**Cold-only, pseudonymous** (amended 2026-08-10: the warm network is
excluded — the GTM runs under the operator's pseudonymous persona, and the
warm network knows the operator otherwise. Persona setup and deliverability
mechanics live in the operator-private identity checklist under
`growth/.local/colophon/`). Conversations are **async-first**: DM and email
threads are the default "20-minute conversation"; calls only if the
operator decides the persona does calls.

**Channel staging** (each launch is an engine attempt with its own written
prediction):

| Channel | Opens | Condition |
|---|---|---|
| Trigger scanning + prospect list-building | Day 1 | None — research needs no identity or artifact |
| Ecosystem embedding (Inspect community, evals discourse) | Day 1 | The persona account exists (it does); contributor posture, never advertiser — now the reputation channel, not a week-2 background thread |
| Cold sends — X DMs first | ~Day 5 | Demo report #1 live (the artifact is the credibility; DMs need no domain warmup) |
| Cold sends — email | ~Day 8–10 | Demo #1 live + send-domain warmup ≥5 days in |
| Public push (X thread, launch-adjacent posts) | When surface + both demos are live | The launch moment; spent once |

**Mechanics.** An agent-run trigger scanner sweeps X/GitHub/HN/release posts
for live benchmark claims across the five pools and outputs candidates with
the specific claim quoted; Ritsu approves every send. Outreach follows GTM
plan §8.1 — about their claim, never about our category. The ask is a
20-minute conversation, not a demo. Cadence target: ~7 conversations/week.

**Interview core** (five questions, tagged by pool in the log):

1. What live claim or decision are you carrying right now?
2. How do you evaluate today — what does the workflow actually look like?
3. Where does the result cross a trust boundary, and who is skeptical?
4. What would make the evidence credible to *that* audience?
5. What would you commit to a design-partner campaign? (the four-element
   bar, probed gently)

**Privacy:** prospect table and pipeline live in `growth/.local/colophon/`
(operator-private, gitignored — the mono is public; prospect data never
enters it, and never enters any corpus).

## 4. Lane C — campaigns (Track 2)

- **Proposal-qualified** = a prospect with a live claim or decision and a
  real deadline (surfaced in the interview). They get the one-page proposal
  within 48h: named comparison, task source, assurance preset, price,
  timeline, deliverables (report + portable bundle + published claim
  assets).
- **Committed** = accepted the proposal and meets the DR's four-element bar:
  pays something; supplies representative tasks; names the decision the
  report supports; real deadline. No exceptions — enthusiasm without all
  four does not start a campaign or trigger any build.
- **Concurrency cap: 2 campaigns.** Ritsu operates them personally; manual
  steps are tracked as productization candidates (the anti-consultancy
  control from GTM plan §13).
- **Domain capability builds only on commitment** (DR decision 3), and land
  as platform packages under tier discipline, never in the product tree.

## 5. Lane D — instrumentation (split by what the instrument can honestly measure)

The engine and the pipeline get different treatment because their sample
regimes differ, and forcing one instrument onto both manufactures false
rigor (the learning-engine doc's multiple-comparisons warning).

**Broadcast lane — full engine.** Colophon gets its own engine instance:
`growth/.local/colophon/growth-loadout.md` + `growth-experiment-log.md`,
driven by the growth-experiment skill (PLAN → LOG → EVOLVE). Every broadcast
attempt — each channel launch, the X thread, each demo-report push — gets a
written prediction (concrete number, comparison, or binary), one knob varied,
actuals by Mayfield rung, N≥2 before EVOLVE acts. Expected volume: 6–8
attempts over three weeks. First-week verdicts will be `inconclusive` by
construction (no baseline exists — the engine has never been run); that is
the engine working, not failing.

**Pipeline lane — discipline without the instrument.** Sales conversations
are anecdotes, not samples; the rungs don't model funnel stages and N≥2
per rung-knob pair would never fire in three weeks. Instead: one written
prediction per outreach *batch* (e.g. "of 15 trigger-scan sends quoting a
specific claim, ≥3 reply and ≥1 books a call"), a plain pipeline table, and
the domain rubric scored **once, at program end**, as an explicitly
qualitative read — never a numeric winner. Conversations are tagged by pool
as they happen; no mid-program domain pivots.

**Review cadence:** Mon/Thu — funnel position, verdicts, evolve decisions,
gap-log triage.

## 6. Lane E — evidence-native recording (the work becomes corpus-shaped)

The principle: **GTM work is stored and recorded in Jinn's language — Task,
EvaluationSpec, delivery, verdict — so it can become evidence in the data
layer.** Nothing dispatches anywhere: no marketplace, no on-chain activity,
no live evidence ceremony. Sealed local records only.

**The mapping per broadcast attempt:**

- **Task** — the attempt: artifact content digest, channel, audience slice.
- **EvaluationSpec** — the prediction, as "what counts as success": the
  concrete threshold and the `closeAt`-style boundary ("judge at T+72h").
  Sealed *before* the send — pre-registration, the same move as Colophon's
  method locking.
- **Delivery** — the send: artifact as posted, timestamp, URL.
- **Verdict** — at the boundary, actuals collected (Ritsu-supplied metrics /
  X API reads) and judged **LLM-with-Ritsu in session**, sealed self-signed
  with the evaluator identity disclosed. Self-signed is the tier these
  records deserve, and the evidence-tier vocabulary already says so
  (attested > committed > self-signed) — honest by construction.

**Rights split:** broadcast-lane records (public posts about a public
product) are corpus-eligible. Pipeline-lane records are operator-private
forever; prospect data never enters any corpus.

**Tooling posture:** the sealing helpers exist as public package exports
(`sealTask`, `sealEvaluationSpec`, DSSE via trust-core); a thin
agent-built helper wraps them for the attempt shape. Overhead budget:
minutes per attempt. If it ever costs more, recording drops to gap-logging
only, without ceremony — Lane E never gates a send.

**The gap log.** Every place the substrate cannot express what the program
needs — an external-API oracle evaluator at a close boundary, human/LLM
judging surfaces, rights/consent tagging for corpus inclusion, delayed-close
tooling — goes in a running gap log. End of program, gaps become filed
issues. Substrate builds are chartered separately on their own merits (the
commitment-gated principle, applied internally): **this program records
gaps; it does not close them.**

**The kicker (held, not promised):** the sealed attempt trail is raw
material for a future demo report — "the Colophon launch, fully accounted."
Decided at program end, not before.

## 7. Three-week calendar

**Week 1**

- Days 1–2: merge train; demo-topic spike (agents, parallel); trigger
  scanning + prospect list-building begin; ecosystem embedding starts from
  the persona account; identity checklist executed (send domain, mailbox,
  SPF/DKIM/DMARC, warmup start); domain picked; surface build starts;
  GROWTH.md Discussion opened (blocks nothing); Lane E helper built.
- Days 3–5: demo report #1 produced + published; surface live; first cold
  DM batch approved and sent.
- **Gate:** train merged, surface live, demo #1 up, ≥40 trigger-qualified
  prospects listed, email warmup underway.

**Week 2**

- Demo report #2; cold outbound at full cadence; ecosystem embedding begins;
  first proposals out; public push (X thread) once both demos live.
- **Gate:** ≥6 cumulative conversations, ≥2 proposals delivered.

**Week 3**

- Proposals pushed to commitment; first campaign starts the moment one
  lands; cadence continues; end-of-program review — rubric scored
  (qualitative), engine log read, gap log triaged into issues, program v2
  decided.
- **Gate:** ≥15 conversations (stretch 20), ≥5 proposals. (≥1 commitment:
  pursued outcome.)

## 8. Risks and firebreaks

1. **#2541 merge stalls** (48-commit train) — first fire; only official
   campaign runs wait on it; every other lane proceeds.
2. **Spike finds no exciting topic** — generic comparisons are the accepted
   fallback; weaker ammunition beats none.
3. **Cold reply rates too low** (no warm-network floor under the funnel) —
   the persona's established account age and DM-first sends mitigate the
   fresh-identity cold-start; if replies still lag, shift weight to
   ecosystem embedding and let the demo reports pull inbound rather than
   raising send volume.
4. **Claim discipline** — every outward artifact passes the product design
   §8.1 must-not-imply list; demo reports lead with the self-run disclosure.
   The pitch through this program is disciplined, verifiable
   self-publication — independence language stays future-tense.
5. **Scope creep into substrate work** — Lane E's gap log is the pressure
   valve; builds are chartered separately.
6. **GROWTH.md Discussion drifts** — opened week 1, blocks nothing, but the
   program's engine usage is already sanctioned by DR-2026-08-10 decision 3
   (the discipline, not the canonical-doc revision).

## 9. Out of scope, named

- The optimizer (`policy-optimization`) as GTM machinery — its statistics
  need manufactured trials; growth attempts are one-shot with audience
  memory. It enters the program only as a seeded spike candidate (demo
  report subject) and as the later "now improve what you benchmarked"
  upsell story — one line here so it is not lost, nothing more for three
  weeks.
- Hosted collaboration, billing, marketplace-venue surfaces.
- The venue-honest copy pass on GTM plan §3–§4 (tracked in DR "Deliberately
  unresolved"; §8.1 compliance on program artifacts is in scope).
- Any beachhead selection — coding remains the revisable default; the
  domain rubric is read once at program end.

## 10. Program-end review (the week-3 deliverable)

One session, producing: the qualitative domain read; engine verdicts and
loadout evolution; pipeline state (proposals, commitments, first campaign
status); gap-log issues filed; the "launch, fully accounted" demo-report
decision; and program v2 — extend, reshape, or hand off to a standing
cadence.
