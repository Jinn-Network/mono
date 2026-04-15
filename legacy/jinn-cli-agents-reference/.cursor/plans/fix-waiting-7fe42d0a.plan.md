---
name: Fix WAITING Status Cycles with Live Ponder Queries
overview: ""
todos:
  - id: 71e2491b-ef4c-42b1-872b-1110cf2054f6
    content: Add queryRequestsByJobDefinition and getAllChildrenForJobDefinition
    status: pending
  - id: 9d6f434c-d660-42bf-9aae-b9dec248497f
    content: Add comprehensive STATUS_INFERENCE logging
    status: pending
  - id: c28fa4a4-719f-43be-a026-86652805f620
    content: Implement live Ponder query path with comparison
    status: pending
  - id: 863b029e-93ba-43c9-8ec8-edfa729eb00c
    content: Create and run test-waiting-fix.sh
    status: pending
  - id: b3712f69-ffad-4164-9af2-4ba980df8a21
    content: Update docs with actual test findings
    status: pending
---

# Fix WAITING Status Cycles with Live Ponder Queries

## Context & Background

### The Problem

Jobs in the workstream remain in WAITING status across multiple executions instead of transitioning to COMPLETED. Investigation shows:

1. **Pattern:** Parent jobs (with children) stay WAITING; leaf jobs (no children) complete successfully
2. **Example:** "Trade Idea Generation & Synthesis" (job ID `23783b40-2ba3-4a21-a998-3ce233ef497c`) executed 4 times, all showing WAITING status in Ponder despite agent claiming completion
3. **Hypothesis:** Status inference uses frozen hierarchy snapshot from IPFS metadata, which may be stale when job executes

### Current Architecture

**Status Inference Flow:**

1. Worker executes job via [`worker/orchestration/jobRunner.ts`](worker/orchestration/jobRunner.ts)
2. Calls `inferJobStatus()` in [`worker/status/inferStatus.ts`](worker/status/inferStatus.ts) 
3. Currently checks `metadata.additionalContext.hierarchy` (frozen snapshot from dispatch time)
4. Uses `extractChildrenFromHierarchy()` to classify children as active/completed/failed
5. Returns WAITING if any children show as "active" in hierarchy

**The Issue:**

- Hierarchy is embedded in IPFS metadata at dispatch time
- Between dispatch (T0) and execution (T2), children may complete (T1)
- Worker uses stale hierarchy showing children as "active" when Ponder shows them as "completed"
- No live query to Ponder during status inference

### Goal

Replace hierarchy-based inference with live Ponder queries, add logging to prove/disprove the staleness theory, and document actual findings.

---

## Technical Implementation Details

### Key Files

1. [`worker/status/inferStatus.ts`](worker/status/inferStatus.ts) - Status inference logic (141 lines)
2. [`worker/status/childJobs.ts`](worker/status/childJobs.ts) - Child job queries (87 lines)
3. [`worker/types.ts`](worker/types.ts) - Type definitions
4. [`worker/mech_worker.ts`](worker/mech_worker.ts) - Main worker loop

### Current Code Structure

**`inferJobStatus()` logic:**

```typescript
// Line 52-141 in worker/status/inferStatus.ts
export async function inferJobStatus(params: {
  requestId: string;
  error: any;
  telemetry: any;
  delegatedThisRun?: boolean;
  metadata?: IpfsMetadata;
}): Promise<FinalStatus>
```

**Decision flow:**

1. If error → FAILED
2. If dispatched children this run → DELEGATING
3. **If hierarchy exists** → Use `extractChildrenFromHierarchy()` (line 85-117)
4. Fallback: Use per-request child query (line 120-140)

### Data Types

```typescript
// From worker/types.ts
interface HierarchyJob {
  id?: string;
  name?: string;
  level?: number;
  status?: 'completed' | 'active' | 'failed' | 'delivered' | 'success' | 'error';
  jobId?: string;
  sourceJobDefinitionId?: string;
  // ... more fields
}

interface IpfsMetadata {
  jobDefinitionId?: string;
  additionalContext?: {
    hierarchy?: HierarchyJob[];
    // ... more fields
  };
  // ... more fields
}
```

