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
`checkAllOfConstruction`, `checkExternalVerifierBlock`, `checkExternalVerifierSpec`,
`checkMeasurementCoverage`, `checkStatePredicateBlock`, `checkStatePredicateSpec`,
`checkVerdictConsistency`, `deriveEvaluationTask`, `evaluatePredicates`,
`harborPackageContentHash`, `readExternalVerifierMeasurements`, `resolveFamilyUri`), and
`FIXTURE_FAMILIES` — every fixture family this
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

### `external-verifier` family

The `external-verifier` grader family describes a task that is judged by a verifier an external
harness ships and runs itself. Whoever seals the spec runs no grader, so the spec states only
what can be read from the harness's task package, with nothing invented. Its rules are proposal
0002 (`proposals/0002-external-verifier-grader-family.md` in the protocol specification
repository). This version defines one harness, `harbor`.

- **The grader is the task package.** `grader` is a single descriptor whose `digest.sha256` is
  the content hash the harness itself assigns to the package. It is not the SHA-256 of any file
  or archive, so no byte stream hashes to it. `harborPackageContentHash` applies Harbor's rule:
  one line per file (the path, a zero byte, the file's SHA-256, a newline), ordered by path,
  then hashed once more.
- **The block is what the package declares.** `testMaterial` lists the package's own test files
  by path and SHA-256, with the paths unique and ascending by Unicode code point
  (`compareCodePointStrings`). `declaredImage` is the image reference exactly as the package
  writes it. It may be a tag, and it pins no image. `timeout` is the declared verifier timeout
  in seconds. The block has no field for an image digest, a platform, a parser or a transition
  list, and a block that carries one under a bare key is refused.
- **A measurement is the harness's own reward.** Each declared measurement is the same-named
  key of the reward map the harness reports for a trial. `readExternalVerifierMeasurements`
  reads it: a safe whole number stays a number, any other number becomes a decimal string, and
  an absent key gets no default. The family fixes no verdict rule. The spec's own `verdictRule`
  says what a reward means.
- **The facts of one run are not in the spec.** The harness version, the timeout after any
  multiplier, the platform and the digest of the image that was pulled belong to the Result
  Evaluation Evidence that reports the evaluation, in `evaluationMethod` and `evidence`.

Nothing in this package runs the family. A spec of this family does not make a verdict
reproducible. It fixes which package, which test files and which declared environment were
named as the judge.

Fixture families: `external-verifier-block`, `external-verifier-measurements`,
`external-verifier-package-digest`, and the `external-verifier` cases under `evaluation-spec/`.

## `@noble/hashes` version constraint

This package, `@jinn-network/task-execution-protocol`, and `@jinn-network/evidence-protocol` all
declare `@noble/hashes` as `^2.2.0`. The range is deliberate and the three must stay aligned:
each is a self-contained Yarn project, and all three are `portal:`-resolved together into the
same downstream project by `evaluation-harness`, `evaluator-adapters`, `oci-grader`, `testing`,
and `backend-local/assembly`. A portal chain in which one package pins an exact version while
another floats fails to install (YN0071) as soon as upstream publishes a newer 2.x.

The earlier exact `2.2.0` pin here was incidental, not a canonical-hashing stability commitment.
Sealed bytes are held by this package's golden and adversarial fixture families, not by a version
number — a hash function whose output moved within a semver-compatible release would be an
upstream defect that the fixtures catch. The range therefore lets a security or correctness patch
in `@noble/hashes` 2.x reach every package, while each committed `yarn.lock` plus
`yarn install --immutable` keeps each project's resolved artifact reproducible.

Locks resolve per project, so the resolved version may differ between them — `oci-grader`
currently sits on 2.4.0 while the rest of the tree stays on 2.2.0. This package's hashing module
*is* loaded under 2.4.0 in that project: `oci-grader/src/errors.ts` value-imports from
`evaluation-harness`, whose barrel loads `launcher.ts`, which value-imports
`EVALUATION_TASK_PROFILE_URI` from here — and this package's barrel re-exports `bytes.js`. What
does not span the boundary is the *invocation*, not the load: `oci-grader` seals with
`node:crypto`, and its one direct import from here (`swe-rebench-source.ts`) is `import type`, so
no sealed bytes are produced by 2.4.0's `@noble/hashes`. Adding a call — not merely an import —
that produces sealed bytes across such a split means re-minting or re-verifying the consuming
package's pinned digests.

No package under `packages/task-execution/` may carry a `@noble/hashes` entry in `resolutions` to
work around a mismatch; align the declared range instead. Both rules are enforced by
`.github/scripts/task-execution-package-inventory.test.mjs`.

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
