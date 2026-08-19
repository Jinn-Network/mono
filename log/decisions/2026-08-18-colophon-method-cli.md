# DR-2026-08-18-f — Colophon method operand

- **Date:** 2026-08-18
- **Status:** **Accepted 2026-08-18.** Ratified by operator instruction to
  implement the Colophon method CLI train (issue
  [#2804](https://github.com/Jinn-Network/mono/issues/2804)).
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
   `runtime inspect bind-judge`, `runtime terminal-bench migrate`, and
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
   APEX inspection, later View logs — or refuse (cousin / custom /
   non-conforming / named slice → inspection-only or refuse per existing
   suite rules). Copy must not claim Colophon placed the foreign row.

9. **GUI.** The shipped Inspect form maps to `method.bind` with an
   Inspect-shaped document. Catalog presets stay unavailable (machine host
   paths). Derived export stays unavailable (local job/log copy).

## Out of this train

Renaming sealed `one_task`; GUI catalog picker; folding `import swebench`
into `method`; inspect-harbor as a way to wear TB 2.1; renaming the
`lock` verb.
