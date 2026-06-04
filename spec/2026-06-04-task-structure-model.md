---
version: 0.1
date: 2026-06-04
author: opus
status: proposed
---

# Task structure model — Result, Process, Solution

A plain-English disambiguation of how a **task** is structured in Jinn, and a
proposal for the canonical-doc edits that follow from it. The motivating
observation: the operator app and our reporting currently surface a single
"value of the solution," but a task produces **more than one valued thing**,
and the protocol already meters them separately on-chain. Collapsing them into
one number is not just imprecise — it is the binding constraint on the learning
loop (see §4).

This spec is a **proposal**. It does not edit `GLOSSARY.md` or `SPEC.md`
in place; canonical content changes only through a linked Discussion +
CODEOWNERS review (`spec/2026-04-28-canonical-docs.md`). §5 lists the exact
edits this proposal would anchor.

## 1. The problem in one paragraph

When an operator runs an attempt, what comes out is reported as "the solution"
and assigned a value. But "the solution" is doing three jobs at once: it names
(a) the **result** — the end-state that was reached, (b) the **process** — the
trajectory of work that reached it, and (c) the reusable **solution** in the
corpus sense — the distilled, content-addressed method that can be matched
against future tasks. These are three different objects with three different
kinds of value, and a human reasoning about a task cannot tell which one a
reported number refers to. `GLOSSARY.md`'s existing definition of *Solution*
already leans toward (c) — its examples are "a skill, a plugin, a prompt set, a
harness configuration, a full environment," all reusable *methods*, none of
them per-task *answers* — which makes the flattening in reporting an active
contradiction, not just a vagueness.

## 2. The model

The model has two layers: the **entities** that do the work, and the
**objects** a task precipitates as it moves through the loop (Creation →
Execution → Evaluation → Knowledge).

### 2.1 Entities — who and what does the work

| Entity | Plain English | Notes |
|---|---|---|
| **Operator** | The human who owns, runs, and manages one or more nodes. | Accountable off-chain. Not the key-holder — the node is (see §6). |
| **Node** | The software bundle an operator runs: daemon + operator app (frontend) + local store. | *May* run an indexer, but by default consumes a **shared** indexer — per-node self-indexing is the 2026-05-23 substrate incident. Holds the keys and signs on-chain. |
| **Run** | One instance of work a node does to contribute to a task. Typed by loop phase: **creation run**, **solve run**, **evaluation run**. | A *solve run* is the loop's "Execution" phase. The act of solving — **not** the Solution it may produce (§2.2). |
| **Role** | The relationship a run establishes to a task: **creator**, **solver**, **evaluator**. | A *hat worn per-run*, not a fixed identity. One node can do all three run types; an **independence rule** forbids invalid combinations on the same task (you cannot evaluate your own solve run). |

Two roles are **standing**, not per-task runs:

- **Curator** — stakes JINN, defines the evaluation criteria, and launches a
  SolverNet (canonical in `GLOSSARY.md`; renamed from Launcher / Trainer). It
  directs emissions and bears the convergence bet; it is not a unit of work a
  node "runs."
- **App** — consumes the substrate; locks JINN for service-tier reads. A reader,
  not a runner.

The chain proves runs are **distinct** (different addresses, different
transactions); it does not prove they are **independent** (different real-world
operators). The independence rule is therefore an economic / reputational
constraint layered on top of distinctness, not something the run-type taxonomy
enforces by itself.

### 2.2 Objects — what a task precipitates

| Object | Plain English | What it answers | Lifetime |
|---|---|---|---|
| **Task** | The desired state a creation run publishes, with fee. Canonical umbrella over the older `intent` / `desired state` / `DesiredState`. | *What is wanted?* | One task |
| **Result / Outcome** | The end-state a solve run reached; whether the task was made true. | *Did it work?* | One run |
| **Process / Trace** | The trajectory of work the solve run took to reach the result — the steps, the method, the record of how. | *How did it get there?* | One run; **distillable** |
| **Solution** | The reusable, content-addressed method distilled from good processes and stored in the corpus (skill / plugin / prompt set / harness config / environment). | *What should the next solve run reuse?* | Persists across tasks |
| **Knowledge** | The accumulating corpus of Solutions plus the verdicts attached to them. | *What has the network learned?* | The substrate |

