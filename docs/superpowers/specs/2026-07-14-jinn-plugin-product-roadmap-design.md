# Jinn Plugin Product Roadmap

**Date:** 2026-07-14

**Status:** Product direction approved; written review pending

## Purpose

This document defines the high-level product lifecycle, ecosystem architecture, and development
stages of the Jinn Plugin. It is a strategic product design, not an implementation specification.
Detailed interaction designs, schemas, ranking algorithms, evaluator mechanics, marketplace
economics, and training systems belong in later, independently reviewed designs.

The roadmap is organized around successive complete versions of the user-facing product. The
supporting infrastructure becomes more capable at each stage, but infrastructure maturity is not
itself the product milestone.

## Product decision

The **Jinn Plugin is the enduring product** through which users experience the Jinn ecosystem. It
makes an agent better using accumulated experience and turns eligible work into knowledge that
can improve future agents.

The plugin runs inside a compatible agent environment but is not defined by any particular host.
It owns the learning relationship with the user: understanding work, supplying knowledge,
capturing evidence, improving the agent's configuration, and coordinating with the network. A
host supplies execution and configurable surfaces through an integration boundary.

Search, tasks, the corpus, evaluation, distillation, and eventual model training are not separate
user products. They are supporting capabilities and applications that increase the value
delivered through the plugin.

## Enduring product promise

The plugin's promise is:

> Make the user's agent better from shared experience, and turn eligible work into knowledge that
> improves future agents.

The canonical knowledge substrate remains stable over time. Jinn captures durable evidence of
agentic work once, then reuses it for retrieval, skill distillation, policy optimization,
evaluation, and model training. What evolves is how that evidence is selected, transformed,
evaluated, and deployed. Skills, policies, datasets, and model adaptations extend the corpus as
provenance-linked derivatives; they do not replace its underlying evidence.

The plugin has four enduring responsibilities:

1. **Consume:** bring useful shared or local knowledge into the current workflow.
2. **Sense:** understand the user's work, identify missing knowledge, and observe whether an
   intervention helped.
3. **Coordinate:** route eligible demand and outcomes into the network and obtain improved
   artifacts from it.
4. **Apply:** trial, configure, measure, update, and roll back increasingly capable learning
   artifacts in the user's agent environment.

The unresolved product problem is not whether individual components can retrieve a trace, create
a task, or generate a skill. It is whether those components form one coherent experience that
reliably improves the user's work.

## Stable user lifecycle

The same product lifecycle persists through every stage:

> User starts ordinary agentic work → plugin understands the task → plugin finds and applies
> relevant knowledge → host performs the work → plugin measures the outcome → eligible gaps
> become network demand → the network produces better knowledge → the plugin applies it to future
> work.

Later stages improve the quality, compression, and adaptiveness of the knowledge applied within
this lifecycle. They do not replace the product relationship.

The user should not need to operate a corpus, marketplace, distillation pipeline, or training
system. Those systems should appear through legible product moments: what Jinn used, how it
affected the work, what may be contributed, and what the user can control.

## Durable knowledge substrate

Jinn follows a **capture once, derive many times** model. From the first product stage, the system
records a durable, provenance-linked episode of agentic work as the common raw material for every
later learning method.

A canonical evidence episode contains or references:

- the task and relevant environment;
- the agent's actual trajectory, including tool use and intermediate decisions;
- intermediate artifacts and final outputs;
- the model, host, skills, and agent-policy configuration used;
- the outcome and evaluator evidence;
- cost and latency; and
- privacy, retention, and publication status.

The trajectory must be a typed, discoverable, first-class part of the evidence episode. Its bytes
may remain in a content-addressed object for size or privacy reasons, but consumers must not need
to infer that a meaningful trajectory is hidden inside a generic system snapshot.

Different uses require different physical representations. Retrieval may require chunks and
indexes, training may require examples or preference pairs, and evaluation may require sealed
holdouts. These are reproducible, provenance-linked views of canonical evidence rather than new
sources of knowledge that must be regenerated for each stage.

