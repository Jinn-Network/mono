# `@jinn-network/record-discovery-facts-task-execution`

Facts-profile documents and record-fact recompute functions for the **single** Task Execution
Protocol record-kind tree leaf — Task, Submission, Delivery, profile document, evaluation
specification, plugin, and checkpoint (seven kinds, one leaf, one record-kind-tree dependency,
per program §6.5's folded facts-leaf granularity ruling:
`docs/superpowers/plans/2026-07-28-stack-implementation-program.md` §6 confirmation 5). One of
the `discovery/facts/*` leaves the Record Discovery Protocol v1 design defers per-record-kind
specifics to
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` §12).

Each facts profile is a sealed, digest-pinned declarative document (owned shape:
`@jinn-network/record-discovery-protocol`'s `FactsProfileDocument`) labeling every field
record-fact vs substrate-fact, naming reference-bearing fields, and declaring CloudEvents
attribute liftings.

- **Task** — `profileUri`/`profileDigest` (from the sealed `profile` ResourceDescriptor),
  `author`, `evaluationDigest`, `supersedesDigest` — all record facts.
- **Submission** — the operator-filter card (design §5.4): `taskDigest` (from the Submission's
  own bytes) and `taskProfileUri` (drawn from the *referenced* Task's bytes) are record facts;
  `requesterIri` and `deadline` are record facts from the Submission's own bytes; `terms` is a
  **substrate** fact (marketplace-projection-only, design §6.3) — author sources reject it.
  Plus the mandatory benchmarking companion amendment (Addendum 2026-07-28-b): optional
  `benchrun`/`benchcell`/`bencharm` record facts, declared as CloudEvents filter attributes,
  absent on non-benchmarking records and opaque to the core.
- **Delivery** — `taskDigest`, `attemptUri`, `outcome`, plus the same optional
  `benchrun`/`benchcell`/`bencharm` triple.
- **Profile document** — `profile` (the profile's own family/version identifier),
  `extendsDigest` (reference-bearing, when the profile extends a parent).
- **Evaluation spec** — `family` (the grader family).
- **Plugin / checkpoint** — structurally registered (kind URI + `FactsRecompute` entry) but
  with **zero declared fields**: no defining-bytes schema for either artifact kind exists yet
  anywhere in `@jinn-network/task-execution-protocol` or `@jinn-network/task-execution-profiles`
  (a gap discovered during implementation, flagged for the program gate — see `src/recompute.ts`
  for the full note). An empty profile asserts nothing, so nothing can be inconsistent.

The per-kind record-fact `RecordFactRecompute` functions (`src/recompute.ts`) recompute every
record fact from the record's own sealed bytes, decoded and validated through the same zod
schemas `@jinn-network/task-execution-protocol` (Task/Submission/Delivery) and
`@jinn-network/task-execution-profiles` (profile document/evaluation spec) export — never from a
supplied projection.

**Dependency note** (flagged deviation from the plan's literal package.json sketch — see
`src/recompute.ts`'s top comment): this leaf depends directly on **both**
`@jinn-network/task-execution-protocol` and `@jinn-network/task-execution-profiles`, because
profiles' public surface does not re-export Task/Submission/Delivery's schemas. Both packages
live under the one `packages/task-execution/` record-kind tree this leaf is scoped to.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

See `docs/superpowers/plans/2026-07-28-record-discovery.md` (Task 24) and its Addendum
2026-07-28-b for the implementation plan.

## Join edges

Facts profiles must declare their kind's complete outbound-reference set (record-discovery
design §12, amendment 2026-08-28). `task.v2` adds the digest-pinned inputs; `delivery.v2` adds
the outputs produced, the evidence records about the work, and the Delivery it replaces. A
ResourceDescriptor satisfiable by `uri` or inline `content` alone pins nothing and is not an
edge, so only digest-bearing members are carried.

The plugin and checkpoint profiles stay empty: no defining schema for either exists in-tree, so
there is nothing to declare, and an empty profile asserts nothing.
