---
title: Measurements Reference
purpose: reference
scope: [gemini-agent, worker]
last_verified: 2026-01-30
related_code:
  - gemini-agent/mcp/tools/create_measurement.ts
  - worker/artifacts.ts
  - ponder/src/index.ts
keywords: [measurements, invariants, coverage, floor, ceiling, range, boolean]
when_to_read: "When creating measurements or understanding coverage computation"
---

# Measurements Reference

How agents record invariant assessments and how coverage is computed.

## What Are Measurements?

Measurements record whether invariants are being met. Agents create measurements during job execution using the `create_measurement` tool. Each measurement:
- References an invariant by ID
- Records a value or pass/fail status
- Includes context explaining the assessment
- Is stored on IPFS and indexed by Ponder

## Measurement Types

| Type | Purpose | Pass Condition |
|------|---------|----------------|
| `FLOOR` | Value must be at least X | `measured_value >= min_threshold` |
| `CEILING` | Value must be at most X | `measured_value <= max_threshold` |
| `RANGE` | Value must be within range | `min <= measured_value <= max` |
| `BOOLEAN` | Pass/fail assertion | `passed === true` |

## Creating Measurements

### FLOOR (minimum threshold)

```typescript
create_measurement({
  invariant_type: "FLOOR",
  invariant_id: "GOAL-CONTENT",
  measured_value: 85,
  min_threshold: 70,
  context: "Content quality score from analytics dashboard"
})
```

### CEILING (maximum threshold)

```typescript
create_measurement({
  invariant_type: "CEILING",
  invariant_id: "GOAL-RESPONSE-TIME",
  measured_value: 250,
  max_threshold: 500,
  context: "Average API response time in ms"
})
```

### RANGE (min and max)

```typescript
create_measurement({
  invariant_type: "RANGE",
  invariant_id: "GOAL-PRICE",
  measured_value: 45,
  min_threshold: 30,
  max_threshold: 60,
  context: "Current token price within target range"
})
```

### BOOLEAN (pass/fail)

```typescript
create_measurement({
  invariant_type: "BOOLEAN",
  invariant_id: "GOAL-SITE-UP",
  passed: true,
  context: "Site returned 200 OK on health check"
})
```

## Invariant ID Conventions

| Prefix | Source | Purpose |
|--------|--------|---------|
| `GOAL-` | Blueprint templates | Mission-critical goals |
| `JOB-` | Job-specific | Task-level objectives |
| `OUT-` | Output invariants | Deliverable requirements |
| `STRAT-` | StrategyInvariantProvider | Strategic constraints |
| `SYS-` | system-blueprint.json | System-level rules |
| `COORD-` | CoordinationInvariantProvider | Multi-job coordination |
| `QUAL-` | QualityInvariantProvider | Quality standards |

**Mission invariants** (tracked for coverage): `GOAL-`, `JOB-`, `OUT-`, `STRAT-`

## Storage Flow

```
Agent calls create_measurement()
    ↓
Payload uploaded to IPFS (returns CID)
    ↓
CID included in telemetry toolCalls[]
    ↓
Worker extracts artifacts from telemetry
    ↓
Artifacts included in delivery payload
    ↓
Ponder indexes as MEASUREMENT artifact
    ↓
Available via GraphQL queries
```

**Ponder query for measurements:**
```graphql
query GetMeasurements($workstreamId: String!) {
  artifacts(
    where: { sourceRequestId: $workstreamId, topic: "MEASUREMENT" }
    orderBy: "blockTimestamp"
    orderDirection: "desc"
  ) {
    items {
      id
      contentPreview
      blockTimestamp
    }
  }
}
```

## Coverage Computation

After job execution, the worker computes measurement coverage:

```typescript
interface MeasurementCoverage {
  totalMissionInvariants: number;  // Count of GOAL-/JOB-/OUT-/STRAT- invariants
  measuredCount: number;           // How many were measured
  unmeasuredIds: string[];         // Which ones weren't measured
  measuredIds: string[];           // Which ones were measured
  coveragePercent: number;         // measuredCount / total * 100
  passingCount: number;            // Measurements with passed=true
  failingCount: number;            // Measurements with passed=false
  delegated: boolean;              // True if job status is DELEGATING
}
```

**Coverage rules:**
- Only mission invariants count (GOAL-, JOB-, OUT-, STRAT- prefixes)
- System (SYS-) and coordination (COORD-) invariants are excluded
- 0% coverage is normal for orchestrator jobs that delegate
- 0% coverage across entire workstream indicates a problem

## Viewing Measurements

**CLI inspection:**
```bash
yarn inspect-job-run <request-id>
# Shows "Measurement Coverage" section
```

**Explorer UI:**
- InvariantCard shows gauge visualization with health status
- Status colors: healthy (green), warning (yellow), critical (red), unknown (gray)
- Shows last measurement timestamp ("2 hours ago")

## Related Documentation

- Artifacts: `docs/reference/artifacts.md`
- Writing invariants: `docs/guides/writing-invariants.md`
- Blueprint structure: `docs/guides/blueprints_and_templates.md`
