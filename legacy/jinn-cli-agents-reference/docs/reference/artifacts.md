---
title: Artifacts Reference
purpose: reference
scope: [gemini-agent, mcp, worker]
last_verified: 2026-01-30
related_code:
  - gemini-agent/mcp/tools/create_artifact.ts
  - gemini-agent/mcp/tools/create_measurement.ts
  - worker/artifacts.ts
  - ponder/ponder.schema.ts
keywords: [artifacts, IPFS, create_artifact, create_measurement, JOB_REPORT, WORKER_TELEMETRY]
when_to_read: "Use when creating artifacts, understanding artifact types, or debugging missing artifacts in workstream"
---

# Artifacts Reference

Quick reference for artifact types, creation, and usage.

---

## What Are Artifacts?

Artifacts are immutable content stored on IPFS and indexed by Ponder. They represent job outputs, telemetry, measurements, and other data.

---

## Artifact Types

| Type | Purpose | Created By |
|------|---------|------------|
| `JOB_REPORT` | Structured summary of job execution | Worker (automatic) |
| `WORKER_TELEMETRY` | Full execution telemetry (tool calls, timing, tokens) | Worker (automatic) |
| `SITUATION` | Job context for memory/recognition | Worker (optional phases) |
| `MEMORY` | Learnings from recognition/reflection | Worker (optional phases) |
| `BRANCH_DATA` | Git branch information | Worker (for coding jobs) |
| `MEASUREMENT` | Invariant measurement result | Agent via `create_measurement` |
| Custom types | Application-specific data | Agent via `create_artifact` |

---

## Automatic vs Manual Artifacts

**Automatic** (Worker creates after job execution):
- `JOB_REPORT` - Always created
- `WORKER_TELEMETRY` - Always created
- `SITUATION` - Created during optional context phases (when enabled)
- `MEMORY` - Created during optional reflection phase (when enabled)
- `BRANCH_DATA` - For coding jobs with git work

**Manual** (Agent creates during execution):
- `MEASUREMENT` - Via `create_measurement` tool
- Custom types - Via `create_artifact` tool

---

## Creating Artifacts

### Measurements

Use `create_measurement` to record invariant assessments:

```typescript
create_measurement({
  invariantId: "GOAL-CONTENT",
  value: 85,
  passed: true,
  evidence: "Found 12 blog posts meeting quality criteria"
})
```

### Custom Artifacts

Use `create_artifact` for other content:

```typescript
create_artifact({
  name: "research-findings",
  content: "...",
  artifactType: "RESEARCH_REPORT"
})
```

---

## Artifact Storage

1. **IPFS** - Content stored on IPFS, returns CID
2. **Ponder** - Indexed for searchability
3. **Delivery** - Referenced in job delivery payload

---

## Searching Artifacts

Use `search_artifacts` to find artifacts:

```typescript
search_artifacts({
  query: "content quality",
  artifactType: "MEASUREMENT",
  workstreamId: "0x123..."
})
```

---

## Artifact in Telemetry

Artifacts created during execution appear in telemetry:

```json
{
  "tool": "create_measurement",
  "success": true,
  "result": {
    "data": {
      "cid": "bafkrei...",
      "artifactType": "MEASUREMENT"
    }
  }
}
```

---

## Measurement Coverage

For jobs with goal invariants:
- **Coverage** = (invariants measured) / (total goal invariants)
- **0% coverage on single job** - Normal for orchestrators that delegate
- **0% coverage on entire workstream** - Problem, no measurements recorded

Check measurement coverage:
```bash
yarn inspect-job-run <request-id>
# Look at "Measurement Coverage" section
```

---

## Viewing Artifacts

**In workstream summary:**
```bash
yarn inspect-workstream <id>
# Shows artifact count
```

**Raw artifact content:**
Access via IPFS gateway: `https://gateway.autonolas.tech/ipfs/<cid>`

---

## Related Documentation

- Writing invariants: `docs/guides/writing-invariants.md`
- Job lifecycle: `docs/reference/job-lifecycle.md`
