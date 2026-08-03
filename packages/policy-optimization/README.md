# @jinn-network/policy-optimization

The Policy Optimization product: a tier-4 package that maintains a population of identifiable
policies for a task family, allocates evaluation to them through ordinary Tasks and the
benchmarking records, accepts candidates from independent proposers, and gives adopters evidence
to decide with.

**Authority:**
[`docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md`](../../docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md).
Program:
[`docs/superpowers/plans/2026-08-03-policy-optimization-implementation-program.md`](../../docs/superpowers/plans/2026-08-03-policy-optimization-implementation-program.md).

Publication is disabled. Nothing in tiers 1–3 may reference this package, and nothing does.

## What is here now

Sub-unit **C7a — the core state layer**. Two things, and nothing else:

| Surface | Design section | What it is |
| --- | --- | --- |
| The campaign document | §5.1 | A sealed product-convention document (JCS-once, sha256, format token `network.jinn.policy-optimization.campaign/1.0`) fixing *what is being optimized, what counts as better, and the budget*. Not a record kind. |
| The campaign journal | §5.2 | A host-persisted, append-only ordering of product decisions, with restart recovery and idempotent replay. Not network truth. |

The wave engine (C7b), admission and proposers (C7c), and the archive and CLI (C7d) build on these
types. This package implements **no execution, assembly, or aggregation machinery** — re-implementing
any of it is forbidden duplication (§6.1), and statistics reach this product only as
`benchmarking-aggregate` method-registry references (program ruling R3). The source-boundary guard
enforces both.

## The campaign document

```
formatToken       network.jinn.policy-optimization.campaign/1.0
target            taskProfile; developmentBenchmark; promotionBenchmark (committed, §6.3);
                  trainingEvidence? (saved-query digest)
seeds[]           typed references {kind: "candidate" | "tuple", digest} (substrate §5.1)
mutationSurface   which axes candidates may vary. v0: ["loadout"], validated
frozenAxes        byte-exact values for every non-mutable axis; exact pins, never constraint-shaped
objective         methods[]: {id, version, parameters} registry references; constraints[]
budgets           proposal {maxProposals}; evaluation {maxCells}; hardCap {maxCells}
allocation        {policyRef, parameters} — product policy, not a registry method
stoppingRule      {ruleRef, parameters} — mandatory; exploration cannot run open-ended
```

Namespaced (reverse-DNS or absolute-URI) top-level extension keys are preserved; an unrecognized
non-namespaced field is refused, exactly as the candidate manifest does (substrate §5.3).

### The sealing-time check

§5.1 requires that "all seeds and every admitted candidate MUST byte-share these values — checked
at campaign sealing (seeds that disagree make the document invalid)". The document carries seed
*digests*, so that check is uncomputable from the document alone. `sealCampaign` therefore takes
the seed referents beside the document and **verifies each against its digest** before comparing
axes: a tuple is re-digested, a candidate manifest is parsed exactly and re-digested, and only then
is its `policy` compared byte-for-byte against `frozenAxes`. Handing over the wrong referent under
the right digest is refused, not trusted.

`checkSeedAgreement` is exported separately so a *reader* who holds the referents can re-run
exactly what the sealer ran. It is the one campaign check a parse of the sealed bytes cannot repeat.

## The journal

One campaign per directory: `campaign.json` (the sealed document) and `journal.jsonl` (the
ordering). Each entry carries `{formatToken, campaign, seq, previous, type, recordedAt, payload}`;
`previous` is the sha256 of the preceding entry's canonical bytes.

`payload` is validated as canonical JSON and nothing more. Per-event payload schemas belong to the
sub-unit that emits them — freezing `allocation-decided`'s shape here would be this unit
legislating for a unit that has not been designed yet.

### Lifecycle

The design fixes four phases and closes the event list, and names no separate "phase changed"
event — so the phase is **derived from the events**, never stored beside them.

| Phase | Entered by | Events legal in it |
| --- | --- | --- |
| `DRAFT` | `created` (seq 1, and nowhere else) | `candidate-admitted`, `candidate-rejected`, `wave-planned`, `closed` |
| `EXPLORING` | the first `wave-planned` | every event except `created` |
| `CONFIRMING` | `promotion-run-sealed` | `matrix-assembled`, `report-recorded`, `frontier-updated`, `closed` |
| `CLOSED` | `closed` | nothing |

