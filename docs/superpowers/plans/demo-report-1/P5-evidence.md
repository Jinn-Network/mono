# Demo-1 P5 Evidence

**Recorded:** 2026-08-13

**Branch:** `codex/demo1-p5-plumbing`

**Original implementation base:** `a0bc1abe0c788a4dafdc8f6e9dcdf67e5f9c44ba`

**Current integration base:** `002a7e17b`

**Recovery implementation commit:** `76a9857db`

## Current outcome: authenticated fresh run stopped at the disk gate

The operator-authorized recovery run used the product-owned secret-forwarding boundary described
below. It passed isolated readiness and the repeated real gold-PASS/empty-FAIL baseline, locked at
`2026-08-13T10:09:18.799Z`, and dispatched every one of its twelve fixed cells exactly once. Every
Claude attempt used `claude-haiku-4-5-20251001` through Claude Code `2.1.222`; all twelve delivered
a patch, every pinning axis matched, and there were zero authentication failures.

Ten cells received valid grader verdicts: six PASS and four FAIL. The two Hermes WebUI Skill-arm
replicates delivered patches but became `could-not-grade` when the host fell below the repeated
40-GiB Docker safety gate. The sealed Matrix therefore has ten judged and two unscorable cells,
is `partial`, and carries the `nonjudged-arm-imbalance` flag. The P5 accounting guard refused it,
so no immutable bundle or cold verification was emitted. The closed Run was not resumed, topped
up, or altered.

