# E3 Closure-Preparation Evidence

**Date:** 2026-08-13
**Scope:** documentation-only re-attack and register preparation; no model, Docker, release, lock, preregistration, official run, or publication action

## Pinned inputs

The packet started from `origin/integration/evidence-v1` commit
`0427833e9e7e62cf9fc86c1194ed01688354f1db`.

| Artifact at packet start | Version | Git blob | SHA-256 |
|---|---|---|---|
| `E1-comparison-frame.md` | v0.6 | `d3f84759c43e043f2f9e6ea08fcc5307550d4b48` | `98503ba3b23fe4304c93d1fc9a2879e3fe17ecae355bc747b74fcb1ed7534cf4` |
| Demo-1 program | native-CLAUDE/publication-boundary program | `917d7484f9f25155402025c4a3bba1454b5c8566` | `a0848c6624556a327a86287d1fc87b841459ed2efb3f14903020a8f36259defa` |
| `E3-attack-checklist.md` | v0.4 | `ef929aad16e8d864f32cabe1f3cc21e6379b5c42` | `200e8075419560aca72c5c84b28980ef1caad7f3afa98b4c0f3c05439a75a28d` |

The v0.6 E1 delta from E3's former v0.3 pin was re-attacked rather than accepted by
version label. E1 v0.7 records the resulting reconciliations, and E3 v0.5 names the
affected attack surfaces explicitly.

## Prepared artifacts

| Artifact after closure preparation | Version | Git blob | SHA-256 |
|---|---|---|---|
| `E1-comparison-frame.md` | v0.7 + exact-head review correction | `dedc157d39933742d97c8e088ce744f1a1cc050b` | `fb691b45329aa980ac87958feb0a0b916c95339e186f0022888e204f8f553090` |
| Demo-1 program | closure-prep sequence | `baf5e4369080c6c0ac8563c615ab54c262189412` | `9e418331965e9f38d6fcbde4bdae0f2710fce5aab85c494c213374e721eb2593` |
| `E3-attack-checklist.md` | v0.5 + exact-head review correction | `af1ab1ffb64c0551350e660cf7fefe022622f509` | `2e401a4ec81e07de499d7ba1bb76e224971e8aa18c7ab81dfd436a5e67e7cd68` |

The register digest is recorded outside the register because embedding a file's own
digest would mutate the file and invalidate that digest. K3 requires the operator's
future sign-off to repeat the exact final register digest that ships in the bundle.

## Exact register state

| Disposition | Count | Items |
|---|---:|---|
| `open` | 71 | all entries except the five below |
| `fixed` | 2 | B5, E1 |
| `disclosed-limitation` | 2 | C1, C2 |
| `withdrawn` | 1 | J6 |
| **Total** | **76** | — |

C1, C2, and E1 retain named post-run guards. Fourteen open items name a distinct
post-lock/pre-dispatch equality or ordering guard: B1, B2, B8, C8, D1, D2, E4,
H1, H3, H8, H9, H13, I3, and I6. The split does not weaken the gate: every such
guard must pass after Benchmark/Run sealing and before the first official dispatch.
B2, E4, H1, and I3 additionally retain explicit handoff or post-run guards; their
pre-dispatch evidence alone cannot close the full item at K1.

## Deliberately unresolved

- P5 remains draft PR #2626 at `8affc469d05e33d9619834bfa4b1ddfb4424d44b`; its
  real Docker/Claude gate has not run and its required checks are not green.
- B3/C3/C5/C6/C8 instrumentation and H4/H5/H7 statistical audits are not implemented.
- The Haiku suitability gate, E2 rehearsal/sizing, J4/J5 research, exact content/slate
  freeze, canary artifacts, operator sign-off, lock, E4 anchor, official run, cold
  verification, and handoff remain future gates.
- `@jinn-network/benchmarking-aggregate` and
  `@jinn-network/task-execution-oci-grader` returned npm E404 during the audit; this
  packet does not create packages, configure trusted publishing, or release anything.
- Network publication topology, public URL/discovery/mirror/Explorer surfaces,
  long-term key custody, and errata policy remain publication-only decisions.

This packet does not claim zero open items, a green P5 gate, a locked method, a
pre-registered Run, a completed report, or publication.

## Validation

- Deterministic register audit: 76 unique ordered item headings; one status per item;
  exact counts `71 open / 2 fixed / 2 disclosed-limitation / 1 withdrawn`; exact
  terminal set `B5,C1,C2,E1,J6`; all 14 named post-lock/pre-dispatch guards present;
  exact C1/C2 sentences match E1; attacked-object and external register pins match
  the actual bytes.
- Platform architecture control: 174 tests passed; catalog coverage emitted to a
  temporary path; both generated architecture files passed `--check`.
- Canonical-doc scope: passed; no root canonical document changed, so the canonical
  Discussion-link gate is not triggered.
- `git diff --check`: passed after the exact-head review removed trailing whitespace.
- Stale-wording scan: passed for the old publication-framing question, C1 upgrade
  path, unqualified instruction-byte claim, and published-artifact-only cold verify.

No Docker, model, package publication, release, lock, anchor, or official-run command
was executed.