The three claims worth stating flatly:

1. **A Result and a Process are distinct, and each is independently valuable.**
   The Result has value as a verified outcome (someone wanted X; X is now true,
   attestable on-chain). The Process has value as *knowledge* — it is what
   generalizes to the next task. In an open agentic knowledge economy the
   Process is frequently the **more** valuable of the two, because the corpus is
   a substrate of *processes-distilled-into-methods*, not a ledger of answers.

2. **A Solution is not a Result.** A Solution is what a Process becomes when it
   is abstracted out of a single solve run and made reusable. The Result is
   consumed by the creator who wanted it; the Solution is consumed by every
   future solve run. Conflating them is the core of the reporting gap — and it
   is why "solve run," not "solution run," is the name for the act (a solve run
   only *sometimes* yields a Solution).

3. **A role is a hat, not an identity.** Creator, solver, and evaluator are
   relationships a *run* establishes to a task, not types of operator. One
   operator's node can perform all three run types; the independence rule
   governs which combinations are valid on a single task. This keeps the entity
   model small (operator → node → run) and pushes the "who may do what" question
   onto a single economic rule rather than a taxonomy of entity types.

The whole model in one picture:

```
operator (human)  ──owns──▶  node (daemon + frontend + store; maybe indexer)
node  ──performs──▶  runs, each typed by loop phase:
                       creation run · solve run · evaluation run
run   ──establishes──▶  a per-task role (creator / solver / evaluator),
                        under an independence rule
standing roles (not runs):  curator (stakes, defines eval, launches SolverNet)
                            app     (consumes the substrate)
task  ──is──▶  created · solved · evaluated against
a solve run  ──produces──▶  a result + a process  →  sometimes distilled
                                                      into a solution  →  knowledge
```

## 3. The economics already split it

This is not a new distinction we are inventing for legibility; the protocol's
four incentive channels already meter Result and Process separately:

- **Restoration reward** pays for the **work / attempt** — the Process.
- **Outcome reward** pays for the **result holding** — the Result.

(Plus **creation** and **evaluation** rewards on the other two roles.) The
contract layer distinguishes Process-value from Result-value; the reporting
layer collapses them back into one "solution value." The model in §2 simply
names what the chain already pays for, so the two layers stop disagreeing.

## 4. Why this is load-bearing for learning — not just wording