The journal's historical failure detail is only `oci grader unavailable: pinned grader image is
unavailable`: the OCI adapter discarded the failed inspection's exit code and stderr. A direct
post-stop reproduction made the distinction observable. At 34.54 GiB, the exclusive P5 Docker
wrapper refused an exact image inspection with exit 78, while direct Docker inspection succeeded
and returned the sealed Hermes image digest. Live observations had crossed below 40 GiB before
both failed grading operations. This strongly attributes the two stops to the disk gate without
fabricating historical exit codes the journal did not retain.

The normalized evidence is
`p5-artifacts/fresh-run-disk-stop-2026-08-13.json`, digest
`sha256:70fdb02db9eefdea9eb93ffdbcf7e106c4df18f88315c4d68667800422767229`. Its Run digest is
`sha256:fb43d4d560cfa02555fb65c12ac284f85a43f1537472088db27c5df1bb360a8f`, Matrix digest is
`sha256:4ea47bf74ab50393e8d462a29b9562035d2664deefa69a37617c2411cf61944f`, and Report digest is
`sha256:f6d13f11928fb3d0972a2bcb2aaf9cb4989a0e691d4ff23775eb25c876f29fcd`.
This remains a plumbing stop, not a capability result or publication artifact.

### Recovery implementation after the immutable stop

The closed Run and its stop evidence above remain unchanged. The next fresh P5 Run uses an
append-only recovery contract rather than altering or topping up that Run:

- a 60-GiB start gate establishes a 16-GiB reserve owned by the new output directory; only this
  authenticated file may be released automatically, toward a 44-GiB target and never below the
  existing 40-GiB hard floor;
- the sealed Run opts into one evaluation-only infrastructure retry; absence of the new policy
  field still means zero and preserves legacy bytes;
- only typed backend/dependency/transport unavailability is eligible. Grader timeouts, test
  failures, model failures, and unclassified text are not;
- the first outage is a nonterminal append-only journal fact. Resume reuses the already delivered
  patch and solve dispatch, and attempt 2 grades the same derived evaluation Task bytes;
- process interruption resumes the same accepted evaluation attempt rather than spending another
  retry; insufficient run-owned recovery space stops before attempt 2 and leaves the checkpoint
  open;
- status and the deletion-portable bundle expose and authenticate the complete failed/recovered or
  failed/exhausted lineage.

No shared Docker cache, package cache, worktree, or user data is automatically deleted. Those
resources are not owned by one Run and may be active or costly to reconstruct, so any broader
pre-run cleanup remains an explicit operator decision.

## Earlier outcome: fresh run stopped on isolated Claude authentication

The operator authorized a fresh P5 run after the exact images became locally available. The
original qBraid and Fromager rows then failed their mandatory gold controls before any Claude cell
ran: their immutable images lacked dependencies required to collect the sealed upstream test
commands. The outcome-blind recovery screen also rejected three candidates whose gold and empty
controls failed identically. The complete screening evidence is sealed in
`p5-artifacts/gold-control-recovery-2026-08-13.json`.

The replacement slate is Foamlib, Conan, and Hermes WebUI across three repositories. The final
real grader control ran from `2026-08-13T08:44:06.338Z` through
`2026-08-13T08:44:25.925Z`, with 55.32 GiB available at its initial disk gate. All three exact
digest-pinned gold patches passed and all three empty patches failed; grader networking was
disabled. The transcript is `p5-artifacts/green-baseline-recovery-pass.json`, digest
`sha256:f5bec9dcf80da5a312724167351ab4496e2f2e9e6627d093e3a0b6cf59c00e83`.
No Claude cell had been dispatched when this recovered slate was frozen.

The authorized fresh run then passed the runtime inventory probe, repeated the green baseline,
quoted 12 cells, locked, and dispatched every fixed cell exactly once. All 12 isolated Claude
processes initialized with exact model `claude-haiku-4-5-20251001` and Claude Code `2.1.222`.
All six baseline processes had no plugin and all six Skill processes loaded only
`jinn-demo1-skill`, so the intended arm delivery occurred. However, every process also reported
`apiKeySource: none` and stopped immediately with `authentication_failed` and
`Not logged in · Please run /login`. No process consumed input or output tokens.

The ambient readiness probe had checked the operator's default Claude configuration. Execution
then set `CLAUDE_CONFIG_DIR` to each attempt's isolated, initially empty harness-state directory,
and the launcher declared no secret forwarding. The operator's host login therefore was not
available to the attempts. Copying host configuration or extracting credentials into experiment
workspaces was not attempted: that would expand the credential and isolation contract rather than
recover the already locked run.

The Run closed `partial`; Matrix accounting contains all 12 cells as expired, zero judged, and no
replacements. No retry or cell top-up is permitted after dispatch, and no report bundle was
emitted. The normalized stop evidence is
`p5-artifacts/fresh-run-auth-stop-2026-08-13.json`, digest
`sha256:3a3e50f1e7d96eabefec2ecd7c7f3330a81b1dae28ae490325b48eb06e9aacae`.
Its Run digest is
`sha256:00f9ffc80f46bd28f2aee477c86624d8b9ce6d90bb60e13027f466d45b13faf9`
and Matrix digest is
`sha256:bc3edf382edf7649726bfbe87b640ed19b17434a71b2c8cb6ccf6fbd60c7d76c`.

## Historical outcome: stopped at the digest-pinned image pre-stage

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
- OCI image preparation now distinguishes the runtime's image-not-found status from every other
  nonzero inspection result. An unexpected host-policy exit such as the P5 wrapper's exit 78 is
  preserved in the operational error and cannot be reinterpreted as permission to pull. The OCI
  package passes 76 tests, typecheck, build, pack smoke, and its architecture/source-boundary
  guards with this correction.
- Future pre-stage stop output uses local operational schema `demo1.p5-green-baseline-stop/2`
  (not a platform record kind). Its injected child observer must capture `startedAt`,
  `completedAt`, monotonic elapsed, configured timeout, the direct `timedOut` boolean, and a
  timeout-kill, early-exit, or typed child-process-error classification. A ChildProcess error can
  never be labeled as an ordinary exit. The canonical `p5:walkthrough` always supplies immutable
  stop output and attempt identity, so every future image-prestage stop takes this v2 path.
  Validation rejects missing, contradictory, or elapsed-before-child-bound timeout evidence.

The recovered final fixture was minted at `2026-08-13T08:43:46.163Z` after the disk gate had
recovered above 40 GiB. It contains three rows from three repositories and seals:

- parser `network.jinn.parser.swe-rebench-v2@1.0.0`, digest
  `sha256:5b859d500777a1370bdadcee098ce9449f92772b7c9572709b502d9ee3be9e7a`;
- grader program
  `sha256:8194eb47ad010d8e1ce2f5f4a5becd3354102f80c138aad836cfd3b0e8b2ab11`;
- a 1,800-second timeout and the exact canonical P3b material for every row.

The fixture bytes are `sha256:365cbfa8218501cfb804dcb0555fbb63b563060e1aafadd68513ebbc28627f87`
for `rows.json` and `sha256:0e09dbfa994730101c53510060838eca23380533aad5b7aeaa601288b85e4973`
for `provenance.json`. The strict post-P3b fixture suite passes all 11 assertions.

Final non-Docker reruns on Node 22 passed:

- P5 pure/injected tests: 27/27;
- strict final-fixture tests: 11/11;
- benchmark-product core full suite: 83 files passed, 3 skipped; 892 tests passed,
  13 skipped;
- benchmark-product typecheck, build, parity check, and packed-consumer smoke;
- package inventory, source boundaries, and architecture generator: 39/39, followed by an exact
  generated-topology check.

## Authorized recovery path

The pinned-image and grader-valid-slate issues are resolved. On 2026-08-13 the operator identified
the already-provisioned `claude setup-token` credential and authorized a wholly new P5 run. The
credential remains in its operator-owned, non-workspace 0600 file; its path and bytes are not
sealed into the Run, launch plan, transcript, or repository.

The recovery implementation does not copy the operator's default Claude configuration into an
attempt. Instead, each newly sealed solve Submission carries one opaque capability-grant
descriptor. After durable spawn intent, the local backend resolves that descriptor into a 0600
file under the attempt's private `secrets/` directory. A deterministic product-owned wrapper reads
that file inside the child process, sets `CLAUDE_CODE_OAUTH_TOKEN` with `CLAUDE_FORCE_OAUTH=1`,
removes conflicting Anthropic environment variables, invokes the exact bound Claude executable,
and exits with it. The launch plan contains only the `secrets/<target>` reference. Secret bytes are
zeroed where mutable and the attempt secrets directory is removed at terminal harvest.

The wrapper digest is the sealed harness executable digest. Its source binds and re-verifies the
underlying Claude executable path and digest before every invocation, so the wrapper cannot hide
Claude binary drift. Readiness now uses that same wrapper and token-file contract with a freshly
created `CLAUDE_CONFIG_DIR`, then deletes the probe directory. The real preflight passed with
Claude Code `2.1.222`, exact model inventory `claude-haiku-4-5-20251001`, and distinct recorded
wrapper and Claude-binary digests. This proves the former ambient-vs-isolated authentication gap is
closed without weakening per-attempt state isolation.

The authenticated recovery run repeated the disk gate and real three-task gold-PASS/empty-FAIL
baseline, but the host did not retain enough space for all twelve later grading operations. A
future wholly new run therefore needs materially more than the bare 40-GiB start threshold, must
again account all twelve newly locked cells, emit the local immutable bundle, delete the builder
workspace, and pass cold verification. Both earlier locked Runs remain terminal and are never
resumed, retried, or topped up.

## Publication boundary

This packet may emit only a local immutable bundle. It did not create a public report URL, signed
Record Discovery source, archive mirror, Explorer view, local report bundle, or publication claim.
This evidence is a blocked implementation checkpoint, not a published benchmark and not a
capability result. Neither partial run can support an arm-effect claim.
