# Demo-1 P5 Evidence

**Recorded:** 2026-08-13

**Branch:** `codex/demo1-p5-plumbing`

**Exact base:** `a0bc1abe0c788a4dafdc8f6e9dcdf67e5f9c44ba`

**Integrated through:** `0427833e9e7e62cf9fc86c1194ed01688354f1db`, including P4 draw correction `834f3436dc5991098addc9177f4652d81d6cbfb6`

## Current outcome: stopped at the digest-pinned image pre-stage

P5 is not complete. The disk precondition later recovered, so the fixture was legally minted and
the real OCI green-baseline control began. The operator attests that the configured 1,800-second
bound expired before the first exact digest-pinned image became locally available. One recorded
infrastructure-only retry was authorized under the identical digest, platform, configured bound,
and grader contract; the operator attests to the same configured-bound expiry in that
pre-dispatch stage. Both attempts failed closed as:

```text
EvaluationOperationalError: oci grader unavailable: pinned grader image is unavailable
canonicalCode: UNAVAILABLE
reason: provider-unavailable
recoveryAdvice: new-attempt-required
```

The exact attempted image was
`swerebench/sweb.eval.x86_64.gerlero_1776_foamlib-329@sha256:1f70f75a3faee203644429f61712d6d49a9a46ddb66eb199c8164e60cf027781`
for `linux/amd64`. Attempt 1 began with 47,299,448 KiB (45.1083 GiB) available and ended
with 44,970,404 KiB (42.8871 GiB). Attempt 2 began with 44,939,716 KiB (42.8579 GiB)
available and ended with 44,297,640 KiB (42.2455 GiB). The exact digest was absent after
each attempt. No tag fallback, unpinned substitute, timeout change, cache deletion, or third
attempt occurred. No gold/empty grade or Claude cell was dispatched.

The authenticated original execution history preserves command issuance, a late observation of
the still-running exact pull (1,764 seconds for attempt 1; 1,748 seconds for attempt 2), terminal
`UNAVAILABLE`, and the post-attempt exact-image absence. It does **not** expose the runner's
`boundedExit.timedOut` value or a final monotonic elapsed measurement. Accordingly this packet
does not claim a machine-proven timeout or infer one from wall-clock narrative; the precise expiry
classification is operator-attested, while `UNAVAILABLE` and exact-image absence are preserved
machine evidence.

The append-only stop records are:

- `p5-artifacts/green-baseline-attempt-1-stop.json`,
  `sha256:ffe480c0d7203340dd8e5b78531eb4ffefb9b6795ade814e0c66bc6e47ace47f`;
- `p5-artifacts/green-baseline-attempt-2-stop.json`,
  `sha256:5a1201153ae5c26d99fba0a54f19b73a7101fb0b4fc16cdfb53b15dd0cf41ef1`.

Their deletion-portable normalized source excerpts are
`green-baseline-attempt-1-session-excerpt.json`
(`sha256:d60564dfe7f5a7d623faceb76c8eb1f23c34f2c5943234e6b1ce2d3c5a464b8f`) and
`green-baseline-attempt-2-session-excerpt.json`
(`sha256:63be2562938bfac51a071c1728bff46368b6b15ad3721766cecaab05ec1ebd55`).
Each excerpt identifies and hashes the authenticated source history and every normalized source
event, while declaring that private history is not a retention dependency.

## Offline implementation evidence

- The current-source dependency closure (26 packages) builds through the OCI-grader package on
  Node 22; benchmark-product core builds and typechecks.
- P4's shared-ensemble correction is merged. The old paired-delta fixture remains byte-immutable,
  its manifest erratum routes current conformance to the append-only v2 successor, and P5 asserts
  the corrected public identity `draws = resamples × clusterCount` without product-side statistics.
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
- Future pre-stage stop output uses local operational schema `demo1.p5-green-baseline-stop/2`
  (not a platform record kind). Its injected child observer must capture `startedAt`,
  `completedAt`, monotonic elapsed, configured timeout, the direct `timedOut` boolean, and a
  timeout-kill, early-exit, or typed child-process-error classification. A ChildProcess error can
  never be labeled as an ordinary exit. The canonical `p5:walkthrough` always supplies immutable
  stop output and attempt identity, so every future image-prestage stop takes this v2 path.
  Validation rejects missing, contradictory, or elapsed-before-child-bound timeout evidence.

The final fixture was minted at `2026-08-13T01:06:45.511Z` after an immediate
47,323,076-KiB (45.13-GiB) disk pass. It contains three rows from three repositories and seals:

- parser `network.jinn.parser.swe-rebench-v2@1.0.0`, digest
  `sha256:5b859d500777a1370bdadcee098ce9449f92772b7c9572709b502d9ee3be9e7a`;
- grader program
  `sha256:8194eb47ad010d8e1ce2f5f4a5becd3354102f80c138aad836cfd3b0e8b2ab11`;
- a 1,800-second timeout and the exact canonical P3b material for every row.

The fixture bytes are `sha256:121dda614c63ea204c1d2cfb5054692c0751afd9d51c366a5bbcc395d4e4b06a`
for `rows.json` and `sha256:ff67450c05b6f3b8a1f41f3c224273ddf5a85a648765f01c11ccccc791bcb60c`
for `provenance.json`. The strict post-P3b fixture suite passes all 11 assertions.

Final non-Docker reruns on Node 22 passed:

- P5 pure/injected tests: 17/17;
- strict final-fixture tests: 11/11;
- benchmark-product core full suite: 78 files passed, 3 skipped; 819 tests passed,
  13 skipped;
- benchmark-product typecheck, build, parity check, and packed-consumer smoke;
- package inventory, source boundaries, and architecture generator: 28/28, followed by an exact
  generated-topology check.

## Required continuation

The two permitted pre-dispatch image attempts are exhausted under the recorded retry policy.
Continuation requires operator action
outside this packet to make the exact digest-pinned image available without changing the frozen
contract, followed by a fresh authorized run. Only then may the real three-task gold-PASS/
empty-FAIL control, Claude readiness probe, 12 cells, and local cold bundle verification run.
The stop evidence is a terminal handoff, not permission to improvise a substitute.

## Publication boundary

This packet may emit only a local immutable bundle. It did not create a public report URL, signed
Record Discovery source, archive mirror, Explorer view, local report bundle, or publication claim.
This evidence is a blocked implementation checkpoint, not a published benchmark and not a
capability result.