This is the part that elevates the disambiguation from a glossary tidy-up to a
precondition. Map the three objects onto the learning engine
(`docs/learning-engine.md`, in flight on branch
`claude/learning-model-explanation-yoBdo`) and the RL-on-harness roadmap
(`spec/2026-05-28-harness-as-policy-learning-architecture.md`, Discussion
[#770](https://github.com/Jinn-Network/mono/discussions/770)):

| Task-structure term | Learning-engine term | Role in the loop |
|---|---|---|
| **Solution** | the **policy / loadout** being iterated; its content-addressed identity `codeDigest = hash(implStateDir)` is the **chassis** (policy identity) | the mutable bundle the loop tries to improve |
| **Result / Outcome** | the **verdict** | the signal policy-evaluation reads |
| **Process / Trace** | the **trajectory** | the substrate that **credit-assignment granularity** (the "resolution" knob) operates on |

With that mapping, the original observation restates exactly:

- Reporting a single "value of the solution" **is the resolution knob stuck at
  its lowest setting.** It is the same gap #770 names as the one missing RL
  component — *credit assignment*: knowing which part of which object earned the
  verdict. You cannot assign credit to a Process you did not keep, nor across
  Solutions you cannot tell apart.
- There are **two independent axes of un-flattening**, and #770 names both:
  - **Result resolution.** oaksprout's comment: SWE evals compute per-test
    results then collapse to binary pass/fail, discarding information; threading
    `passedCount / totalCount` through the schema reduces variance for free.
    That is the **Result** gaining resolution.
  - **Process resolution.** The ladder's Level 4 (process reward models for
    step-level credit) requires the **Process** to exist as a first-class,
    scorable object rather than being thrown away after the attempt. That is the
    **Process** gaining resolution.
- The **chassis** (`codeDigest`) is why this is tractable: it is the stable
  identity of a *Solution*, distinct from the per-attempt *Result*. Without a
  content-addressed Solution identity, evaluation population collapses to
  local-only and credit cannot accumulate across runs (learning engine, "Policy
  identity"). The §2 model makes "Solution ≠ Result ≠ Process" explicit so the
  identity attaches to the right object.

**Conclusion:** disambiguating the task structure is the precondition for the
learning loop to assign credit at all. Sharpen the names before cranking the
search rule.

## 5. Proposed canonical edits (pending Discussion + CODEOWNERS)

These do not land with this spec; they are what a ratified version anchors.

1. **`GLOSSARY.md` — add `Result / Outcome`** under "Network primitives and
   process": the end-state an attempt reaches; whether the desired state was
   made true; the per-attempt object the **outcome reward** channel pays for.
   Distinct from Solution.

2. **`GLOSSARY.md` — add `Process / Trace`**: the trajectory of work that
   produced a Result; the per-attempt object the **restoration reward** channel
   pays for; the substrate credit assignment operates on; distillable into a
   Solution. Note the alias relationship to the learning engine's *trajectory*.

3. **`GLOSSARY.md` — refine the `Solution` note**: keep the existing definition
   (it already leans to the reusable-method side) but add one sentence stating
   that a Solution is *not* a per-task Result — it is what a Process becomes once
   distilled and content-addressed for reuse — and cross-link Result and
   Process so the three are read together.

4. **`SPEC.md` — annotate the loop / roles** so that "executions an operator
   stores and serves" is explicitly understood as carrying both a Result and a
   Process, and the Result/Process split is tied to the outcome/restoration
   reward channels already named in the tokenomics section.

5. **`GLOSSARY.md` — add the entity terms** (§2.1): `Operator` (human who owns
   and runs nodes), `Node` (the software bundle: daemon + frontend + store; may
   run an indexer but defaults to a shared one), `Run` (one instance of a node's
   work, typed by loop phase: creation / solve / evaluation run), and `Role` (a
   per-run relationship to a task — creator / solver / evaluator — distinct from
   the standing `Curator` and `App` roles). Cross-reference the existing
   `Curator` entry. Use **solve run**, never "solution run."

6. **`SPEC.md` — Roles section** currently says the Operator "posts execution
   bonds, writes attestations." Reconcile with §2.1: the **node** holds keys and
   signs; the **operator** owns the node and is accountable. State the
   attribution once (see the open question in §6).

7. **Operator app / reporting** — follow-up Issue, not a canonical edit: stop
   reporting a single "value of the solution"; report Result-value and
   Process-value as distinct, matching the on-chain channels. Scope and surface
   per `client/OPERATOR-APP-SPEC.md`.

## 6. Open questions (deliberately unsettled)

- **Naming.** "Result" vs "Outcome" — the reward channel is *outcome reward*, so
  "Outcome" may be the better head term with "Result" as the plain alias. "Trace"
  vs "Process" — "Trace" is more precise (the recorded artifact) where "Process"
  is the broader notion. The Discussion settles these; this spec uses the pairs.
- **On-chain attribution: operator or node?** §2.1 proposes the node holds keys
  and signs while the operator is the off-chain owner, so a bond, attestation, or
  slash attaches to a **node address**, with the operator accountable behind it.
  SPEC currently attributes these to the "Operator." Settling this fixes who a
  receipt names — relevant to the comms rule that addresses are pseudonymous, not
  PII. Left open here.
- **Run vs reward-channel asymmetry.** Three run types (creation / solve /
  evaluation) but four reward channels (creation / restoration / outcome /
  evaluation). The **outcome** channel rewards a *result holding over time* — it
  is not a run a node performs. The model should not grow an "outcome run" to
  force symmetry; the asymmetry is correct and worth stating.
- **Where the Process is stored and served.** The Result is attestable on-chain;
  the Process is bytes (a trajectory record). Whether it rides the same
  `search → inspect → acquire` artifact chain as Solutions, and what the schema
  is, is for the evidence-schema work (Phase A.1), not this spec.
- **Does every Process distill to a Solution?** No — most attempts produce a
  Process and a Result without yielding a corpus-worthy Solution. The promotion
  rule (when a Process earns distillation into a Solution) is the learning loop's
  acceptance criterion, owned by the harness-as-policy spec, not here.
