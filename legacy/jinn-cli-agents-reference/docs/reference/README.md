---
title: Reference Documentation Index
purpose: reference
scope: [worker, gemini-agent, frontend, deployment]
last_verified: 2026-01-30
related_code:
  - docs/reference/
keywords: [reference, documentation, index, lookup]
when_to_read: "When looking for the right reference document to consult"
---

# Reference Documentation

Concise, LLM-friendly reference docs for common lookup needs.

These docs are designed to be:
- **Quick to scan** - Key information at a glance
- **Accurate** - Single source of truth
- **Referenced by skills** - Used as context for agent skills

---

## Available References

| Doc | Purpose |
|-----|---------|
| [tool-policy.md](./tool-policy.md) | Tool enablement hierarchy, meta-tools, UNAUTHORIZED_TOOLS errors |
| [dispatch-types.md](./dispatch-types.md) | Dispatch types (verification, parent, cycle, recovery) |
| [job-lifecycle.md](./job-lifecycle.md) | Job status values, transitions, inference logic |
| [error-codes.md](./error-codes.md) | Error codes and troubleshooting |
| [artifacts.md](./artifacts.md) | Artifact types, creation, measurement coverage |
| [measurements.md](./measurements.md) | Measurement types, creation, coverage computation |
| [olas-contracts.md](./olas-contracts.md) | OLAS contract addresses and staking config |

---

## Related Documentation

| Directory | Purpose |
|-----------|---------|
| `docs/context/` | Architecture and integration docs |
| `docs/runbooks/` | Procedural how-to guides |
| `docs/guides/` | Conceptual understanding |
| `docs/spec/` | Specifications and standards |

---

## Contributing

When adding new reference docs:
1. Keep them concise (~100-200 lines)
2. Include tables for quick lookup
3. Link to deep-dive docs for more detail
4. Update this README