### Ponder GraphQL Schema

**Queries used:**

```graphql
# Get children of a single request
query GetChildJobs($sourceRequestId: String!) {
  requests(where: { sourceRequestId: $sourceRequestId }) {
    items {
      id
      delivered
    }
  }
}

# Get all requests for a job definition (NEW - to implement)
query GetRequestsForJobDef($jobDefId: String!) {
  requests(where: { jobDefinitionId: $jobDefId }) {
    items {
      id
      blockTimestamp
    }
  }
}
```

**Ponder Endpoint:**

- Production: `https://ponder-production-6d16.up.railway.app/graphql`
- Retrieved via `getPonderGraphqlUrl()` from [`gemini-agent/mcp/tools/shared/env.js`](gemini-agent/mcp/tools/shared/env.js)

### Logging System

**Use `workerLogger` from [`logging/index.js`](logging/index.js):**

```typescript
import { workerLogger } from '../../logging/index.js';

workerLogger.info({ key: 'value' }, 'Message');
workerLogger.warn({ error }, 'Warning');
```

---

## Phase 1: Add Helper Functions

### File: [`worker/status/childJobs.ts`](worker/status/childJobs.ts)

**Location:** After existing `getChildJobStatus()` function (line 87)

**Add these two functions:**

#### 1.1 `queryRequestsByJobDefinition()`

```typescript
/**
 * Query all requests for a given job definition from Ponder
 * Used to find all runs of a job across its lifetime
 */
export async function queryRequestsByJobDefinition(
  jobDefinitionId: string
): Promise<Array<{ id: string; blockTimestamp: string }>> {
  const maxAttempts = 3;
  const baseDelayMs = 300;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await graphQLRequest<{ 
        requests: { items: Array<{ id: string; blockTimestamp: string }> } 
      }>({
        url: PONDER_GRAPHQL_URL,
        query: `
          query GetRequestsForJobDef($jobDefId: String!) {
            requests(
              where: { jobDefinitionId: $jobDefId }
              orderBy: "blockTimestamp"
              orderDirection: "asc"
              limit: 100
            ) {
              items {
                id
                blockTimestamp
              }
            }
          }
        `,
        variables: { jobDefId: jobDefinitionId },
        context: { operation: 'queryRequestsByJobDefinition', jobDefinitionId }
      });

      return data?.requests?.items || [];
    } catch (error: any) {
      if (attempt === maxAttempts) {
        workerLogger.error({
          jobDefinitionId,
          error: serializeError(error)
        }, 'Failed to query requests for job definition');
        return [];
      }
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt));
    }
  }

  return [];
}
```

#### 1.2 `getAllChildrenForJobDefinition()`

```typescript
/**
 * Get all children across all runs of a job definition
 * This queries Ponder for fresh data, not relying on hierarchy snapshots
 */
export interface JobLevelChildStatusResult {
  allChildren: Array<{ id: string; delivered: boolean; requestId: string }>;
  totalChildren: number;
  undeliveredChildren: number;
  queryDuration_ms: number;
}

export async function getAllChildrenForJobDefinition(
  jobDefinitionId: string
): Promise<JobLevelChildStatusResult> {
  const queryStart = Date.now();
  
  // Step 1: Get all requests for this job definition
  const allRequests = await queryRequestsByJobDefinition(jobDefinitionId);
  
  workerLogger.debug({
    jobDefinitionId,
    requestCount: allRequests.length
  }, 'Querying children for all requests of job definition');
  
  // Step 2: Get children for each request (parallel queries)
  const childrenByRequest = await Promise.all(
    allRequests.map(req => getChildJobStatus(req.id))
  );
  
  // Step 3: Flatten and deduplicate by child request ID
  const allChildrenMap = new Map<string, { id: string; delivered: boolean; requestId: string }>();
  
  for (let i = 0; i < allRequests.length; i++) {
    const parentRequestId = allRequests[i].id;
    const { childJobs } = childrenByRequest[i];
    
    for (const child of childJobs) {
      // Only store first occurrence of each child
      if (!allChildrenMap.has(child.id)) {
        allChildrenMap.set(child.id, {
          id: child.id,
          delivered: child.delivered,
          requestId: parentRequestId
        });
      }
    }
  }
  
  const allChildren = Array.from(allChildrenMap.values());
  const undeliveredChildren = allChildren.filter(c => !c.delivered).length;
  
  workerLogger.debug({
    jobDefinitionId,
    totalChildren: allChildren.length,
    undeliveredChildren,
    queryDuration_ms: Date.now() - queryStart
  }, 'Aggregated all children for job definition');
  
  return {
    allChildren,
    totalChildren: allChildren.length,
    undeliveredChildren,
    queryDuration_ms: Date.now() - queryStart
  };
}
```