Derived artifacts—including skills, complete agent policies, datasets, evaluators, adapters,
and model weights—are also retained with lineage to their source evidence, transformations,
evaluations, and observed deployment outcomes. The corpus therefore accumulates both durable
evidence and the artifacts compiled from it.

Privacy changes which views may leave the machine, not the semantic evidence model. Private and
public episodes should share the same conceptual contract even when raw private content remains
local or is later deleted under user-controlled retention policy.

## Product architecture

### Jinn Plugin

The plugin is the user-facing intelligence and coordination layer. It understands the current
work, retrieves relevant knowledge, captures durable local evidence, performs or invokes local
learning, configures the host agent, presents controls, captures outcomes, and communicates the
value Jinn provided. As the ecosystem develops, it discovers and manages skills, agent policies,
and model adaptations produced elsewhere.

### Host integration boundary

The host is an external execution dependency, not part of the Jinn product definition. It may be
any compatible agent environment that exposes the work context, execution lifecycle, evidence,
and configurable surfaces the plugin needs. Host-specific adapters translate those surfaces into
the stable capabilities expected by the plugin.

The plugin may modify prompts, tools, skills, retrieval, model selection, budgets, and execution
behavior where the host permits it. Disabling or bypassing the plugin must return the host to its
unmodified behavior. The detailed design of any particular host belongs in a separate document.

### Jinn Core

Jinn Core is the general-purpose substrate: corpus, task marketplace, execution, evaluation,
provenance, and incentives. It stores evidence, coordinates scarce work, and makes results
verifiable. Its evidence model is stable across learning stages, and its derived artifacts retain
lineage to that evidence. It should expose general primitives rather than embed every learning
method.

### Skill Factory

The Skill Factory is an application built on Jinn Core, not a responsibility hidden inside the
plugin or core protocol. It reads corpus evidence, produces candidate skills, creates and funds
marketplace experiments, optimizes candidates, and benchmarks them across agents, models, hosts,
and environments.

A factory may run a GEPA-style loop while offloading expensive and diverse agentic execution to
the task marketplace. Successful skills and their evaluation evidence are published for plugin
consumption.

### Skills Hub

The Skills Hub is the catalog and distribution surface for shared skills. It records versions,
compatibility, provenance, evaluation results, expected costs and benefits, and observed
real-world performance. The plugin uses the hub to discover, trial, install, update, and roll back
skills.

The hub may be presented inside the plugin, but the process that produces its skills remains an
independent application.

### Other learning applications

Future policy optimizers and model-training applications can use the same core primitives. They
consume evidence and marketplace execution, then publish evaluated artifacts that the plugin can
deploy. Jinn Core does not need to become a skill factory, policy optimizer, or model trainer.

The architectural rule is:

> The plugin consumes and applies network learning; it does not need to contain every process that
> produces it.

## Product value flow

### Immediate utility loop

The adoption loop begins with direct value:

> User work → plugin identifies a need → plugin applies available knowledge → host completes
> the work → plugin measures the result.

This is why someone installs and continues using Jinn. Contribution cannot substitute for this
utility.

### Ecosystem improvement loop

Observed use directs how the shared system improves:

> Observed demand or failure → eligible OSS task → marketplace execution and evaluation → corpus
> evidence → factory-produced artifact → distribution hub → plugin deployment → real-world
> outcome.

The task marketplace therefore has two durable roles:

1. **Generate missing evidence** by producing attempts against valuable tasks.
2. **Benchmark derived artifacts** such as skills, policies, and model adaptations.

The corpus grows where real agent use reveals valuable missing knowledge. Learning applications
then compress and configure that evidence so it becomes cheaper, more reliable, and easier for
the plugin to apply.

| Participant | Receives | Contributes |
| --- | --- | --- |
| User | Better or cheaper agentic work | Demand signals, outcomes, and eligible OSS work |
| Jinn Plugin | Evidence and evaluated artifacts | Context, attribution, deployment, and feedback |
| Factory applications | Corpus evidence and distributed execution | Optimized, benchmarked artifacts |
| Marketplace participants | Rewards and reputation | Generation, execution, evaluation, and benchmarking |
| Corpus | Verified evidence and lineage | Shared memory for connected agents and applications |
| Jinn ecosystem | Growing utility and defensibility | Coordination, verification, and public infrastructure |

