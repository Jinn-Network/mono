# Provenance: `evidence-statement.json`

This file is a **byte-for-byte copy** — `diff` clean, not re-serialized — of the real Evidence
Result Evaluation golden statement:

- Source path:
  `packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/statement.json`
- Base commit (last commit that touched the source path at copy time): `94a1a5c1d4ca37f42431c24c85247e2e8c9c7dfa`

This is the byte-pin carrier for `ResultEvaluationStatementShape`
(`src/result-evaluation.ts`): it ties the mirror schema to the *real* Evidence predicate bytes
(program §7.15, plan Task 13, Finding 8), not to this plan's own mirror of itself. The JSON file
above is never hand-edited — if the upstream Evidence golden statement changes, re-copy it from
the source path (there is intentionally no import; see design §12/§14's no-evidence-import
boundary and program §7.15's cross-tree equivalence-leg scoping).

A provenance note lives here, alongside the fixture, rather than as an injected field inside the
JSON — injecting a field would make this file something other than an exact byte-copy of the
upstream asset, defeating its purpose as a byte-pin.
