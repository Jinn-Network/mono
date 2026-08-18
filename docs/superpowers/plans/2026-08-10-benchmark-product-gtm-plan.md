# Benchmark Product: High-Level Go-to-Market Plan

**Status:** Working strategy draft  
**Version:** 0.4 (2026-08-18 — APEX-SWE-dev third named protocol per [DR-2026-08-18](../../../log/decisions/2026-08-18-apex-swe-dev-official-suite.md); 2026-08-17 — TB 2.1 named protocol vs Inspect select-a-task per [DR-2026-08-17-b](../../../log/decisions/2026-08-17-official-suite-protocol.md); engine-wrap vs campaign-overlay copy per [DR-2026-08-17](../../../log/decisions/2026-08-17-runtime-engine-direct-mode.md); 2026-08-10 — §6 discovery gate rewritten commitment-gated per [DR-2026-08-10](../../../log/decisions/2026-08-10-product-led-gtm-and-first-market.md); §10 Phase 1 aligned; authority note routed through the DR. v0.1 circulated outside the repo.)  
**Work shape:** `design`  
**Date:** 2026-08-10  
**Repository basis:** `integration/evidence-v1` is the canonical implementation branch. PR #2541 is the current standalone Benchmark Product candidate and remains open against that branch at the time of writing.

## 1. Strategic decision

Launch **one benchmarking product with two primary modes**:

1. **Self-serve:** technical teams design, run, verify, and publish their own benchmarks.
2. **Managed:** experts design and operate the campaign for the customer through the same product, state machine, permissions, and audit trail.

Independent execution, evaluation, and verification can become additional paid capabilities available to either mode.

The launch should **not commit to coding agents as the permanent beachhead before customer discovery**. Coding remains a plausible early domain, but it is one hypothesis among several.

The GTM should instead organize around a domain-independent buying moment:

> **A team needs to make, validate, or rely on a consequential claim about how an AI system performs.**

This keeps the product broad in addressable market while preserving a narrow job to be done.

## 2. Product and infrastructure separation

The external product must remain distinct from the infrastructure beneath it.

| Layer | Role |
|---|---|
| **Benchmark Product** | The customer-facing self-serve and managed experience for running credible benchmarks and publishing the evidence behind them |
| **Jinn** | The protocol and network for execution, evaluation, verification, evidence, and later open provider coordination |
| **Jinn Data** | The future compounding corpus of rights-permitted work, environments, evaluations, attestations, and provenance produced through campaigns |
| **Query product** | A later demand-facing application that searches existing evidence and commissions only what is missing once the corpus has useful density |

The Benchmark Product is the first product because it provides value without requiring an existing data corpus. Each campaign can then create the evidence inventory that makes Jinn Data and the later query product useful.

## 3. GTM thesis

### The market problem

AI performance claims are easy to make and difficult to rely on.

Teams currently assemble evaluation workflows from scripts, datasets, dashboards, scorers, spreadsheets, logs, and one-off reports. The resulting score often hides the conditions that produced it:

- which tasks were selected;
- whether the method changed after results appeared;
- which executions failed or disappeared;
- which environment and configuration were used;
- who evaluated the result;
- what kind of independence the evaluation actually had;
- whether another party can reproduce or verify the conclusion.

This becomes especially painful when the result must cross a trust boundary, such as a product launch, customer diligence process, vendor comparison, research claim, procurement decision, or public benchmark.

### The product answer

> **Run credible AI benchmarks and publish the evidence behind every result. Do it yourself, get expert help, or add independent assurance.**

The product should make it straightforward to:

- define the systems and work being compared;
- lock the method before the official run;
- account for every expected result, including failures and missing cells;
- apply an explicit evaluation and assurance policy;
- produce a legible report with limitations;
- publish a portable evidence bundle that another party can inspect and verify.

### Why now

AI systems are becoming capable across more workflows, and the volume of generated work is rising quickly. The scarce resource is shifting from output generation to trustworthy evidence about what works, under which conditions, and according to whose judgment.

The market already supports several adjacent layers:

- **Inspect** provides an open-source framework for authoring and running evaluations across coding, reasoning, behavior, agentic, and multimodal tasks.
- **Braintrust** provides internal observability, datasets, scorers, experiments, and deployment gates for teams improving their own AI systems.
- **Scale** provides managed environments, data operations, and evaluation programs.
- **Vals** provides independent, domain-specific benchmarks and evaluation authority.

