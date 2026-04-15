---
title: "Venture-Workstream Separation: Why Governance Lives on the Venture"
purpose: architecture-decision
scope: [ventures, workstreams, measurement, scheduling]
date: 2026-02-09
authors: [oak, claude]
status: proposal
keywords: [venture, workstream, dispatch-schedule, invariants, measurement, olas-registry]
---

# Venture-Workstream Separation

## Problem Statement

The current system conflates two fundamentally different concepts:

- **Ventures** — persistent entities with goals, governance, and continuous operation
- **Workstreams** — finite units of work that should have a start, a scope, and an end

Today, a venture is a Supabase row with a `root_workstream_id` that points to a single cyclic workstream. That workstream runs forever, self-governs (agents measure their own work), self-schedules (cycles fire immediately on completion), and accumulates unbounded job trees. The venture's invariants are baked into the workstream's IPFS payload at dispatch time — the worker never reads the Supabase venture definition.

This creates several concrete problems:

1. **Stale invariants.** Updating a venture's blueprint in Supabase has no effect until you manually redispatch into the workstream. The IPFS payload is the real source of truth.
2. **No measurement independence.** The same agent that writes a blog post decides whether the blog post is good enough. There's no separation of judge and executor.
3. **No scheduling control.** Cycles fire as fast as possible. There's no "write content weekly" or "measure analytics daily" — just an undifferentiated loop.
4. **Unbounded growth.** The Long Run workstream accumulated 582 jobs over 20 days. AMP2 hit 123 stalled jobs in a single day from uncontrolled delegation fan-out.
5. **34% orchestration overhead.** A third of all on-chain transactions in active workstreams are management/coordinator jobs that produce no artifacts.

## Evidence

Analysis of live workstream data (Feb 9, 2026):

| Workstream | Total Jobs | Delivery Rate | Days Active | Pattern |
|-----------|-----------|--------------|-------------|---------|
| The Long Run (G3A) | 582 | 98% | 20 | 6+ cycles, 5 levels deep |
| The Lamp (M05) | 97 | 96% | 18 | Steady but sparse |
| Growth Agency (TC2) | 336 | 88% | 4 | 6 levels deep, aggressive |
| Blog Growth AMP | 164 | 25% | 1 | 123 stalled, abandoned |
| Service Replicator | 27 | 100% | 14 | Shallow (depth 2), focused |

The best performer (Service Replicator) is the simplest — shallow tree, finite tasks, 100% delivery. The worst performer (AMP) tried to be the most cyclic and hierarchical.

Measurement density across all workstreams is ~2-3%. The Long Run has 14 measurement artifacts across 582 jobs. The measurement system exists in code but is barely used in practice, and when used, agents self-report values with no independent verification.

## Two Proposals Considered

### Option A: Dispatch Schedule on the Workstream

Keep ventures and workstreams unified. Put the dispatch schedule on the root job's IPFS payload. The worker reads the schedule from the root job, checks what's due, and dispatches children accordingly.

```
Root Job (= the venture)
  ├── Invariants
  ├── Dispatch Schedule
  │   ├── content: every 7 days
  │   ├── measurement: every 1 day
  │   └── review: every 30 days
  └── Worker reads schedule, dispatches children
```

**Problems with this approach:**

- The schedule propagates down the work tree. Child jobs inherit scheduling context they have no business knowing about — a Content Writer doesn't need to know that measurements happen on Fridays.
- Scheduling becomes entangled with agent decision-making. The workstream graph is inherently non-deterministic (agents decide what to dispatch), so deterministic scheduling inside it creates tension.
- Updating the schedule requires redispatching the root job — you're modifying a running execution to change governance.
- The workstream becomes responsible for its own governance. The judge and the executor are the same entity.

### Option B: Governance on the Venture, Execution on the Workstream (Recommended)

Separate the venture (governance) from the workstream (execution). The venture is a static, governed entity — ideally on-chain as an OLAS service NFT. The worker watches the venture config and dispatches finite workstreams on schedule.

