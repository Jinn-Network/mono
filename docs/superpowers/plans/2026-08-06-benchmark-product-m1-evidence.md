# Benchmark Product — M1 Walking-Skeleton Evidence (recorded run)

Companion to `2026-08-05-standalone-benchmarking-product-program.md`.
Recorded 2026-08-06 (re-recorded after the review fix: the harness now
unconditionally clean-rebuilds dist/ before running) by the master
coordinator executing
`node scripts/m1-walkthrough.mjs` in `packages/benchmark-product/core`
at the BP-14 integration head. Exit code 0.

## What the run proves

A cold start in a fresh temp workspace, driven ONLY through the product CLI
(16 real child-process invocations of `dist/cli/bin.js`, every call `--json`):

init → authority show → draft create → sample init (seals ≥2 prediction
Tasks + EvaluationSpec + Benchmark + admission receipts) → arm add ×2
(`prediction-v1-baseline`, `sample-uniform`) → inspect → **authority grant
to a delegated agent** → quote → **lock and launch executed BY the
delegated agent** (the agent-native proof) → status → collect → results →
report → verify.

Execution was REAL end-to-end: the composed `makeLocalTaskExecutionBackend`
spawned real solver subprocesses for both arms (6 solve cells), the real
evaluation-harness subprocess graded each delivery (6 evaluation cells),
verdicts were DSSE-signed with the workspace key, the Matrix assembled with
complete accounting (6/6 judged, 0 failed), `verifyMatrix` re-derived it,
the DSSE Report sealed with `preregistered: true` (wilson@1 was carried in
the Run's analysisPlan at lock), the claim package was written, and
`verify` passed all three legs: `matrix-rederivation`,
`report-verification`, `claim-consistency`.

## Recorded digests (this run)

- benchmark `sha256:83a4edf3d67239ea20d028ebecb0c4f69a5d416579e93035f3fc67b366169169`
- run `sha256:baf676910c6c9aecaa7bb8b61b9e5f4b2931a43869cb281d27653776e989f6c7`
- matrix `sha256:7e6a646611f53b76aeb5af19b7af813ed18557f1a48a9aaf8142efeff0dfb4ed`
- report `sha256:0a481499622314a81fc9539745d9a2d1aafc8bacf451c09e86711bd710e718ec`
- report DSSE envelope `sha256:a1d210b7a71c4b0cd1269ade81b0e577190eaa12648afa0c7be0e9981fc4998b`

Determinism cross-check: the benchmark digest is byte-identical to an
independent earlier run of the same harness (`83a4edf3…` in both) — the
bundled sample seals deterministically. Run/matrix/report digests differ
per run because `closeAt` is computed from the injected clock at lock
time; that is the pre-registration working as designed, not
nondeterminism in sealing.

## Honest limits of this evidence (venue + method)

1. **Local self-run venue**: reproducibility and discipline, no
   pre-registration or completeness guarantee against the run owner
   (platform design §7.2 leg c). Stated in the results document,
   report limitations, and claim package.
2. **Headline method**: wilson@1 pass-rate per arm. On the 3-item sample
   both arms pass all cells (1.0000 each, interval low 0.4385) — the
   pass/fail spec grades submission validity, while the forecasting-skill
   separation (Brier measurements, `brierSpread`) is recorded in the
   verdict measurements but is NOT compared by the M1 headline method.
   A skill-separating comparison method presentation is M2+ surface; the
   claim package carries only the platform-computed wilson numbers and
   hides nothing.
3. **Single evaluator identity, `independence: disclosed`** (direct-check
   preset) — disclosed in report disclosures; distinctness ≠ real-world
   party independence, repeated wherever the result surfaces.
4. **Trust root is workspace-local** (self-run): `verify`'s authenticity
   leg resolves a workspace-synthesized genesis binding — integrity +
   workspace-key authorship, not third-party attestation. Disclosed in
   the claim package's `verification.trustRoot`.
5. A `claude-code`-launcher repository-work run was NOT attempted for M1
   (optional additional evidence per the dossier; the M1 venue composition
   scopes to the prediction-forecast profile). The SWE-bench-shaped intake
   path is implemented and tested at the import layer only.

## M1 definition check

Agent-interface-first walking skeleton: sample path ✓, two configurations ✓,
success defined through the platform EvaluationSpec ✓, official method
locked before results ✓, one real supported run on the strongest
implemented backend ✓, complete accounting ✓, machine-readable results ✓,
minimal verifiable report ✓ — all through the agent-facing CLI, no
graphical surface ✓, delegated-agent authority exercised for lock+launch ✓.

Transcript artifact (full command list + envelopes): session scratchpad
`m1-evidence-transcript.json` (not committed; digests above are the
durable references, and the harness re-produces the transcript on demand).