**Import needed:**

```typescript
import { serializeError } from '../logging/errors.js';
```

---

## Phase 2: Add Comprehensive Logging

### File: [`worker/status/inferStatus.ts`](worker/status/inferStatus.ts)

**Location:** Inside the `if (hierarchy && jobDefinitionId)` block (line 85)

**Add logging BEFORE existing logic:**

```typescript
if (hierarchy && jobDefinitionId) {
  // ============================================================
  // NEW: Log hierarchy data we're about to use
  // ============================================================
  workerLogger.info({
    requestId,
    jobDefinitionId,
    hierarchyPresent: true,
    hierarchyLength: hierarchy.length,
    hierarchyJobIds: hierarchy.map(h => h.jobId || h.id).filter(Boolean)
  }, '[STATUS_INFERENCE] Hierarchy data available in metadata');
  
  // Job-centric view: check all children across all runs of this job
  const children = extractChildrenFromHierarchy(hierarchy, jobDefinitionId);
  
  // ============================================================
  // NEW: Log what extractChildrenFromHierarchy found
  // ============================================================
  workerLogger.info({
    requestId,
    jobDefinitionId,
    activeChildren: children.active.map(c => ({
      id: c.id || c.jobId,
      name: c.name || c.jobName,
      status: c.status,
      level: c.level
    })),
    activeChildrenCount: children.active.length,
    completedChildrenCount: children.completed.length,
    failedChildrenCount: children.failed.length
  }, '[STATUS_INFERENCE] Extracted children from hierarchy (snapshot data)');
  
  // ... existing logic continues below
}
```

---

## Phase 3: Implement Live Query Path

### File: [`worker/status/inferStatus.ts`](worker/status/inferStatus.ts)

**Location:** Replace the entire section from line 81-118

**Add import at top:**

```typescript
import { getAllChildrenForJobDefinition, type JobLevelChildStatusResult } from './childJobs.js';
import { serializeError } from '../logging/errors.js';
```

**Replace lines 81-118 with:**