The economic loop follows the utility loop. Rewards should pay for scarce generation, execution,
evaluation, optimization, and benchmarking that demonstrably improve user outcomes—not for
undifferentiated publication or corpus volume.

## Product lifecycle roadmap

The stages are cumulative versions of one product. Each stage must provide a complete user
experience; later stages deepen the kind of knowledge supplied through it.

| Stage | User experience | Plugin role | Supporting ecosystem | Graduation evidence |
| --- | --- | --- | --- | --- |
| **1. Complete connected product** | Shared knowledge helps ordinary OSS work through one coherent flow | Connects retrieval, work, outcome, history, and contribution | Existing components assembled end to end; trajectories surfaced as first-class evidence | The complete lifecycle is usable and preserves reusable evidence |
| **2. Product-shaped foundation** | Jinn is reliable, legible, and measurable | Attributes outcomes and manages controls and fallback | Stable evidence and lifecycle contracts plus product instrumentation | Utility is repeatable and attributable |
| **3. Skills network** | Evaluated skills improve the user's agent | Discovers, trials, applies, measures, and rolls back skills | Skill Factory, Skills Hub, and marketplace benchmarking | Skills beat raw retrieval |
| **4. Agent policy network** | Jinn selects complete agent configurations | Configures the host, compares policies, and rolls them back | Policy-optimization applications and controlled evaluation | Dynamic policies beat static loadouts |
| **5. Model adaptation network** | Appropriate learning is internalized into models | Coordinates deployment, comparison, and feedback | Training applications and training verification | Adaptation beats plugin-level learning |

The strategic progression is:

> Complete product → measurable product → evaluated skills → optimized agent policies → adapted
> models.

### Stage 1 — Complete connected product

The first objective is to assemble what already exists into one coherent, end-to-end product
experience. Proof of improvement is secondary to making the complete lifecycle usable.

The user can:

1. Install or enable Jinn in a compatible agent environment.
2. Perform normal OSS work rather than enter a benchmark-oriented workflow.
3. Receive relevant corpus knowledge during the work.
4. Understand what Jinn contributed.
5. Complete the task normally.
6. Review the outcome and any eligible contribution.
7. See useful history across sessions.

The plugin acts as the product shell connecting existing retrieval, corpus, task, trace,
evaluation, and local-distillation capabilities. Some internal steps may remain rough or manually
operated. Stage 1 requires a coherent user experience, not mature automation behind every step.

Stage 1 also establishes the durable raw material for later stages. The actual trajectory is
captured as a first-class, discoverable component of the evidence episode rather than remaining
available only through incidental storage such as a system snapshot. Retrieval does not consume
and discard this evidence; the same episode remains available to future factories and training
applications.

The Stage 1 gate is product completeness:

> A person can use Jinn for real OSS work, receive shared knowledge, understand what Jinn did, and
> contribute an eligible learning signal through one coherent experience, while Jinn preserves
> the resulting evidence in a form reusable by later learning stages.

### Stage 2 — Product-shaped foundation

After the complete experience has been dogfooded, Jinn is refactored around the lifecycle revealed
by actual product use.

This stage:

- establishes a clean and stable plugin–host integration boundary;
- establishes the stable canonical evidence contract shared by local and public knowledge;
- unifies overlapping task, trace, trajectory, snapshot, outcome, and contribution concepts;
- removes accidental storage boundaries that hide meaningful evidence inside generic artifacts;
- replaces the manual bridges exposed by Stage 1;
- makes permissions, provenance, and fallback behavior legible;
- adds reliable attribution from supplied knowledge to observed outcomes; and
- measures quality, cost, latency, and failure rate.

The Stage 2 gate is a repeatable and measurable product:

> Users can reliably complete the lifecycle, and Jinn can determine whether its intervention
> helped, harmed, or made no difference.