- **`wave-planned` is the `EXPLORING` boundary**, because a wave is where a campaign starts spending
  evaluation budget and §6.3 requires the promotion gate to be committed and unrevealed before that
  happens. Seed admission stays legal in `DRAFT`: it spends the owner's own budget (§12) and reveals
  nothing about the promotion set.
- **`CONFIRMING` admits exactly one `promotion-run-sealed`** — the event enters the phase and the
  phase does not admit it.
- **`CLOSED` refuses every append, including a second `closed`.** A replay of an entry already
  recorded remains a no-op, closed or not.

### Restart recovery and replay

`createCampaign` is idempotent for the same campaign and refuses a different one. Writing the
document and appending the first journal line cannot be one atomic act, so a crash between them is
reachable; a `create` that refused on sight of an existing document would turn that window into a
directory nobody can finish or reuse. An empty journal is therefore a legal state, and re-running
`createCampaign` resumes it through the ordinary idempotent-replay path.

`openCampaign(directory)` is the whole of recovery: it re-reads the sealed document, replays the
journal (contiguous `seq` from 1, unbroken `previous` chain, every entry naming this campaign,
non-decreasing `recordedAt`, every event legal where it sits) and derives the phase. The handle it
returns is indistinguishable from the one the appending process held.

`appendCampaignEvent` has three outcomes and no others:

- the `seq` is already recorded and the entry it would produce is byte-identical → **no-op** (the
  crash case: the line landed, the caller never saw the handle);
- the `seq` is already recorded and the entry differs → **`journal-conflict`** (two decisions
  cannot occupy one position in an ordering);
- the `seq` is the next one and every guard passes → the line is fsynced, then the new handle exists.

## Findings

- **F-C7a-1 (addition).** The design names the campaign document's format token and the journal's
  event list but no token for the journal entries. One is added
  (`network.jinn.policy-optimization.campaign-journal-entry/1.0`): the journal is a host-persisted
  document this package re-reads across restarts, and a versionless envelope cannot refuse a future
  revision's bytes. Host-local state, never network truth (§5.2), so this is a product convention
  and not a protocol surface.
- **F-C7a-2 (scope of the constraint-shape rule).** "Never constraint-shaped" is checkable exactly
  where the stack registers constraint *membership*, which today is the `model` axis alone
  (`@jinn-network/policy-identity`'s `CONSTRAINT_MEMBERSHIP_KEYS`). Every other axis compares by
  byte-equality, so any non-`null` value there already names one treatment. A tripwire test fails
  the day that set grows, so the rule is extended deliberately rather than silently under-applying.
- **F-C7a-3 (added check).** A campaign whose `promotionBenchmark` equals its
  `developmentBenchmark` is refused. The design does not say this in so many words, but a dev wave
  reveals every item it runs, so the two being equal contaminates the gate by construction (§6.3).
- **F-C7a-4 (residual, not a defect).** `checkExploringEntry`'s unrevealedness leg can refute but
  not confirm: `checkRevealConsistency` verifies the bytes the *caller* supplies, so an owner who
  supplies none always passes. This is product §11's honesty residual restated at the code
  boundary — v0 promotion discipline protects an honest owner from self-deception and proves
  nothing to strangers. The checks that bind strangers are §6.3's post-reveal third-party re-run
  and, on an anchored venue, the promotion Benchmark's anchor preceding the earliest dev-cell anchor.
- **F-C7a-5 (residual, not a defect).** The journal's `previous` chain reaches every entry that has
  a successor. A rewritten **tail** chains to nothing and opens cleanly. Catching that needs an
  external commitment, which v0 has nowhere by design (§11: a v0 owner can "retro-write a
  host-local journal — invisibly"). The chain is here to catch a corrupted or half-written file,
  not a determined owner. A test asserts this limit rather than leaving it implied.

No integration finding was raised against a tier-3 package: `@jinn-network/benchmarking-records`
supplied every committed-benchmark predicate this unit needed (`parseBenchmark`, `documentDigest`,
`checkItemDistinctness`, `checkRevealConsistency`, `JudgeabilityRevealContext`,
`compareCalendarStrictRfc3339Instants`) and `@jinn-network/policy-identity` supplied the
canonicalization, digests, and tuple validation. Nothing was reimplemented and nothing was patched.

## Development

```bash
yarn install
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

The portal dependencies (`policy-identity`, `benchmarking-records`, and the latter's own
`task-execution-protocol`) must be installed and built from source first.
