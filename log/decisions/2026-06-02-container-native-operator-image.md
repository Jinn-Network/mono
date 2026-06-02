---
id: DR-2026-06-02
title: One container-native base image for hosted operators; move the entrypoint gotcha-fixes into the daemon
date: 2026-06-02
verb: Steer
status: proposed
authors: opus (design stage, claude/eager-cerf-3d59c6; design note + spec: docs/superpowers/specs/2026-06-02-hosted-operator-container-consolidation.md)
relates-to: issue [#951](https://github.com/Jinn-Network/mono/issues/951) (this refactor), PR [#952](https://github.com/Jinn-Network/mono/pull/952) / issue #661 (the launcher+operator recipe — the regression reference, NOT yet merged), issue #805 (stale-pidfile crash-loop), issue #649 (preflight pidfile-liveness), issue #815 (aiUnits on /v1/status), issue #846 (railway.toml-at-repo-root incident)
---

## Context

Standing up the hosted claude-code/Haiku launcher+operator on Railway (#661) surfaced that we maintain **three divergent Dockerfiles** for one artifact — the `@jinn-network/client` daemon — and each hosted target forked the canonical image and re-solved a different subset of ~10 container gotchas inside its own bash entrypoint:

- `client/Dockerfile` — canonical, laptop-compose-shaped: root, hard-coded `VOLUME ["/data"]`, `/root/.claude.json` symlink auth, no entrypoint.
- `deploy/railway-operator-codex/` — codex operator (solver-only, no generator).
- `deploy/railway-launcher-operator/` — claude operator, the most complete entrypoint, **landed by #661 but only in unmerged PR #952**.

The build stages are byte-identical across all three; the divergence is entirely in the entrypoints. The deepest fixes (non-root drop, stale-pidfile reclaim #805, AppleDouble `._*` skip, state-on-volume, IPFS pool fetch) live **only** in the launcher entrypoint — they benefit no other image and are invisible to the operator app. The codex deploy will hit #805 / zero-tasks the moment it uses the generator. This violates the canonical operator-app principle (panel-driven, no terminal after first run) and makes every hosted deploy a multi-hour re-discovery of the same gotchas.

The full design note, current-state map, and stacked-PR plan are in the companion spec: [`docs/superpowers/specs/2026-06-02-hosted-operator-container-consolidation.md`](../../docs/superpowers/specs/2026-06-02-hosted-operator-container-consolidation.md). This DR records the architectural decision and the open questions the human must ratify.

## Decision (proposed)

**1. Move the daemon-shaped gotcha-fixes out of the bash entrypoints and into the daemon, so every image inherits them.** Specifically:
- stale-pidfile reclaim for the self / PID-1-in-container case → `client/src/preflight/pidfile-liveness.ts`;
- solvernet store skips `._*` / dotfiles → `client/src/solvernets/store.ts`;
- a single volume-aware `JINN_STATE_DIR` root that earning / generator-pool / impl-state / db all hang off → `client/src/config.ts` (+ rewire `swe-rebench-v2.ts` to read it from config, not `process.env`);
- generator fetches the validated pool from IPFS when the local dir is empty → `client/src/solver-types/swe-rebench-v2.ts`;
- boot-time deployment-readiness preflight → extend `client/src/preflight/` + `doctor.ts`;
- headless status surface (loop-completion + impl-state cadence) → extend `client/src/api/gather-status.ts` (`/v1/status`).

**2. Consolidate the three Dockerfiles into one container-native base image + thin per-harness overlays** (differ only in *which agent CLI* + *which auth env*). The base: non-root (`USER node`) by default, env-based auth default, no hard-coded `VOLUME`, pinned agent CLI, `ENV JINN_STATE_DIR=/data`.

**3. Strangler-fig sequencing.** The daemon-internal fixes (spec slices S1–S6) ship first and **independently of #952**. The image consolidation (S7–S8) is **gated on #952 merging**, because `deploy/railway-launcher-operator/` is the regression reference the consolidated base must reproduce.

**4. Derive, don't collapse, the state dirs.** `JINN_STATE_DIR` is a new root from which the existing keys derive *unless individually overridden*; the existing per-key env vars (`JINN_EARNING_DIR`, `JINN_DB_PATH`, `JINN_ENGINE_IMPL_STATE_DIR_ROOT`, `JINN_SWE_REBENCH_V2_STATE_DIR`) stay as escape hatches. `JINN_STATE_DIR` unset ⇒ byte-identical legacy defaults. `workingDirRoot` stays ephemeral (reaped per-task), not under `$JINN_STATE_DIR`.

**5. Child-issue carve-up.** A3–A6 land as `fix`/`feat`-shaped child issues under #951 (so the bug fixes get standalone regression tests and can proceed while #952 is in flight); A1/A2/A7 stay on #951 as the `refactor` parent's terminal slices.

## Why this shape

- **Fixes propagate.** Once a gotcha is solved in the daemon, every image — laptop, compose, codex, claude, launcher — inherits it. Today each entrypoint re-solves a subset and the codex image is one generator-call away from #805.
- **The entrypoint shrinks to its legitimate job.** After the move, the entrypoint does only deployment-secret materialization (idempotent env-seed of config / launched-record / auth) + chown/gosu drop + exec. Everything that is a *daemon correctness bug* moves in; everything that is *deployment-secret plumbing* stays.
- **It reconciles with shipped code, not greenfield.** The preflight DI/`CheckResult` system (#649) and the un-gated `/v1/status` surface (#815) already exist — A5 and A6 *extend* them. The design pass verified this against `client/src/preflight/` and `client/src/api/gather-status.ts`.
- **The risky surface is contained.** The one breaking-change vector (state-dir resolution) is neutralized by derive-don't-collapse + a byte-identical-defaults regression test; the one security vector (IPFS fetch) is neutralized by hash-verify + never-overwrite-newer. The hash binds the fetched artifact to the on-chain ref; ref *authenticity* reduces to the `setMetadata` write authority for that `manifestCid` — the correct SolverNet trust model (the manifest owner is the authority for their own pool), called out as a residual assumption in open question #4.

## Open questions to ratify

1. **GHCR base image vs. ARG-Dockerfile bridge.** Recommended: GHCR base as the target, single ARG-Dockerfile as the bridge if the GHCR publish is private/unreachable. (Decide at S7 start on reachability.)
2. **Non-root posture.** Recommended: image-default `USER node` + a minimal root→node gosu chown shim (Railway mounts `/data` as root). Confirm vs. requiring host-side chown.
3. **`JINN_STATE_DIR` naming + derivation precedence.** Confirm derive-don't-collapse and `workingDirRoot`-stays-ephemeral.
4. **A4 artifact-CID resolution path.** On-chain `IdentityRegistry.getMetadata` read by manifestCid, vs. extending the DiscoveryAPI `PublishedArtifact` read-shape (currently plugin-only). The latter is cleaner but widens the indexer contract.
5. **`CLAUDE_CODE_OAUTH_TOKEN` headless lifecycle.** Does the token survive container restarts / need periodic refresh? Highest-risk unknown for headless operation; A5's credential check asserts presence but cannot fix expiry. (Carried from the #952 reference spec §10 #4.)
6. **Codex recipe fate.** Recommended: keep `deploy/railway-operator-codex/` as a second reference overlay (proves the base is agent-agnostic) rather than deprecate.
7. **#951 scope vs. child issues.** Decided in §5 above; this DR ratifies it.

## Alternatives considered (rejected)

- **Collapse the four state-dir keys into one.** Rejected: a hard breaking change to every existing operator config and the `e2e`/`staking` scripts. Derive-don't-collapse is fully back-compatible and is the only option that lets each slice ship independently (spec §8).
- **Keep solving gotchas in per-image entrypoints.** Rejected: this is the status quo whose cost (fixes don't propagate; multi-hour re-discovery per deploy) is exactly what #951 exists to remove.
- **Big-bang rewrite of all three Dockerfiles at once.** Rejected: the `refactor` shape mandates stacked PRs (strangler-fig); a big-bang change can't be reviewed in `< ~200 LOC` slices and can't land the daemon fixes (which deliver value now) ahead of the #952-gated image work.

## Status / next steps

`proposed`. This design pass produced the spec + this DR only — **no slice is implemented**. Next human steps:
1. Ratify (or amend) this DR and the §9 open questions in the spec.
2. Land PR #952 (the regression reference) before S7/S8.
3. Approve the child-issue carve-up (§6 of the spec) and file C1–C8.
