# Demo-1: Skill delivery A/B on SkillsBench v1.1

**Stage:** final (confirmatory). **Sealed 2026-08-20.** Every number below is taken from `demo1-report.v1.json`. Recompute with `cd packages/benchmark-product/core && yarn demo1:verify`.

## Disclosures on the face

These four facts bound the claim. They are not footnotes.

1. **Scale.** The paired estimate uses **14 informative tasks of 41** statically-admitted units. The official Demo-1 floor is **21 units in 13 independence clusters**. This run does not meet that floor.
2. **Flat population.** Every statically-admitted task was run: A×5, B×5, C×2 (**492 cells**). No task was selected or dropped on any outcome. The paired estimate is then restricted to the **pre-declared** informative subset: C = 0 in every replicate and max(mean A, mean B) > 0. Equivalence margin ±15 pp (150000 ppm). That rule was locked before any confirmatory cell existed; it was not tuned after seeing results.
3. **Host-agent deviation.** The agent ran on the host (Claude Code authenticates itself there), not inside the task image. Grading always ran inside the pinned container. Agent-side environment is the host interpreter, not the task's.
4. **Subject model.** Every cell ran `claude-haiku-4-5-20251001`. Nothing here generalizes to other models.

**Self-run venue.** The same operator produced and sealed every cell. The checkable artifact chain, not the operator, is what a reader should rely on. The contributors who designed and ran this benchmark operate the self-run venue it ran on, chose the slate and content artifact, built the estimator in the same program that emits the result, produced the grading environment, ran and graded both arms, and are using the report to demonstrate the benchmark product. The agent under test is made by the same vendor whose skill mechanism is one of the two arms. Attribution is role-only.

## Question

Holding task, model, harness, instruction bytes, non-instruction resources, and environment fixed, does the *delivery mechanism* for curated instructions change agent success?

- **Arm A** — instructions as a native Agent Skill (`--plugin-dir`, progressive disclosure).
- **Arm B** — byte-identical instruction text flattened into root `CLAUDE.md`.
- **Arm C** — no instructions (manipulation check). If C matches A/B, the task does not measure instruction delivery.

**Corpus:** SkillsBench v1.1 at `b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af`. **Design:** flat, all 41 statically-admitted tasks.

## Result

On the 14-task informative subset, mean **A − B = −0.047** (sealed −47143 ppm of reward).

**95% CI: −0.223 to 0.129** (t-critical 2.16, df = 13, SE = 0.082). The interval includes zero. The point estimate favors the flat `CLAUDE.md` arm by about 4.7 percentage points. This method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered.

### Variance decomposition (informative subset)

| Quantity | Value |
|---|---:|
| Between-task variance of deltas | 0.093 |
| Mean sampling variance | 0.071 |
| Task heterogeneity | 0.022 |
| Heterogeneity share | 0.239 |

About 24% of between-task variance is estimated as real task-to-task heterogeneity after subtracting replicate noise. Most of the spread is still sampling variance at n = 5 per arm.

### Manipulation check (full 41-task slate)

C is scored on every declared C cell, not on the informative subset.

| Quantity | Value |
|---|---:|
| C cells | 82 |
| C full-pass | 7 / 82 |
| C mean reward | 0.085 |
| A/B mean reward | 0.178 |
| Uplift (A/B − C) | 0.092 |

Seven C cells fully passed. Four tasks had at least one nonzero C replicate and therefore left the paired estimate: `3d-scan-calc` (C = 1, 1), `parallel-tfidf-search` (C = 1, 1), `pddl-tpp-planning` (C = 1, 1), `r2r-mpc-control` (C = 1, 0). On those tasks the agent can succeed without the instruction package, so A vs B is not a delivery contrast.

### Funnel: 41 → 14

| Stage | Tasks |
|---|---:|
| Statically admitted, all run | 41 |
| Dropped: C not identically zero | 4 |
| Dropped: C identically zero and max(mean A, mean B) = 0 | 23 |
| Informative subset (paired A−B) | 14 |

The 23 tasks where neither A nor B ever scored above zero contribute nothing to a delivery contrast: the instructions did not produce success under either mechanism, on this model, in this host-agent setup.

### Per-task A − B (informative subset)

