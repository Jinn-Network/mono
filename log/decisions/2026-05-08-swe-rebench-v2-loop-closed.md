# SWE-rebench v2 Loop Closed

Date: 2026-05-08

## Summary

The single-operator Base Sepolia SWE-rebench v2 loop closed under manifest CID
`bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi`.

The launcher posted task `45`, the same daemon solved it through the Codex-backed
learner path, and the same daemon evaluated the resulting Solution through
`swe-rebench-v2-evaluator`. The Verdict settled with `score: 0` and
`passed_match: false`.

## Key Transactions

- Launch metadata tx: `0xdd93db15bbaf28a1d4696800cefa1de49da36bf1fbeca1db90456f040674a96c`
- First task post tx for task `45`: `0x69de50ba6236351c0e3e81456c442221b12714d5a1eddd9b0a6f4100e0ccf228`
- Solution marketplace delivery tx: `0x2537a81deeaf39fd63f1881693ab74852694a56588df47326edd5727cb556e32`
- Solution router claim tx: `0xb102240dc3f095137b36d7eb81b7429c79b69feb4ef21f82909b5819fc7f4216`
- Verdict marketplace delivery tx: `0x2b1f8b4a2bfe6fbb8fbd74cf885bc58aedc6add78db6cf98bc02dd906431085f`
- Verdict router claim tx: `0x3e999bcdb4f262bc14d5eafe82b7a5f0fec9c3c3d9596918cf55ca2e8b2ece67`

## Artifacts

- Task id: `45`
- Task CID: `f01551220df477987e69e6a03c3386a072b889512e98c4a9df991057d48fe4256fbe9778a`
- Solution request id: `0x35df930dc4254ef3ee037f201b093ae17ac3dff01c46a8732f20b096546e7833`
- Solution envelope CID: `bafkreibmv3otjyd5jjfrd6cxkrrr353jq3zwt6grgyvbmmnnih3f22myvi`
- Solution working dir: `/Users/adrianobradley/.jinn-client/engine/work/0xb0ec7f8782c3c55c38815ab84a33d8e9713cc5508c1f9a01ad0a9928143c1954`
- Verdict request id: `0xdf4d3b1d970bd277b6a3d705b50a0b0ac47b70c87b59dbf1a09dcd288758bf39`
- Verdict envelope CID: `bafkreidmqegkuc74zupjkkstfoqvynnwbywccwkygvownsrvz7ugk6mdam`
- Verdict working dir: `/Users/adrianobradley/.jinn-client/engine/work/0xdf4d3b1d970bd277b6a3d705b50a0b0ac47b70c87b59dbf1a09dcd288758bf39`
- Test log CID: `bafkreieqf4bhlqoxkf7tu6hzmnu7ll3ltbnpdruc3ladw3heuoanie2doy`
- Verdict trajectory CID: `bafkreiaykvromnbeizppfih3bx6yjljbf3obnpbj74ovmxyhvs3xmhi3ly`

## Timing

- Launch record timestamp: `2026-05-08T10:12:45.125Z`
- Task `45` posted: `2026-05-08T12:40:16.464Z`
- Solution completed: `2026-05-08T15:04:32Z`
- Verdict completed: `2026-05-08T15:20:13Z`
- Launch-to-loop closure: about 5h 7m, including debugging/recovery time.

## Changes Needed During Closure

- Codex support was added through harness-agnostic runtime plugin projections rather
  than an inline-only Codex prompt path.
- The learner harvester was relaxed so a valid typed SWE payload file can complete
  harvest even when `.execute/summary.json` is absent.
- The harness prompt was neutralized so the daemon prompt asks for task completion
  and payload submission without naming harness-specific skill ids.
- `MechAdapter` was fixed to recompute evidence hashes over the raw fetched envelope
  wire object instead of the schema-normalized object.
- Base Sepolia self-evaluation recovery was unblocked by removing the remaining
  local same-operator skip from evaluation opportunity construction.
- The live daemon now passes the shared store into `MechAdapter`, so durable pending
  evaluation recovery (`mech_pending_evaluation_solutions_v1`) works.
- Delivery-event recovery now defaults to a bounded 100k-block backfill window
  instead of scanning from genesis when reconstructing a solution envelope CID.
- Docker Desktop had to be started, then `SweRebenchV2EvaluatorHarness.onEnable()`
  was invoked directly because the old CLI only enabled the selected SolverNet
  solver harness.
- After closure, `jinn harnesses enable swe-rebench-v2-evaluator` was added as
  the supported direct Harness setup command.

## Follow-ups

- Decide whether to keep the Base Sepolia self-eval bypass while setting up
  multi-operator dogfood, or revert the bypass now that this single-operator loop
  has been proven.
