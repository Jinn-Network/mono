# E1 pre-run source, task-evidence, and selection freeze

**Original source freeze:** 2026-08-13

**Task-evidence recovery:** 2026-08-14
**Status:** **STOP — static domain capacity is insufficient; no Docker or preview permitted**

## Authenticated machine artifacts

| Artifact | Schema | SHA-256 | Disposition |
|---|---|---|---|
| `E1-pre-run-freeze.stop.v2.json` | `jinn.demo1.pre-run-freeze.v2` | `08b7e7d0a17d8a4c1ff876111a2e0cb49056b3e5bfe313e8684f46d2b85ae58a` | Preserved byte-for-byte; historical STOP |
| `E1-task-evidence.v1.json` | `jinn.demo1.task-evidence.v1` | `b136f80342e5d6e7179267590c72d6bcde9c6922ecd61841faf18905daada8e1` | Complete static scan of the authorized task universe |
| `E1-pre-run-freeze.stop.v3.json` | `jinn.demo1.pre-run-freeze.v3` | `d439e6729144a74c84f124c058a3c1e01e557091085b9e2c26740884e24b2f3c` | Historical STOP on the superseded `anthropics/skills` source |
| `E1-pre-run-freeze.stop.v4.json` | `jinn.demo1.pre-run-freeze.v4` | `6c14442b71ff711ad37045f2f9295a3f1d11b433b99bf9122ba7da81ac06772e` | **Current STOP**, on SkillsBench v1.1; supersedes v3 by digest |

The v3 artifact names and authenticates v2 rather than replacing its bytes. It embeds the exact
task-evidence artifact, rebuilds every candidate disposition, derives the selection basis
`0e3bae591902ee7efd38848ebeeee858dabbbc1efb2e5c9d86bbbce2bd80f1d3`, and resolves the
task-selection seed to `486786042`. The seed authorizes no execution while the status is `stop`.

## Frozen source

- Repository: `https://github.com/anthropics/skills.git`
- Commit: `f17010c9bb483898c1d9c9f42dde2b3a98889434`
- Commit tree: `0fe4c0c8372b239b13062036d08d05f79d4055a1`
- `skills/` tree: `491339fffffe73a52f638f09747dddd8ae2cf154`
- Candidate count: 17 folders, inventoried in lexical repository-path order.

The product-owned source manifest still binds every folder tree, `SKILL.md` path, Git blob, byte
count, SHA-256, description, and folder-license identity. The four source-available document
skills remain excluded. Only `brand-guidelines` and `frontend-design` clear the source,
folder-license, description, and standalone-instruction checks. The recovery generator fetched
both candidates from the pinned commit and proved their exact Git blob, SHA-256, and byte count
before scanning tasks; a caller cannot substitute content or labels.

## Authorized task universe

The scan consumes two exact local snapshots and refuses any byte drift:

| Snapshot | Bytes | SHA-256 | Bound meaning |
|---|---:|---|---|
| `pool-cache.json` | 7,751,413 | `3af257961dfc662a44227438f7ce211278a13a6d44a84a75c96870564779e64d` | Private problem, patch, test patch, repository, and base-commit inputs |
| `validated-pool.json` | 309,558 | `91af6499668c471820caeb06a6c1abcc4439983802e6fe86a34f5ead8a827032` | Evaluation-semantics version 4, row hashes, and exact image digests |

Their intersection contains **197 gold-validated, digest-pinned tasks across 123 repositories**.
The canonical private-universe digest is
`9c898f40e724869cae7934d52f8e60aee2416bc48f0e4a354ff0fbb5c26e65d9`.
The artifact retains task and evidence identities but does not publish raw private problem or gold
patch bytes. It does not consume the older Haiku-generated quality screen.

## Frozen outcome-blind policy

Each candidate/task pair has seven fail-closed checks:

