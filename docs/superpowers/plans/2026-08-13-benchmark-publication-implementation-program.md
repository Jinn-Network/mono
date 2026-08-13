# Benchmark Publication Interoperability — Implementation Program

| Field | Value |
|---|---|
| Date | 2026-08-13 |
| Baseline | `fa3f452bb631f38cd5cbf25787e205471c3fa6e1` |
| Integration branch | `codex/benchmark-publication-interop` |
| Delivery | Local commits only; no push, PR, issue mutation, publish, or deployment |
| Authorities | `../specs/2026-08-13-benchmark-publication-interoperability-profile.md`; `../../spikes/2026-08-13-colophon-harbor-marketplace-publication.md` |

## Fixed outcomes

- Add reusable BenchmarkAccounting, observation archives, Report v2, Matrix v2, neutral record publication, and benchmark-publication layers.
- Make Colophon publication stage-based, durable, resumable, public-before-run or post-hoc, with accounting-only closure and no task rerun.
- Add direct Harbor 0.21 compatibility and Terminal-Bench 2 selection/migration while exposing every Jinn dispatch and disabling hidden retries.
- Preserve Report v1, Matrix v1, legacy bundles, the frozen task backend interface, and third-party origin authority.
- Defer marketplace execution/product wiring, settlement, deployment, and arbitrary historical Harbor import.

## Coordinator law

- Each packet is implemented in a branch/worktree based on the latest integrated SHA, receives tests first and an independent read-only review, and is integrated only by the coordinator.
- Workers use `gpt-5.6-terra`, do not spawn agents, do not merge or push, and return their commit SHA and verification evidence.
- Blockers are specification/interface violations, failing tests or fixtures, security defects, or data-loss risks. Other findings are recorded for follow-up.
- After each integration, run the affected package battery and update this ledger.

## Packet DAG

| Packet | Objective | Depends | State |
|---|---|---|---|
| PUB-00 | Authorities, program, issue drafts, baseline | — | complete |
| PUB-01 | Benchmark records, Accounting/archive/Report v2/extensions | PUB-00 | complete |
| PUB-02 | Neutral record-publication package and source adapter | PUB-00 | complete |
| PUB-03 | Accounting facts and verification | PUB-01 | complete |
| PUB-04 | Runner capture, explicit attempts, Matrix v2 | PUB-01 | complete |
| PUB-05 | Aggregate Report v2 | PUB-01 | complete |
| PUB-06 | Evidence-publication compatibility adapter | PUB-02 | complete |
| PUB-07 | Benchmark-publication package | PUB-01..04, PUB-02 | complete |
| PUB-08 | Runtime contributor contract and adapter migration | PUB-07 | complete |
| PUB-09 | Colophon durable capture and state migration | PUB-08 | complete |
| PUB-10 | Harbor selection, execution, archive, verification | PUB-08 | pending |
| PUB-11 | Terminal-Bench 2 selection, migration, smoke | PUB-10 | pending |
| PUB-12 | Colophon public source, authorization, registration | PUB-09, PUB-07 | complete |
| PUB-13 | Accounting/report publication and bundle v3 | PUB-10..12 | pending |
| PUB-14 | CLI, HTTP, and web UX | PUB-13 | pending |
| PUB-15 | Conformance, architecture, final review and handoff | PUB-14 | pending |

## Verification baseline

The repository pins Node 22 and Yarn 4.13.0 (`.nvmrc`, `.node-version`, package engines, and CI). The coordinator shell initially resolved Node 20.10.0, so all verification commands explicitly prepend `/Users/adrianobradley/.nvm/versions/node/v22.23.1/bin` to `PATH`. Package-local tests are mandatory before integration; final verification includes schema/runtime parity, package builds and pack smoke tests, architecture/catalog guards, product core/web tests, crash recovery, no-rerun post-hoc publication, and loopback HTTP byte retrieval.

## Ledger

| Packet | Base | Head | Tests | Review | Integrated |
|---|---|---|---|---|---|
| PUB-00 | `fa3f452bb` | pending commit | `git diff --check`; authority files byte-for-byte transferred | authority documents approved | integration baseline |
| PUB-01 | `36dc97bfa` | `85fa66d6a`, `e628c4bbf` | 330 tests; typecheck; build; schema drift/parity; pack smoke | APPROVE after 3 blockers fixed | `a898121c4`, `0923ac9aa` |
| PUB-02 | `36dc97bfa` | `c56d178cd`, `c65947090` | 4 tests; typecheck; build; pack smoke; discovery/catalog/architecture guards | APPROVE after 2 blockers fixed | `449814ac3`, `fedc41282` |
| PUB-03 | `58e155f6c` | `080ef2b0d`, `18107a2d1` | 39 tests; typecheck; build; pack smoke; discovery guards | APPROVE after 2 blockers fixed | `809cdb0ac`, `18637eb9d` |
| PUB-04 | `58e155f6c` | `976073f9a` | 68 passed, 2 skipped; typecheck; build; pack smoke; conformance | APPROVE | `5bc33a494` |
| PUB-05 | `58e155f6c` | `ed4a9e866`, `fbc80326c` | 199 tests; typecheck; build; pack smoke | APPROVE after close-boundary blocker fixed | `81789e196`, `d2c120249` |
| PUB-06 | `5ad001499` | `319430ed8` | 398 tests; typecheck; build; packed consumer smoke | APPROVE | `dde07e0a2`; guards `17127c593` |
| PUB-07 | `5ad001499` | `9393b1a9e`, `c9bef1c8b`, `e25861d3c` | 6 tests; typecheck; build; pack smoke; benchmarking guards; architecture | APPROVE after closure/media blockers fixed | `3826364d6`, `f854a55a1`, `b7862f06c` |
| PUB-08 | `f48ff4158` | `2d8f19383`, `54131eb6b` | 10 focused tests; core typecheck; build; pack smoke | APPROVE after Inspect binding/API blockers fixed | `828863d6f`, `22531a7ea` |
| PUB-09 | `91c47f70d` | `2ff4be724`, `a00bfe1bd` | 99 focused tests; run-path/report/results/bundle; core typecheck | APPROVE after compatibility/receipt blockers fixed | `22d8e17a8`, `4df67c0cf` |
| PUB-12 | `4df67c0cf` | `bbb2a7658`, `dd1a83450`, `745fd7cef` | 103 focused tests across publication, state, key identity, authority, lock/launch; typecheck; build; parity; pack smoke | APPROVE after provenance, authority, concurrency, and exact-closure blockers fixed | `92d8ff9e2`, `e3021aab7`, `1fe6399b8`; architecture `3c7034fe8` |
