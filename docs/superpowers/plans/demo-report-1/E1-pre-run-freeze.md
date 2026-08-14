# E1 pre-run source, task-evidence, and selection freeze

**Original source freeze:** 2026-08-13

**Task-evidence recovery:** 2026-08-14
**Status:** **STOP — static domain capacity is insufficient; no Docker or preview permitted**

## Authenticated machine artifacts

| Artifact | Schema | SHA-256 | Disposition |
|---|---|---|---|
| `E1-pre-run-freeze.stop.v2.json` | `jinn.demo1.pre-run-freeze.v2` | `08b7e7d0a17d8a4c1ff876111a2e0cb49056b3e5bfe313e8684f46d2b85ae58a` | Preserved byte-for-byte; historical STOP |
| `E1-task-evidence.v1.json` | `jinn.demo1.task-evidence.v1` | `b136f80342e5d6e7179267590c72d6bcde9c6922ecd61841faf18905daada8e1` | Complete static scan of the authorized task universe |
| `E1-pre-run-freeze.stop.v3.json` | `jinn.demo1.pre-run-freeze.v3` | `d439e6729144a74c84f124c058a3c1e01e557091085b9e2c26740884e24b2f3c` | Current independently recomputable STOP |

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

The dynamic control coordinator is sequential and crash-resumable. It checkpoints before and
after image and grader operations, allows one recorded infrastructure retry, requires the current
OCI path to run with the pinned image, `--pull never`, and networking disabled, and requires gold
PASS plus empty FAIL before sealing evidence. Its cleanup policy is configurable:

- `run-owned` (default): after evidence is sealed, remove only exact image digests that were absent
  at run start and pulled by this scan;
- `manual`: retain those images for an operator; or
- `none`: perform no image cleanup.

No policy can delete pre-existing images, the completed P5 images, build cache, volumes, the Core
Desktop VM, or user data. A failed or unsealed run performs no automatic cleanup. The current STOP
never entered Docker, so the cleanup boundary was not invoked.

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
