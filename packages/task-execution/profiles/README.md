# `@jinn-network/task-execution-profiles`

Sealed task-profile documents and the EvaluationSpec format for the Jinn Task Execution Protocol
(TEP). A pure, I/O-free schema-and-sealing package: it re-implements canonicalization and sealing
locally (per-package, never a shared runtime dependency) so its sealed bytes are byte-compatible
with the TEP protocol sealer and with the Evidence Result Evaluation predicate — compatibility
held by fixtures, not imports.

Imports `@jinn-network/task-execution-protocol` only. No evidence package, no discovery, no
trust, no marketplace.

## Package contents

- `src/` — sealing primitives, EvaluationSpec schema/seal, task-profile schema/seal, the DSSE
  admission-receipt shape, and the conformance kit (`src/testing.ts`).
- `profiles/task-profiles/` — the two v1 sealed profile documents
  (`repository-work/1.0`, `evaluation-task/1.0`) with pinned digests.
- `fixtures/` — golden + adversarial fixture families per module (see `fixtures/README.md`).
- `dist/` — compiled output.

## The two v1 sealed profile documents

| Profile | Reserved instance URI | Sealed asset |
| --- | --- | --- |
| `repository-work/1.0` (design §8) — real-repository code-change work, delivered as a patch | `https://spec.jinn.network/task-profiles/repository-work/1.0` | `profiles/task-profiles/repository-work/1.0/profile.json` + `profile.sha256` |
| `evaluation-task/1.0` (design §9) — the generic thin profile for evaluation-as-work; its `verdict` output *is* the DSSE-signed Result Evaluation Statement | `https://spec.jinn.network/task-profiles/evaluation-task/1.0` | `profiles/task-profiles/evaluation-task/1.0/profile.json` + `profile.sha256` |

Each `profile.json` is the exact raw RFC 8785 JCS bytes (no indentation, no trailing newline,
program §7.1) produced by this package's own builder + sealer — `sha256(profile.json) ==
profile.sha256`. Regenerate both with `yarn generate:documents`; verify with `yarn
check:documents`.

**Pre-release checklist item (coordinator brief mandate 6, design §17):** the two reserved URIs
above are namespace reservations, not yet published, resolvable documents. Per the TEP/Evidence
convention, an instance URI **must resolve to the published document before any EXTERNAL
conformance claim** cites it — internal work (building on these profiles inside this repository)
does not gate on publication. Publishing them is out of this package's scope.

## Use

```ts
import { canonicalJsonBytes, sealDocument } from "@jinn-network/task-execution-profiles";

const { bytes, digest } = sealDocument(value);
```

Building the two v1 documents:

```ts
import { buildRepositoryWorkProfile, buildEvaluationTaskProfile, sealTaskProfile } from "@jinn-network/task-execution-profiles";

const { digest } = sealTaskProfile(buildRepositoryWorkProfile());
```

## Conformance kit (`./testing`)

The `./testing` subpath re-exports the pure structural runner (`loadFixtureFamily`,
`runStructuralCheck`), the named structural checks (`checkAdmissionReceipt`,
`checkAllOfConstruction`, `checkMeasurementCoverage`, `checkStatePredicateBlock`,
`checkStatePredicateSpec`, `checkVerdictConsistency`, `deriveEvaluationTask`,
`evaluatePredicates`, `resolveFamilyUri`), and `FIXTURE_FAMILIES` — every fixture family this
package ships under `fixtures/*`. A downstream consumer (the marketplace binding, the Autopilot
adapter) drives its own conformance suite by iterating `FIXTURE_FAMILIES`, loading each with
`loadFixtureFamily`, and running the matching structural check with `runStructuralCheck` — without
depending on the TEP testing kit or re-implementing this package's fixtures (design §12/§14: this
package never depends on `@jinn-network/task-execution-testing`; fixture consumers depend on
`profiles`, keeping the graph acyclic):

```ts
import { FIXTURE_FAMILIES, loadFixtureFamily, runStructuralCheck } from "@jinn-network/task-execution-profiles/testing";

for (const family of FIXTURE_FAMILIES) {
  const cases = await loadFixtureFamily(
    new URL(`../node_modules/@jinn-network/task-execution-profiles/fixtures/${family}`, import.meta.url).pathname,
  );
  // run(cases, ...)
}
```

### `state-predicate` family

The `state-predicate` grader family is a sealed criteria document over a sealed chain world: the
`familyBlock` references the **composite** crypto-environment record by digest (never inlined),
and `evaluatePredicates` is a pure function over a canonical chain observation that both
admission and evaluation compose. Predicate outcomes use **satisfied / violated / unevaluable**
against the named information contract — not "verified", because the evaluator states what the
sealed world showed under the block's criteria, not absolute truth.

Fixture families: `state-predicate-block`, `state-predicate-evaluation`, and the sealed
`evaluation-spec/golden/state-predicate-minimal` pin.

## Development

Use Node 22 and Yarn 4.13.0:

```bash
yarn install
yarn typecheck
yarn test
yarn build
yarn check:documents
yarn pack:smoke
```
