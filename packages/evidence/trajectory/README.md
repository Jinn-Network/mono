# @jinn-network/evidence-trajectory

The sealed Trajectory record kind: a portable, verifiable structure for what happened
inside an agent execution.

A Trajectory record is a list of OpenTelemetry-shaped spans under a Jinn-owned vocabulary
profile, derived from a digest-bound native trace by a named decoder. The record is a pure
function of its inputs — no wall clock, no randomness — so the same trace decoded by the
same decoder version always produces the same bytes and the same digest.

Every identifier in the record is derived from the record's own declared inputs, so a
consumer can recompute them and detect fabricated spans without holding the source bytes.

See `../../../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md` §7.2.
