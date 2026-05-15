---
id: DR-2026-05-07-e
title: Embedded OpenTelemetry pipeline unifies capture and task-execution trajectories
date: 2026-05-07
verb: Steer
status: ratified
authors: oaksprout, opus (drafted on jinn-mono-6m7t)
spec: spec/2026-05-07-telemetry-collector-and-task-generator.md
---

## Context

The collector needs a scrubbing pipeline for capture-envelope trajectories. Three architectural shapes were considered for how the pipeline relates to the existing `client/src/trajectory/collector.ts` (the bespoke trajectory collector network harnesses use today):

- **(α) Yes — unify on embedded OTLP from day 1.** Existing harnesses migrate onto an embedded OpenTelemetry OTLP receiver in jinn-client. One scrubbing pipeline for both streams.
- **(β) No — capture path uses OTLP; network-task path stays bespoke.** Two parallel scrubbing pipelines.
- **(γ) Yes — but as a v0.5 follow-up, not v0.** Spec commits to unification as the architectural target; v0 ships parallel pipelines; v0.5 migrates network tasks.

## Decision

**Select (α) — unify on embedded OTLP receiver from day 1.**

The jinn-client daemon embeds an OpenTelemetry SDK-Node-based OTLP receiver (gRPC + HTTP, default `localhost:7332`). All trajectory streams — captures from external tools (Claude Code, Codex, Gemini CLI, Cursor, Aider, etc.) AND ordinary task-execution from in-process harnesses (claude-code-learner, prediction-v0-baseline, prediction-v1-baseline, etc.) — flow through the same receiver and the same OTel SDK processor stack.

The existing `client/src/trajectory/collector.ts` migrates: existing harnesses emit OTel via the OTel SDK exporter pointing at the embedded receiver, replacing the in-process direct call. The bespoke collector becomes a thin compatibility shim during migration and is removed once all harnesses are migrated.

## Rationale

- **The existing collector is already OpenTelemetry-shaped, just bespoke.** `client/src/trajectory/collector.ts` accepts spans with attributes and events, scrubs them with a pattern set, signs a `redactionManifest` — these are exactly what the OTel SDK's processor pipeline does, just hand-written. The migration is mechanical.
- **One scrubbing pipeline beats two.** A new redaction processor lands in one place and applies to capture envelopes and to ordinary task-execution envelopes alike. No drift, no per-stream debugging, no "we fixed it for captures but the bug is still in network tasks."
- **Off-the-shelf OTel processors mature faster than bespoke.** The OpenTelemetry ecosystem ships first-class processors (batch, redaction, transform, attribute-renamer, scope-filter) that the bespoke collector either lacks or reimplements informally. Standardising lets us upgrade by depending on releases rather than maintaining our own implementations.
- **Vendor-neutral capture surface from day 1.** Any tool that emits OTel can participate, including non-Jinn-aware tools the operator configures via env vars. The embedded receiver is a Schelling point for any future ingest path.
- **Network task quality benefits.** Today's harnesses produce trajectories that get the V1 credential scrub. After migration they get the same identity + path + future-redaction processors as captures — a strict upgrade for the existing path.

## Alternatives considered and rejected

- **(β) Parallel pipelines per stream.** Rejected for the divergence cost. Two scrubbing implementations means two test suites, two bug-fix paths, and inevitably one stream falls behind the other. The "we'll keep them in sync" promise is one we'd break under engineering pressure.
- **(γ) Unify as v0.5 follow-up.** Rejected because the right time to do the migration is when the pipeline is being touched anyway. v0 introduces the embedded receiver for captures; punting the migration to v0.5 means doing the same work twice (once to wire up captures, once to migrate harnesses) and shipping a known-temporary parallel-pipeline architecture in between.
- **Standalone OpenTelemetry Collector deployment alongside jinn-client.** Considered briefly as an alternative to embedding. Rejected because it introduces a separate process the operator has to install and run; the embedded option uses the OTel SDK packages directly in jinn-client's Node runtime and avoids the install/operate/upgrade story for a separate Go binary.

## Consequences

- **`client/src/trajectory/receiver.ts` is added** — OTLP gRPC + HTTP listener wired to the OTel SDK processor stack.
- **`client/src/trajectory/processors/`** is added — identity scrub, path scrub, manifest builder, SQLite exporter. The existing V1 credential scrub becomes one processor in the stack.
- **`client/src/trajectory/collector.ts` is removed** at the end of migration. During migration it becomes a thin shim; harness call sites switch to OTel SDK exporters one at a time.
- **Harness `HarnessContext`** gains an OTel exporter handle (or accesses it via a daemon-provided global tracer). Existing harnesses' span-emit code is largely unchanged in shape; the wire to the collector is replaced.
- **`client/src/trajectory/secret-scrub.ts` is preserved as a processor.** The pattern set is the same; the function signature shifts to the OTel SDK processor interface.
- **`captureManifest.scrubProcessors[]`** records the processor name + version + config for each scrub. Future bonded-auditor work can verify what version produced the published artifact.
- **All existing trajectory tests must be migrated** to the new pipeline. Cost is real but bounded — the scrubbing semantics are preserved end-to-end, so most tests are about wiring rather than behavior.
- **Engineering scope is ~3-5 days** for the migration on top of the receiver work. Sized in spec §8.1 as part of the v0 component breakdown.

## Status

Ratified by Captain oaksprout during the design exercise on jinn-mono-6m7t; locked 2026-05-07. `jinn-mono-h43b` (proper anonymization tool) is the gating issue for both streams.
