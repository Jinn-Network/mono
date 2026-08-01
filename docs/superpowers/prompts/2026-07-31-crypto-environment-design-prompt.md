# Design prompt — the crypto environment family: agent evaluation on sandboxed chains as marketplace task supply

**Date:** 2026-07-31

**Shape:** `design` — output is one specification. No code, no package moves.

**Audience note:** this charter assumes NO context from the sessions that produced it. Every
document it depends on is linked; read them before designing. Where this charter restates a
rule, the owning document wins.

---

## 0. Context you must load first

**What Jinn is, at the altitude that matters here:** a marketplace for agentic work on Base
(OLAS-native). Tasks are posted with escrowed fees; solvers attempt them; evaluators grade
them; every graded attempt produces verifiable evidence (trajectory + signed verdict). The
purpose of task supply is that evidence: verdict-graded agent trajectories are the data
product the loop farms.

**The supply stack this session builds on** (approved 2026-07-31, the immediate ancestor):
[`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md),
with its evidence base
[`../notes/2026-07-31-task-supply-research-findings.md`](../notes/2026-07-31-task-supply-research-findings.md)
and program plan
[`../plans/2026-07-31-supply-program.md`](../plans/2026-07-31-supply-program.md)
(implementation in progress). Its core moves, which this session extends rather than
reopens:

- **Verified environments are the durable asset; tasks are cheap derivatives.** An
  *environment record* (tier-2 sealed document: what the environment is) accumulates
  *verification attestations* (DSSE-signed observations: it works, K runs, known baseline);
  tasks reference the record by digest; every run instantiates a fresh ephemeral instance.
  Three distinct layers — definition / instance / family — and the instance is never a
  record.
- **Admission is source-agnostic:** a task enters supply only with a differential-admission
  receipt proving its grader discriminates (the do-nothing solution must fail; the
  reference solution must pass; repeatably).
- **Curation from exhaust:** marketplace verdicts yield per-task empirical pass rates —
  the difficulty signal RL labs pay for. Value band ≈ 2–70% pass rate, peak ~50%.
- The first family is **SWE** (repo@commit + pinned container image + test suite);
  imported SWE tasks are ~1:1 with environment records because mined bugs pin per-instance
  commits. The many-tasks-per-record economics arrive with *generated* tasks.

**The product idea this session designs** (operator-originated): a **crypto environment
family** — reproducible sandboxed-chain environments (e.g. an EVM fork at a pinned block)
in which agents perform consequential crypto actions (swap, supply/borrow, vote, revoke,
rescue), graded deterministically against resulting chain state. Published as marketplace
task supply, it farms graded evidence for exactly the agent capability the crypto ecosystem
most wants measured — and it is the family where the environment-as-asset economics are
strong from day one: one base environment record → many parameterized scenario tasks
(unlike mined SWE), because the template is *designed* for parameterization rather than
excavated from history.

**Operator-supplied prior-art sketch, TO BE RE-VERIFIED by this session's own lanes** (it
came from an external research conversation; treat every claim as unverified until a lane
confirms it): CAIBA's **Onchain Execution Benchmark (OCE)** is the closest existing thing —
~70 tasks, natural-language objective → agent-produced transactions → Anvil mainnet fork →
post-state acceptance checks. **EVMbench** — ~117 vulnerability detect/patch/exploit tasks
on isolated Anvil instances, deterministic replay grading, hardened against grader
exploitation. **CyberChainBench** — ~541 historical DeFi incidents as fork environments,
orchestrated via **Harbor**. **CryptoBench / LATTICE** — research/copilot quality, not
execution. **Anvil** (Foundry) supplies fork-at-block, impersonation, time control, state
dump/load, traces. The sketch's own verdict: nobody offers the *generic authoring +
execution + verification substrate* that makes crypto tasks portable across agents,
evaluators, and suites — and its integration advice ("Jinn should define how environment
references, execution profiles, and verifier results attach to tasks — not implement the
orchestrator inside the protocol") is precisely the architecture the supply stack already
has.

Three failure modes to guard against:

1. **One giant crypto terrarium.** "Generic" means a reusable environment kernel with
   pluggable scenarios, not one universal simulated blockchain. Universal action verbs
   (`swap()`, `stake()`) leak protocol semantics; the generic layer is *initial state +
   capabilities + objective predicates + constraints*, with protocols as scenario content.
2. **Stretching the SWE shapes.** The existing `environment/1.0` record binds image +
   test invocations + parser + pass/fail baselines; the existing `deterministic-process`
   evaluation family grades by test transitions. A chain environment binds different
   things (runtime, fork state, fixtures, tool surface, limits) and grades by different
   means (state predicates). This family is a **sibling record profile and a new
   EvaluationSpec family** — never a stretch of the SWE ones. The stack was built for
   this: record kinds are versioned, evaluation families are pluggable, unknown kinds
   deploy without protocol changes.
3. **Pretending fork-state is as reproducible as an image.** A pinned container image is
   self-contained bytes; a mainnet fork at block N depends on *archive-node state* being
   obtainable at verification time — a liveness dependency the SWE family does not have,
   and the single hardest honesty problem this session owns.

## 1. Objective

Answer five questions, in order. Do not start a question until the previous answer is
approved.

**Q1 — The crypto environment record.** What a crypto environment *binds*: chain runtime
(kind + version, e.g. anvil@x), chain identity, fork provenance (block, state root), the
**state-materialization strategy** — this is the reproducibility crux: a digest-pinned
self-contained state snapshot (Anvil state dump as an artifact — the true analog of the
pinned image) versus a declared live-fork dependency on archive RPC (cheaper, but
third-party re-verification then depends on someone else's node) — decide the tiers and
their honest claims; fixtures (funded accounts, protocol address book, deployed scenario
contracts); the agent-facing tool surface and its limits (RPC allowlist, signing scope,
transaction/value/gas caps); and identity + lifecycle per the supply design's rules
(sealed once; staleness derived; attestations append). Then its verification protocol:
what the K-run analog is for a chain environment (deterministic re-materialization of the
fork state; scripted probe transactions producing identical post-states?), what a
verification attestation asserts, and what re-verification costs a third party.

**Q2 — The state-predicate evaluation family.** A new EvaluationSpec family (sibling to
`deterministic-process`): post-state predicates (balances, positions, ownership, votes),
event and transaction predicates (required/forbidden events, revert status), safety
constraints (no unlimited approvals, no unapproved spend, no wrong-chain action),
invariants (health factor, solvency), optimization metrics (gas, tx count) as *measured
facts* distinct from pass/fail, and the closed vocabulary + verdict rule discipline the
profiles design demands. Decide what admission proves here — the differential-receipt
analog: the do-nothing agent must fail the predicates, a reference solution must satisfy
them, repeatably, with alternative valid paths accepted (predicates over end-state, not
over the route) — and what the adversarial checks are (evaluator manipulation, predicate
shortcuts, grader-visible answers).

**Q3 — Scenario templates and task generation.** The derivation strategies for this
family: base environment record + scenario template + parameters = task instance (vary
token, amount, block, constraint, deadline). This is where one record → hundreds of tasks.
Decide the template model, the parameter validation pipeline (a generated task still needs
admission — the opportunity must exist, liquidity must suffice, the predicates must be
satisfiable and non-trivially), historical-state mining (accounts near liquidation,
governance windows) as a named strategy, and provenance labeling (these tasks are
`synthetic` in the supply vocabulary — designed drills, not mined history — with lineage
to template + parameters).

**Q4 — Safety, custody, and the action firewall.** The agent must never touch real funds,
real credentials, or the open internet from inside a task. Design the firewall as
normative properties of the family: sandbox-only signing (task keys are fixture keys,
worthless outside the instance), RPC method allowlist, egress policy, value/gas caps as
task fields, hidden evaluator state separated from agent-visible state, and the
prompt-injection posture (task instructions and on-chain content are untrusted text; the
solver's harness rules apply). Check against Jinn custody law (no key material in
packages; signer-object-only; fail closed) and TEP's confidential-task rule (portable task
documents never embed secrets). State plainly what this family does NOT protect against —
the honesty-surface discipline of the parent design.

**Q5 — Composition into the supply stack and the runner question.** How this family rides
the existing units: environment records verified by the (extended?) verification
capability, tasks admitted via the admission analog, sealed and pooled via derivation,
posted via task-posting, curated by pass-rate exhaust — name exactly what each existing
unit needs (a new strategy? a new port? nothing?) versus what is new-family-only. Then the
runner: who executes a crypto task at solve time — the local execution backend's launcher
model, a Harbor-orchestrated runner, a dedicated chain-runner harness — and who executes
at *evaluation* time (the evaluator re-runs predicates against recorded post-state or
re-executes?). The session decides make/adopt for the orchestration layer (Harbor and
Anvil are candidates to adopt, per the standards-audit rule) and files findings to the
owning programs for anything the existing units must grow.

## 2. What is settled — treat as law

- **The supply design** (2026-07-31, linked above): the three-layer environment model,
  admission discipline, curation-as-projection, posting split, bounded-claims honesty
  rules, and its §14 extension seams. This session *is* one of those extensions; it
  reopens nothing there. A gap in an existing unit is a finding with a proposed
  disposition to the supply program — never a fork.
- **The platform architecture** (DR-2026-07-30,
  [`../specs/2026-07-30-jinn-platform-architecture.md`](../specs/2026-07-30-jinn-platform-architecture.md)):
  four tiers; nothing in tiers 1–3 names a product; guards and conformance kits ship with
  packages; **compose, do not build a monolith** — split what can stand alone (the seam
  test: would a consumer want this piece without the others?).
- **The stack designs own their concerns**: sealing and confidential tasks
  ([`../specs/2026-07-27-task-execution-protocol-and-stack-design.md`](../specs/2026-07-27-task-execution-protocol-and-stack-design.md)),
  task profiles + EvaluationSpec families and their extension rules
  ([`../specs/2026-07-27-task-profiles-and-evaluation-specs-design.md`](../specs/2026-07-27-task-profiles-and-evaluation-specs-design.md)),
  the local execution backend's launcher model
  ([`../specs/2026-07-27-local-execution-backend-design.md`](../specs/2026-07-27-local-execution-backend-design.md)),
  marketplace posting
  ([`../specs/2026-07-28-marketplace-binding-design.md`](../specs/2026-07-28-marketplace-binding-design.md)),
  benchmarking composition
  ([`../specs/2026-07-28-benchmarking-application-design.md`](../specs/2026-07-28-benchmarking-application-design.md)).
- **The custody law** (consumption-boundary design): no key material in published
  packages, no ambient authority, signer-object-only, fail-closed. Fixture keys inside
  sealed task documents are legitimate *only* because they are valueless by construction —
  the session must state that rule explicitly.
- **Sealed once, forever; derived status is never a mutable record; DSSE + in-toto is the
  only envelope world** ([`../specs/2026-07-30-stack-design-principles.md`](../specs/2026-07-30-stack-design-principles.md)
  §5–§7, which also carries the §3 standards-audit rule and the §12 session method).
- **Provenance vocabulary**: generated crypto tasks are `synthetic`, honestly labeled,
  with template + parameter lineage — the supply design's provenance rules apply
  unchanged.

## 3. What is explicitly unsettled — bring a conclusion, not a summary

- The state-materialization tier ladder (snapshot artifact vs archive-fork dependency) and
  whether v1 requires self-contained snapshots — the reproducibility-vs-cost trade this
  family lives or dies on.
- Whether chain-environment verification extends `@jinn-network/environment-verification`
  (a second runtime port) or is a sibling capability — the compose-don't-monolith seam
  test decides, not tidiness.
- The EvaluationSpec family's expressiveness boundary: declarative predicate vocabulary
  (closed, verifiable, limited) vs evaluator-module-by-digest (expressive, but code-as-
  grader reopens the trust question) — or tiers of both.
- Whether multi-account / multi-agent scenarios (scripted counterparties, adversarial
  actors) are v1 or named extensions; likewise non-EVM chains, cross-chain, and
  historical-incident replay.
- The runner make/adopt call (Harbor? bespoke thin runner over Anvil? both, per venue?)
  and where solve-time trace capture attaches.
- Whether OCE-style existing task corpora can be *imported* as a bootstrap (the supply
  program's import-first lesson may repeat here) — subject to license and re-validation.
- Fee/pricing defaults for a family whose evaluation is cheap and deterministic (verdict
  rail economics differ from SWE's Docker-heavy grading).
- Naming, per the one-pass rule.

## 4. The reconciliation that matters most

**Determinism is this family's product claim, and chain state is where it leaks.** The
SWE family's honesty problem was flaky tests; this family's is *world dependence*: fork
state that can't be re-materialized, RPC providers that prune history, protocol upgrades
that break replay, and live-market anything. The session succeeds if every claim in a
crypto environment record and verdict is re-checkable by a third party years later from
digest-pinned artifacts — and if everything that cannot meet that bar (live prices, CEX
accounts, real bridges) is excluded loudly rather than approximated quietly. The prior-art
sketch rates exactly those categories low-feasibility; believe it, verify it, and write
the non-goals accordingly.

## 5. Session gates and triggers

- **Gate to open:** none hard. The supply stack's units are implemented or in flight;
  their interfaces are law via the program plan. If implementation has diverged from an
  interface this session consumes, that is a finding, not a blocker.
- **This session must not gate:** the supply program's v1 execution, the daemon cutover,
  or the marketplace binding program.

## 6. Method

Per principles §12. Suggested research lanes:

1. **Prior-art verification lane** — verify and deepen the operator-supplied sketch: OCE
   (task shapes, checker design, license), EVMbench (grader-hardening techniques),
   CyberChainBench + Harbor (orchestration model), Anvil capabilities (state dump/load
   fidelity, determinism controls, version pinning). Web research; get primary sources.
2. **Reproducibility lane** — the state-materialization question: Anvil state dump
   formats and stability, archive-node economics, snapshot artifact sizes, deterministic
   re-execution evidence. This lane feeds Q1's crux.
3. **Stack-fit lane** — read the supply units' implemented interfaces (the program plan's
   §4 pins and the code on the `supply/*` branches): exactly where a second family plugs
   in, what the verification capability's runtime port assumes, what admission's
   observation port assumes, what derivation's strategy seam requires.
4. **Predicate-vocabulary lane** — survey how existing systems express chain-state
   assertions (OCE checkers, Foundry test assertions/cheatcodes, invariant-testing
   frameworks, Tenderly simulation asserts) to ground Q2's vocabulary in practice.
5. **Adversarial lane** at the end, per the two-review rule — evaluator manipulation,
   predicate shortcuts, fixture-key exfiltration attempts, fork-state substitution,
   prompt injection via on-chain content (token names, contract metadata are
   attacker-authored text).

One material question at a time; section-by-section approval; one specification; two
fresh reviews before presenting; commit only on explicit approval. If the framing
collapses mid-session, recharter rather than writing a spec around a dying framing — the
supply lineage did this twice in one day and both were the method working.

## 7. Scope discipline — what this session does not own

- The supply stack's v1 (SWE family) — extensions land as findings with dispositions.
- Live-market trading, CEX operations, real-fund anything — excluded, not deferred.
- The marketplace protocol, escrow mechanics, reward economics.
- Building the orchestrator inside the protocol — the protocol gets references,
  profiles, and evidence attachment; runners stay replaceable backends.
- Benchmark suite curation — the benchmarking application composes sealed tasks; this
  session supplies task shapes, not suites.

## 8. Success criteria

1. One specification under `docs/superpowers/specs/`, sections approved one at a time.
2. The crypto environment record profile: bindings, state-materialization tiers with
   honest claims, verification protocol, attestation semantics — with the standards
   audit on the record.
3. The state-predicate EvaluationSpec family: vocabulary, verdict rule, admission
   analog, adversarial checks.
4. The template/generation model with its validation pipeline and provenance rules.
5. The action-firewall properties as normative family rules, custody-law-checked, with
   an explicit does-not-protect-against list.
6. The composition map: what each existing supply unit needs (findings filed) vs what
   is new; the runner make/adopt decision.
7. Non-goals that exclude the irreproducible loudly; extensions parked with owners;
   the naming pass.
