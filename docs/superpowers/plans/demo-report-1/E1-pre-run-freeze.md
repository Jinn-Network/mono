# E1 pre-run source and selection freeze

**Date:** 2026-08-13

**Status:** **STOP — no content candidate selected; no preview permitted**

**Machine inventory:** `E1-pre-run-freeze.stop.v2.json`

**Canonical inventory digest:** `sha256:31443f825b77d35967530a0f2c881a8e6effb93ba2a6b2d7b71061b437d68b04`

## Frozen source

- Repository: `https://github.com/anthropics/skills.git`
- Commit: `f17010c9bb483898c1d9c9f42dde2b3a98889434`
- Commit tree: `0fe4c0c8372b239b13062036d08d05f79d4055a1`
- `skills/` tree: `491339fffffe73a52f638f09747dddd8ae2cf154`
- Upstream commit date: 2026-08-07T13:14:14-04:00
- Candidate count: 17 folders, all inventoried in lexical repository-path order.

The product-owned source manifest binds every folder tree, `SKILL.md` path, Git blob,
byte count, and SHA-256 to that exact commit tree. It likewise binds the exact folder-license
path/blob/byte digest and the compatibility decision; callers cannot substitute labels for
either identity. The canonical artifact records the exact upstream description, the complete
standalone assessment and evidence reference, every task input and evidence reference, and
every derived count and rejection reason. The four fixed document skills — `docx`, `pdf`, `pptx`, and `xlsx` —
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
body can truthfully be frozen.

Exact official sizing is intentionally **not** a pre-E2 readiness input. Before E2, a candidate
must support the fixed six-repository suitability pool, the ten-task/five-repository rehearsal
pool, and an objective official feasibility floor of five tasks across at least two repositories.
That floor is the minimum admissibility boundary of `paired-delta@1`; it does not claim the
eventual official design is adequately powered. E2 later selects the exact official task and
replicate capacity under the 600-cell ceiling from the already frozen winner and task order.
If the selected E2 design exceeds that winner's frozen pool, the program stops with evidence;
it does not switch candidates using rehearsal outcomes.

The program must not preview a candidate, run the Haiku suitability gate, start E2, or switch
content sources while this STOP inventory is current. Resumption requires a complete,
pre-model task-evidence manifest meeting those three fixed feasibility requirements. Those
inputs produce a new canonical freeze, one pre-E2 winner and new SHA-256-derived integer seeds
before the first preview; exact official capacity remains pending until E2.

## Deterministic method contract

`@jinn-network/benchmark-product-core` now owns the pure freeze boundary:

- source URL is fixed to `anthropics/skills`; commit/tree/path/blob/byte digests and
  folder-license identities must match the product-owned manifest exactly;
- the machine artifact is one canonical `inputs`/`derived` schema and independently rebuilds
  candidate status, task status, ranking, selection basis, and resolved seeds from its inputs;
- candidates are inventoried and rejected fail-closed;
- only matching evidence counts toward task eligibility;
- candidate ranking is eligible-task count descending, then repository path lexical;
- suitability, rehearsal, and official task pools must be disjoint by repository;
- pre-E2 readiness uses the objective five-task/two-repository official feasibility floor;
  E2 freezes exact official capacity later without reopening candidate choice;
- task selection, replicate scheduling, interleaving, and paired-bootstrap seeds are
  domain-separated SHA-256 first-word integers in `[1, 4294967295]`;
- the winner's authenticated license identity, literal `source.md`, deterministic transform digest,
  materialized `SKILL.md`, and byte-identical `CLAUDE.md` body are included only in a
  `ready` freeze; and
- lack of a suitable candidate emits `stop`, never fallback content.

The stopped inventory resolves seeds because they are part of its canonical selection basis:
task selection `2618989006`, replicate scheduling `3361499064`, interleaving `1475670040`,
and paired bootstrap `3322963037`. They authorize no execution and change if any source,
eligibility evidence, pool requirement, or candidate assessment changes.

No model arm, Docker cell, preview, rehearsal, or official run was executed to produce this
packet.