The Benchmark Product's opening is the space between them:

> **Self-serve like an evaluation tool, credible like an independent benchmark, with managed expertise and stronger external assurance available when needed.**

Established evaluation frameworks run each **trial**. Colophon locks the comparison, accounts every cell, and publishes a checkable Jinn bundle. It does not run the framework's campaign, import a finished job, or replace Inspect, Harbor, or Braintrust as an authoring tool. Jinn's differentiated role remains evidence, assurance, completeness, verification, and the eventual open provider market.

## 4. Positioning

### Category

**Verifiable benchmarking**

### Primary pitch

> **Make AI performance claims people can inspect.**
>
> Compare systems on the same work, lock the method before the run, account for every result, and publish the evidence behind the conclusion.

### Supporting line

> **Run it yourself, have experts operate it with you, or source stronger independent assurance.**

### Memorable shorthand

> **Benchmark claims with receipts.**

### What the product is not

Do not lead with:

- a generic evals platform;
- a coding-agent benchmark tool;
- a decentralized AI marketplace;
- a blockchain evidence product;
- a data search engine;
- a universal certification authority;
- a replacement for Inspect, Braintrust, or the customer's internal stack.

The immediate value is a more credible decision or claim. Jinn is the infrastructure attribution, not the headline.

## 5. Initial customer definition

Do not define the first customer by domain alone. Define them by the presence of a high-value evaluation trigger.

### Core customer profile

A technically capable team that:

- builds, buys, or deploys an AI system;
- has a real comparison or performance question;
- faces external or internal scrutiny over the answer;
- can provide or help define representative work;
- needs the result by a meaningful deadline;
- values a report and evidence package that survives outside the originating tool.

### Likely users

- evaluation engineers;
- research engineers;
- applied AI engineers;
- technical founders;
- model or agent infrastructure engineers;
- benchmark authors;
- technical product leaders.

### Likely economic buyers

- founders and CEOs making product claims;
- CTOs and heads of engineering;
- heads of research or evaluation;
- product leaders choosing which AI system to ship;
- procurement or assurance owners comparing vendors;
- evaluation companies delivering work to their own clients.

### Buying triggers

Prioritize prospects when they are:

- launching a new AI product or version;
- claiming an improvement over a baseline or competitor;
- choosing among models, agents, vendors, or configurations;
- responding to customer or investor technical diligence;
- publishing a benchmark, research result, or case study;
- entering a public challenge;
- validating an AI system for a consequential workflow;
- trying to reproduce or challenge another party's claim.

The best outbound question is not “Are you interested in evals?” It is:

> **What AI performance claim or decision do you need other people to trust next?**

## 6. Domain discovery strategy

### Principle: broad domain, narrow job

The product should remain focused on one repeatable lifecycle even while early demand comes from different domains.

The variables may change:

- task content;
- environment;
- models or agents;
- scorer;
- domain expert;
- assurance requirement.

The core product should not:

- fork into a different workflow for every domain;
- add domain-specific product features after one prospect request;
- encode a permanent vertical before repeat demand appears.

### Initial domain hypotheses

Prospecting should deliberately sample several areas rather than defaulting to coding:

1. **Software and developer workflows**  
   Coding agents, code review, migrations, testing, security work, and developer tools.

2. **Enterprise tool-use and computer-use workflows**  
   Agents operating business software, APIs, browsers, and multi-step internal processes.

3. **Professional knowledge work**  
   Finance, legal, research, operations, and other domains where expert evaluation matters.

4. **AI product and model comparisons**  
   Teams choosing models, prompts, harnesses, retrieval systems, or agent configurations for a specific application.

5. **Independent benchmark and evaluation providers**  
   Benchmark authors, assurance firms, and domain specialists that need a stronger delivery and publication system.

These are discovery pools, not five product roadmaps.

### Domain selection rubric

Score each domain based on observed customer evidence:

| Criterion | Question |
|---|---|
| **Urgency** | Is there a recurring trigger with a real deadline and consequence? |
| **Willingness to pay** | Will customers pay for software, expert help, or independent assurance? |
| **Self-serve readiness** | Can a capable user bring enough tasks, systems, and criteria to start without a bespoke research program? |
| **Observability** | Can the work, environment, output, and evaluation be captured reliably? |
| **Repeatability** | Does the same team need to rerun the benchmark across releases? |
| **External trust value** | Does evidence from a third party or independent provider materially strengthen the result? |
| **Standardization** | Can recurring campaigns become templates rather than custom consulting projects? |
| **Evidence reuse** | Can some campaign outputs be retained, shared, or licensed for future use? |
| **Supply feasibility** | Can suitable task authors, environments, evaluators, and operators be sourced? |
| **Distribution** | Will customers publish or share an artifact that can attract the next user? |

