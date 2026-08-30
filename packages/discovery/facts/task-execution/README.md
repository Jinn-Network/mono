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
design §12, amendment 2026-08-28). `task.v2` adds the digest-pinned inputs and the output-slot
schemas; `delivery.v2` adds the outputs produced, the evidence records about the work, and the
Delivery it replaces; and `evaluation-spec.v2` adds the graders plus whatever its family block
pins — the composite crypto environment a state-predicate spec runs against and the ABIs its
success predicates read through, a deterministic-process image, test material and parser, a
model-graded rubric and judge output schema, a human-review form, a composite's sub-specs. v1
declared only the family, which left "which evaluation specs run in this crypto environment"
unanswerable from a card.

A ResourceDescriptor satisfiable by `uri` or inline `content` alone pins nothing and is not an
edge, so only digest-bearing members are carried.

`profile-document.v2` adds the output-slot schemas a profile pins. v1 declared only `extends`,
but `outputConventions.slots[].schema` is the same optional-digest ResourceDescriptor this leaf
already treats as an edge on an evaluation spec. `task.v2` carries the same field for
`outputs[].schema`, the corresponding member of a Task's own closed output slot: both kinds
answer "which records pin output schema `sha256:X`" rather than one of them answering it and the
other returning empty. The two fields are not identically typed -- the profile-document field is
an optional ResourceDescriptor, the Task field is `z.unknown()` -- so only a digest-map whose
`sha256` entry is 64 lowercase hex characters is carried, from either side.

Audited and unchanged: `submission.v1` already declares its one edge, the Task. A Submission's
harness pin does carry a digest, but it lives under a namespaced key of the structurally open
`requirements` map, which has no field for a profile to declare — the design amendment states
that limit.

The plugin and checkpoint profiles stay empty: no defining schema for either exists in-tree, so
there is nothing to declare, and an empty profile asserts nothing.

Each profile's `referenceBearingFields` is pinned in `profiles.test.ts`. That pin is a
change-detector authored from the same reading of the schema as the profile itself, not an
independent completeness proof; see the design amendment's *What enforces this*.
