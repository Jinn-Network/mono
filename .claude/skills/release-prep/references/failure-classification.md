# Failure classification

Every `fail` verdict has a `failClass` — release-readiness uses it to decide whether a fail blocks ship.

## Classes

| Class | Pattern | Triage default |
|---|---|---|
| `real-bug` | assertion failures, schema mismatches, unexpected returned values | BLOCKING |
| `flake-infra` | HTTP errors, ECONNREFUSED, ECONNRESET, network errors, getaddrinfo failures | retry once → if persistent, DEFERRABLE |
| `flake-timing` | "timed out", "timeout", "waiting for X" | retry once → if persistent, DEFERRABLE |
| `agent-crash` | scenario itself threw before producing a verdict | escalate to human |

## Detection

`classifyFailure(err)` in `operator/scripts/release/scenario-types.ts` regex-matches the error message against pattern lists. Conservative default: unknown errors are classified `real-bug` (so a genuine bug isn't accidentally treated as a flake).

## Adding patterns

When a real infrastructure issue keeps showing up as `real-bug`, extend the `FLAKE_INFRA_PATTERNS` or `FLAKE_TIMING_PATTERNS` lists in `scenario-types.ts`. Each addition should be accompanied by a regression test in `scenario-types.test.ts` so the classification is durable.

## What release-readiness does with each class

- `real-bug` → adds to BLOCKING gaps; closure subagent dispatched
- `flake-infra` → retry once; if persistent, marks as DEFERRABLE with a `tier-1-...=flake-infra` marker
- `flake-timing` → same as flake-infra
- `agent-crash` → escalate to human; recommendation = DEFER with diagnostic in handoff doc