A domain should become the primary beachhead only after it demonstrates repeated paid demand, repeat usage, manageable service effort, and strong artifact-led distribution.

### Discovery gate (commitment-gated)

Discovery runs on two tracks with deliberately different cost profiles
([DR-2026-08-10](../../../log/decisions/2026-08-10-product-led-gtm-and-first-market.md) decision 3).

**Track 1 — interviews: cheap, sampled deliberately.** Interview prospects across all
five domain pools before fixing a vertical. Breadth is enforced here because it costs
only conversations. This is the control against availability bias: if outreach only
ever touches the coding ecosystem, "demand-led" selection quietly becomes "selection by
who we already knew."

**Track 2 — campaigns: expensive, commitment-gated.** A campaign — and any adapter,
environment, or evaluator work it needs — is built only when a customer commits. No
domain capability is built speculatively.

**The commitment bar.** A customer counts as committed when all four hold:

1. they pay something — even a nominal design-partner fee; the point is a costly
   signal, not revenue;
2. they supply representative tasks, or the material to derive them;
3. they name the specific decision or claim the report will support;
4. there is a real deadline.

Enthusiasm without all four does not trigger a build.

**Build discipline.** Customer-triggered adapters, environments, and evaluator flows
land as ordinary platform packages under the existing tier rules — never in the product
tree. The product's consumption contract is not relaxed for urgency. Doing things that
don't scale applies to the commercial motion, not to code boundaries.

**Scoring discipline.** When comparing domains on service cost, separate one-time
platform build (the adapter) from recurring campaign cost, so the first non-coding
domain is not artificially penalized against coding, where the build is already sunk.

**Measurement discipline.** Each discovery attempt — an outreach wave, a design-partner
campaign, a channel test — runs through the GROWTH.md engine: a written prediction
before the attempt, one variable changed at a time, and at least two attempts on the
same question before a verdict acts. The selection rubric above is the scoring
instrument; the engine is what keeps a five-domain × ten-criterion comparison at small
N from selecting a beachhead on noise.

**Beachhead selection.** Coding-agent builders remain the default beachhead
(DR-2026-08-10 decision 2): it is what the shipped product runs today and where
distribution already reaches. The default is displaced only when another domain
outperforms it on the rubric across completed, committed campaigns — and a beachhead
change is recorded as a product decision, not a silent GTM drift.

Coding may still win this process. The point is to let customer evidence make that
decision.

## 7. One product, four offers

The same product lifecycle supports a commercial ladder.

| Offer | Customer buys | Strategic role |
|---|---|---|
| **Self-serve** | Software for configuring, running, verifying, and publishing a benchmark | Product-led adoption and report distribution |
| **Assisted setup** | Help converting an existing evaluation question into a sound campaign | Low-friction paid expertise and onboarding |
| **Independent assurance** | External execution, evaluation, verification, or corroboration | Jinn-native differentiation and marketplace demand |
| **Managed campaign** | End-to-end evaluation design, operation, interpretation, and delivery | Early revenue, customer learning, and high-value outcomes |

### Self-serve

Best for teams that already understand what they want to compare and can bring tasks, an evaluation framework, or a benchmark definition.

The user receives:

- method locking;
- complete run accounting;
- explicit assurance disclosures;
- report generation;
- portable verification;
- publishable claim assets.

### Assisted setup

Best for teams with a viable benchmark but uncertainty around task selection, scoring, sample design, or assurance configuration.

This should be bounded and repeatable, not an open-ended consulting engagement.

### Independent assurance

Best for customers that can run the campaign themselves but need stronger evidence for an external audience.

Potential components include:

- independent execution;
- an external evaluator;
- an evaluator panel;
- environment verification;
- reproduction by another provider.

This is likely the sharpest product upsell because it draws directly on Jinn's open market architecture.

### Managed campaign

Best for customers with a consequential question but insufficient evaluation expertise or operating capacity.

The managed team should use the exact same product operations and evidence model as self-serve users. Customers receive the workspace, report, records, and limitations, not a black-box consulting deliverable.