```typescript
// 3. Check for undelivered children - ALWAYS query live from Ponder first
const hierarchy = metadata?.additionalContext?.hierarchy;
const jobDefinitionId = metadata?.jobDefinitionId;

// ============================================================
// NEW: Query live child status from Ponder (single source of truth)
// ============================================================
let liveChildStatus: JobLevelChildStatusResult | null = null;
if (jobDefinitionId) {
  try {
    liveChildStatus = await getAllChildrenForJobDefinition(jobDefinitionId);
    
    workerLogger.info({
      requestId,
      jobDefinitionId,
      totalChildren: liveChildStatus.totalChildren,
      undeliveredChildren: liveChildStatus.undeliveredChildren,
      queryDuration_ms: liveChildStatus.queryDuration_ms,
      allChildrenDetails: liveChildStatus.allChildren.map(c => ({
        id: c.id,
        delivered: c.delivered,
        fromRequestId: c.requestId
      }))
    }, '[STATUS_INFERENCE] Live Ponder query for all children across all runs');
  } catch (error) {
    workerLogger.warn({
      requestId,
      jobDefinitionId,
      error: serializeError(error)
    }, '[STATUS_INFERENCE] Failed to query live child status, will use hierarchy fallback');
  }
}

if (hierarchy && jobDefinitionId) {
  // ============================================================
  // Logging from Phase 2 goes here
  // ============================================================
  workerLogger.info({
    requestId,
    jobDefinitionId,
    hierarchyPresent: true,
    hierarchyLength: hierarchy.length,
    hierarchyJobIds: hierarchy.map(h => h.jobId || h.id).filter(Boolean)
  }, '[STATUS_INFERENCE] Hierarchy data available in metadata');
  
  const children = extractChildrenFromHierarchy(hierarchy, jobDefinitionId);
  
  workerLogger.info({
    requestId,
    jobDefinitionId,
    activeChildren: children.active.map(c => ({
      id: c.id || c.jobId,
      name: c.name || c.jobName,
      status: c.status,
      level: c.level
    })),
    activeChildrenCount: children.active.length,
    completedChildrenCount: children.completed.length,
    failedChildrenCount: children.failed.length
  }, '[STATUS_INFERENCE] Extracted children from hierarchy (snapshot data)');
  
  // ============================================================
  // NEW: Compare hierarchy vs live data and make decision
  // ============================================================
  if (liveChildStatus) {
    workerLogger.info({
      requestId,
      jobDefinitionId,
      comparison: {
        hierarchyActive: children.active.length,
        hierarchyCompleted: children.completed.length,
        hierarchyFailed: children.failed.length,
        liveTotal: liveChildStatus.totalChildren,
        liveUndelivered: liveChildStatus.undeliveredChildren,
        liveDelivered: liveChildStatus.totalChildren - liveChildStatus.undeliveredChildren,
        discrepancy: children.active.length !== liveChildStatus.undeliveredChildren
      }
    }, '[STATUS_INFERENCE] Comparison: hierarchy snapshot vs live Ponder query');
    
    // ============================================================
    // DECISION: Always use live data when available
    // ============================================================
    if (liveChildStatus.undeliveredChildren > 0) {
      workerLogger.info({
        requestId,
        jobDefinitionId,
        decision: 'WAITING',
        reason: 'live_query_shows_undelivered_children',
        undeliveredCount: liveChildStatus.undeliveredChildren,
        undeliveredIds: liveChildStatus.allChildren
          .filter(c => !c.delivered)
          .map(c => c.id)
      }, '[STATUS_INFERENCE] DECISION: Using live query result → WAITING');
      
      return {
        status: 'WAITING',
        message: `Waiting for ${liveChildStatus.undeliveredChildren} child job(s) to deliver (live query)`
      };
    }
    
    workerLogger.info({
      requestId,
      jobDefinitionId,
      decision: 'COMPLETED',
      reason: 'live_query_shows_all_delivered',
      totalChildren: liveChildStatus.totalChildren
    }, '[STATUS_INFERENCE] DECISION: Using live query result → COMPLETED');
    
    return {
      status: 'COMPLETED',
      message: liveChildStatus.totalChildren > 0
        ? `All ${liveChildStatus.totalChildren} child job(s) delivered (live query)`
        : 'Job completed direct work'
    };
  }
  
  // ============================================================
  // Fallback: Use hierarchy if live query failed
  // ============================================================
  workerLogger.warn({
    requestId,
    jobDefinitionId,
    reason: 'live_query_failed_using_hierarchy'
  }, '[STATUS_INFERENCE] Falling back to hierarchy snapshot');
  
  // Block completion if there are failed children (require remediation)
  if (children.failed.length > 0) {
    const failedJobNames = children.failed
      .map(j => j.jobName || j.name || 'unknown')
      .slice(0, 3)
      .join(', ');
    return {
      status: 'WAITING',
      message: `${children.failed.length} child job(s) failed and need remediation: ${failedJobNames}`
    };
  }

  // Block completion if there are active children
  if (children.active.length > 0) {
    return {
      status: 'WAITING',
      message: `Waiting for ${children.active.length} active child job(s) to complete`
    };
  }

  // All children completed or none exist
  const completionReason = children.completed.length > 0
    ? `All ${children.completed.length} child job(s) completed`
    : 'Job completed direct work';

  return {
    status: 'COMPLETED',
    message: completionReason
  };
}

// ... rest of function unchanged (lines 119-141)
```

---

## Phase 4: Create Test Script

### File: [`scripts/test-waiting-fix.sh`](scripts/test-waiting-fix.sh)

**Create new file:**

