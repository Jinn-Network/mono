# P5 — End-to-End Plumbing Gate Runbook

| | |
|---|---|
| **Status** | Implementation complete; real execution stopped at exact-image pre-stage |
| **Version** | 1.0 |
| **Updated** | 2026-08-13 |
| **Lane** | C4 |
| **Packet** | P5 |
| **Base** | Started at `a0bc1abe0c788a4dafdc8f6e9dcdf67e5f9c44ba`; merged through `0427833e9e7e62cf9fc86c1194ed01688354f1db` |

## Purpose and boundary

P5 is a disposable product-plumbing proof. It runs exactly three SWE-rebench tasks from three
repositories, two native Claude Code arms, and two replicates: 12 cells. It proves the local chain
`import → quote → lock → launch → collect → report → verify`, real OCI grading, complete evidence
accounting, and deletion-portable local bundle verification.

It does **not** measure capability. The slate is below paired-delta's five-pair minimum, so the
Report must emit no interval and must state why. P5 does not invoke publication, create a public
URL or discovery source, mint an archive mirror, or claim that Demo-1 is published.

## Final interfaces

- P2 supplies one product-owned, readiness-probed Claude Code runtime. Arm A uses the native
  generated `SKILL.md`; arm B uses the byte-identical body as native root `CLAUDE.md`. There is no
  C arm in P5.
- P2b supplies real per-axis run-pinning evidence. Every one of the 12 Matrix cells must be
  `match` for harness, model, loadout, and isolation, with one dispatch and no failed checks.
- P3b supplies the real OCI evaluator through `GraderReportSource`. Parent launch pre-stages the
  exact image digest; the child is local-only, runs with `--pull never`, and has no grader network
  unless both sealed material and host policy declare it.
- P4b supplies paired-delta presentation. The report must have three pairs and three source-repo
  clusters, withhold the interval because `minN=5`, and preserve number-free compact artifacts.
- P4's shared-ensemble draw-accounting correction is integrated. P5 asserts the public report
  field exactly: `draws = resamples × clusterCount`. The pre-correction fixture remains immutable;
  current conformance is routed through its append-only `paired-delta-shared-ensemble.v2.json`
  successor and manifest erratum.

No new record kind or tier-1–3 publication semantic is introduced.

## Frozen fixture

The fixture is minted only after P3b's final material contract. Each row must contain:

- a `docker://repository@sha256:<64 hex>` URI whose embedded digest equals `image.digest.sha256`;
- one `swe-rebench-evaluation-row` descriptor containing canonical JSON;
- exactly `instance_id`, `base_commit`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, and
  `install_config` in that material, with the material digest re-derived from its bytes;
- the shipped parser identity, frozen grader-program digest, and 1,800-second timeout;
- repository-level source provenance, yielding three distinct clusters.

The upstream gold `patch` is structurally excluded from the fixture, Task, agent context, solve
workspace, and evidence transcript. The local green-baseline control fetches it at execution time,
keeps it only in the grader's private temporary input, and proves gold PASS plus empty FAIL for all
three tasks.

## Safety gate

Before every image or Docker phase, `/` must have at least 40 GiB available. The gate is rechecked
at mint start, before any mint Docker fallback, before every image pre-stage and grader attempt,
at walkthrough start, before launch, and around every Docker subprocess. A failed gate stops with
the exact observed bytes/GiB and never deletes caches or user data. Docker work is local-only and
never required by CI.

Other terminal stops are a missing/non-ready Claude binding, missing credentials, unavailable
digest-pinned image, a failed gold/empty control, or a required platform-semantics change. There is
no automatic substitution or silent workaround.

Every future image-prestage stop must be emitted as local operational schema
`demo1.p5-green-baseline-stop/2` with directly captured `startedAt`, `completedAt`, monotonic
elapsed, configured timeout, `timedOut`, and timeout classification. The P5 child observer records
the actual timeout `SIGKILL`; validation rejects inferred, missing, contradictory, or
elapsed-before-bound timeout claims. This stop schema is not a new platform record kind or
tier-1–3 publication semantic.

## One-command execution

From `packages/benchmark-product/core`, on Node 22 with portal symlink preservation:

```sh
yarn p5:walkthrough \
  --claude /absolute/path/to/claude \
  --claude-version <exact-version> \
  --docker /absolute/path/to/docker \
  --output-dir /new/immutable/output/directory
```

The output directory must not already exist. The command:

1. clean-builds the benchmark product and readiness-probes exact model, harness, and loadout
   inventories;
2. runs all three real gold-PASS/empty-FAIL controls;
3. imports the three frozen tasks, registers only arms A/B, quotes exactly 12 cells, and locks;
4. launches with the gated Docker path, then collects, reports, and verifies;
5. rejects any missing cell, repeat dispatch, failed verification check, or non-`match` axis;
6. requires three pairs, three source clusters, `draws = resamples × clusterCount`, and no interval;
7. emits the local immutable bundle, copies it outside the builder workspace, deletes only that
   newly created builder workspace, and cold-verifies the copied bundle;
8. writes a transcript that says explicitly that the result proves plumbing, not capability, and
   that the publication boundary was not crossed.

The operations facade is intentional: the real Claude binding is a host-owned injected runtime,
and the CLI does not infer it from ambient executable or credential state.

## CI-safe gates

These run without network, Docker, or Claude:

```sh
yarn p5:offline:test
yarn vitest run src/intake/p5-micro-slate.test.ts
yarn typecheck
yarn build
yarn test
yarn pack:smoke
```

The fixture check/mint and real gate are local-only because they use live source/image state:

```sh
yarn p5:fixture:check
yarn p5:fixture:mint
yarn p5:green \
  --docker /absolute/path/to/docker \
  --output /new/transcript.json \
  --stop-output /new/prestage-stop.json \
  --attempt 1
```

## Acceptance evidence

The final `P5-evidence.md` records the exact branch head, fixture/provenance identities, disk-gate
snapshots, per-task gold/empty outcomes, readiness inventory, Benchmark/Run/Matrix/Report/bundle
digests, all-12 accounting, per-axis match counts, cluster/draw accounting, withheld-interval
reason, builder-workspace deletion, cold verification checks, package/architecture gates, and the
explicit no-publication boundary. If a terminal stop occurs, it records the stop evidence instead
of manufacturing a passing result.

The current run stopped before dispatch after two exact-image pre-stage attempts (the original and
the single authorized infrastructure retry). The operator attests that each configured
1,800-second bound expired, but the original execution history did not capture the direct child
timeout bit or final monotonic elapsed and therefore does not independently prove a timeout. The
append-only stop records preserve both attempts, terminal `UNAVAILABLE`, exact-image absence, and
this limitation. No third attempt, alternate image, gold/empty grade, or Claude cell is permitted
in this packet without new operator action.
