# DR-2026-08-16 — Demo-1 Source-Method Amendment: SkillsBench Task-Bundle Units

- **Date:** 2026-08-16
- **Status:** **Proposed.** Decisions 1–5 are operative for implementation planning; Decision 6
  (the network-policy ruling) is deliberately **gated on evidence that does not exist yet** and
  closes only when the static admission stage reports its number.
- **Owning docs:** [`docs/superpowers/plans/demo-report-1/E1-comparison-frame.md`](../../docs/superpowers/plans/demo-report-1/E1-comparison-frame.md)
  §0.1 and §2.3 (source decision); [`docs/superpowers/plans/demo-report-1/E1-pre-run-freeze.md`](../../docs/superpowers/plans/demo-report-1/E1-pre-run-freeze.md)
  (frozen source and resumption boundary);
  [`docs/superpowers/plans/2026-08-11-demo-report-1-skill-ab-program.md`](../../docs/superpowers/plans/2026-08-11-demo-report-1-skill-ab-program.md)
  §E1 (program spine)
- **Amends:** E1 §0.1's "Content source" row and §2.3's "Approved: C2"; the program plan's E1
  paragraph. Each owning doc receives a **dated, append-only amendment** pointing back here.
- **Does not amend:** the three sealed pre-run artifacts. Their bytes are pinned by
  `.github/scripts/demo1-historical-artifacts.test.mjs` and
  `packages/benchmark-product/core/src/method/demo1-task-evidence.test.ts`.

## Context

Demo-1 asks one question: holding task, model, harness, instruction bodies, non-instruction
resources, and environment fixed, does native progressive Skill delivery change performance
relative to placing the same authenticated bodies in root `CLAUDE.md`?