```bash
#!/bin/bash
set -e

echo "========================================="
echo "Testing WAITING Status Fix"
echo "========================================="
echo ""

# Test target (job that's currently WAITING)
JOB_ID="23783b40-2ba3-4a21-a998-3ce233ef497c"
JOB_NAME="Trade Idea Generation & Synthesis"
WORKSTREAM_ID="0x0d2dcd01a6c0f62dafbc93bc314bd7b766296e8b6cbebf5ae62815ecb453594c"
PONDER_URL="https://ponder-production-6d16.up.railway.app/graphql"

echo "Test Configuration:"
echo "  Job ID: $JOB_ID"
echo "  Job Name: $JOB_NAME"
echo "  Workstream: $WORKSTREAM_ID"
echo ""

# ============================================================
# Step 1: Check BEFORE state
# ============================================================
echo "Step 1: Checking current job status in Ponder..."
echo "----------------------------------------"

node -e "
const https = require('https');
https.request({
  hostname: 'jinn-gemini-production.up.railway.app',
  path: '/graphql',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    try {
      const data = JSON.parse(body);
      const job = data?.data?.jobDefinition;
      if (job) {
        console.log('  Job Name:', job.name);
        console.log('  Current Status:', job.lastStatus);
        console.log('  Source Job ID:', job.sourceJobDefinitionId || 'null (root job)');
      } else {
        console.log('  ERROR: Job not found');
      }
    } catch (e) {
      console.log('  ERROR:', e.message);
    }
  });
}).end(JSON.stringify({ 
  query: 'query { jobDefinition(id: \"$JOB_ID\") { id name lastStatus sourceJobDefinitionId } }' 
}));
" 2>&1

echo ""

# ============================================================
# Step 2: Run worker on workstream
# ============================================================
echo "Step 2: Running worker with --single on workstream..."
echo "----------------------------------------"
echo "  This will process the next available job in the workstream"
echo "  Look for [STATUS_INFERENCE] markers in the logs"
echo ""

# Run worker and capture logs
yarn dev:mech --workstream=$WORKSTREAM_ID --single 2>&1 | tee /tmp/waiting-fix-test.log

echo ""

# ============================================================
# Step 3: Extract and analyze logs
# ============================================================
echo "Step 3: Analyzing logs for status inference decisions..."
echo "----------------------------------------"

if grep -q "\[STATUS_INFERENCE\]" /tmp/waiting-fix-test.log; then
  echo "✓ Found status inference logs"
  echo ""
  echo "Key log entries:"
  grep "\[STATUS_INFERENCE\]" /tmp/waiting-fix-test.log | while read -r line; do
    echo "  $line"
  done
else
  echo "✗ No status inference logs found"
  echo "  This might mean:"
  echo "  - No job was processed (check if workstream has pending jobs)"
  echo "  - Logging not working as expected"
fi

echo ""

# ============================================================
# Step 4: Check AFTER state
# ============================================================
echo "Step 4: Checking updated status in Ponder..."
echo "----------------------------------------"

sleep 5  # Wait for Ponder to index the delivery

node -e "
const https = require('https');
https.request({
  hostname: 'jinn-gemini-production.up.railway.app',
  path: '/graphql',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    try {
      const data = JSON.parse(body);
      const job = data?.data?.jobDefinition;
      if (job) {
        console.log('  Job Name:', job.name);
        console.log('  Updated Status:', job.lastStatus);
      } else {
        console.log('  ERROR: Job not found');
      }
    } catch (e) {
      console.log('  ERROR:', e.message);
    }
  });
}).end(JSON.stringify({ 
  query: 'query { jobDefinition(id: \"$JOB_ID\") { id name lastStatus } }' 
}));
" 2>&1

echo ""
echo "========================================="
echo "Test Complete"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Review logs at: /tmp/waiting-fix-test.log"
echo "  2. Check for hierarchy vs live query comparison"
echo "  3. Verify if status transitioned (WAITING → COMPLETED)"
echo "  4. Document findings in WAITING_CYCLES_ANALYSIS.md"
```

**Make executable:**

```bash
chmod +x scripts/test-waiting-fix.sh
```

---

## Phase 5: Document Findings

### File: [`WAITING_CYCLES_ANALYSIS.md`](WAITING_CYCLES_ANALYSIS.md)

