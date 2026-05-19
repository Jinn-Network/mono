# `client/scripts/release/`

Mechanical gate-runners invoked by the `release-prep` skill (see
`.claude/skills/release-prep/SKILL.md`) and by CI on every stable publish.

## Tier 1 orchestrator

`run-tier-1.ts` runs all four Tier 1 scenarios in parallel and emits a
structured verdict.

```bash
yarn release:tier-1 <candidate-version>
```

Output goes to `tier-1-evidence/<timestamp>/` with `summary.json`,
`marker.txt`, and per-scenario `.log` files.

Per-scenario standalone invocations:

```bash
yarn release:tier-1:T1.1    # bootstrap-fresh-anvil
yarn release:tier-1:T1.2    # harness-readiness-contract
yarn release:tier-1:T1.3    # indexer-round-trip
yarn release:tier-1:T1.4    # SPA route smoke
```

Exit codes:
- `0` — all scenarios passed (or only failed with non-`real-bug` classes / skipped)
- `1` — at least one `verdict=fail` with `failClass=real-bug`
- `2` — internal orchestrator error

Spec: `docs/superpowers/specs/2026-05-19-release-readiness-and-substrate-design.md` §3.

## Files

| Path | Responsibility |
|---|---|
| `scenario-types.ts` | Shared `ScenarioVerdict`, `FailClass`, `ScenarioOptions` types + `classifyFailure` regex classifier. Consumed by every T1.x callable and the orchestrator. |
| `run-tier-1.ts` | Orchestrator. Imports T1.1–T1.3 callables and invokes T1.4 via the Playwright CLI subprocess. Emits `summary.json` + `marker.txt`. |
| `README.md` | This file. |