The method approved in E1 §2.3 answered it with a **single Anthropic Skill candidate** from
`anthropics/skills` @ `f17010c9…`, paired against an **unrelated SWE-rebench repository slate**.
Because the Skill and the tasks came from different worlds, the method needed a candidate-specific
domain classifier to decide which tasks a Skill plausibly bore on. That classifier is where the
method died. PR [#2687](https://github.com/Jinn-Network/mono/pull/2687) recorded the result
honestly in `jinn.demo1.pre-run-freeze.v3`: `brand-guidelines` matched 0 of 197 authenticated
tasks, `frontend-design` matched 3, against an immutable floor of 21 tasks across 13 repositories.
Status `stop`. Zero model arms, zero Docker controls, zero previews, zero cells.

The freeze's own resumption boundary says what is required to move: *"a newly authenticated task
snapshot whose static ceiling is viable; do not weaken the rule, author replacement content, or
silently switch sources."* Switching sources is therefore permitted — but only explicitly, and only
through a separately reviewed decision. This is that decision.

## Decision 1 — Supersede the content source

**Demo-1's experimental material becomes SkillsBench v1.1**, repository
`benchflow-ai/skillsbench`, release tag `v1.1` (annotated tag `a30b2ac8…`) dereferencing to commit
`b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af`. E1 §2.3's "Approved: C2 — a skill from
`anthropics/skills`" is superseded.

The reason is structural, not preferential. SkillsBench ships each curated Skill bundle **inside**
the task package that needs it. The upstream task-to-bundle pairing replaces the domain classifier
entirely: Jinn no longer has to invent a relevance hypothesis, only to verify that the unit is
safe, licensed, reproducible, non-leaking, runnable, and transformable.

`anthropics/skills` @ `f17010c9…` remains pinned in
`packages/benchmark-product/core/src/method/demo1-prerun-source.ts` **as historical identity**, so
the v2 and v3 artifacts keep recomputing. It is no longer the active source.

SWE-Skills-Bench remains formally withdrawn (E1 §2.3, C1). This decision does not revive it.

## Decision 2 — Anthropic authorship leaves the substantive claim

The superseded method had a defensive property: because the Skill was authored by the mechanism's
originator, a negative result for arm A could not be dismissed as "you wrote a bad skill" (E1
§2.3). SkillsBench Skills are authored by benchmark contributors, so that specific shield is gone.

It is not needed, and its loss changes nothing measurable. Demo-1 grades **delivery mechanism**,
not authorship: the instruction bodies are byte-identical across arms A and B, so no author's
writing is on trial in the primary contrast. The report's §2.7 must-not-imply list already carries
"**Not** a judgment of any authored skill's quality"; that line now does the whole job.

Demo-1 is **not** evaluating whether Anthropic writes good Skills, whether SkillsBench's authors
do, whether any named third-party Skill is effective, whether Skills beat no-Skill baselines in
general, whether SkillsBench represents arbitrary real-world tasks, or whether one vendor beats
another.

## Decision 3 — The experimental unit is a task-bundle unit

The unit becomes **one exact upstream SkillsBench task package together with its complete curated
Skill bundle**. Multi-Skill bundles are in scope and are the common case: across the 87 active
tasks the per-task Skill count runs 1 (21 tasks), 2 (23), 3 (21), 4 (7), 5 (8), 6 (6), 7 (1).
**Sixty-six of eighty-seven tasks carry more than one Skill**, so the one-candidate schema cannot
be preserved by restricting the source; it must be replaced.

A unit binds, at minimum: upstream task identity, task-package digest, environment identity, every
constituent Skill folder identity, every `SKILL.md`, frontmatter, and instruction-body identity,
every script/reference/asset/template/resource identity, oracle identity, verifier identity,
runtime and image identity, license and provenance evidence, and independence-cluster identity.

Consequently the active path has **no candidate ranking, no winning Skill, no candidate-specific
domain classifier, and no lexicographic candidate tie-break**. The admissible population is the
complete fixed v1.1 active roster filtered only by predeclared fail-closed checks.

## Decision 4 — Independence clusters replace repository disjointness

Literal repository disjointness does not fit a multi-domain source. Two units join the same cluster
when they share any of:

1. a constituent Skill content digest;
2. the same underlying repository, project, dataset, task-specific input family, or artifact family;
3. the same task-family template or generated task lineage;
4. task-specific oracle or verifier lineage beyond common harness boilerplate.

Membership is transitive. Implementations **may add** conservative edge classes when evidence shows
another leakage or dependence mechanism; they **may never remove** these four.

The numerical floors are unchanged and remain product-owned constants: suitability 6 units / 6
clusters, rehearsal 10 / 5, official feasibility floor 5 / 2 — combined minimum **21 units across
13 independent clusters**, with the three pools cluster-disjoint. Pool assignment stays fully
deterministic from the authenticated inventory, the eligibility evidence, the fixed clustering
method, a sealed selection basis, and a derived nonzero seed. No manual assignment.

## Decision 5 — Outcome firewall, restated for the new source

SkillsBench's corpus may have been curated using historical model runs. That is a property of an
independently published source population, it is accepted, and it is disclosed.

Jinn must not use upstream leaderboard positions, per-task pass rates, with-Skill versus no-Skill
uplift, trajectories, model outputs, published rankings, new previews, or any new model execution
to determine eligibility, exclusion, ranking, clusters, pool membership, replacement, or execution
order. Admission code may inspect source bytes, package metadata, licenses, runtime policy,
environment definitions, oracle behavior, verifier behavior, and deterministic controls.

Reconnaissance for this DR excluded `experiments/` and `website/` from the source snapshot; no
outcome dataset was fetched or read.

## Decision 6 (gated) — The network-policy contradiction

**This is the finding that decides whether Demo-1 can run on this source at all, and it is
deliberately left open.**

Demo-1's contamination rule holds that no-network execution is admissible; allowlisted networking
is admissible only when the allowlist cannot reach answer-bearing sources; and unrestricted public
networking is ineligible absent a separately reviewed mechanism proving that source, oracle,
verifier, expected-output, and answer retrieval are impossible.

SkillsBench's `task.md` frontmatter offers exactly two values, and the measured distribution across
all 87 active tasks at the pinned commit is:

| `environment.network_mode` | Tasks |
|---|---:|
| `public` | **86** |
| `no-network` | **1** (`bike-rebalance`) |

Against a floor of 21 units and 13 clusters. Compounding it, the verifiers are themselves
non-hermetic: `verifier/test.sh` runs `apt-get update` and `curl https://astral.sh/uv/…`, so even
grading needs egress.

Three options, and the recorded reasoning for each:

- **(a) Accept a second STOP.** Admit the one `no-network` unit, seal a SkillsBench-backed STOP.
  Cheapest, fully honest, delivers no report.
- **(b) Build a per-unit egress broker.** Derive each unit's minimum allowlist statically from its
  own source; hard-deny `github.com`, `raw.githubusercontent.com`, `codeload.github.com`, any
  SkillsBench mirror, and the benchmark website; enforce through a broker. Units whose need cannot
  be met are `unverifiable`. This is exactly the "separately reviewed mechanism" the policy
  contemplates, and the precedent exists in-repo:
  `packages/benchmark-product/core/src/runtime/inspect/oci.ts` already models
  `network: "none" | "broker-only"` with `broker.py` behind it.
- **(c) Weaken the policy to admit unrestricted public networking.** **Rejected.** The agent could
  fetch its own task's oracle and verifier from GitHub. This destroys the result.

**Ruling: option (b), gated — and the gate is evidence, not preference.** The static admission
stage is entirely independent of this question and produces, at zero execution cost, the exact
count of units surviving every static check *except* network. That number decides:

- **below 21 units or 13 clusters** → option (b) cannot help; the answer is **(a)**, with real
  evidence behind it rather than an assumption;
- **at or above both floors** → the broker is worth building, and it becomes its own reviewed
  packet.

Until that number exists, no implementation may assume either outcome. The freeze STOPs by default
and the broker is additive, so the gate is reversible in both directions.

### Decision 6 — closed 2026-08-16, resolved to option (b)

The gate has been run. `yarn skillsbench:inventory` authenticates all 87 active tasks from the
pinned release, executing no model and pulling no image
(`execution: {modelArms: 0, previews: 0, dockerControls: 0}`).

| Measure | Result |
|---|---|
| Inventoried | 84 of 87 |
| Refused at construction | 3 — `simpo-code-reproduction` (git submodule; package not self-contained), `earthquake-phase-association` and `seismic-phase-picking` (a `licenses` directory where a skill folder belongs) |
| Independence clusters over all inventoried units | 52, from 129 evidence-bearing edges |
| **Static capacity as things stand** | **1 unit / 1 cluster** — against a required 21 / 13. **Insufficient.** |
| Units failing on egress alone | 83 of 84 |
| Other rejections | 21 statement disclosure, 19 licence, 6 answer collision |
| **Counterfactual: units clearing every static check but egress** | **57 units / 45 clusters** |

**57 units across 45 clusters is comfortably above the 21/13 floor**, with room to lose units to
the dynamic oracle and no-op controls and still clear it. The per-unit egress broker is therefore
worth building, and **Decision 6 resolves to option (b)**.

**The amendment's own prediction was wrong, and that is recorded rather than quietly dropped.** The
section below still says a second STOP was the more likely outcome. It was written before the
number existed and it is left standing, because the point of gating the ruling on evidence was
precisely that a guess — including this document's own — should not decide it.

Two things follow, and neither is optional:

1. **Today's honest state is still STOP.** Capacity is 1/21. The broker does not exist, so no
   freeze may report `ready` and nothing may execute. Option (b) is a decision to build, not a
   decision that the source has passed.
2. **The broker is its own reviewed packet** with its own acceptance criteria: a per-unit allowlist
   derived statically from the unit's own source; hard denial of `github.com`,
   `raw.githubusercontent.com`, `codeload.github.com`, every SkillsBench mirror, and the benchmark
   website; enforcement through the existing `network: "none" | "broker-only"` seam in
   `packages/benchmark-product/core/src/runtime/inspect/oci.ts`; and a unit whose declared need
   cannot be met by such an allowlist staying `unverifiable`. Until it lands and its evidence is
   sealed, `runtimeIsolationSatisfiable` stays `unverifiable` for all 83 public-mode units.

## What this decision does not do

- It does not rewrite, reinterpret, or retro-fit the historical STOP. The v2, task-evidence v1, and
  v3 artifacts describe the **old** method against `anthropics/skills` and SWE-rebench, and they
  keep saying exactly that. Their bytes and digests are unchanged and CI-pinned.
- It does not weaken any eligibility requirement, floor, or fail-closed rule.
- It does not authorize a Haiku suitability run, E2, a preview, a rehearsal cell, an official cell,
  publication, or a public claim. Every one of those remains gated behind a `ready` freeze that
  does not exist.
- It does not adopt SWE-Skills-Bench, a general BenchFlow marketplace integration, upstream
  SkillsBench fixes, task authoring, or Skill authoring.
- It does not decide which record chain the eventual report derives from. Both the commissioned
  chain (Matrix v1 / Report v1–v2) and the evidence-native chain added by PR
  [#2712](https://github.com/Jinn-Network/mono/pull/2712) (Matrix v2 / Report v3) remain live; that
  choice is deferred until a freeze exists.

## Source identity, verified

Every value below was read from the pinned release and is reproduced here so a reader can check it
without trusting this document.

| Property | Value |
|---|---|
| Repository | `benchflow-ai/skillsbench` |
| Release tag | `v1.1` (annotated tag object `a30b2ac88c8f1fd1c77385be6b4dea204ca9eb69`) |
| Commit | `b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af` |
| Release manifest asset | `skillsbench-v1.1-task-manifest.json`, 73,717 bytes; binds `commit`, `active_task_count: 87`, `excluded_task_count: 14`, and a per-task `digest` |
| Active roster | 87 trees under `tasks/`; 14 under `tasks-extra/` marked `excluded: true` |
| Runner line | `pyproject.toml`: `benchflow[sandbox-daytona]>=0.6.3,<0.7`; `requires-python >=3.12` |
| Pinned runner | BenchFlow v0.6.3, tag object `17b30189…` → commit `99baefb602674bbd31139fd2f1a22c3ed45752f9` |
| Root license | Apache-2.0 |

**Four discrepancies, each to be resolved fail-closed by the implementation:**

1. **`registry.json` disagrees with the release.** Its `skillsbench 1.1` entry records per-task
   `git_commit_id: 55bfe693f2a19f6b2f29aca3f54fe98b9d994668`, not the release commit, and carries
   per-task digests that differ from the release manifest's for the same task. Recompute every
   task-package digest from the actual release tree and cross-check **both** surfaces; any
   three-way disagreement is a source-drift refusal.
2. **No immutable runtime identity exists upstream.** `environment/Dockerfile` starts from mutable
   tags (`FROM ubuntu:24.04`) and no image digest appears anywhere in the package. Jinn must
   resolve base tags to digests and pin its own built-image digest.
3. **Documented runner range disagrees with the machine-readable one.** `README.md` and `AGENTS.md`
   say `benchflow>=0.6.2,<0.7`; `pyproject.toml` and `registry.json` say `>=0.6.3,<0.7`. Resolve to
   the machine-readable value and pin one exact commit.
4. **The upstream roster has already moved.** `CONTRIBUTING.md` at the pinned commit says the
   current release is SkillsBench 1.2, and BenchFlow published v0.7.0–v0.7.3 on 2026-08-16 —
   outside v1.1's supported range. Every pin must be an exact frozen commit; no range may be
   resolved at install time.

## Consequences

**Improved.** The new source is fully public, so the successor freeze is independently
recomputable by a third party. The current v3 freeze is not: its generator reads two
operator-private snapshots under `~/.jinn-client/swe-rebench-v2/`. This directly serves
[`PRINCIPLES.md`](../../PRINCIPLES.md)'s Legible principle in a way the superseded method could not.

**Harder.** Three things get more expensive, and none of them is optional:

- BenchFlow is a **third runtime family**, unrelated to the Harbor and Inspect adapters shipped in
  PR #2712. Those supply the adapter *pattern*; none of their runtime mapping is reusable.
- BenchFlow's native skill modes do not hand Demo-1 its arms. `with-skill` is close to arm A, there
  is no flatten mode for arm B, and native `no-skill` strips the entire `environment/skills` tree —
  resources included — which would break the arm-C resource-parity requirement. Jinn owns treatment
  materialization for all three arms.
- Per-skill licensing must be established beyond the repository root. All 25 per-skill
  `LICENSE.txt` files in the roster are git blob `c55ab42224874608473643de0a85736b7fec0730` — byte-
  identical to `skills/docx/LICENSE.txt` in Demo-1's existing pinned manifest, already classified
  `LicenseRef-Anthropic-Source-Available`, status `incompatible`. The vendored document-skill family
  is therefore license-excluded, which also removes the largest independence cluster.

**Unchanged.** The substantive claim, the three-arm structure, the primary A-versus-B contrast
paired by unit, the manipulation contrast against arm C, the pre-declared rule that a failed
manipulation check makes A-versus-B uninformative about delivery mechanism, the pool floors, the
outcome firewall, and every must-not-imply line in E1 §2.7.

## Honest statement of the likely outcome

> **Superseded 2026-08-16 by the measured result in Decision 6.** The paragraph below is left
> exactly as written. The counterfactual capacity is 57 units across 45 clusters, so the broker
> path is viable and the prediction was wrong. Keeping a wrong prediction visible is the point:
> the ruling was gated on a number so that no guess — including this one — would decide it.

On the static evidence available when this DR was written, the most probable terminal state of a
correct implementation is **a second, SkillsBench-backed STOP** — because 86 of 87 active tasks
declare `network_mode: public` and Decision 6's gate may well resolve to option (a).

That is recorded here deliberately, before any code is written, so that a later STOP reads as the
method working rather than as the method failing. Demo-1's value has never been that it produces a
number; it is that it refuses to produce one it cannot stand behind.