**Add this section at the end (after "What We SHOULD Do"):**

```markdown
---

## Test Results (Actual Data)

**Test Date:** [FILL IN AFTER RUNNING]  
**Job Tested:** Trade Idea Generation & Synthesis  
**Job ID:** 23783b40-2ba3-4a21-a998-3ce233ef497c  
**Workstream:** 0x0d2dcd01a6c0f62dafbc93bc314bd7b766296e8b6cbebf5ae62815ecb453594c

### Before Fix

- **Status in Ponder:** [FILL IN]
- **Last Execution:** [FILL IN timestamp]

### During Test Execution

**Hierarchy Data (from frozen snapshot):**
- Present: [yes/no]
- Active children count: [FILL IN]
- Completed children count: [FILL IN]
- Failed children count: [FILL IN]
- Active children IDs: [FILL IN]

**Live Ponder Query (fresh data):**
- Total children found: [FILL IN]
- Undelivered children count: [FILL IN]
- Delivered children count: [FILL IN]
- Query duration: [FILL IN] ms
- Undelivered IDs: [FILL IN]

**Comparison Analysis:**
- Hierarchy showed: [X] active children
- Live query showed: [Y] undelivered children
- **Discrepancy:** [yes/no - FILL IN]
- **Staleness confirmed:** [yes/no - FILL IN]

**Status Decision:**
- Method used: [live_query / hierarchy_fallback]
- Final status: [WAITING / COMPLETED]
- Reasoning: [from logs]
- Message: [from delivery]

### After Fix

- **Status in Ponder:** [WAITING / COMPLETED]
- **Did it transition:** [yes/no]
- **If no transition:** [reason from logs]

### Root Cause Conclusion

[Based on actual comparison data above:]

**Confirmed:** [staleness issue / different issue]

**Evidence:**
- [List key evidence from test]
- [E.g., "Hierarchy showed 2 active but live query showed 0 undelivered"]

**Next Actions:**
- [If fix worked: document success]
- [If fix didn't work: investigate other causes]
```

### File: [`AGENT_README_TEST.md`](AGENT_README_TEST.md)

**Update Gotcha #12 (around line 460) with actual findings:**

```markdown
### 12. Stale Hierarchy in Status Inference (2025-12-01) [UPDATED AFTER TESTING]

**Issue:** Jobs cycle through WAITING status multiple times instead of COMPLETED after children finish

**Root Cause:** [FILL IN AFTER TESTING: "Confirmed stale hierarchy" OR "Different issue identified: ..."]

**Evidence from Testing ([date]):**
- Test job: Trade Idea Generation & Synthesis (23783b40-2ba3-4a21-a998-3ce233ef497c)
- Hierarchy snapshot showed: [X] active children
- Live Ponder query showed: [Y] undelivered children
- Discrepancy: [yes/no with details]
- Status transition: [WAITING→COMPLETED or remained WAITING]

**Solution Implemented:**
Query live child delivery status from Ponder during `inferJobStatus()` instead of trusting hierarchy snapshot. Hierarchy still used for agent context but NOT for completion logic.

**Code Changes:**
- [`worker/status/childJobs.ts`](worker/status/childJobs.ts): Added `getAllChildrenForJobDefinition()` to query fresh data
- [`worker/status/inferStatus.ts`](worker/status/inferStatus.ts): Live query path with hierarchy comparison logging
- Added `[STATUS_INFERENCE]` logging markers for debugging

**Testing:**
- Test script: [`scripts/test-waiting-fix.sh`](scripts/test-waiting-fix.sh)
- Full analysis: [`WAITING_CYCLES_ANALYSIS.md`](WAITING_CYCLES_ANALYSIS.md)

**Prevention:**
Never rely on `hierarchy.status` for terminal state decisions. Always query Ponder directly for child delivery status.
```

---

## Testing Instructions

### Prerequisites

1. Ensure worker environment is configured:
   ```bash
   # Required env vars
   SUPABASE_URL=https://clnwgxgvmnrkwqdblqgf.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<key>
   PONDER_GRAPHQL_URL=https://ponder-production-6d16.up.railway.app/graphql
   ```

