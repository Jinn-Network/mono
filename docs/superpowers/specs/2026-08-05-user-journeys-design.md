# Jinn User Journeys — the Requester Path, Beat by Beat

- **Version:** 0.1
- **Date:** 2026-08-05
- **Status:** Draft — walked and written in-session (operator: Ritsu, 2026-08-05); pending
  operator review. DevX Re-Seal component C5's build phase is gated on this document
  ([#2396](https://github.com/Jinn-Network/mono/issues/2396)), and §9 reorders that build.
- **Shape:** `design`
- **Scope:** the four requester journeys — first request (R1), everyday requesting (R2),
  production (R3), and authoring a new work class (R4) — at the detail levels §2 declares;
  for R1 and R2, the beat-level walk in which each beat names what the human does, what the
  agent does, what they see, what can fail, its time budget, and whether its machinery exists;
  the build-order consequences that follow (§9); the open questions the walk surfaced (§10); and
  the measured R1 walk against live Base Sepolia that tested every claim above (§11).
- **Out of scope:** designing R4, which is named and parked (§7); the operator journeys, which
  are pointers only (§8); the packaging of these journeys — skills, host plugin, MCP tool
  surface, custody posture, transition manifest — all owned by the
  [agent-artifacts design](./2026-08-04-agent-artifacts-replacement-design.md); the custody law,
  the consumer classes, the ten `requester_*` tools, and the posting authority, none of which
  this document amends; the website (C4), the spec host (C3), and the re-seal (C0–C2).
- **Depends on:** the [DevX surface design](./2026-08-03-devx-surface-design.md) §2 (the agent
  is the reader), §5.1 (the Build door), §8 (program sequencing) and §11 (the success
  criterion this document turns into beats), with its two 2026-08-04 amendments; the
  [agent-artifacts design](./2026-08-04-agent-artifacts-replacement-design.md) §2 (the tier-4
  requester product and its ten tools), §2.2 (custody), §3 (fetch-and-self-install), §6 (test
  tiers) and §8 (the build order §9 amends); the
  [marketplace surfaces design](./2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md)
  §4.1 (custody law), §4.2 (the six consumer classes — R1/R2 are class 1, R3 is class 3) and
  §4.3 (the work-client mint sequence); [DR-2026-08-04](../../../log/decisions/2026-08-04-spec-origin-and-vocabulary.md)
  (requester as the demand-side role everywhere; `spec.jinn.network`);
  [DR-2026-08-03](../../../log/decisions/2026-08-03-phase-c-capability-boundaries.md) decisions
  3 and 4 (the ratified posting authority; Record Discovery as the sole public discovery
  plane); the [task profiles and evaluation specs design](./2026-07-27-task-profiles-and-evaluation-specs-design.md)
  §6 (profiles are sealed published documents), which bounds R1 beat 5 and all of R4.

> **Label discipline (mandatory throughout).** **`R1`–`R4` and `O1`–`O2` in this document are
> journeys and nothing else.** Four unrelated letter-numbered schemes are live in this
> repository and two of them collide with the labels used here: the **custody law's C1–C5**
> (marketplace surfaces §4.1), the **DevX Re-Seal components C0–C5** (#2396, of which the
> agent-artifacts design is C5), the **build tasks B1–B8** (agent-artifacts §8, extended by §9
> here), and the **residuals R1–R4** in
> [`2026-07-30-implementation-program-addenda.md`](../plans/2026-07-30-implementation-program-addenda.md)
> §3 — whose R4 is a grader-family taxonomy finding with no relationship to this document's R4.
> Every reference below to a scheme other than the journeys names its owning document.

## 1. Problem statement

The DevX surface program designed the *packaging* of the requester experience in detail —
skills as the canonical published artifact, the host plugin as their bundle, the requester MCP
as a new tier-4 product, keyless custody with signer injection, signed manifests at
`spec.jinn.network`, a transition manifest that sunsets `jinn integrations` whole. Every one of
those rulings stands. None of them was derived from a written journey; they accreted through
question-and-answer, each sound in isolation. The operator named the consequence mid-program:
*"I feel like this is a bit ad hoc. Can we take a step back and think about the user journey
here."*

Walking it exposed three holes that no amount of packaging closes:

1. **The requester journey rode operator plumbing.** The only posting path a stranger can reach
   today requires OLAS service registration, staking, and mech deployment (§4.3). It onboards a
   requester as a supplier. The DevX success criterion — a stranger's agent completing post →
   deliver → retrieve in fifteen minutes — cannot be met on it, and the reason is not
   performance.
2. **No step answered "what can I actually get solved today."** Every designed beat assumed the
   person already knew what to ask for. A stranger does not, and the network's answer is
   narrower than the documentation implies (§4.2).
3. **The payoff was never designed.** What the person *receives* at the end — the artifact, the
   verdict, the receipt, and in what order — had no owning decision anywhere in the program.

This document closes all three. It is the acceptance test the build order (§9), the published
skills, the docs, and the agent-tier eval answer to. Where it disagrees with an approved
design about *sequence*, §9 records the amendment; it disagrees with none of them about
*substance*.

## 2. The journey map

| | Journey | Who | The job | Surface | Detail here | Status |
|---|---|---|---|---|---|---|
| **R1** | First request | a stranger, through their agent | zero to first verified result | published skill + `jinn` CLI (class 1) | **beat level** | designed; three beats have no machinery (§9) |
| **R2** | Everyday requesting | an agent mid-work | delegate a sub-problem, integrate the result | `@jinn-network/requester-mcp` (class 1) | **beat level** | designed; co-develops with the work-client mint |
| **R3** | Production | an application or org at volume | requesting with real custody | the work client (class 3) | **lifecycle + gates** | **class 3 has no blessed surface today** |
| **R4** | Authoring a new work class | a domain owner | design a task profile and evaluation spec | sealed published documents | **named and parked** | not self-serve; needs its own session |
| **O1** | Operator first setup | a node runner | install → fund → stake → deliver | `jinn` CLI + operator app | **pointer** | correctly operator-shaped |
| **O2** | Operator steady state | a node runner | keep earning | operator app | **pointer** | canonical elsewhere |

**Why these detail levels.** R1 and R2 are walked beat by beat because they gate the build
order — §9 exists only because walking them showed which machinery is missing. R3 is a
lifecycle rather than beats because its beats are its customer's, not Jinn's; what Jinn owes it
is a gate list it can plan against. R4 is named and parked because designing it here would
repeat the mistake this document was written to correct: it deserves a session, not a
subsection. O1 and O2 are pointers because the operator journey is already correctly shaped —
its eleven-step bootstrap is *supposed* to register a service and stake, which is exactly what
makes it wrong for a requester.

**Consumer class.** R1 and R2 are class 1 in the marketplace surfaces §4.2 table — first-touch,
machine-local CLI keystore. R3 is class 3. Custody does not relax because an agent is driving
(DevX surface design §2); the five published guardrails (agent-artifacts §4, G1–G5) bind every
beat below, and the two value-moving beats — post (R1 beat 6, R2 beat 3) — are the `confirm`
gates G3 names.

## 3. The machinery ledger

Every beat below carries one of four statuses. The distinction is the point of the exercise: a
journey document that cannot tell a shipped verb from a designed one is a wish list.

| Status | Meaning |
|---|---|
| **exists** | code on a merged branch, reachable by a user today |
| **built, unmerged** | code written and reviewed-pending on an open pull request |
| **designed** | ruled in an approved design; no implementation |
| **must be built** | no design owns it; §9 files the consequence |

Two facts make the second row necessary rather than pedantic. `jinn evidence find|show` and
`jinn tasks watch` are **built, unmerged** — they live in `f2b2732df` on
[PR #2382](https://github.com/Jinn-Network/mono/pull/2382), which is open; `client/src/cli/commands/evidence.ts`
does not exist on `integration/evidence-v1`. And the native requester vertical is code-complete
but **feature-disabled in every shipped build** and pinned to one golden fixture
(`client/src/cli/commands/native-requester.ts:166-172`, `:90-96`). Both would read as "exists"
to anyone grepping the reseal train, and neither is reachable by a stranger.

## 4. R1 — first request

**The job:** friction-to-trust for a stranger. **The acceptance test** is the DevX surface
design §11 criterion, restated for the artifact taxonomy that superseded prompts: *a stranger's
agent, given only the bootstrap, completes post → deliver → retrieve on testnet in ≤ 15 minutes
with no terminal touch by the human, spending only faucet funds.* The substance is unchanged;
only the named artifact moved, because agent-artifacts §0 ruling 6 dropped the prompt family
and made the skill canonical.

**Budget.** The nine beats below sum to 15:00. Beat 7 is the only beat whose duration Jinn does
not control — it is operator supply, not code — and that is precisely why beat 1 exists. The
fifteen-minute criterion is meetable only against warm supply; beat 1 is what tells the human
whether supply is warm *before* they spend, instead of at minute twelve.

| Beat | | Budget | Cumulative |
|---|---|---|---|
| 0 | Landing | 0:30 | 0:30 |
| 1 | Orient — supply awareness | 1:00 | 1:30 |
| 2–4 | Requester-only init | 4:30 | 6:00 |
| 5 | Spec interview | 2:00 | 8:00 |
| 5b | Evaluation preview | 0:30 | 8:30 |
| 6 | Post | 1:00 | 9:30 |
| 7 | Watch | 4:00 | 13:30 |
| 8 | Payoff | 1:30 | 15:00 |

### 4.0 Beat 0 — landing

- **Human:** arrives at `jinn.network`, takes the Build door, copies one line and gives it to
  their agent.
- **Agent:** fetches `https://spec.jinn.network/skills/builder/v1.md` and installs it into its
  own harness by whatever mechanism that harness has.
- **They see:** one sentence and one URL. Nothing to configure, no account, no wallet yet.
- **Can fail:** the spec host is unreachable — **which is the state today**: the walk found
  `spec.jinn.network` resolving to a Vercel project with nothing deployed, returning
  `DEPLOYMENT_NOT_FOUND` on every path including `/manifest.json` (§11). The bootstrap URL is
  the first thing a stranger touches and it currently 404s; that wall is C3's and the human
  DNS/deploy gate on #2396, not C5's. Also: the harness has no skill-install mechanism, in
  which case the agent reads the document into context instead, which is sufficient — the skill
  is host-neutral markdown by construction.
- **Budget:** 0:30.
- **Machinery:** **designed** — agent-artifacts §3 (fetch-and-self-install, three links, only
  the first a human step) and §8 tasks B2 (the skill) and B8 (the website's bootstrap line with
  its build-time resolution check). Nothing per-host is written by Jinn; the installer that used
  to do that is deleted whole at B3.

### 4.1 Beat 1 — orient: what is solvable right now

**This is the skill's first instruction, before any wallet exists.** It is the beat that kills
post-into-silence at the front door rather than at minute twelve, and it is the beat this
program did not have.

- **Human:** says what they are trying to get done, in their own words, or says nothing and
  waits to be told what is possible.
- **Agent:** queries live supply — which work classes are accepting tasks, whether operators
  are actively claiming them, and whether recent tasks in those classes reached verdicts — and
  tells the human in plain terms: *here is what this network can do for you today, and here is
  how busy it is.*
- **They see:** a short list of work classes with a liveness signal, or an honest empty answer.
  Not a catalog of everything the protocol could theoretically express.
- **Can fail:** discovery is unreachable, which is stated as an outage rather than silently
  falling through to direct chain reads (`discovery.fallbackToOnchain` is opt-in and off by
  default since the 2026-05-23 substrate incident); supply is genuinely cold, which is a
  legitimate answer and must be said before the human spends four minutes on init.
- **Budget:** 1:00.
- **Machinery:** **must be built** (§9 item B0b). Discovery holds the ingredients and joins
  none of them. `getSolverNetOperatorCount` is documented in its own interface as an
  *ever-participated* signal, explicitly not "operators participating today"
  (`client/src/discovery/types.ts:526-533`); `getTaskPostCounts` counts posts, not deliveries
  (`:679`); `getVerdictTallies` — the verified-outcome read — returns an empty Map over the HTTP
  implementation (`:761-765`). The only place the three meet is two independent dashboard GET
  routes rendered as adjacent columns (`client/src/api/discovery-endpoint.ts:99-147`), which is
  presentation, not a query.

  **The honest answer is also narrower than the docs imply.** Exactly three task profiles are
  sealed and published — `repository-work/1.0`, `prediction-forecast/1.0`, and
  `evaluation-task/1.0` — and the third is the derived evaluation machinery, not something a
  requester asks for. Two requestable work classes exist. A supply read that returns two rows is
  not a failure of the read; it is the first true thing the network has ever told a stranger,
  and it is better said at 1:30 than discovered at 12:00.

### 4.2 Beats 2–4 — requester-only init

Wallet and keystore, creator Safe, testnet faucet. **No service registration, no staking, no
mech deployment.**

- **Human:** approves one funding step. That is the whole human contribution to this beat.
- **Agent:** creates the agent EOA and its encrypted keystore, deploys the creator Safe, claims
  testnet funds, and reports the addresses.
- **They see:** an address, a Safe, a balance. Three facts, each checkable on a block explorer.
- **Can fail:** the faucet rate-limits, which it reports as one claim per address per 24 hours
  (`client/src/earning/faucet.ts:120-127`) — a failure path, **not the normal path**: the walk
  measured back-to-back calls both succeeding at 0.0001 ETH each (§11), and the drip loop is
  sized accordingly. The faucet also returns *before* its transaction mines, so a balance read
  taken immediately after success reads zero. Safe deployment can revert. The agent must never
  resolve a shortfall by moving value from a pre-existing wallet, which is guardrail G4.
- **Budget:** 4:30.
- **Machinery:** **must be built** (§9 item B0a), and the gap is larger than "init is missing".

  **Whose verb this is, settled.** Requester first-touch is a `jinn` CLI job by ratified rule,
  not by default: the consumer-class table (marketplace surfaces §4.2) gives class 1 — *external
  requester, first-touch* — a blessed surface of "record schemas + `jinn` CLI" and key custody
  of "CLI keystore, machine-local", and §8.3's class-1 quickstart is *"post a task with the
  `jinn` CLI"*. Agent-artifacts §2.2's "keystore creation stays the CLI's first-touch job" is
  **derived from that row**, not assumed. What is *not* settled is where that CLI lives:
  `@jinn-network/client` is catalogued `"domain": "operator"`, `"role": "operator daemon and
  application"` (`architecture/platform-packages.v1.json`) while shipping class 1's blessed
  surface, and the composition cutover renames its tree `client/` → `operator/` at stage 5. The
  catalog row is the defect — one package serving two personas, described as serving one — and
  correcting it is part of B0a (§9). The binary is not in question: that entry's
  `transition.sunsetCondition` retires the *legacy release coupling*, not the CLI, and headless
  §10 re-bases the CLI onto the read plane and control routes "exactly like the console."
  Physical tree placement after stage 6 is §10 question 4.

  Two separate walls stand here, and the walk added two smaller defects on top of them: `jinn
  init` refuses without `JINN_PASSWORD` and its hint offers **`jinn run`** — the daemon, the
  *operator's* entry point — as the fix for the requester's first command; and
  `jinn fund-requirements` reports the shortfall as `"blocks": "bootstrap"` and asks for
  **0.02 ETH**, the operator bootstrap target, where a requester needs Safe-deployment gas.
  Both are requester-path framing borrowed from the supplier path, and both are B0a's to fix.

  First, **no requester-only init exists.** `jinn init` writes a
  keystore and deploys no Safe (`client/src/cli/commands/init.ts:125-126`; measured at 2
  seconds). The closest existing
  path, `ensureStage1` (`client/src/earning/bootstrap.ts:533-637`), is wallet + fleet Safe +
  ERC-8004 identity behind an ETH-only funding gate — no OLAS, no service, no staking — and is
  the right thing to build on, but its only callers are the `solver-plugins-*` verbs. No posting
  verb calls it.

  Second, **the two Safes are not the same Safe, and the legacy path means the wrong one.**
  `fleet_safe_address` (`client/src/earning/types.ts:135`) and `services[].safe_address` (`:76`)
  are distinct objects in standard mode, and every legacy call site that says "creator Safe"
  resolves to the *service* Safe. The native requester is the only place a creator Safe is a
  free-standing address (`client/src/native-requester/requester.ts:280` — a bare address, with no
  `serviceId`, `stakingAddress`, or `mechAddress` anywhere in that directory; the requester role
  is explicitly exempted from the marketplace-agent authorization check at
  `client/src/daemon/native-production-deployment.ts:155-163`, needing only escrow funding at
  `:174-180`). It takes that address from static configuration. **Nothing creates it.**

### 4.3 Beat 5 — spec interview

- **Human:** describes what they want, at whatever level of precision they naturally have.
- **Agent:** elicits the rest and drafts it into the chosen profile's slots — including
  acceptance criteria written to be **evaluable rather than aspirational**. This is where the
  agent earns its place in the journey; a form would produce "the code should be good" and an
  interview produces a criterion a grader can run.
- **They see:** a draft spec they can read and correct, in their own domain's language, with
  the criteria stated as checks.
- **Can fail:** what the human wants fits no published profile, which is a beat-1 failure
  surfacing late and must be said plainly rather than forced into the nearest slot; the
  criteria are unevaluable and the agent must say so rather than post them.
- **Budget:** 2:00.
- **Machinery:** **designed**, bounded by sealed profiles. The profile document is the runtime
  validation authority and its payload schema is what the interview fills
  ([task profiles design](./2026-07-27-task-profiles-and-evaluation-specs-design.md) §6.1); the
  Task pins it by URI **and digest**, so a URI cannot silently serve different content to later
  Tasks (§6.2). The interview itself is skill content (B2), not a tool.

### 4.4 Beat 5b — evaluation preview

**Do not omit this beat.** Before any spend, the agent shows *both* halves: the work as
specced, and exactly how the result will be judged.

- **Human:** reads both halves and approves once.
- **Agent:** renders the drafted spec beside the evaluation spec that will grade it — the
  grader family, the declared measurements, and the verdict rule — then waits.
- **They see:** the job and its rubric, side by side, before money moves.
- **Can fail:** the evaluation spec is derived rather than authored and reads as machinery, in
  which case the agent must translate it into the criteria language of beat 5 rather than
  pasting a document.
- **Budget:** 0:30.
- **Machinery:** **designed** — evaluation specs are sealed documents with declared
  measurements and a declarative closed-vocabulary verdict rule (task profiles design §7), and
  the confirm-gated preview shape is agent-artifacts §2's two value-moving tools. The rendering
  is skill content.

> **Ruling.** Consenting to the spend is consenting to the evaluation. The evaluation spec is
> shown *before* the confirm gate, never after the verdict. A requester who first learns how
> their work was graded by reading the verdict has been graded without consent, whatever the
> spec said.

### 4.5 Beat 6 — post

- **Human:** confirms.
- **Agent:** posts the task from the creator Safe and returns a receipt.
- **They see:** a task id and a transaction hash. **A receipt, not a write-ahead log** — the
  durability machinery underneath is real and invisible.
- **Can fail:** insufficient escrow; the post broadcasts but the confirmation is lost, which is
  what the durable path exists for; a duplicate post, which idempotency must absorb rather than
  charge for twice.
- **Budget:** 1:00.
- **Machinery:** **designed** on the native path, whose engine is built but unreachable. The
  ratified posting authority is `MarketplaceRequesterBackend` recovering through the one posting
  WAL (DR-2026-08-03 decision 3), and the native requester already implements the requester-side
  half properly: durable recovery before and after the draft walk
  (`client/src/native-requester/requester.ts:1874-1880`), `runId` idempotency that returns the
  prior association rather than minting a second Submission (`:1914-1927`), and a canonical
  `TaskCreated` association that refuses non-canonical or mismatched events rather than guessing
  (`:1723-1818`). It is **feature-disabled in shipped builds and pinned to
  `prediction-forecast-golden.json`** (`client/src/cli/commands/native-requester.ts:166-172`,
  `:90-96`), so posting an arbitrary spec natively is not reachable today.

  **The legacy path is not the fallback.** `jinn tasks submit` emits `bootstrap_incomplete`
  unless an *operational service* exists (`client/src/cli/commands/tasks.ts:558-598`), then binds
  `creatorMultisig` to that service's Safe (`:590`). The real gate is
  `pickPrimaryMechService`, which requires `isOperationalServiceStep(step) && safe_address &&
  mech_address` (`client/src/cli/execution-context.ts:48-50`, enforced at `:210-222`), and only
  `complete` and `safe_binding_pending` qualify (`client/src/earning/types.ts:66-68`) — both
  downstream of staking and mech deployment. Routing a requester there does not merely cost
  time; it makes them a supplier to post one task.

### 4.6 Beat 7 — watch, with honest failure beats

- **Human:** does something else. The agent is watching.
- **Agent:** narrates the lifecycle as it happens — claimed, delivered, verdict — and, if
  nothing claims the task within a stated window, says so, says why, and offers alternatives.
- **They see:** three state changes, or an honest account of why they did not happen.
- **Can fail:** nothing claims it; something claims it and never delivers; the delivery is
  inconsistent with itself, which is a contradiction rather than a pending state and must be
  reported as one.
- **Budget:** 4:00.
- **Machinery:** **built, unmerged**, and the walk found this beat working well — `jinn tasks
  watch 1 --timeout 5` reached `status: "delivered"` in 598 ms against live testnet with no
  config file, emitting the NDJSON progress envelope first (§11). It polls
  `getAutopilotDeliveryCandidates` to a terminal state with a 900-second default timeout, and
  treats a contradiction as a distinct outcome rather than folding it into pending. Its terminal
  states are `delivered` and `timeout`, both exit 0. One paper cut for an agent driving the
  journey: `tasks watch` takes a **positional** task id while `evidence find` takes
  **`--task-id`**, so moving between them costs an `invalid_invocation`.

> **Ruling.** Silence is never an allowed ending. A watch that reaches its timeout must produce
> a statement — what was posted, what did not happen, what the human can do — not an absence.
> The timeout is a beat, not the loop giving up.

### 4.7 Beat 8 — the payoff

**Deliverable first. Verdict second. Receipts third.**

- **Human:** reads the answer.
- **Agent:** fetches the delivered artifacts and opens them — the actual patch, file, or
  answer; then shows the verdict **against the criteria the human approved at beat 5b**; then
  offers the receipts for anyone who wants to check.
- **They see:** their result. **The human never sees an envelope**; the agent translates
  records into a result.
- **Can fail:** the artifact is unreachable at its content address; the verdict is FAIL, which
  is a real outcome and not an error; the delivered artifact does not match what the criteria
  asked for, which the agent must say rather than presenting a passing verdict as a passing
  result.
- **Budget:** 1:30.
- **Machinery:** **must be built** (§9 item B0c). `jinn evidence show` returns artifact
  *references* — `{artifactType, sha256}` (`client/src/cli/commands/evidence.ts:155-158`) — and
  performs no filesystem writes at all. The only artifact-byte retrieval anywhere in the
  repository is the MCP `acquire_artifact` tool (`client/src/mcp/server.ts:469-524`), which
  returns base64 into a solver agent's tool response and is unreachable from any `jinn evidence`
  verb. Post → deliver → **retrieve** is the criterion; retrieve currently returns a hash.

> **Ruling.** The ordering is deliverable, verdict, receipts — not the record order, which is
> the reverse. Anchoring, envelope, and verdict are how the network knows the result is real;
> they are not what the person came for. A payoff that leads with provenance has confused its
> own audit trail for its product.

## 5. R2 — everyday requesting

**The actual product.** An agent mid-work recognizes a sub-problem it should delegate, delegates
it, and integrates the result. Served by `@jinn-network/requester-mcp`, the tier-4 product
ruled in agent-artifacts §2 and co-developed with the work-client mint (§2.1). Its ten tools
are that document's; the mapping below says which beat each serves and which beats no tool
covers.

### 5.1 Beat 1 — trigger

- **Human:** absent. This beat happens inside the agent's own work.
- **Agent:** recognizes that a sub-problem is delegable — bounded, specifiable, and gradeable —
  rather than something to keep doing inline.
- **They see:** nothing yet.
- **Can fail:** over-delegation (spending on what would have been cheaper inline);
  under-delegation (the interesting failure, and invisible).
- **Budget:** unmetered — this is judgment inside ongoing work.
- **Machinery:** **must be built** as skill content (B2), not a tool. No tool can notice this;
  the recognition criteria belong in the published skill.

### 5.2 Beat 2 — delegate-or-do proposal

- **Human:** reads a proposal, not a request for permission to think about it.
- **Agent:** presents the spec, the evaluation, the cost, and the inline estimate it is being
  compared against.
- **They see:** four numbers and two documents, on one screen.
- **Can fail:** the inline estimate is guesswork presented as a comparison, which makes the
  choice look informed when it is not.
- **Budget:** unmetered.
- **Machinery:** **designed** — `requester_funding_requirements` and `requester_balance` supply
  the cost side; the spec and evaluation drafts are beat-5/5b skill content reused.

### 5.3 Beat 3 — consent

- **Human:** approves this spend.
- **Agent:** surfaces the `confirm: true` preview naming the exact follow-up call, and waits.
- **They see:** what is about to be spent, and on what.
- **Can fail:** approval fatigue — the failure mode that makes per-spend consent degrade into
  reflexive assent, which is worse than no gate because it looks like one.
- **Budget:** unmetered.
- **Machinery:** **designed** — `requester_task_submit` carries `confirm: true` and otherwise
  returns a preview envelope (agent-artifacts §2). Guardrail G3 requires the wait.

> **Open — standing budgets.** Per-spend consent is today's rule and it is the right *first*
> rule. It does not survive contact with volume: an agent that must ask before every delegation
> cannot delegate at the rate that makes delegation worth doing. The candidate replacement is
> **policy consent** — *up to X per day, on work classes Y, without asking* — which changes
> what the human approves rather than how often. This is a custody design question, not a UX
> preference: a standing budget is a standing authority, and it interacts with the custody law's
> C3 (signer injection) and with what a "no signer configured" result means when a policy is
> live but the budget is exhausted. **Flagged, not settled** (§10).

### 5.4 Beat 4 — fire and continue

- **Human:** absent.
- **Agent:** posts, then **returns to its own work**, watching in the background.
- **They see:** the delegation acknowledged, the conversation continuing.
- **Can fail:** the watch blocks the delegator, which makes the whole journey pointless —
  delegation that halts the delegator is a slow synchronous call with extra steps.
- **Budget:** unmetered; the delegator's work continues.
- **Machinery:** **must be built** (§9). `requester_task_watch` is specified as *streaming
  progress to terminal state* (agent-artifacts §2), and the CLI verb it mirrors is a blocking
  `for(;;)` with no detach, no pidfile, and no daemon handoff. Foreground streaming is the right
  shape for R1 beat 7, where watching *is* the human's activity, and the wrong shape here.
  Background watch is a distinct semantic, not a flag.

### 5.5 Beat 5 — arrival and integration

- **Human:** receives a delta, not a document.
- **Agent:** fetches the artifacts, integrates the result into the work in progress, and
  reports what changed.
- **They see:** *"the retry logic now handles the 429 case; here is the diff"* — not *"here is
  a result to look at."*
- **Can fail:** the artifact arrives but does not apply cleanly to work that has moved on since
  the delegation; integration is presented as done when it was only fetched.
- **Budget:** unmetered.
- **Machinery:** **designed** for the find and show legs (`requester_evidence_find`,
  `requester_evidence_show`); **must be built** for the fetch, which is the same §9 item B0c
  that R1 beat 8 needs.

### 5.6 Beat 6 — exceptions, honestly

- **Human:** learns that the delegation did not go as hoped, in the same channel and the same
  voice as a success.
- **Agent:** reports which of the three exception paths occurred, and what remains available.
- **They see:** the exception named plainly, never a delegation that quietly stops mattering.
- **Can fail:** the three paths below — and the third has no remedy.
- **Budget:** unmetered.
- **Machinery:** **built, unmerged** for the no-claim path; **designed** for the FAIL path;
  **nothing, by ratified design** for the third.

Three, and the third has no remedy.

- **No claim.** The task is not picked up. The agent says so, with the elapsed window, and
  offers to re-post, re-spec, or stop. Machinery: **built, unmerged** (the `timeout` terminal
  state).
- **FAIL verdict.** The work was done and judged not to meet the criteria. This is a result,
  not an error; it is shown against the beat-5b criteria like any other verdict. Machinery:
  **designed**.
- **Disagreeing with a verdict.** **There is no recourse today.** No challenge mechanism exists
  and none is planned before Phase B.2. The reason is structural rather than an oversight:
  `SPEC.md` gates reward on *loop completion* — any verdict — never on Pass, so a wrong or
  malicious Fail cannot deny a solver their earnings, and the challenge mechanism that a
  Pass-gate would require is deliberately not built. That reasoning protects the *solver*. It
  does nothing for a requester who believes the verdict is wrong, and the skill must say so in
  those words rather than implying a dispute path exists.

### 5.7 Beat 7 — ledger and spec library

The requester-side learning loop, and the beat that turns R2 from a tool into a practice.

- **Human:** asks what they have been spending and what has been worth it.
- **Agent:** reports what was spent, what came back, and **which specs produced verdicts worth
  trusting** — so the next delegation is written better than the last.
- **They see:** their own history as evidence about their own specs.
- **Can fail:** the ledger records spend without recording outcome, which produces an expense
  report rather than a learning loop.
- **Budget:** unmetered.
- **Machinery:** **must be built** (§9). No tool in the ten covers it, and no design owns it.
  This is the requester-side mirror of the corpus: the network accumulates what solvers learn;
  nothing accumulates what requesters learn about *asking*.

## 6. R3 — production

An application or organization requesting at volume with real custody. This is the class-3 path
of marketplace surfaces §4.2, and it is a lifecycle rather than a set of beats — its beats
belong to its customer's product, not to Jinn.

**The lifecycle.**

1. **Adoption via someone's R2 experience.** Nobody adopts a marketplace from a landing page.
   Production requesting starts because one engineer's agent delegated something successfully.
2. **Custody for real.** A KMS/HSM/MPC signer is injected; a dedicated posting Safe holds a
   capped float. The organization never touches the CLI keystore path — the class-3 posture,
   and the reason class 1 cannot serve them: the CLI loads keys only from its machine-local
   keystore, so a KMS-holding organization *cannot* be class 1.
3. **Specs become code.** Task specs and evaluation specs enter version control and get
   reviewed like code, because at volume the product's quality **is** the evaluation spec's
   quality. This is the stage at which requesting stops being a tool call and becomes an
   engineering artifact.
4. **Policy replaces per-spend consent.** The R2 beat-3 open question is not open here; it is
   mandatory. Production cannot gate every delegation on a human.
5. **Volume operations.** Idempotency keys, durable recovery, reconciliation of posted-versus-
   settled. The posting authority already carries this shape — one operation, one durable
   side-effect authority, the WAL as sole transaction authority — and production is where it is
   load-bearing rather than defensive.
6. **Verdict-gated automation with fallback paths.** Downstream systems act on verdicts, which
   means a FAIL or an unscorable outcome needs a defined path, not an exception handler.
7. **The audit story as a feature.** The organization sells its customers the fact that every
   result carries evidence. This is the point at which Jinn's receipts stop being Jinn's proof
   and start being the customer's product.

**The gates, stated honestly.**

- **The work client is unminted.** Marketplace surfaces §4.2 says it in those words: *"Until
  the work client mints (follow-up 5), class 3 has no blessed surface"* — a vacancy that is
  "accepted and dated, not hidden." Interim class-3 demand is served case-by-case as class-2
  posture with the custody guidance applied. The mint sequence is §4.3; the requester MCP
  co-develops with it (agent-artifacts §2.1).
- **Evaluator economics and challenge are Phase B.2.** At volume, "the evaluator might be
  wrong and there is no appeal" stops being a footnote.
- **Production means mainnet, which is Phase 2.** Everything above runs on testnet today, and
  a production customer's economics do not exist until real OLAS emissions do.

Nothing in this section is scheduled by this document. It is written so that R3 can be planned
against rather than discovered.

## 7. R4 — authoring a new work class

**Named, and parked.** A domain owner designs a task profile and an evaluation spec so that a
new kind of work becomes requestable.

**Not self-serve today, and the honest reason is not the one most people assume.** The
*mechanism* is designed and partly built: task profiles are sealed published documents, there is
no registry object anywhere in the protocol, anyone may publish a profile in a namespace they
control, and — in the owning design's own words — *"authoring a new domain means publishing a
document, not shipping SDK code"* (task profiles design §6, §6.5). What makes R4 not self-serve
is everything around that document. A profile is a sealed artifact pinned by digest, requiring
publication at a resolvable origin; it needs a paired evaluation spec with a declared grader
family and a closed-vocabulary verdict rule; and the economics of getting anyone to *evaluate* a
novel class — who grades it, and why — is Phase B.2. Two requestable work classes exist today
(§4.2), which is the measure of how self-serve this is.

**The current path** is therefore: propose the class, and the profile is authored in-repo and
published from it, the same way the existing three were.

**This document does not design R4.** It deserves its own session — one that takes the
evaluator-economics question seriously rather than treating profile authoring as a
documentation problem. Nothing here should be read as a plan for it.

## 8. O1 / O2 — the operator journeys

Pointers only.

- **O1 — first setup.** Install → fund → stake → deliver → earn. The eleven-step bootstrap is
  **correctly operator-shaped**: registering an OLAS service, staking, and deploying a mech is
  exactly what an operator is doing, and the fact that it is wrong for a requester (§4.5) is a
  statement about the requester path, not a defect in this one. Canonical surface:
  [`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md); door copy: DevX surface
  design §5.2.
- **O1's one journey defect: honesty about testnet economics.** The door promises earning, and
  earning is partly aspirational until mainnet. `SPEC.md` already states the number — supplemental,
  not a wage — and the operator door must carry that plainly rather than leaving a stranger to
  infer it.
- **O2 — steady state.** Canonical in the operator app spec. Out of scope here.

## 9. Build-order consequences

Walking R1 and R2 moved five items. Three of them precede the C5 build entirely.

**Ahead of agent-artifacts §8 tasks B1–B5.** The amendment is recorded in that document's §8.1;
the reasoning is here. B1–B5 package a journey whose first, second, and last beats do not
exist. Publishing a skill that instructs an agent to run verbs that cannot complete would ship
a red acceptance test as a green artifact — and the T1 deterministic tier
(agent-artifacts §6) executes the skill's commands *literally*, so it would be red on arrival.

| # | Item | Beat it unblocks | Nearest code to build on |
|---|---|---|---|
| **B0a** | **Requester-only init over the native path** — wallet, keystore, creator Safe, faucet; no service, no staking, no mech | R1 beats 2–4 | `ensureStage1` (`client/src/earning/bootstrap.ts:533-637`) is the right shape behind an ETH-only gate; the native requester already takes a free-standing `creatorSafe` (`client/src/native-requester/requester.ts:280`) that nothing creates. Lifting the feature-disable and the fixture pin (`client/src/cli/commands/native-requester.ts:166-172`, `:90-96`) is part of this item, not separate from it. Also corrects the catalog row that describes the package shipping class 1's blessed surface as `"domain": "operator"`, `"role": "operator daemon and application"` (§4.2) — a one-field derivation fix, landed with the verb that makes it load-bearing. |
| **B0b** | **The supply-awareness read** — "what is solvable right now," as a first-class question | R1 beat 1 | Discovery holds the ingredients and joins none; two of the three are stubbed empty over HTTP (`client/src/discovery/types.ts:526-533`, `:679`, `:761-765`). Needs a windowed operator-activity signal, which does not exist in any form. |
| **B0c** | **Artifact retrieval into the workspace** — the deliverable, not its hash | R1 beat 8, R2 beat 5 | `jinn evidence show` returns `{artifactType, sha256}` and writes nothing (`client/src/cli/commands/evidence.ts:155-158`); `acquire_artifact` (`client/src/mcp/server.ts:469-524`) proves the fetch path exists but is unreachable from any requester verb. |

**Within R2, co-developed with the requester MCP (agent-artifacts §8 task B6).**

| # | Item | Beat it unblocks |
|---|---|---|
| **B0d** | **Background watch semantics** — distinct from foreground streaming, not a flag on it | R2 beat 4 |
| **B0e** | **The requester ledger and spec library** | R2 beat 7 |

**Carried by the walk, small enough to ride existing items.** B0a also owns the two framing
defects §4.2 records — `jinn init`'s hint pointing a requester at `jinn run`, and
`fund-requirements` asking for the operator's 0.02 ETH bootstrap target. B0c also owns beat 8's
vocabulary: the payoff verb renders envelope fields where the §4.7 ruling says the human never
sees an envelope. Separately, `tasks watch` takes a positional task id while `evidence find`
takes `--task-id`; whichever of the two moves, they should agree before a published skill names
both.

**Not this program's.** Beat 0's wall — `spec.jinn.network` deployed-but-empty — is C3's and the
human DNS/deploy gate on #2396. It is recorded here because it sits ahead of every wall C5 owns,
and no amount of C5 work makes the bootstrap line fetchable.

**Unchanged.** B1–B8 keep their content and their relative order; B2 keeps its dependency on
C1's origin wave; B6 keeps its co-scheduling with the mint. Nothing in this section touches the
custody law, the consumer classes, the ten tools, or the transition manifest.

## 10. Open questions

1. **Standing budgets (R2 beat 3).** Does policy consent replace per-spend consent, and at what
   layer — the MCP product, the work client, or the signer? It is a custody question with a
   custody-law surface, not a UX preference.
2. **The shape of the supply read (B0b).** A CLI verb, a discovery method, or both? The skill
   needs it at beat 1 before any tool is installed, which argues for the CLI; R2 needs it as a
   tool. And a windowed operator-activity signal has to exist before either can answer honestly.
3. **Where retrieved artifacts land (B0c).** Into the workspace as files, or returned as bytes
   for the agent to place? R1 beat 8 and R2 beat 5 may want different answers, which would make
   this two items rather than one.
4. **Where the CLI lives after stage 6.** Not a blocker on anything here — class 1's blessed
   surface is the `jinn` CLI whatever tree it ships from (§4.2), and B0a builds into the tree
   that exists. But stage 5 renames that tree `client/` → `operator/` and stage 6 sends the SPA
   to `apps/operator-console/` and re-bases the CLI onto the read plane
   (composition §11 stage table as amended 2026-08-04; headless §9, §10) — leaving a two-persona
   CLI inside a tree named for one of them. Either the CLI separates at that seam or the
   operator tree is documented as shipping both personas' entry points. This belongs to the
   composition/headless owners at stage 6, not to C5; it is recorded here because B0a is the
   work that makes the mismatch load-bearing.
5. **R4 entirely.** Parked, per §7.
6. **Vocabulary lag.** This document uses **requester** throughout, per DR-2026-08-04. `SPEC.md`
   §Roles and `GLOSSARY.md` still say *Curator* and *SolverNet*, both anchored to a dissolved
   concept; the GLOSSARY pass is an open human-checklist item on #2396 and goes through the
   canonical-doc process. Nothing is redefined here — this document links rather than restates.

## 11. Measured walk (2026-08-05)

R1 was walked on this branch against live Base Sepolia, from a scratch `HOME` with a fresh
keystore, using the class-1 verbs the published skill will name. Predictions were written
before the run. **Two predictions were wrong and one wall arrived earlier than expected**;
those three lines are the reason to run a walk rather than assert one.

| Beat | Predicted | Measured | Verdict |
|---|---|---|---|
| 0 | not predicted | `spec.jinn.network` resolves to Vercel and returns **`x-vercel-error: DEPLOYMENT_NOT_FOUND`** on every path including `/manifest.json`; the apex returns 200 | **wall, earlier than predicted** |
| 1 | no verb answers it | confirmed across three reasonable agent guesses | **wall, as predicted** |
| 2–4 | no requester-only init | confirmed, plus two new defects | **wall, as predicted** |
| — | faucet blocks the journey at 1 claim/24h | **wrong** — see below | **prediction corrected** |
| 5 / 5b | — | nothing to exercise; no skill, no interview | **untested** |
| 6 | both paths refuse | confirmed verbatim, with a refinement | **wall, as predicted** |
| 7 | foreground-only | works, and works well | **no wall** |
| 8 | returns references | confirmed, and worse in human form | **wall, as predicted** |

**Beat 0 — the bootstrap URL 404s today.** DNS and the Vercel project exist, so the human gate
on #2396 is partly done, but nothing is deployed. The one line the website will tell a stranger
to paste cannot be fetched. This wall sits ahead of every other one and is C3's, not C5's.

**Beat 1 — three guesses, three dead ends.** `jinn tasks list` returns `{"tasks":[]}` with no
statement of what it listed, so an agent cannot distinguish "the network has nothing" from
"wrong question". `jinn solver-nets list` fails on a missing config file — and the concept is
dissolved. `jinn evidence find` needs a task id the stranger does not have. The CLI registry
has no supply-shaped verb.

**Beats 2–4 — init works, and points the wrong way.** `jinn init` succeeds in **2 seconds** and
creates the EOA, **deploying no Safe**, as expected. Two defects the code read had not shown:
it refuses without `JINN_PASSWORD` and its hint tells the requester to *"run `jinn run`"* — the
daemon, the operator's entry point, offered as the fix for the requester's first command. And
`jinn fund-requirements` reports the shortfall as `"blocks": "bootstrap"` and asks for
**0.02 ETH**, which is the operator bootstrap target; a requester needs Safe-deployment gas, not
that.

**The faucet prediction was wrong, and the code was right.** Two back-to-back calls against a
fresh address **both returned `ok: true` with no rate limit**, delivering exactly
`ESTIMATED_DRIP_WEI` — 0.0001 ETH — each, for 0.0002 ETH total. The "1 claim per 24 hours per
address" string is the *error path*, not the normal path, so `computeFaucetDripCap`'s sizing for
~200 sequential drips (420 with its safety factor) is coherent rather than contradictory: at the
~0.5 s per call measured, 0.02 ETH is reachable inside the five-minute loop deadline. §4.2's
"can fail" line stands as a failure mode; any reading of it as a hard per-day ceiling on the
journey is corrected here. One real hazard surfaced instead: **the faucet returns before its
transaction mines**, so a balance read immediately after a successful call sees zero.

**Beat 6 — both paths refuse, verbatim.** Legacy: `bootstrap_incomplete` / *"No bootstrapped
service available to submit Tasks from. Run `jinn bootstrap` first."* Native:
`bootstrap_incomplete` / *"Native requester preflight refused before execution authority was
loaded"*, reason *"native structured config is missing"*. The refinement: the native path's
first wall for a stranger is a **hand-authored config naming an already-existing `safeAddress`**
— the feature-disable sits behind it and is never reached. Both paths also emit the same
`bootstrap_incomplete` code, which is actively misleading on the native path, where no bootstrap
is involved.

**Beat 7 — this beat is good.** `jinn tasks watch 1 --timeout 5` reached `status: "delivered"`
in **598 ms**, emitting the NDJSON progress envelope first. One paper cut: `tasks watch` takes a
**positional** task id while `evidence find` takes **`--task-id`**, and an agent driving both
gets an `invalid_invocation` in between. Note also that this ran with **no config file at all** —
testnet discovery defaults carried it.

**Beat 8 — the payoff is two hex digests.** Against a real delivered envelope, `jinn evidence
show --human` renders:

```
  Artifacts : 2
    prediction_v1_solution dc718eec2a5e7db0f21f70d9edf54626018755c102451e9cbfcc6c3691bd80ce
    system_snapshot 51cc436914c9b184af1065e71f43e82eb0194cbb9f83c6e87649c7ffd0b13524
```

The prediction the requester asked for is not there and no verb can fetch it. The whole output
is envelope vocabulary — Digest, Kind, Role, Tier, Operator, Task, Trajectory, Artifacts —
which is the §4.7 ruling ("the human never sees an envelope") failing in the currently shipped
shape, not only in the missing fetch. **B0c is the difference between post → deliver → retrieve
and post → deliver → *hash*.**

**What the walk did not test.** Beats 5 and 5b have no machinery to exercise: the spec interview
and the evaluation preview are skill content that B2 has not written. Their budgets are
estimates, not measurements. No task was posted, so no end-to-end clock was taken — the walk
stops at beat 6 by construction, which is the finding.

## 12. Provenance

Produced by the 2026-08-05 user-journey session (operator: Ritsu), which was called by the
operator's step-back mid-program — *"I feel like this is a bit ad hoc. Can we take a step back
and think about the user journey here"* — after the DevX Re-Seal program had designed the
requester packaging without ever walking the requester path.

The journey map (§2) was established in that session. This document walks it, and the walk is
what produced §9: three items moved ahead of a build order that was otherwise ready to execute.

Every machinery status in §§4–5 was verified against code at the stated file and line on this
branch, not inferred from design documents. Two of those verifications corrected working
assumptions and are called out at §3, because both would read as "shipped" to a reader
grepping the reseal train: `jinn evidence find|show` and `jinn tasks watch` are built but
unmerged, and the native requester is code-complete but feature-disabled and fixture-pinned.

R1 was then **walked against live Base Sepolia** (§11) rather than left as an assertion, on the
operator's direction to run the journey as a user after writing it. The walk corrected the spec
twice — the faucet is not the per-day ceiling §4.2 first claimed, and beat 0 fails ahead of
every wall this document had predicted — and added four defects that reading the code had not
surfaced: the requester's first command points at the operator's daemon, the funding ask is the
operator's target, the two read verbs disagree on how a task id is passed, and the payoff verb
renders the deliverable as a hash in envelope vocabulary. Where the walk and the document
disagreed, the document was corrected.
