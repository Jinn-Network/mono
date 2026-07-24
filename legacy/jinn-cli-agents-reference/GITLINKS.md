# Archived gitlink provenance

`legacy/jinn-cli-agents-reference` is a historical source snapshot, not a live
submodule root. Its April 2026 import carried three gitlink index entries whose
paths were not registered in the monorepo root `.gitmodules`. The source
snapshot itself also lacked complete metadata for those entries.

The monorepo therefore records the pointers here instead of treating them as
live root submodules:

| Archived path | Source | Commit |
|---|---|---|
| `olas-operate-middleware` | `https://github.com/Jinn-Network/olas-operate-middleware.git` | `c9316d360c16a2c7a282ae5b33b93780213bc92e` |
| `services/x402-builder` | `https://github.com/oaksprout/x402-builder.git` | `4d11409843da23eed6a5fd091e90aa4d1f14c11a` |
| `tests-next/fixtures/git-template` | Local fixture repository; no remote URL was recorded | `b9ca3bc61eb994e1aab213bac7328c612b4b02d5` |

Use the source URL and pinned commit when historical inspection requires one of
the first two repositories. The test fixture commit was a local Git object in
the source repository and is recorded for provenance only.