1. candidate-specific domain compatibility;
2. real OCI-grader gold-patch PASS;
3. real OCI-grader empty-patch FAIL;
4. exact-base-commit permissive SPDX license;
5. no instruction leakage in the task statement;
6. no pre-existing `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, or `.cursorrules`; and
7. no problem/gold leakage or eight-character candidate/gold token collision.

`frontend-design` requires a frontend-presentation path and a user-interface term in the problem.
`brand-guidelines` additionally requires a branding term. These literal rules were applied to all
197 tasks before any container work.

The resulting static ceiling is:

| Candidate | Domain-compatible tasks | Repositories | Minimum required before dynamic checks |
|---|---:|---:|---:|
| `brand-guidelines` | 0 | 0 | 21 tasks / 13 repositories |
| `frontend-design` | 3 | 3 | 21 tasks / 13 repositories |

The three `frontend-design` matches are `ImperialCollegeLondon__proCAT-503`,
`avaiga__taipy-2797`, and `biopragmatics__bioregistry-1644`. Even if every unrun license,
gold, and empty control passed, three tasks cannot fill a six-task/six-repository
suitability pool, a ten-task/five-repository rehearsal pool, and a five-task/two-repository
official feasibility pool without repository overlap. `brand-guidelines` cannot fill any pool.

For completeness, the recovery also queried each surviving repository at its exact base commit.
All three recursive trees are free of the four conflicting instruction filenames, and the detected licenses
are BSD-3-Clause (`proCAT`), Apache-2.0 (`taipy`), and MIT (`bioregistry`). Their exact API
projections and evidence digests are retained in the machine artifact. No repository checkout or
container was needed for this static evidence.

Therefore the method stops at the static ceiling. Dynamic checks are recorded `unverifiable` with
the exact reason “not run after the deterministic domain-capacity screen”; no missing proof is
treated as a pass.

## Deterministic partition and resumable recovery

V3 removes caller-selected pool labels. If a later, authenticated task snapshot is statically
viable, the product owns a deterministic, repository-indivisible partition:

- one official pair meeting five tasks across two repositories;
- five different rehearsal repositories supplying ten tasks;
- six further suitability repositories supplying one task each; and
- SHA-256 ranking within the selected repositories.

Only a candidate with all seven checks at `match` can become the pre-E2 winner. The existing E2
implementation is exposed only through the verified v3-to-v2 adapter after v3 earns `ready`; a
`stop` artifact throws before E2.

The fixed six-task/six-repository suitability, ten-task/five-repository rehearsal, and
five-task/two-repository official-feasibility floors are product-owned constants. Both the v2
normalizer and the v3 verifier reject any caller attempt to weaken them.

The dynamic control coordinator is sequential and crash-resumable. It checkpoints before and
after image and grader operations, allows one recorded infrastructure retry, requires the current
OCI path to run with the pinned image, `--pull never`, and networking disabled, and requires gold
PASS plus empty FAIL before sealing evidence. Docker does not provide exclusive cache ownership
from before/after image inventories: another process can pull or begin using the same digest during
the run. The coordinator therefore performs no automatic image cleanup at all. Any image or cache
removal is a separate operator action after inspecting the sealed evidence and current Docker use;
the coordinator cannot delete pre-existing images, the completed P5 images, build cache, volumes,
the Core Desktop VM, or user data. The current STOP never entered Docker.

## Execution accounting and resumption boundary

- Model arms: **0**
- Claude previews: **0**
- Docker controls: **0**
- Haiku suitability cells: **0**
- E2 rehearsal cells: **0**
- Official cells: **0**

Demo-1 remains blocked at the pre-run content boundary. Resumption requires a new authenticated
task snapshot from the same pinned content source (or an explicit, separately reviewed source
change) whose static domain ceiling can satisfy all three disjoint pools. It must regenerate both
machine artifacts and receive independent review before any Docker control or preview. There is
no automatic content fallback, candidate switch, task replacement, Haiku run, E2 run, official
run, or publication claim from this packet.

## Reproduction

With Node 22 and the documented portal dependency graph built:

```bash
cd packages/benchmark-product/core
yarn build
yarn demo1:task-evidence:check
yarn demo1:task-evidence:test
yarn vitest run src/method/demo1-task-evidence.test.ts src/method/demo1-prerun.test.ts
```

The check command fetches only the two exact pinned candidate files, authenticates both, rebuilds
the 197-task evidence and v3 freeze, and requires byte-identical output.

Note that this reproduction is **not third-party recomputable**: the generator reads two
operator-private snapshots under `~/.jinn-client/swe-rebench-v2/`. That limitation is inherent to
the superseded source and is one of the reasons the amendment below moves to a fully public one.

---

## Source-method amendment (2026-08-16)

**Everything above this line is preserved exactly and continues to describe the superseded method:
one `anthropics/skills` candidate against an unrelated SWE-rebench slate.** The three artifacts in
the table at the top of this document are unchanged, and their digests are pinned by
`.github/scripts/demo1-historical-artifacts.test.mjs` (build-free, runs on every pull request) and
by `packages/benchmark-product/core/src/method/demo1-task-evidence.test.ts` (real verifier
round-trips). **Nothing below rewrites the STOP; it records why the next attempt uses a different
source.**

Ratified by [DR-2026-08-16](../../../../log/decisions/2026-08-16-demo1-skillsbench-source-amendment.md).
Frame-level detail is in [`E1-comparison-frame.md`](E1-comparison-frame.md) §2.3.1.

**The resumption condition, met.** This document's resumption boundary required "a newly
authenticated task snapshot from the same pinned content source (or an explicit, separately
reviewed source change) whose static domain ceiling can satisfy all three disjoint pools." The
source change is now explicit and separately reviewed. The *ceiling* is not yet established — that
is the work the amendment authorizes, and it authorizes nothing else.

**New source identity.**

| Property | Value |
|---|---|
| Repository | `benchflow-ai/skillsbench` |
| Release | `v1.1`, annotated tag `a30b2ac88c8f1fd1c77385be6b4dea204ca9eb69` |
| Commit | `b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af` |
| Active roster | 87 task packages under `tasks/`; 14 excluded under `tasks-extra/` |
| Runner | BenchFlow `>=0.6.3,<0.7`, pinned at v0.6.3 commit `99baefb602674bbd31139fd2f1a22c3ed45752f9` |
| Root license | Apache-2.0 |

**New experimental unit.** One exact upstream task package plus its complete curated Skill bundle.
Multi-Skill bundles are in scope (66 of 87 tasks carry more than one Skill). No candidate ranking,
no winner, no domain classifier.

**New independence rule.** Transitive clusters over four fixed edge classes replace repository
disjointness. Pool floors are unchanged: 6/6, 10/5, 5/2 — combined **21 units across 13 clusters**,
cluster-disjoint.

**Execution accounting is still zero.** This amendment authorizes no Docker control, no model arm,
no preview, no Haiku cell, no E2 rehearsal, no official cell, and no publication claim. The
successor freeze (`jinn.demo1.pre-run-freeze.v4`) supersedes v3 by digest exactly as v3 supersedes
v2, and a `stop` v4 cannot authorize E2 — the same guard shape as
`demo1PreRunFreezeV3AsV2`'s "a STOP freeze cannot authorize E2".

**The open question, stated plainly.** 86 of the 87 active tasks declare
`environment.network_mode: public`; exactly one (`bike-rebalance`) declares `no-network`. The
verifiers are non-hermetic too — `verifier/test.sh` runs `apt-get update` and
`curl https://astral.sh/uv/…`. Against a 21-unit floor, and under a contamination rule that makes
unrestricted public networking ineligible without a separately reviewed mechanism, **this source
may not be viable either.** DR-2026-08-16 Decision 6 gates the ruling on the static admission
count, which costs no execution to obtain.

