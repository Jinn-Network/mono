# E1 pre-run source and selection freeze

**Date:** 2026-08-13

**Status:** **STOP — no content candidate selected; no preview permitted**

**Machine inventory:** `E1-pre-run-freeze.stop.v1.json`

**Canonical inventory digest:** `sha256:ac213523dc8292edb18066c05826454bb44a79f6a6dc9dd1cfa7e984aac35f66`

## Frozen source

- Repository: `https://github.com/anthropics/skills.git`
- Commit: `f17010c9bb483898c1d9c9f42dde2b3a98889434`
- `skills/` tree: `491339fffffe73a52f638f09747dddd8ae2cf154`
- Upstream commit date: 2026-08-07T13:14:14-04:00
- Candidate count: 17 folders, all inventoried in lexical repository-path order.

The inventory records every upstream `SKILL.md` byte count and SHA-256, exact upstream
description, folder-license status and digest, standalone-usability assessment, task count,
and rejection reason. The four fixed document skills — `docx`, `pdf`, `pptx`, and `xlsx` —
are rejected independently of every other criterion. `doc-coauthoring` is rejected because
its folder contains no license file. Skills whose instructions require sibling files are
rejected by the one-frozen-`source.md` contract.

Only `brand-guidelines` and `frontend-design` clear the source, folder-license,
description, and standalone-instruction checks. Neither is selected because the repository
contains zero task rows with the complete candidate-specific evidence required by the
approved outcome-blind rule.

## Why this is a STOP rather than a winner

The tracked SWE-rebench slate evidence is insufficient for this experiment. The screening
report records a `rowHash`, `gold-patch-resolves`, and a quality code for selected tasks, but
does not bind all of the following candidate-specific proofs:

1. verified task-image digest;
2. real-grader gold-patch pass;
3. real-grader empty-patch fail;
4. compatible task/repository license;
5. absence of instruction leakage;
6. absence of a pre-existing conflicting instruction file; and
7. absence of a content/gold-patch collision.

No missing proof is treated as a pass. Consequently every candidate has an eligible-task
count of zero, the survivor ranking is empty, and there is no winner whose license or source
body can truthfully be frozen. The exact official-pool capacity requirement also remains
unresolved until E2 seals a design; the 600-cell ceiling alone does not determine a task and
repository count.

The program must not preview a candidate, run the Haiku suitability gate, start E2, or switch
content sources while this STOP inventory is current. Resumption requires a complete,
pre-model task-evidence manifest and an explicit official-pool capacity requirement. Those
inputs produce a new canonical freeze and new SHA-256-derived integer seeds before the first
preview.

## Deterministic method contract

`@jinn-network/benchmark-product-core` now owns the pure freeze boundary:

- source URL is fixed to `anthropics/skills` and commit/tree ids must be exact;
- candidates are inventoried and rejected fail-closed;
- only matching evidence counts toward task eligibility;
- candidate ranking is eligible-task count descending, then repository path lexical;
- suitability, rehearsal, and official task pools must be disjoint by repository;
- task selection, replicate scheduling, interleaving, and paired-bootstrap seeds are
  domain-separated SHA-256 first-word integers in `[1, 4294967295]`;
- the winner's license bytes, literal `source.md`, deterministic transform digest,
  materialized `SKILL.md`, and byte-identical `CLAUDE.md` body are included only in a
  `ready` freeze; and
- lack of a suitable candidate emits `stop`, never fallback content.

The stopped inventory resolves seeds because they are part of its canonical selection basis:
task selection `1133641589`, replicate scheduling `624781390`, interleaving `3868643525`,
and paired bootstrap `2714409742`. They authorize no execution and change if any source,
eligibility evidence, pool requirement, or candidate assessment changes.

No model arm, Docker cell, preview, rehearsal, or official run was executed to produce this
packet.