2. Verify job is still in WAITING:
   ```bash
   yarn inspect-job 23783b40-2ba3-4a21-a998-3ce233ef497c
   ```


### Run Test

```bash
# Make script executable
chmod +x scripts/test-waiting-fix.sh

# Run test
./scripts/test-waiting-fix.sh

# Review detailed logs
less /tmp/waiting-fix-test.log

# Search for specific log markers
grep "\[STATUS_INFERENCE\]" /tmp/waiting-fix-test.log
```

### What to Look For

1. **Hierarchy data:** Check if present and what it contains
2. **Live query results:** Compare with hierarchy
3. **Comparison logs:** Look for discrepancies
4. **Decision reasoning:** Which path was taken (live vs fallback)
5. **Final status:** Did it change in Ponder?

---

## Success Criteria

### Code Quality

- ✓ TypeScript compiles without errors
- ✓ All new functions have proper error handling
- ✓ Logging uses consistent `[STATUS_INFERENCE]` markers
- ✓ Imports are correct and minimal

### Test Execution

- ✓ Script runs to completion without crashes
- ✓ Logs show hierarchy data (if present)
- ✓ Logs show live query results
- ✓ Logs show comparison between hierarchy and live data
- ✓ Decision reasoning is clearly logged
- ✓ Job status in Ponder is checked before/after

### Documentation

- ✓ Test results captured with actual data (not placeholders)
- ✓ Root cause confirmed or disproven with evidence
- ✓ AGENT_README gotcha updated with facts
- ✓ Speculation files marked appropriately

---

## Implementation Checklist

- [ ] **Phase 1:** Add helper functions to `childJobs.ts`
                                - [ ] `queryRequestsByJobDefinition()`
                                - [ ] `getAllChildrenForJobDefinition()`
                                - [ ] Add imports and types

- [ ] **Phase 2:** Add logging to `inferStatus.ts`
                                - [ ] Log hierarchy presence and content
                                - [ ] Log extracted children counts
                                - [ ] Use `[STATUS_INFERENCE]` markers

- [ ] **Phase 3:** Implement live query path
                                - [ ] Add `getAllChildrenForJobDefinition` import
                                - [ ] Query live status before hierarchy check
                                - [ ] Add comparison logging
                                - [ ] Implement decision logic (prefer live data)
                                - [ ] Keep hierarchy as fallback

- [ ] **Phase 4:** Create and run test
                                - [ ] Create `test-waiting-fix.sh`
                                - [ ] Make executable
                                - [ ] Run test and capture logs
                                - [ ] Verify status before/after

- [ ] **Phase 5:** Document findings
                                - [ ] Fill in test results in `WAITING_CYCLES_ANALYSIS.md`
                                - [ ] Update AGENT_README gotcha #12
                                - [ ] Rename speculation files if needed

---

## Troubleshooting

### If test fails with "no jobs processed"

Check if workstream has pending jobs:

```bash
yarn inspect-workstream 0x0d2dcd01a6c0f62dafbc93bc314bd7b766296e8b6cbebf5ae62815ecb453594c
```

### If logs don't show `[STATUS_INFERENCE]` markers

1. Check TypeScript compilation: `yarn build`
2. Verify logging was added correctly
3. Check if job had children (leaf jobs skip this path)

### If status doesn't change

1. Check delivery success in logs
2. Verify Ponder indexing (wait 30s and re-check)
3. Review decision reasoning in logs - may legitimately be WAITING

---

## Additional Context

### Why This Approach

1. **Live data is truth:** Ponder is the canonical source for child delivery status
2. **Hierarchy still useful:** Kept for agent context and planning, just not for terminal decisions
3. **Logging proves hypothesis:** Comparison logs will show if staleness is real
4. **Graceful degradation:** Falls back to hierarchy if live query fails
5. **Minimal disruption:** Only changes status inference, not dispatch or execution logic

### Related Issues

- See `SUMMARY_WORKSTREAM_FIXES.md` for context on workstream analysis
- See `WAITING_CYCLES_ANALYSIS.md` for full investigation history
- Original hypothesis in `WAITING_CYCLES_ROOT_CAUSE.md` (pre-test speculation)