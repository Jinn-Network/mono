# Fixture families

Every fixture family lives at `fixtures/<family>/{golden,adversarial}/*.json`. Each file is a
single case: `{ "input": <unknown>, "expect": <unknown> }`.

- **`golden/`** — conforming inputs. `expect` is the exact value the module under test must
  return for `input`.
- **`adversarial/`** — nonconforming inputs. `expect` is the outcome the module under test must
  produce instead of succeeding — typically `{ "ok": false, "code": "invalid-document" }` (the
  `runStructuralCheck` projection of a thrown `ProfilesError`), but any structural rejection shape
  the module returns directly is equally valid.

`src/testing.ts` (`./testing` package entry) ships `loadFixtureFamily(familyDir)` — reads both
subdirectories and tags each case with its `kind` (`"golden" | "adversarial"`) and its file-stem
`name` — and `runStructuralCheck(cases, check)`, a pure runner: a golden case passes when
`check(input)` deep-equals `expect`; an adversarial case passes when `check`'s outcome (its return
value, or a thrown `ProfilesError` projected to `{ ok: false, code }`) deep-equals `expect`.

This mirrors the split convention of `@jinn-network/task-execution-testing`'s
golden/adversarial fixtures (design §12/§24), adapted to per-module structural fixtures instead of
whole-scenario documents: every schema, sealer, and evaluator in this package registers its own
fixture family under this directory, and the family's golden/adversarial split is the same
conformance contract the two v1 sealed profile documents are checked against.

No fixture file may contain a secret, a real signature, or personally identifying material — see
Global Constraints (no secrets in sealed documents, ever).