This sequencing is intentional: assemble the product first, then clean the architecture around
evidence from using it.

### Stage 3 — Skills network

The plugin progresses from primarily retrieving evidence to applying evaluated, reusable skills.

For the user, Jinn can:

- recognize that a shared skill is relevant;
- explain its expected benefit and compatibility;
- trial it in shadow or canary mode;
- configure it in the host agent;
- measure whether it helped on real work; and
- retain, update, or roll it back.

The ecosystem adds a Skill Factory on top of Jinn Core. It consumes the same canonical evidence
already used for retrieval and publishes provenance-linked derivatives rather than introducing a
skill-specific knowledge substrate. A factory run can:

1. Find a valuable repeated pattern or capability gap in corpus activity.
2. Select representative traces, successes, failures, and tasks.
3. Produce an initial skill and candidate variants.
4. Create marketplace tasks that execute candidates under controlled conditions.
5. Evaluate quality, cost, latency, robustness, and compatibility.
6. Use the results to generate another population of candidates.
7. Repeat until improvement plateaus or the budget is exhausted.
8. Publish the successful skill and its evaluation envelope to the Skills Hub.
9. Use plugin deployments to validate real-world performance and detect degradation.

Local skill distillation remains a plugin capability as the private and immediate path. The plugin
may perform it directly or invoke a local service through the host integration. The Skill Factory
is the heavier public path for producing skills intended to generalize across users. A locally
useful skill may inspire a public candidate, but the public version must be reconstructed from
eligible evidence and independently evaluated.

The Stage 3 gate is:

> Evaluated skills delivered through the plugin outperform raw retrieval or static instructions
> after accounting for generation, evaluation, and runtime cost.

### Stage 4 — Agent policy network

The unit of learning expands from an individual skill to a complete agent configuration: skills,
tools, prompts, retrieval strategy, model choice, budgets, and execution policy. These policies
are part of the plugin's product surface even though the plugin applies them through host-specific
integration capabilities.

The plugin can construct and adapt policies locally, while policy-optimization applications built
on Jinn Core generate and compare candidates at network scale. The marketplace supplies
heterogeneous execution and controlled evaluation. These applications reuse the canonical
evidence and evaluation history accumulated by earlier stages. The plugin remains the deployment,
control, rollback, and measurement surface.

For the user, Jinn can select and manage the best-known configuration for a category of work
without hiding what changed or preventing a return to a stable baseline.

The Stage 4 gate is:

> Dynamic, task-aware agent policies outperform the best stable skill configuration without
> introducing unacceptable complexity or unreliability.

### Stage 5 — Model adaptation network

Only after the earlier evaluation loops produce trustworthy evidence does Jinn support
fine-tuning, preference learning, reinforcement learning, or other model adaptation.

External training applications consume corpus evidence and task-marketplace execution in the same
way the Skill Factory does. They produce candidate adapters or models while Jinn Core supplies
tasks, evaluation, provenance, and potentially distributed compute coordination. Training
examples, preference pairs, rewards, and holdouts are derived views of the existing evidence—not a
new corpus that requires earlier work to be generated again.

The plugin:

- identifies where runtime knowledge remains expensive or insufficient;
- selects compatible model adaptations;
- deploys them under controlled conditions;
- compares them with plugin-level learning;
- measures real-world benefit and degradation; and
- routes eligible evidence into future training.

The Stage 5 gate is:

> Model adaptation provides additional cost-adjusted capability beyond retrieval, skills, and
> agent policies after including training and deployment cost.

## Initial contribution and privacy boundary

Coding and OSS work are the initial wedge because they provide reproducible environments and
relatively strong evaluators. They are suitable for completing the product lifecycle and proving
the learning mechanism; they do not make Jinn permanently a coding product.

The initial public contribution boundary is intentionally narrow:

- raw private traces remain local;
- only reproducible OSS-derived work can become a user-originated public task;
- private experience may help derive local evaluation criteria or gold holdouts, but private facts
  cannot be required by the resulting public task or evaluator;