## 8. Market entry and channels

### 8.1 Founder-led, trigger-based outbound

Search for visible moments when a benchmark claim is being prepared or scrutinized:

- launch announcements;
- benchmark tables in product pages or repositories;
- release notes;
- research posts;
- model comparisons;
- procurement requests;
- customer case studies;
- public disputes over performance claims.

The outreach should be specific to the claim:

> “We saw the comparison behind your release. We are building a way to lock the method, account for every result, and publish evidence that customers can independently inspect.”

### 8.2 Design-partner campaigns

Recruit a small set of partners with real upcoming decisions. Each engagement should produce an actual report used in a launch, sales process, procurement decision, internal release gate, or research claim.

The success event is not account creation. It is:

1. a benchmark is locked;
2. the campaign completes or reports its limitations honestly;
3. the result is used in a real decision;
4. another party inspects or verifies it;
5. the customer returns for a later release or comparison.

### 8.3 Open evaluation ecosystem

A first-class Inspect integration can be a major acquisition channel:

> **Select a supported Inspect task. Colophon expands it into a locked multi-arm comparison and runs each cell through Inspect.**

The product should complement the open-source evaluation ecosystem by keeping Inspect as the trial engine, not by pretending the Inspect eval-set is the published claim.

Terminal-Bench 2.1 is a different door: a **named official protocol** Colophon wraps, not a select-a-task overlay and not Hub-as-the-claim ([DR-2026-08-17-b](../../../log/decisions/2026-08-17-official-suite-protocol.md)):

> **Lock the official Terminal-Bench 2.1 method. Colophon runs Harbor under that lock, accounts every cell, and publishes a checkable bundle. Hub export is a derived artifact for their submit flow, not the claim of record.**

A cousin method on TB tasks must not wear the suite name. A protocol-faithful slice is not a leaderboard-complete run. Copy must not claim Colophon placed a Hub row while community submissions are closed.

APEX-SWE-dev is a third named protocol: wrap both Mercor harnesses on the public 50, Pass@1, never a Mercor leaderboard row ([DR-2026-08-18](../../../log/decisions/2026-08-18-apex-swe-dev-official-suite.md)):

> **Lock the official APEX-SWE-dev method. Colophon wraps Mercor's apx and run_e2e under that lock. The public 50 cannot wear the 200-task APEX-SWE leaderboard.**

Potential distribution surfaces include:

- integration guides;
- a CLI workflow;
- reusable campaign templates;
- CI examples;
- report verification badges;
- public example bundles.

### 8.4 Evaluator and benchmark-builder partnerships

Independent evaluators, benchmark creators, and domain experts can use the product as their delivery layer.

Give them:

- an auditable campaign control plane;
- portable reports;
- client-facing verification;
- attributable evaluation work;
- later access to execution and verification supply.

These partners can become both suppliers and distribution channels.

### 8.5 Artifact-led distribution

The published report is the core distribution object.

Every report should make it easy for a reader to see:

- what was compared;
- what method was locked;
- whether all expected runs were accounted for;
- which assurance policy was used;
- who executed and evaluated the work;
- what limitations remain;
- how to verify the evidence.

A report can carry restrained product attribution such as:

> **Method locked. Complete run accounting. Evidence available.**

Avoid language such as “certified,” “proven true,” or “officially ranked” unless a later product establishes a precise and defensible meaning for it.

## 9. Pricing posture

Treat this as a set of launch hypotheses to validate, not final pricing.

### Self-serve

Use a low-friction entry point to maximize completed benchmarks and published reports. A plausible structure is free local use plus paid hosted collaboration or usage later, but hosting and packaging decisions remain to be validated.

### Assisted setup

Offer a fixed-scope package with a clear deliverable, such as a benchmark design review, task-set validation, or campaign configuration.

### Managed campaign

Charge a project fee for evaluation design and operation, with compute, model, expert, and external-provider costs visible separately.

### Independent assurance

Charge per campaign or per purchased provider capability, with a transparent application or coordination fee.

### Continuous evaluation

Once repeat usage is established, offer scheduled reruns, release comparisons, and standing assurance policies as a recurring product.

## 10. Launch sequence

### Phase 0: launch readiness

Establish a product that can support a real campaign without a preexisting Jinn Data corpus.

Minimum GTM gates:

