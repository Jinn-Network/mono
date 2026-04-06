---
title: Dispatch Types Reference
purpose: reference
scope: [worker]
last_verified: 2026-01-30
related_code:
  - worker/status/autoDispatch.ts
  - worker/orchestration/jobRunner.ts
  - control-api/server.ts
keywords: [dispatch types, manual, verification, parent, cycle, loop_recovery, auto-dispatch]
when_to_read: "Use when debugging why a job was re-dispatched, understanding workstream flow, or implementing dispatch logic"
---

# Dispatch Types Reference

Quick reference for dispatch types and auto-recovery mechanisms.

---

## Dispatch Types

When viewing workstream dispatch chains, you'll see type annotations like `[verification]` or `[loop_recovery]`. Here's what each means:

### manual

User or script triggered dispatch. Entry point for a workstream.

```
○ Community Hub Template – H3N         ← manual (root)
```

### verification

Job re-dispatched to verify its children's integrated work.

- Triggered when all children complete AND this job had dispatched children
- Job reviews merged code before marking complete
- Up to 3 verification attempts

```
✓ Site Manager [verification]          ← Re-run to verify its children
```

### parent

Job re-dispatched because its children completed (workflow continuation).

- This job had previously dispatched children and delivered with DELEGATING/WAITING
- Now all children reached terminal status, so this job resumes
- Uses Control API to claim dispatch slot (prevents concurrent execution)

```
✓ Content Manager [parent]             ← Resumed after its children finished
```

### cycle

Cyclic job auto-restart after completion.

- Job definition has `cyclic: true`
- Tracks cycle number and previous request ID
- Used for continuous/recurring workstreams

```
○ Daily Monitor [cycle]                ← Cycle #2, #3, etc.
```

### continuation

Job re-dispatched because its children's code is not yet integrated into its branch.

- This job completed but git shows unmerged child branches
- Job resumes to integrate/merge the child work
- Prevents completion until all child code is merged

---

## Recovery Dispatches

Recovery dispatches are **normal system behavior** - they indicate the system detected a problem and automatically recovered.

### loop_recovery

Triggered when agent hits repetition threshold (10+ identical lines in output).

- Agent was stuck in a loop
- Process was killed
- Job auto-redispatched with recovery context

**Context includes:**
- `loopMessage` - Why loop was detected
- `attempt` - Recovery attempt number (1-indexed)
- `previousRequestId` - The terminated run

```
○ Ecosystem Research Specialist [loop_recovery]
```

### timeout_recovery

Triggered when execution exceeds the response timeout.

- Agent took too long
- Process was terminated
- Job auto-redispatched

**Context includes:**
- `attempt` - Recovery attempt number
- `triggeredAt` - When timeout occurred

```
○ Ecosystem Research Specialist [timeout_recovery]
```

---

## Dispatch Cooldowns

To prevent infinite loops, there's a **5-minute cooldown** between same parent/child dispatch pairs.

If a parent-child dispatch pattern repeats within 5 minutes, the system will block it.

---

## Recovery Context in Jobs

When a job is dispatched due to recovery, it receives additional context:

```typescript
additionalContext: {
  loopRecovery?: {
    attempt: number,           // 1-indexed
    loopMessage: string,       // Why terminated
    triggeredAt: string,       // Timestamp
    previousRequestId?: string // Terminated run
  },

  timeoutRecovery?: {
    attempt: number,           // 1-indexed
    triggeredAt: string        // Timestamp
  },

  verificationRequired?: boolean,
  verificationAttempt?: number,

  cycle?: {
    isCycleRun: boolean,
    cycleNumber: number,
    previousCycleRequestId?: string
  }
}
```

---

## Interpreting Dispatch Chains

When analyzing a workstream:

1. **Multiple recovery dispatches** for same job may indicate a persistent issue
2. **Verification dispatches** are normal - parent reviewing children
3. **Parent dispatches** are normal - workflow continuation
4. **Cycle dispatches** are normal for continuous workstreams

**Not a problem:**
```
○ Job A [loop_recovery]        ← System recovered
✓ Job A                        ← Later run succeeded
```

**May need investigation:**
```
○ Job A [loop_recovery]        ← Attempt 1
○ Job A [loop_recovery]        ← Attempt 2
○ Job A [loop_recovery]        ← Attempt 3 - persistent issue?
```

---

## Related Documentation

- Parent-child flow: `docs/context/parent-child-flow.md`
- Job lifecycle: `docs/reference/job-lifecycle.md`
- Auto-dispatch code: `worker/status/autoDispatch.ts`
