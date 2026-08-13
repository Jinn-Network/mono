# P5 — End-to-End Plumbing Gate Runbook

| | |
|---|---|
| **Status** | Implementation in progress; real execution is host-gated |
| **Version** | 1.0 |
| **Updated** | 2026-08-13 |
| **Lane** | C4 |
| **Packet** | P5 |
| **Base** | `integration/evidence-v1` at `a0bc1abe0c788a4dafdc8f6e9dcdf67e5f9c44ba` |

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
- The P4 draw-accounting correction is a merge prerequisite. P5 asserts the public report field
  exactly: `draws = resamples × clusterCount`.

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
yarn p5:green --output /new/transcript.json
```

## Acceptance evidence

The final `P5-evidence.md` records the exact branch head, fixture/provenance identities, disk-gate
snapshots, per-task gold/empty outcomes, readiness inventory, Benchmark/Run/Matrix/Report/bundle
digests, all-12 accounting, per-axis match counts, cluster/draw accounting, withheld-interval
reason, builder-workspace deletion, cold verification checks, package/architecture gates, and the
explicit no-publication boundary. If a terminal stop occurs, it records the stop evidence instead
of manufacturing a passing result.