- the standalone Benchmark Product has a ratified product definition;
- a user can complete the core lifecycle end to end;
- the product works with at least one established open-source evaluation framework;
- the report clearly distinguishes self-run discipline from genuine external independence;
- managed operators use the same product surface as self-serve users;
- the output can be shared and independently verified.

### Phase 1: assisted design-partner alpha

Run real campaigns wherever committed design partners pull them (§6 discovery gate). Operate the product with users, but do not build parallel manual workflows or speculative domain capabilities.

**Exit condition:** multiple reports are used in real decisions, at least one customer repeats the workflow, and the team has comparative domain evidence from Track 1 interviews plus completed, committed campaigns.

### Phase 2: private self-serve beta

Invite technically capable users who can lock a named suite protocol, select a supported Inspect task, or bring their own task set.

Offer self-serve, assisted setup, and managed modes side by side.

**Exit condition:** users complete a credible benchmark without the product team operating the lifecycle, while managed engagements continue to surface repeatable product improvements.

### Phase 3: public launch

Launch around customer artifacts and outcomes, not protocol architecture.

Primary calls to action:

- **Run your benchmark**
- **Have us run it with you**

### Phase 4: independent assurance market

Add genuine external evaluators, execution providers, and environment verifiers.

The product evolves from disciplined self-publication to configurable external assurance.

### Phase 5: Jinn Data and evidence reuse

As campaign output gains density, begin checking whether qualifying evidence already exists before commissioning new work.

The later promise becomes:

> **Reuse what already qualifies. Create only what is missing.**

## 11. Metrics

### North-star metric

> **Verifiable benchmark reports used in a real decision or external claim.**

A report counts when it supports a release, customer diligence process, vendor comparison, procurement decision, research claim, or deployment decision.

### Funnel metrics

| Stage | Metric |
|---|---|
| **Acquisition** | Qualified prospects with a live benchmark or decision trigger |
| **Activation** | Time from project creation to a locked benchmark |
| **Completion** | Share of locked campaigns reaching a complete or honestly partial report |
| **Value** | Reports used in a real external or internal decision |
| **Distribution** | Reports shared, readers reached, and third-party verification actions |
| **Retention** | Teams rerunning a benchmark for a later release or new comparison |
| **Monetization** | Conversion to assisted setup, managed service, or independent assurance |
| **Network** | Campaigns using genuinely external execution, evaluation, or verification |
| **Data** | Rights-permitted evidence retained for future qualification or reuse |

### Domain-selection metrics

Compare domains on:

- paid design-partner conversion;
- time to first useful report;
- repeat usage;
- service hours required per campaign;
- ability to standardize templates;
- importance of independent assurance;
- report sharing and reader verification;
- evidence reuse rights;
- provider and environment availability.

## 12. Defensibility and investor story

The initial interface is not the moat. Benchmark workflows, report pages, and semantic search can be copied.

The potential compounding advantage is the combination of:

- a growing graph of work, environments, outcomes, evaluations, and attestations;
- a reputation graph for operators, evaluators, and verifiers;
- a demand graph showing which capabilities and trust standards buyers need;
- a live market capable of producing missing work or assurance;
- portable evidence that can support multiple applications and trust policies.

The investor narrative is:

> **Start with a self-serve product for credible AI benchmarking. Monetize expertise and independent assurance around it. Let every campaign create reusable evidence and market demand. Over time, turn repeated evaluation spending into a compounding data and assurance economy.**

The managed service creates revenue and operational learning. Self-serve creates distribution. Open provider supply creates structural differentiation. Jinn Data creates the later search and reuse opportunity.

## 13. Primary risks and controls

### Risk: broad market becomes product sprawl

**Control:** remain broad by domain but narrow by job. Every campaign must use the same core lifecycle. Add domain-specific product behavior only after repeated, paid demand.

### Risk: self-serve is too difficult

**Control:** use managed and assisted campaigns to discover the templates, defaults, checks, and explanations that need to become product features.

### Risk: managed service becomes a consultancy

**Control:** all managed work must use the same product state and operations. Track manual steps and productize only repeated ones. Reject engagements that require an entirely separate workflow.

### Risk: customers do not value external assurance

**Control:** test it as an explicit paid option. Measure whether it changes purchase decisions, publication confidence, customer diligence, or willingness to share results.

### Risk: customers only need private internal evals

**Control:** target claims and decisions that cross a trust boundary. Integrate with internal evaluation tools rather than competing for their full workflow.

### Risk: reports are technically verifiable but not understandable

