# Keep the Base Sepolia self-eval bypass; revert as a mainnet gate

Date: 2026-05-13
Author: opus
Resolves: `jinn-mono-uy6v.6`

## Summary

Keep the local same-operator skip in the daemon's evaluation-opportunity
construction through v1 (Base Sepolia testnet). Reverting it to enforce the
multi-operator-only invariant is deferred and re-homed as a **mainnet gate**
— it is required before Phase 2 mainnet launch, not before v1 ship.

## Context

The same-operator self-eval bypass was added during the 2026-05-08
single-operator closure (DR-2026-05-08 §Changes Needed During Closure).
DR-2026-05-08 §Follow-ups left open whether to keep it through the
multi-operator dogfood (jinn-mono-2sro) or revert before v1 ship.

The bead `uy6v.6` framed it as a binary decision: keep through v1 ship
(allows continued single-operator validation alongside multi-operator runs)
vs. revert before v1 ship (forces the multi-operator-only invariant).

## Decision

Keep through v1 ship. Defer the revert as a mainnet-launch gate.

## Rationale

- v1 ships to **Base Sepolia testnet only** (per the `uy6v` epic scope and
  the broader Phase A / Phase 2 split in `cargo/CLAUDE.md` §Phased Rollout).
  Testnet's purpose is to surface operational issues — keeping the bypass
  preserves a working single-operator validation path that catches harness /
  generator / on-chain bugs faster than a multi-operator-only flow can.
- Multi-operator dogfood (`jinn-mono-2sro`) does not require the bypass to
  be removed — it only requires that at least one cross-operator eval
  succeeds when both operators are present. The bypass is permissive
  (allows same-operator self-eval if no other evaluator is available); it
  does not *prevent* cross-operator eval when one is.
- On mainnet, self-eval is a Sybil/integrity hazard regardless of operational
  convenience — the cross-operator invariant is a trust property, not a UX
  property. The revert there is a non-negotiable gate, not a discretion
  call.

## Code state

No code change in this DR. The bypass remains active. The follow-up bead
captures the revert as part of mainnet readiness; that work owns the code
removal and its regression-test coverage.

## Follow-up

- New bead: revert the self-eval bypass before Phase 2 mainnet launch.
  Filed as `jinn-mono-gu8q` (P2, deferred until 2026-08-01 — the Phase 2
  horizon). Link into the Phase 2 mainnet-readiness epic when that epic
  exists.
- Reference in v1 release notes (Build Notes for the next Monday cut):
  flag the testnet-only nature of the bypass so operators do not assume
  the same will hold post-mainnet.

## References

- DR-2026-05-08 §Follow-ups: `log/decisions/2026-05-08-swe-rebench-v2-loop-closed.md`
- `jinn-mono-uy6v.6` (this bead): https://github.com/Jinn-Network/mono/issues/155
- `jinn-mono-2sro` (multi-operator smoke)
- `cargo/CLAUDE.md` §Phased Rollout — Phase 2 is mainnet