| Task | Mean A | Mean B | A − B |
|---|---:|---:|---:|
| drone-planning-control | 0.053 | 0.113 | −0.060 |
| edit-pdf | 0.200 | 0.000 | +0.200 |
| energy-market-pricing | 0.000 | 0.200 | −0.200 |
| glm-lake-mendota | 1.000 | 0.800 | +0.200 |
| grid-dispatch-operator | 0.200 | 0.200 | 0.000 |
| hvac-control | 1.000 | 0.400 | +0.600 |
| lake-warming-attribution | 0.000 | 0.600 | −0.600 |
| llm-prefix-cache-replay | 0.200 | 0.600 | −0.400 |
| mario-coin-counting | 0.000 | 0.400 | −0.400 |
| pddl-airport-planning | 0.600 | 0.400 | +0.200 |
| radar-vital-signs | 0.800 | 0.800 | 0.000 |
| threejs-structure-parser | 0.400 | 0.400 | 0.000 |
| threejs-to-obj | 0.200 | 0.400 | −0.200 |
| video-silence-remover | 0.200 | 0.200 | 0.000 |

Signs are mixed. `hvac-control` is the largest skill-side delta (+0.60); `lake-warming-attribution` is the largest flat-file-side delta (−0.60). Four tasks sit at exactly 0.

## Host controls

After cells finished, each droplet ran the no-model oracle (must reach reward 1) and blank submission (must stay at 0) for its assigned tasks. Union: 41 distinct tasks, no duplicate keys.

**39 of 41** matched oracle = 1 and no-op = 0. Two did not:

| Task | Host | Oracle | No-op |
|---|---|---:|---:|
| `pddl-airport-planning` | w5 | 0 | 0 |
| `pddl-tpp-planning` | w6 | 0 | 0 |

A zero from an unvalidated instrument is uninterpretable. Those two tasks remain in the fail-closed 492-cell denominator. `pddl-airport-planning` still entered the informative subset (C was 0 and A/B were not). `pddl-tpp-planning` did not (both C replicates fully passed). The host-control miss is disclosed, not used to shrink the slate.

## Lock (precedes the data)

| | |
|---|---|
| Declaration digest | `sha256:a31405a150a66753273e7b645e5b1391265564c9f0d33df814e4af93bdeb7a7e` |
| Analysis-manifest digest | `sha256:822b2f7469dc2e58a3e72eee32688614d296ba20fc381d9a074e3935a68622b3` |
| Lock commit | `447e311c9` |
| Time-anchor commit | `ec9761220` (RFC 3161 token, freetsa.org) |

Confirmatory cells were collected after that anchor. Exploration cells in `E1-arm-cells.v1.json` are not in this denominator.

## Sealed digests

| Artifact | SHA-256 |
|---|---|
| Report envelope | `sha256:c66199af9e86dd9701f40c0a9d1fd8648dde4e50821f99335ce4052cfbb93583` |
| `demo1-report.v1.json` | `df1f8bb2ded82b82f2454306d6fd33da59f47811b7a45e26c609278ed72f9173` |
| `E1-demo1-confirmatory-cells.v1.json` | `b394d197174f136dc7c10a9564c5e6e5a730935370c141fc7c70ea5efc6da575` |
| `E1-demo1-host-control-evidence.v1.json` | `7164cb1f435f3d851a661b17a5727a4a3fb4e4402d8eb4d162a9161ad87a65c8` |
| `E1-demo1-evidence-bundle.v1.json` | `11a8c189eb06405f8bd97dd2dc31ae5b20a4fb300a2d9b57feabcadc399bdadd` |
| Cohort | `sha256:f279e3fe7de1308f8177bea06d316b0f6c5d546900f75033396fe55a6cf0d001` |
| Matrix | `sha256:1bd2dc6cd59df4784e78fca37907000b2f102ec69448a9a233acc9ca7c834470` |

`yarn demo1:verify` must show 22 checks passing, including preregistration byte-equality against `E1-demo1-preregistration.v1.json`.

## What this does not yet prove

- That native Agent Skills beat, match, or lose to `CLAUDE.md` on any model other than `claude-haiku-4-5-20251001`.
- That the same contrast would hold if the agent ran inside the task image.
- That the official 21-unit / 13-cluster floor is met. It is not.
- That SkillsBench v1.1 as a corpus is generally solvable by this model: 23 of 41 tasks scored 0 on both A and B.
- That the two tasks whose on-host oracle failed are valid instruments.
- Independence of operators. Distinct droplets and distinct cell keys are on disk; they do not prove distinct real-world parties.
- A publication claim. This packet seals and verifies a confirmatory run. Network publication is a separate program.
