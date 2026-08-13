# Demo-1 P5 Evidence

**Recorded:** 2026-08-13

**Branch:** `codex/demo1-p5-plumbing`

**Exact base:** `a0bc1abe0c788a4dafdc8f6e9dcdf67e5f9c44ba`

## Current outcome: stopped at the disk gate

P5 is not complete and the real container/Claude chain has not started. The host-space precondition
failed after implementation began:

```text
/dev/disk3s1s1 482797652 12275624 25980720 33% /
P5 disk gate refused recorded P5 evidence: 24.78 GiB free; at least 40.00 GiB is required.
No caches or user data were deleted.
```

The latest exact available value was 25,980,720 KiB (24.7771 GiB). An earlier blocked snapshot in
this same work session recorded 33,352,736 KiB (31.8077 GiB); neither qualified. No fixture mint, image inspection,
image pull, Docker grader, gold/empty control, or Claude cell was run below the threshold. No cache
or user-data deletion was attempted. Earlier measurements above the threshold were not reused:
the gate is intentionally evaluated again immediately before every image and container phase.

## Offline implementation evidence

- The current-source dependency closure (26 packages) builds through the OCI-grader package on
  Node 22; benchmark-product core builds and typechecks.
- The CI-safe P5 assertions cover the exact 40-GiB boundary and fail-closed lower boundary; exact
  12-cell accounting; one dispatch per cell; all four verification axes; three source clusters;
  no interval with the `minN=5` reason; and raw `draws = resamples × clusterCount` accounting.
- The post-P3b fixture test now requires the named canonical evaluation-row descriptor and exact
  material keys, matching digest-pinned `docker://` URI, shipped parser identity, frozen grader
  program, timeout, and three repository provenance clusters.
- The one-command local runner performs runtime readiness, the three gold-PASS/empty-FAIL controls,
  import/quote/lock/launch/collect/report/verify, all-12 and per-axis audits, local immutable bundle
  materialization, builder-workspace removal, and cold bundle verification.
- The Docker executable is wrapped by a host-space guard. P3b remains responsible for digest
  pre-stage followed by child-local-only `--pull never`; grader network stays disabled.

The committed fixture is deliberately still the pre-P3b mint while this stop is active. Therefore
the focused fixture suite presently reports exactly three expected stale-fixture failures: old
image name, empty `testMaterial`, and missing parser/provenance identity. Those are not waived. A
passing P5 packet requires a legal re-mint and a green rerun.

## Required continuation

Once an immediate measurement again reports at least 40 GiB available:

1. re-mint the fixture and run all CI-safe fixture/package/architecture checks;
2. run the real three-task gold-PASS/empty-FAIL OCI control;
3. merge the P4 draw-accounting correction and retain the exact raw-draw assertion;
4. prove the real Claude readiness inventory, then run all 12 cells without manual intervention;
5. record the sealed Benchmark, Run, Matrix, Report, bundle, per-axis, timing, and cold-recompute
   evidence here.

Any missing image, credential/readiness failure, grader-control failure, or required platform seam
change remains a terminal evidence handoff, not permission to improvise a substitute.

## Publication boundary

This packet may emit only a local immutable bundle. It does not create a public report URL, signed
Record Discovery source, archive mirror, Explorer view, or publication claim. This evidence is a
blocked implementation checkpoint, not a published benchmark and not a capability result.
