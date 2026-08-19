# DR-2026-08-18-f — Colophon method operand

- **Date:** 2026-08-18
- **Status:** **Accepted 2026-08-18.** Ratified by operator instruction to
  implement the Colophon method CLI train (issue
  [#2804](https://github.com/Jinn-Network/mono/issues/2804)).
  **Amended 2026-08-20** (decisions 6 and 8; see the Amendment at the end).
- **Owning docs:** the publication interoperability profile; Colophon
  self-serve; the benchmark-product GTM plan (copy); Inspect runtime adapter
  notes.
- **Amends (at ratification):**
  [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)
  §8.3 (one method story; stop stacking one slogan per suite);
  [`spec/2026-08-13-colophon-self-serve.md`](../../spec/2026-08-13-colophon-self-serve.md)
  §5.5;
  [`docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md`](../../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)
  §8 (`runtime` remains an adapter slot, not a UX fork);
  [`packages/benchmark-product/INSPECT-RUNTIME.md`](../../packages/benchmark-product/INSPECT-RUNTIME.md)
  (Inspect is a framework; `colophon inspect` is draft inspect).
- **Does not rewrite:** official-suite protocol objects themselves
  ([DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md),
  [DR-2026-08-17-e](./2026-08-17-swe-bench-verified-official-suite.md),
  [DR-2026-08-18](./2026-08-18-apex-agents-official-suite.md),
  [DR-2026-08-18-b](./2026-08-18-terminal-bench-3-0-official-suite.md),
  [DR-2026-08-18-c](./2026-08-18-apex-swe-dev-official-suite.md),
  [DR-2026-08-18-d](./2026-08-18-deep-swe-v1.1-official-suite.md),
  [DR-2026-08-18-e](./2026-08-18-inspect-as-specified.md)).
  Those remain named protocols. This DR is the **grammar** for how an
  operator binds one.
- **Does not amend:** `GROWTH.md`.
- **Does not rename:** sealed `SUITE_COVERAGE` (`one_task` | `ten_task` |
  `full` | `custom`); the CLI flag is `--slice 1|10|all`.

## Context

Named official suites and execution frameworks were added as first-class
CLI products (`runtime inspect select`, `runtime harbor select`,
`runtime terminal-bench-2-1 select`, `hub export`, and later siblings).
That made Inspect vs Harbor look like alternative Colophon modes, and made
wearing a suite name look like a different UX from locking a homemade
document. Officialness is conformance of a sealed method document, not
which verb you typed.

`colophon lock <method>` cannot be the bind verb: `lock` already means
`runLock` (seal the quoted Run).

## Decisions

1. **Canonical bind verb is `method`.** Operand is a catalog id **or** a
   method-document path. After bind, quote / lock / launch / collect /
   report / publish stay as they are. Draft inspect stays `inspect` (not
   the Inspect framework). Derived-bundle packaging is one `export` verb.

2. **Resolver is fail-loud XOR.** If the operand exists both as a catalog
   id and as a file, refuse. If it is a readable method file, parse that
   document (complete: coverage and host already inside). If it is a
   catalog id, instantiate that preset plus `--host`, `--slice` / `--ids`.
   If neither, refuse: not a suite and not a file.

3. **`--slice` / `--ids` / `--host` only on a catalog id.** A file operand
   is a complete method document; those flags on a file are refused.
   `--slice 1|10|all` maps to sealed `one_task|ten_task|full`. `--ids` is
   `custom`. Human `--slice` does not rename the sealed enum.

4. **Inspect and Harbor are frameworks a method may name**, not product
   modes and not alternatives. They compose in the world
   (`inspect eval inspect_harbor/terminal_bench_2`). Colophon `adapterId`
   is how a cell is spawned, not a CLI fork. Wearing Terminal-Bench 2.1
   still means Harbor's specified method, not any Inspect wrap.

5. **Officialness is a property of the sealed document.** Suite protocol
   object present and conforming → official; absent → custom. A saved
   official selection file still wears the name. A homemade
   Inspect / Harbor / TB 2.0 document has no suite id.

6. **Breaking replace (no aliases).** Remove per-suite select and
   per-suite export verbs from USAGE and `VERBS`. Keep `inspect` (draft),
   `runtime inspect bind-judge` **[amended 2026-08-20 → retired; the judge
   binding is a method operand. See Amendment clause A]**,
   `runtime terminal-bench migrate`, and
   task-set intake (`import swebench` / `import item-bank` / `sample init`).
   Unknown old verbs exit `invalid-invocation`.

7. **Next suite is a catalog row, not a verb.** The facade exports
   `selectMethod` (action `method.bind`) and `exportDerivedBundle` (action
   `method.export`). Existing select/export modules stay as internals;
   they are not re-exported from the operations facade. Catalog ids on
   this tree at ratification: `terminal-bench-2.1`, `terminal-bench-3.0`,
   `swe-bench-verified`, `apex-agents`, `apex-swe-dev`. Cousin / custom
   documents bind through the file operand (Inspect, Harbor, TB 2.0).

8. **Derived export reads the locked draft.** Hub job, predictions JSONL,
   APEX inspection, later View logs **[amended 2026-08-20 → View logs wired
   for the `inspect-binary-judge` adapter; every conforming export now also
   certifies completeness against its own sealed selection. See Amendment
   clauses B and C]** — or refuse (cousin / custom /
   non-conforming / named slice → inspection-only or refuse per existing
   suite rules). Copy must not claim Colophon placed the foreign row.

9. **GUI.** The shipped Inspect form maps to `method.bind` with an
   Inspect-shaped document. Catalog presets stay unavailable (machine host
   paths). Derived export stays unavailable (local job/log copy).

## Out of this train

Renaming sealed `one_task`; GUI catalog picker; folding `import swebench`
into `method`; inspect-harbor as a way to wear TB 2.1; renaming the
`lock` verb.

## Amendment — 2026-08-20 (judge method-operand citizenship, bind-judge retirement, and export certification; operator-directed)

**Ratified by the operator (Ritsu) at the G1 gate of the LoCoMo judge-report
implementation program**, on the P0 contract-freeze session's checklist
(issue [#2842](https://github.com/Jinn-Network/mono/issues/2842), PR
[#2872](https://github.com/Jinn-Network/mono/pull/2872)). Mechanics are frozen
in
[`docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md`](../../docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md)
§8.1 and §8.2, verified path:line against `next`. This amendment is the
ratifying record; that spec is the implementation contract. Implemented by
packet **P10**.

Three clauses of this DR are amended. Everything else stands.

### A. Decision 6 — `runtime inspect bind-judge` is retired, and the judge binding becomes a method operand

**Amended.** Decision 6 kept `runtime inspect bind-judge` alongside `method`.
It is now **removed**, breaking replace, no alias, exactly as decision 6
removed the nine per-suite verbs. The judge binding request schema
`jinn.network/benchmark-product/inspect-binary-judge-binding-request/1` joins
the method resolver's file-schema table as a non-official document kind, so
the judge binds through `colophon method <judge-binding.json>` like any other
complete method document.

- **Why.** A judge experiment is still a benchmark, and there must not be two
  ways to do the same thing. The operator's own #2850 ruling already makes the
  judge suite a catalog row after publication, so citizenship is where this
  path was headed regardless. Decision 6's carve-out was the right call on the
  day and is now the odd one out.
- **The shapes agree; they never conflicted.** Decision 2 describes a file
  operand as a complete method document, "coverage and host already inside",
  and decision 3 refuses `--host` on a file operand for that reason. The judge
  binding is `{schema, manifest, host}` with the private host binding inside
  the file. It is the **only** file operand on the tree that satisfies decision
  2's parenthetical literally. No reconciliation against decision 3 is
  required, and the reading that one was is withdrawn.
- **Unchanged:** the bind's own semantics. Not one refusal, digest, or written
  byte moves. The operation body is extracted so both the surviving internal
  wrapper and the `method` file dispatch call the same function, because
  nesting the operation inside `method.bind` would append two audit entries and
  the boundary helper guarantees exactly one.
- **Unchanged:** decisions 1 to 5, 7, and 9. `method` is still the canonical
  bind verb; the resolver is still fail-loud XOR; `--slice` / `--ids` /
  `--host` are still catalog-id-only; officialness is still a property of the
  sealed document, and a judge binding carries no suite protocol object, so it
  binds as **custom** and wears no suite name.
- **Still kept** from decision 6: `inspect` (draft),
  `runtime terminal-bench migrate`, and task-set intake (`import swebench` /
  `import item-bank` / `sample init`).

### B. Decision 8 — the View-log export is wired, for the judge adapter only

**Amended, along the line decision 8 itself anticipated.** Decision 8's own
enumeration ends "Hub job, predictions JSONL, APEX inspection, **later View
logs**". The View-log export is now wired, reached through the single `export`
verb's adapter routing on the `inspect-binary-judge` adapter id.

- **Unchanged: the Inspect-eval derived path stays refused.** A plain
  `inspect` draft still hits its own typed refusal before the function is
  reached. This amendment does not reopen that leg of decision 8.
- **Unchanged: no suite name for custom.** A judge draft exports in the
  inspection lane unconditionally; no cousin, custom, non-conforming, or
  named-slice document gains a suite name, and the eligibility predicates are
  byte-untouched.
- **Unchanged:** "copy must not claim Colophon placed the foreign row." The
  new certification sentence (clause C) makes a claim about this run against
  its own sealed selection and says nothing about any external leaderboard.

### C. Decision 8 — every conforming export certifies completeness against its own sealed selection

**Amended, and this is the clause with the widest reach.** Decision 8 governs
what a derived export may say. It is extended with a rule that applies to
**every** export shape, not to the judge:

> Every conforming export certifies completeness against its **own** sealed
> selection, stated with the lock digest: *complete run of the selection
> sealed at lock `<digest>`*. A **catalog suite name is an additional badge**,
> earned only when the sealed selection equals the official dataset.
> Custom-file runs are first-class in the nameless lane, which now states the
> commitment it always had.

- **Why.** Sealing your method ahead of time is Colophon's core value for
  every user, not a privilege of the five catalog rows. The judge bank's
  public freeze is nothing more exotic than a lock digest posted publicly. A
  product whose nameless lane only ever says what a package is *not* has
  hidden its own proposition from the majority of its users.
- **What changes is emitted copy, not who qualifies.** The mode decisions and
  the leaderboard-eligibility predicates are byte-unchanged. The certification
  sentence sits alongside the existing badge and not-a-submission sentences,
  never in place of them, and it renders the sealed Matrix's own completeness
  block rather than recomputing anything.
- **Audit before edit.** All six instruction builders were read before this
  clause was written. Nothing emitted today is false; the certification was
  simply absent everywhere. No existing sentence is rewritten or deleted.

### Unaffected

Decisions 1 to 5, 7, and 9 stand as ratified. The `--slice 1|10|all` mapping,
the sealed `SUITE_COVERAGE` names, the catalog id list, the facade's two
exports (`selectMethod`, `exportDerivedBundle`), and the GUI rulings are
unchanged. The suite-protocol DRs this DR does not rewrite are still not
rewritten.