- anything leaving the machine must be independently executable against a public OSS base; and
- fresh attempts produced for those tasks in clean marketplace environments may become public
  evidence.

Publication begins review-first. Greater automation may follow only after the compiler and
admission boundary are proven. The detailed authorization experience is a follow-on product
design.

These controls restrict publication without fragmenting the knowledge model. A private local
episode and a public OSS episode use the same semantic evidence contract; their storage,
retention, scrubbing, and permitted derived views differ.

## Cross-stage safeguards

Every stage retains:

1. **Local fallback.** Network failure or artifact failure degrades to local knowledge or bypasses
   the plugin, returning the host to its unmodified behavior rather than preventing work.
2. **Provenance.** Jinn can connect applied knowledge to its evidence and the outcome it produced.
3. **Controlled contribution.** Public contribution stays within the approved OSS boundary and is
   legible to the user.
4. **Independent evaluation.** Shared artifacts are tested separately from the process that
   generated them.
5. **Safe deployment.** Skills, policies, and models can be staged, compared, and rolled back.
6. **Cost-adjusted comparison.** Each learning layer must beat the simpler preceding layer after
   its production and runtime costs are included.
7. **Evidence preservation.** New learning methods reuse canonical evidence and add linked
   derivatives rather than replacing or regenerating the substrate.

Failure at one layer does not invalidate the layers beneath it. Raw evidence remains useful if a
distillation method fails, and plugin-managed skills or policies remain valuable if model
adaptation is uneconomical.

## Product principles

1. **The plugin is the product; the network is leverage.** Users adopt Jinn for a better agent, not
   to operate a marketplace.
2. **Every stage is a complete product.** New infrastructure counts only when it forms part of a
   coherent user experience.
3. **Capture once, derive many times.** Canonical evidence is durable raw material for retrieval,
   skills, policies, evaluation, and training; derived artifacts retain lineage to it.
4. **Contribution is useful exhaust.** Normal work reveals demand and, where safe, creates public
   opportunities without making contribution a prerequisite for value.
5. **Factories are applications, not the protocol.** Learning methods may evolve independently
   while reusing stable corpus, task, evaluation, and provenance primitives.
6. **Learning layers must earn their place.** More elaborate artifacts are adopted only when they
   beat simpler ways of applying the evidence.
7. **Utility precedes economics.** Rewards coordinate proven value creation rather than substitute
   for product-market fit.
8. **Knowledge remains a public good.** The marketplace pays for scarce work—generation,
   execution, evaluation, optimization, benchmarking, and compute—not for excluding others from
   knowledge bytes.
9. **Local operation is a durable floor.** Network failure should not prevent the user from
   working or benefiting from private learning managed by the plugin.
10. **The coding wedge is an instrument, not an identity.** The plugin can expand to other agentic
   work once the learning mechanism is proven.

## Explicit non-goals

This document does not specify:

- the detailed Stage 1 interaction design;
- host-specific adapters and execution lifecycles;
- task-capsule, trace, skill, policy, or model-artifact schemas;
- retrieval implementation or ranking;
- publication screens, permissions, or automation thresholds;
- marketplace pricing and reward formulas;
- evaluator implementation;
- GEPA or other factory optimization internals;
- Skills Hub storage or interface design;
- fine-tuning or reinforcement-learning infrastructure; or
- a detailed delivery schedule.

Each is a follow-on design subordinate to this product lifecycle, architectural separation, and
graduation logic.

## Grounding in the repository

This roadmap consolidates the direction already visible in:

- [`SPEC.md`](../../../SPEC.md): the create → solve → evaluate → learn protocol loop;
- [`PRINCIPLES.md`](../../../PRINCIPLES.md): learning maximisation, legibility, and permissionless
  public infrastructure;
- [`spec/2026-07-06-distillation-v1.md`](../../../spec/2026-07-06-distillation-v1.md): the distinction
  between raw evidence and reusable skills, and the requirement that distillation beat retrieval;
- [`docs/learning-engine.md`](../../learning-engine.md): the evaluation instrument and
  evidence-gated policy-improvement loop.
