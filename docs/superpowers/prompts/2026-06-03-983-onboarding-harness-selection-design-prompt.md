# Claude Design prompt — onboarding completeness (#983)

> **Purpose.** A self-contained brief for Claude Design to produce the UI for issue [#983](https://github.com/Jinn-Network/mono/issues/983): bringing SolverNet + harness + model selection into the Jinn operator onboarding flow so that *finishing onboarding leaves the operator with a running, task-claiming node*. Derived from the ratified domain-model delta in [`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md) §2.4, §2.8, §2.9, §2.10, §2.11.
>
> **Read order for the human pasting this:** this prompt is the design brief. The "How the reviewing agent will evaluate" section at the end is the acceptance rubric the produced design is graded against — design *to* it.

---

## 1. Product context (no prior knowledge assumed)

Jinn is an open agentic knowledge economy. An **operator** runs a **node** (a long-running daemon) that earns by doing work for **SolverNets** — task markets the operator joins. The node executes tasks using an **execution harness** (e.g. Claude Code, Codex, a Docker-based evaluator, Hermes) running a chosen **model**.

The operator interacts with the node through a dashboard single-page app. Today the app has two modes:

- **Onboarding** — a full-screen *takeover* that runs first-time setup as three phases: (1) provision wallet, (2) fund wallet, (3) join Jinn (deploy on-chain identity + stake). When the underlying state machine finishes, the app silently switches to —
- **Operating** — the running dashboard (overview, memberships, tasks, rewards, settings).

### The problem this design solves

"Onboarding complete" today does **not** mean "a working node." Two things a node needs before it can do anything are *not* part of onboarding:

1. **Joining a SolverNet.** A fresh node has joined nothing, so it claims no tasks — it is *live but idle*.
2. **Picking + authenticating a harness and picking a model.** Today this lives in a separate post-onboarding "join flow," and harness install/auth punts to a terminal ("run this command, then click Retry").

So an operator who finishes onboarding then has to *discover* they must still join a SolverNet, pick and authenticate a harness, pick a model, and restart the node. We are eliminating that hunt: **onboarding must end with a running node that is already claiming tasks.**

---

## 2. What to design (surfaces)

### A. Onboarding takeover — new selection steps

Extend the onboarding takeover with two new operator-facing steps, sequenced **before** the node flips into Operating mode (so the selections are applied on the node's first running boot — there is **no** "restart to start" step the operator must click):

1. **Choose a SolverNet** — browse the registry of launched SolverNets and join at least one. Minimum to proceed: one membership.
2. **Set up your harness + model** — for the chosen SolverNet's *solver* role, pick a harness, get it ready (install / authenticate in-flow), and pick a model.

These join the existing three phases. The takeover should read as one continuous guided flow from "provision wallet" through "you're running." The operator must not be able to reach the Operating dashboard without having satisfied the completion criterion below.

**Completion criterion (the gate):** onboarding is complete only when the node is *running and eligible to claim tasks* — i.e. ≥1 joined SolverNet **with** a ready harness **and** a selected model for its solver role. (An *evaluator-only* join is complete without a solver harness — see the evaluator rule in §B.)

### B. Harness Selection surface (the reusable component)

A single component used in **two** places, sharing one model: (a) inside the onboarding step above, and (b) inside Settings post-onboarding (operators change their harness/model there later). It is **not** a standalone card on the overview dashboard — design it as an embedded surface, not a top-level page widget.

It must make the **three-tier availability model** legible so the operator understands *why* a harness is or isn't offered:

1. **Available in the protocol** — the SolverNet's manifest declares this harness as solver-compatible. (Varies per SolverNet.)
2. **Supported by this node build** — this harness is compiled into the operator's installed node binary. (A protocol-available harness this build doesn't ship cannot be picked — show it as unavailable-here, informational, not fixable from this surface.)
3. **Installed & authenticated on this machine** — the harness is present on the host and passing its readiness check. This is the *operator-actionable* tier.

The set the operator can actually pick = tier 1 ∩ tier 2. Picking one then drives it to tier 3 via an **install / authenticate** action.

Per-harness fields to surface: name; protocol-available; node-supported; installed; authenticated; ready (= installed ∧ authenticated ∧ passing); role (solver = operator-selected, or evaluator = manifest-bound).

Per-harness actions: **select** (choose for the solver role); **install / authenticate** (the setup action — e.g. show an install command or kick off an auth step, then re-check; *optional* per harness — pure-compute harnesses are ready with no action); **re-check**.

Per-harness state messages: harness not installed; auth expired; version mismatch; *not supported by this node build* (informational).

**Evaluator rule.** The evaluator harness is **bound by the SolverNet manifest**, not chosen by the operator. An *evaluator-only* join needs no solver-harness selection (its readiness is still shown). Support a **"join now, set up the solver harness later"** affordance for an operator who joins as evaluator-only.

**Model selection.** After a ready solver harness is chosen, the operator picks a model from the options that harness offers. Model is onboarding-essential for the solver role.

### C. Settings — host the Harness Selection surface

Settings is the canonical *post-onboarding* home of the same Harness Selection component. An operator changes a membership's harness/model, or re-readies a harness, here — through the *same* surface they saw in onboarding (learn it once). Design the Settings placement/entry-point for it (reached when the operator chooses to "change environment" on a membership).

### D. Overview — removal (note, not a design task)

The standalone "Harness Readiness" card is being removed from the overview dashboard; its readiness content now lives **only** inside the Harness Selection surface (onboarding + Settings). You don't need to design a replacement card — just don't reintroduce a standalone readiness widget on the overview.

### E. No post-onboarding residue

A freshly-onboarded node must show **no** "you still need to do X to start" prompts — no "no SolverNets joined / browse the registry to start earning" banner, no harness empty-states, no "restart to start participating." (Those only apply to a node that *later* leaves all its SolverNets.) Design the happy-path Operating entry so it reads as "you're live," not "finish setting up."

---

## 3. States every surface must cover (no silent axis)

For each surface above, design the full set of states — an incomplete state set is the most common failure here:

- **Empty** — registry has zero joinable SolverNets; harness list empty.
- **Loading** — registry catalog fetching; readiness probing.
- **Error** — *registry unreachable* (the discovery/indexer is down — onboarding can't list SolverNets; show a clear retryable error, not a blank); readiness check failed.
- **Not-ready gating** — operator picked a harness that isn't installed/authed yet: the proceed/finish control is disabled until it's ready (or the operator takes the evaluator-only "set up later" path); show *what* to do.
- **Evaluator-only path** — joined as evaluator only; no solver harness required to finish.
- **Not-supported-by-build** — a protocol-available harness this build doesn't ship: shown, explained, not selectable.
- **Version mismatch / auth expired** — harness installed but its readiness check warns.

---

## 4. Brand + design-system constraints (hard)

The produced design is graded against these — they are not suggestions.

- **shadcn/ui first.** Every UI primitive composes from the shadcn catalog (cards, tabs, dialogs, badges, buttons, selects, steppers/progress, accordions, alerts). Do **not** invent a custom component without first attempting a shadcn composition. If a genuinely novel component is unavoidable, mark it explicitly as a proposed "snowflake" with a one-line justification (why no shadcn primitive fits) — keep it as narrow as possible.
- **Softened-brutalist corners.** Use the radius scale: 4px chips/inputs, 6px buttons/small cards, 10px panels/large cards, pill radius for status chips only. Not square, not heavily rounded.
- **No emoji.** Anywhere — not in labels, not in empty states.
- **No decorative gradients.** Flat surfaces.
- **Palette + type:** blue + gold semantic palette, the Jinn type pairing. Use semantic colour roles (success/ready, warning, error/blocking, info) consistent with a three-severity model (blocking / warning / info).
- **Voice:** terse, plain, British English, no filler, no hype. The Jinn lexicon (*summon, bind, vow, vessel, wish, smoke, seer, wane*) may appear — but **drop the metaphor and speak plainly whenever money, safety, funds, staking, or auth is on the line.** Auth/install copy is plain-speech. No "team"/"co-founder" framing.
- **Tiers must be visually distinguishable** — the operator should grok protocol-available vs node-supported vs installed-authed at a glance (e.g. a status column or a tiered badge set), not have to read prose to infer it.

---

## 5. Deliverables expected from Claude Design

1. The onboarding takeover with the two new steps integrated into the existing three-phase flow (show the full step sequence, not just the new screens in isolation).
2. The Harness Selection surface in its onboarding context **and** its Settings context (demonstrate it is one component in two homes).
3. The full state set from §3 for the Harness Selection surface and the SolverNet-selection step.
4. The happy-path "you're live" Operating entry (no residue).
5. A short component inventory: which shadcn primitives compose each surface, and any flagged snowflakes with justification.

---

## 6. How the reviewing agent will evaluate the output

I (the reviewing agent) will grade the returned design against this rubric before it is accepted as the issue's design artifact. Design *to* this:

1. **Domain-model fidelity.** Every spec field that has a visual surface is represented; no field is invented that isn't in the domain model (§2.4 environment, §2.8 Bootstrap, §2.9 Harness Selection, §2.10 Notifications, §2.11 Settings). I will diff the design's surfaces against those sections. Extra UI that implies a new field = a spec gap to resolve, not a free addition.
2. **Completion gate enforced.** The design must make it *impossible* to reach Operating without ≥1 joined SolverNet + a ready harness + a selected model (or the evaluator-only equivalent). I will look specifically for how "proceed/finish" is disabled and re-enabled.
3. **Three-tier legibility.** An operator can distinguish protocol-available / node-supported / installed-authed at a glance. I will check that an unavailable-here harness is shown-but-not-selectable with a plain reason, and that a not-ready harness shows the *next action*.
4. **No-restart flow.** The selections sit *before* the running flip; there is **no** operator-clicked "restart to start" step. I will check the flow ordering.
5. **No residue.** The post-onboarding Operating entry shows none of: no-SolverNets banner, harness empty-state, restart-to-start prompt. I will check the happy-path screen.
6. **Complete state set.** Empty / loading / error (incl. registry-unreachable) / not-ready / evaluator-only / not-supported / auth-expired all designed. A missing state is a fail, not a nit.
7. **shadcn-first.** Composed from catalog primitives; any snowflake is explicitly flagged and justified and minimal. Unflagged custom components are a fail.
8. **Design-system compliance.** Radii on the softened-brutalist scale; no emoji; no decorative gradients; semantic colour roles mapped to the three-severity model; correct palette/type.
9. **Voice + PII.** Copy is terse plain-speech, plain (non-metaphor) on money/auth/safety, British English; no personal/identifying detail; no "team/co-founder/executive" framing.
10. **One component, two homes.** The Harness Selection surface is demonstrably the *same* model in onboarding and Settings — not two divergent designs.

Anything that fails 1–6 is a blocking revision. 7–10 are revision items unless trivially correctable in the spec/handoff.