**Control:** optimize the report for a skeptical non-specialist reader while preserving machine-readable evidence and expert detail beneath it.

### Risk: the strongest domain is missed by early assumptions

**Control:** deliberately recruit across domain hypotheses and use completed campaigns, paid behavior, and retention to select the beachhead.

## 14. What would falsify the strategy

Reconsider the product direction if customer evidence shows that:

- teams do not care whether a benchmark claim is independently inspectable;
- self-serve users only want internal iteration and deployment gates;
- external audiences rely on brand reputation rather than underlying evidence;
- managed campaigns remain too bespoke to standardize;
- customers will not pay for stronger independent assurance;
- reports are not reused across releases or decisions;
- rights and confidentiality prevent campaign evidence from ever compounding;
- no domain produces a repeatable, urgent buying trigger;
- self-run discipline without external assurance is insufficient to cross the trust boundary — the sharpest falsifier, testable in Phase 1, and the one that invalidates the Phase 0–3 wedge specifically.

## 15. Strategic summary

The GTM is not “launch a coding-agent eval platform.”

It is:

> **Find teams at the moment they need an AI performance claim or decision to withstand scrutiny. Give them a self-serve way to run and publish the benchmark with inspectable evidence. Sell expert help and independent assurance through the same product. Let demand reveal the strongest domain.**

The product sits at the center.

The managed service wraps it.

Established evaluation frameworks run the trial beneath it.

Jinn supplies the evidence and future open assurance market.

Each campaign creates the foundation for Jinn Data and the later query product.

## References

### Repository grounding

- [`PRINCIPLES.md`](https://github.com/Jinn-Network/mono/blob/integration/evidence-v1/PRINCIPLES.md)
- [`CLAUDE.md`](https://github.com/Jinn-Network/mono/blob/integration/evidence-v1/CLAUDE.md)
- [`THESIS.md`](https://github.com/Jinn-Network/mono/blob/integration/evidence-v1/THESIS.md)
- [`BRAND.md`](https://github.com/Jinn-Network/mono/blob/integration/evidence-v1/BRAND.md)
- [`SPEC.md`](https://github.com/Jinn-Network/mono/blob/integration/evidence-v1/SPEC.md)
- [PR #2541: standalone Benchmark Product](https://github.com/Jinn-Network/mono/pull/2541)
- [`2026-08-05-benchmark-product-design.md`](../specs/2026-08-05-benchmark-product-design.md)
- [DR-2026-08-10 — Product-Led GTM and Default First Market](../../../log/decisions/2026-08-10-product-led-gtm-and-first-market.md)
- [DR-2026-08-17 — Runtime engine direct mode](../../../log/decisions/2026-08-17-runtime-engine-direct-mode.md)

### Market reference points

- [Inspect AI](https://inspect.aisi.org.uk/)
- [Braintrust Evaluate](https://www.braintrust.dev/product/evaluate)
- [Scale RL Environments](https://scale.com/rlenvironments)
- [Vals methodology](https://www.vals.ai/methodology)

## Authority note

Engine-wrap vs campaign-overlay copy in §3, §8.1, §8.3, and §15 is governed by [DR-2026-08-17 — Runtime engine direct mode](../../../log/decisions/2026-08-17-runtime-engine-direct-mode.md). TB 2.1 named-protocol copy in §8.3 is governed by [DR-2026-08-17-b — Official suite protocol](../../../log/decisions/2026-08-17-official-suite-protocol.md). APEX-SWE-dev named-protocol copy in §8.3 is governed by [DR-2026-08-18 — Official suite protocol (APEX-SWE-dev)](../../../log/decisions/2026-08-18-apex-swe-dev-official-suite.md). `GROWTH.md` is unchanged.

The current `integration/evidence-v1` version of `GROWTH.md` encodes a harness-first strategy, and the standalone product design lineage (charter §5, program plan §3, PR #2541) fixes coding-agent builders as the first market. This draft departs from both. The departures are proposed — not silently applied — through [DR-2026-08-10 — Product-Led GTM and Default First Market](../../../log/decisions/2026-08-10-product-led-gtm-and-first-market.md): the GROWTH.md strategy-layer revision routes through the canonical-doc process (linked GitHub Discussion + CODEOWNERS approval per `spec/2026-04-28-canonical-docs.md`), and the first-market amendment lands as a dated addendum on the program plan at ratification. Until the DR ratifies, GROWTH.md and the program plan remain authoritative as written.