```
Venture (on-chain, governed by multisig/DAO)
  ├── Blueprint (invariants — what success looks like)
  ├── Dispatch Schedule (when to do what)
  ├── Config (tool policy, templates, parameters)
  └── Owner (multisig/DAO — can update config via on-chain tx)

Worker (daemon, time-aware)
  ├── Watches venture config (reads on-chain + IPFS metadata)
  ├── Checks clock against dispatch schedule
  ├── Dispatches finite workstreams via marketplace
  └── Can cancel stale/stuck jobs

Workstream (finite, scoped)
  ├── Clear objective: "Write 2 blog posts about longevity"
  ├── References venture invariants (doesn't contain them)
  ├── Produces artifacts
  └── Ends
```

## Why Option B

### 1. Clean separation of concerns

The venture declares intent: what to achieve, when to act, what success looks like. The workstream executes: do the thing, produce output, finish. The worker bridges the two: read the config, check the clock, dispatch work. Each concept has one job.

### 2. Real-time grounding

The worker operates on wall-clock time, not "whenever the last cycle finished." It reads the venture config, checks "last content dispatch was 6 days ago, schedule says 7d, not yet due" — that's deterministic. The cyclic model makes timing a function of agent execution speed, worker uptime, and job queue depth.

### 3. Independent measurement

The venture config says "measure invariants every 3 days." The worker dispatches a measurement workstream that's completely separate from the content workstream. The measurement job reads the blog, checks analytics, calls `blog_get_stats`, and reports independently of whoever wrote the content. The judge and the executor are different workstreams dispatched at different times.

### 4. Clean updates

Changing the schedule or invariants is an on-chain config update (or IPFS metadata update referenced by the on-chain record). The worker picks it up on its next poll. No redispatching, no injecting new payloads into running workstreams. The next workstream dispatched simply uses the updated config.

### 5. On-chain verifiability

The venture config is content-addressed (IPFS) and referenced on-chain. Every config change is an auditable on-chain transaction. Governance decisions (changing invariants, adjusting schedule, pausing the venture) are transparent and attributable. A Supabase row is mutable and opaque.

### 6. Natural fit with OLAS

The OLAS service registry already has:
- Service NFTs with ownership (transferable to multisig/DAO)
- Content-addressed metadata (IPFS hash stored on-chain)
- Component and agent registration
- Staking and governance primitives

A venture maps naturally to an OLAS service where the metadata includes the blueprint (invariants) and dispatch schedule.

## What Changes

### Venture becomes on-chain config
- Blueprint (invariants) + dispatch schedule + config stored as IPFS metadata referenced by an OLAS service NFT
- Owner is a multisig or DAO
- Supabase ventures table becomes a read-only index populated by Ponder from on-chain events

### Worker gains venture-watching capability
- New mode: "venture watcher" that polls on-chain venture configs
- Checks dispatch schedule against wall-clock time and workstream history (via Ponder)
- Dispatches finite workstreams as marketplace requests
- Separate from (but alongside) the existing "marketplace poller" that claims unclaimed requests

### Workstreams become finite
- No more cyclic redispatch
- Clear scope: "write 2 posts", "measure all invariants", "review strategy"
- Workstream ends when its scope is complete
- Multiple workstreams can be active for the same venture simultaneously

### Measurement becomes independent
- Dedicated measurement workstreams dispatched on their own schedule
- Measurement jobs observe execution outcomes without being part of the execution
- Results flow back to the venture config (measurement history informs next dispatch decisions)

## Open Questions

1. **Worker architecture.** Should venture-watching be a separate process, a mode of the existing worker, or a dedicated "venture orchestrator" service?

2. **Invariant structure.** Ventures and workstreams may need different invariant models (see separate discussion — ventures are homeostatic/continuous, workstreams are finite/task-oriented).

3. **Migration path.** How to transition existing cyclic workstreams to the new model without disrupting active ventures.

4. **Dispatch schedule expressiveness.** What cadences and conditions does the schedule need to support? Simple intervals? Conditional triggers ("dispatch measurement if content workstream completed in last 24h")? Event-driven ("dispatch when analytics show traffic drop")?

5. **On-chain cost.** Full blueprints with 15+ invariants are large. The OLAS pattern of storing an IPFS hash on-chain with full config off-chain mitigates this, but config updates still require transactions.
