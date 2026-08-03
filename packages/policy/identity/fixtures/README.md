# Conformance fixtures

Authority: [`docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md`](../../../../docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md)
§4, §5, §8 (the substrate design). Fixtures derive from spec text, never from product runs.

## Layout

Families follow the `@jinn-network/task-execution-profiles` convention:
`fixtures/<family>/{golden,adversarial}/*.json`, one case per file, each carrying

- `note` — **why this case exists**. Required, and enforced by `conformance.test.ts`. An
  adversarial fixture with no stated attack is a fixture nobody can maintain: the first person to
  hit it will "fix" the code to make it pass.
- `input` — the case's input.
- `expect` — for golden cases, the exact expected output (canonical text, digest, run pinning).
  For adversarial cases, `{ok: false, code, path}` — the code and the path, never the message.

Two families depart from the shape, deliberately:

- `tuple/demonstrations/` — cases whose content is a *relationship between two documents*
  (null vs absent, with-extension vs stripped, original vs digest-substituted) rather than one
  input and one output. Squeezing them into `{input, expect}` would hide what they assert.
- `fork-healing/` — trees, not documents. Each file describes a `jinn.harness-state.v1` package
  as an in-memory entry list, because the package under test is pure and never touches a
  filesystem.

## Families

| Family | Golden | Adversarial | What it pins |
| --- | --- | --- | --- |
| `tuple/` | 6 | 7 (+3 demonstrations) | §4.1 canonicalization, digest, expression rule |
| `derivation/` | 2 | 5 | §4.1 the total function — **the two-deriver equivalence fixture** |
| `manifest/` | 3 | 7 | §5.1–§5.3 candidate manifest sealing and validation |
| `dsse/` | 1 | 2 | §5.2 the in-toto Statement binding |
| `fork-healing/` | 4 files, 10 cases | — | §4.2 `learner-public.v1` + the materialization refusal |

## `reference/`

`fixtures/reference/` is the kit's **naive reference implementation**. It exists because
substrate §8 requires the derivation-equivalence fixture to be satisfied by two structurally
different implementations, and the program's C1 acceptance criterion is that the package's
deriver byte-matches it on every fixture. It is deliberately unclever: longhand loops, one rule
per branch, every step annotated with the design line it implements.

If the reference and the implementation ever disagree, **the expectations on disk decide** which
one is wrong — not whichever code was written second.

## Cross-unit constants

`fork-healing/tree-golden.json` reproduces, byte for byte, the fixture tree pinned by C3's
shipped regression suite (`client/test/harnesses/hash-profile.test.ts`), and its expected digest
is C3's `FORK_HEALING_FIXTURE_DIGEST`:

```
90b25998166464fbb356ce7738149e7f173a78b6bff4d6896aaa96445e89abd8
```

Two units compute that constant from independent implementations of `learner-public.v1`. The
agreement *is* the cross-unit byte-match the program requires; a disagreement means the
`codeDigest` ↔ loadout-digest fork has quietly reopened.

## Rules

- No fixture file may contain a secret, a real signature over real content, or personally
  identifying material. The DSSE fixtures sign throwaway test documents with a key derived
  deterministically from a published string; the seed is not stored, and the signatures are
  verified at test time rather than trusted to look plausible.
- Digests are computed, never invented. Every `sha256:` value in a golden fixture is the real
  digest of the bytes beside it, and a test re-derives it.
- Canonical texts are **hand-written from the JCS rules**, then checked against the reference —
  not captured from a run. A golden captured from the implementation it gates proves nothing.
