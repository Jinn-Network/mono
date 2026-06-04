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

One task moves through the loop (Creation → Execution → Evaluation → Knowledge)
and precipitates the objects below.

| Object | Plain English | What it answers | Lifetime |
|---|---|---|---|
| **Task / Intent** | The desired state a Creator publishes, with fee. | *What is wanted?* | One task |
| **Execution / Attempt** | One operator's run against the task. | *Who tried, under which Solution?* | One run |
| **Result / Outcome** | The end-state the attempt reached; whether the desired state was made true. | *Did it work?* | One run |
| **Process / Trace** | The trajectory of work that produced the result — the steps, the method, the record of how. | *How did it get there?* | One run; **distillable** |
| **Solution** | The reusable, content-addressed method distilled from good processes and stored in the corpus (skill / plugin / prompt set / harness config / environment). | *What should the next attempt reuse?* | Persists across tasks |
| **Knowledge** | The accumulating corpus of Solutions plus the verdicts attached to them. | *What has the network learned?* | The substrate |

The two claims worth stating flatly:

1. **A Result and a Process are distinct, and each is independently valuable.**
   The Result has value as a verified outcome (someone wanted X; X is now true,
   attestable on-chain). The Process has value as *knowledge* — it is what
   generalizes to the next task. In an open agentic knowledge economy the
   Process is frequently the **more** valuable of the two, because the corpus is
   a substrate of *processes-distilled-into-methods*, not a ledger of answers.

2. **A Solution is not a Result.** A Solution is what a Process becomes when it
   is abstracted out of a single attempt and made reusable. The Result is
   consumed by the Creator who wanted it; the Solution is consumed by every
   future attempt. Conflating them is the core of the reporting gap.

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

5. **Operator app / reporting** — follow-up Issue, not a canonical edit: stop
   reporting a single "value of the solution"; report Result-value and
   Process-value as distinct, matching the on-chain channels. Scope and surface
   per `client/OPERATOR-APP-SPEC.md`.

## 6. Open questions (deliberately unsettled)

- **Naming.** "Result" vs "Outcome" — the reward channel is *outcome reward*, so
  "Outcome" may be the better head term with "Result" as the plain alias. "Trace"
  vs "Process" — "Trace" is more precise (the recorded artifact) where "Process"
  is the broader notion. The Discussion settles these; this spec uses the pairs.
- **Where the Process is stored and served.** The Result is attestable on-chain;
  the Process is bytes (a trajectory record). Whether it rides the same
  `search → inspect → acquire` artifact chain as Solutions, and what the schema
  is, is for the evidence-schema work (Phase A.1), not this spec.
- **Does every Process distill to a Solution?** No — most attempts produce a
  Process and a Result without yielding a corpus-worthy Solution. The promotion
  rule (when a Process earns distillation into a Solution) is the learning loop's
  acceptance criterion, owned by the harness-as-policy spec, not here.
