// packages/marketplace/pipeline/src/facts-mapper-kinds.ts
// SPDX-License-Identifier: MIT

/**
 * The frozen bridge-era submission kind, duplicated by value, not imported: the pipeline
 * declares no record-discovery dependency (source-boundary guard). It deliberately does NOT
 * equal `RECORD_KINDS.submission` in `@jinn-network/record-discovery-protocol`
 * (`https://jinn.network/records/submission/1.0`) and is deliberately outside that package's
 * record-kind grammar (`records/<segment>/<major>.<minor>`), so it can never collide with a
 * native record kind. It must equal the client's `LEGACY_SUBMISSION_RECORD_KIND`
 * (`client/src/daemon/native-submission-facts.ts`); the host asserts that in
 * `client/test/bridge/legacy-facts-card.test.ts`. Frozen per Phase C
 * (`docs/superpowers/specs/2026-08-03-phase-c-capability-boundaries.md` §3, §5) until the
 * package's Phase D deletion.
 */
export const RECORD_KINDS_SUBMISSION =
  "https://jinn.network/records/task-execution/submission/1.0";
