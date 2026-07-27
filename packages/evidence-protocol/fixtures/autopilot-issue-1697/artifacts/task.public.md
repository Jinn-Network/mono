# GitHub issue #1697: Hermetic gate downloads onnxruntime prebuilt from external CDN during yarn install (not hermetic)

**Context.** The "Hermetic gate (deterministic, snapshot)" CI job runs `yarn install`, which downloads the onnxruntime-node prebuilt binary from an external CDN at install time. On 2026-07-12 this failed PR #1622 with `AggregateError [ETIMEDOUT]: connect ETIMEDOUT [IP]` during "Install client deps" — a network flake red-gating a 2-file daemon fix. A gate named "hermetic" should not depend on a third-party CDN per run. (Same class of problem as #1683, fixed for the AC1 gate via committed fixture.)

**Impact.** Any PR can red-gate on CDN weather; operators burn time re-running and diagnosing non-failures.

**Acceptance criteria.**

- [ ] The hermetic-gate job resolves the onnxruntime-node prebuilt without contacting the external CDN on a warm run (dependency/binary cache, vendored artifact, or actions/cache keyed on yarn.lock).
- [ ] A cold-cache run still succeeds (fallback fetch allowed there, or the cache is primed by a scheduled job).

**Files/components.** `.github/workflows/ci.yml` (hermetic gate job), client yarn install path (estimated).
