# GROWTH

**What this doc is / is not.** This is the canonical statement of how Jinn grows: who we are recruiting, the daily loop that does the recruiting, the metrics that gate mainnet, and what we will explicitly not chase. It is not a campaign log, an asset library, or a tactical playbook — those live in [`growth/`](growth/) and become this doc's appendix. It is also not the thesis (see [`THESIS.md`](THESIS.md)) or the voice canon (see [`BRAND.md`](BRAND.md)); growth derives from both and does not restate them.

## 1. The bet

Growth is recruiting, not reach. The early-stage objective is to convince a small number of legitimate, relevant people of Jinn's legitimacy — and the signal of that conviction is that they run a client. One respected operator running on testnet is worth more than broad awareness. Legitimacy is the scarce resource; reach is downstream of it.

This inverts the default crypto growth shape. We are not building a megaphone. We are recruiting a network.

## 2. The bottleneck

The bottleneck is operator count, not code. The full loop — create → solve → evaluate → claim — runs end-to-end on testnet. Mainnet is gated on enough independent, identifiable, technically credible people running the client on testnet. Target: roughly ten external operators before mainnet.

A founder-only network at mainnet launch would concentrate JINN on two addresses and break the no-pre-mine commitment that the protocol is built around. The operator gate is a structural constraint on launch, not a marketing target.

## 3. Audiences

Audiences are prioritised, with different motivations, channels, and conversion actions; they are not collapsed into one funnel. Specifics deferred — to be filled in.

## 4. The daily loop

Recruiting is a daily practice, ranked by leverage. The first two are the heavy lifts and live in the high-cognition deep block; the second two are afternoon work.

**Teach.** One public artefact per working day on the thesis — outcome mining, the four structural properties, the stress-test framing, the state of the field. Threads, essays, talks, recorded walkthroughs. This is the compounding asset: when the thesis is taught publicly, the right operators self-identify and inbound. If only one action fits in the day, it is this one.

**Understand.** One listening conversation per day with someone adjacent — OLAS, Polystrat, Bittensor operators, prediction-market builders. No pitch. *What are you seeing?* Operators eight through fifty come from this work, not from the warm list. It also stress-tests the thesis live.

**Direct offer.** Weekly cadence to the named warm list; daily would burn it. Public offer cadence can be more frequent. The offer is specific: testnet operator slot, time commitment, what we want them to read, are they in. The no-pile (people who said *later* months ago) is reusable.

**Interact.** One synchronous DM thread, voice note, or Telegram exchange per day with someone on or near the warm list. Async-first. Calendly links read as sales-rep energy in this audience and are not used for first contact.

The closing structure when an operator is engaged: objective → why important → blockers → three ways in (full operator, light operator, advisory steward) → walk through plan. Read the specs, run the client, open a PR or an issue.

## 5. What we will not chase

The negative space is doing as much work as the positive plan.

**No broad cold outbound.** Quality of targets over quantity. A list of seven warm contacts is not pumped for daily contact; it is worked weekly and supplemented by inbound from public teaching.

**No fake scarcity.** Urgency comes from real protocol mechanics — the operator gate, the design window before mainnet, contracts cut on a real schedule. Never invented.

**No fear-bait, empowerment-bait, or marketing register.** Operators we want to recruit pattern-match those instantly and discount the rest. The thesis carries its own weight; defensive framing inverts the architecture of the argument. (See [`BRAND.md`](BRAND.md) §1.)

**No retired framings.** *Own What You Know*, *become a founder*, *your AI's experience is worth something*, *desired obsolescence*, *launch a token*. All previously tried, all retired. Do not revive without a proposal.

**No external phase names.** *Phase 0 / Phase 1a / Phase 1b* are internal engineering vocabulary. External framing is *testnet live, mainnet gated on operator set*.

**No founder framing.** Oak and Ritsu are early network stewards, with the same token access as the next operator, earned through the same mechanism. We do not pitch from a separate status to the reader.

**No mercenary-launch tells.** No VC, no pre-sale, no team keys, no allocation. Communicated plainly because it is a real differentiator, not because it is a slogan.

## 6. Metrics

One headline metric at a time. The current headline is **external testnet operators** — independent, identifiable, technically credible people running the client. Target ~10 before mainnet.

Supporting metrics, in order of signal strength:

- **Prediction SolverNet submissions** — actual predictions resolving against on-chain data. Demonstrates the loop produces real artifacts, not just nodes idling.
- **Contributors** — PRs, issues, forks from non-team. Independent technical engagement is a stronger signal than passive node-running.
- **Inbound interest** — DMs, applications, unsolicited mentions from the priority audiences. Lagging indicator of public teaching.

We do not optimise for follower counts, vanity reach, or any metric that does not put a client in the hands of someone whose opinion moves others.

## 7. Where the long-form lives

[`growth/`](growth/) is this doc's working appendix. Strategy notes, channel experiments, copy drafts, campaign tracking, and tooling all live there. When growth/ contradicts this doc, this doc wins; when growth/ extends it, the extension stays in growth/ unless it is load-bearing enough to be promoted via a spec proposal.

Bootstrap reference points inside `growth/`:

- [`growth/docs/2026-04-10-bullseye-framework.md`](growth/docs/2026-04-10-bullseye-framework.md) — channel brainstorm by audience
- [`growth/docs/thesis-mechanistic (1).md`](growth/docs/thesis-mechanistic%20(1).md) and [`growth/docs/thesis-narrative.md`](growth/docs/thesis-narrative.md) — long-form thesis pieces sourcing teach-content
- [`growth/docs/2026-04-24-intro-to-jinn.md`](growth/docs/2026-04-24-intro-to-jinn.md) — canonical intro doc; lead reference for outreach

Two skills under [`growth/skills/`](growth/skills/) implement the techniques behind the daily loop. They are the operational form of the disciplines in §4 — invoked in-session, not just documented.

- **Discovery — [`discover-twitter-recruits/`](growth/skills/discover-twitter-recruits/).** Surfaces candidate accounts for the **Understand** step. Audience filter, not language filter; outputs a triaged list with conversion rationale, an honest reply-rate ranking, and an audit trail of skipped candidates. Calibrated against past discoveries (`@yieldfreaks`, `@ta_eis_eauton`) and corrections (`@gingersamurai`).
- **Broadcast — [`x-algorithm-grader/`](growth/skills/x-algorithm-grader/).** Grades draft posts before publishing for the **Teach** step. Returns a relative reach score, the binding constraint, and the single highest-leverage edit. Calibrated for `@oaksprout`'s crypto+AI-infrastructure cluster.

Both skills are deliberately scoped to one job each. Discovery does not draft replies; broadcast does not generate content. Composing them — discovery surfaces a candidate, the user drafts a reply, the grader scores it — is left to the operator, not folded into a single workflow.

Changes to this document require a linked spec proposal under `spec/YYYY-MM-DD-<topic>.md` and CODEOWNERS approval, per [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).