### Static admission result (2026-08-16)

The gate has been run — `yarn skillsbench:inventory`, zero model arms, zero previews, zero Docker
controls. It authenticates all 87 active tasks from the pinned release and refuses any byte stream
that does not hash back to its declared Git object id.

| Measure | Result |
|---|---|
| Inventoried | 84 of 87 |
| Refused at construction | 3 — `simpo-code-reproduction` (git submodule), `earthquake-phase-association`, `seismic-phase-picking` (a `licenses` directory where a skill folder belongs) |
| Independence clusters | 52, from 129 evidence-bearing edges |
| **Static capacity** | **1 unit / 1 cluster** against a required **21 / 13** — **insufficient** |
| Failing on egress alone | 83 of 84 |
| Other rejections | 21 statement disclosure, 19 licence, 6 answer collision |
| **Clearing every static check but egress** | **57 units / 45 clusters** |
| **The same units after arm-B treatment feasibility** | **39 units / 33 clusters** |

**Demo-1 therefore remains STOPPED**, now at a measured capacity of 1 against a floor of 21 rather
than at the superseded method's domain ceiling. Nothing may execute.

**But the source is not disqualified.** 57 units across 45 clusters clear everything except egress,
and 39 units across 33 clusters survive the arm-B relative-path feasibility filter on top of that —
comfortably above the floor, with room left to lose units to the dynamic oracle and no-op
controls. DR-2026-08-16 Decision 6 is therefore closed in favour of building the reviewed per-unit
egress broker. That is a decision to build, not a finding that the source has passed.

**This document's earlier prediction — that a second STOP was the more likely outcome — was wrong,
and is left standing above rather than edited out.** Gating the ruling on a number was worth doing
precisely because the guess would have been the wrong answer.
