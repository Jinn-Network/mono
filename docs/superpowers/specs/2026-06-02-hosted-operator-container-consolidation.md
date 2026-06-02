# Issue #951 — Consolidate the hosted-operator deploy into one container-native image

- **Date:** 2026-06-02
- **Author:** opus (design stage, `claude/eager-cerf-3d59c6`)
- **Issue:** [#951](https://github.com/Jinn-Network/mono/issues/951)
- **Shape:** refactor (architecture / migration; design upfront, stacked PRs / strangler-fig, integration tests on the container surface)
- **Decision record:** [DR-2026-06-02](../../../log/decisions/2026-06-02-container-native-operator-image.md) (status: proposed — this design pass produces the spec + DR; ratification + child-issue carve-up is the human's next step)
- **Hard dependency:** PR [#952](https://github.com/Jinn-Network/mono/pull/952) (the #661 launcher+operator recipe) for the image-consolidation slices only; the daemon-internal slices are #952-independent.

> **Status note.** This is the **design pass** for a `refactor` whose own acceptance criteria say "detailed design in a session/DR" and "stacked PRs (strangler-fig)". It defines the target architecture and the stacked-PR / child-issue breakdown. It does **not** implement any slice. The next human step is to (1) ratify DR-2026-06-02, (2) land PR #952 (the regression reference), and (3) approve the child-issue carve-up in §6.

## Problem

We maintain **three near-identical multi-stage Dockerfiles** for what is one artifact — the `@jinn-network/client` daemon — and each hosted target independently re-solved a different subset of ~10 container gotchas inside its own bash entrypoint rather than in the daemon:

- `client/Dockerfile` — the canonical `@jinn-network/client` OCI image, shaped for docker-compose on a laptop: runs as **root**, hard-codes `VOLUME ["/data"]` (`client/Dockerfile:94`), uses a `/root/.claude.json` symlink for auth (`client/Dockerfile:76`), unpinned `npm install -g @anthropic-ai/claude-code` (`client/Dockerfile:68`), no entrypoint script.
- `deploy/railway-operator-codex/` — codex operator. Own entrypoint (seeds `CODEX_AUTH_JSON` + `CONFIG_TEMPLATE_JSON`). Solver-only (no generator).
- `deploy/railway-launcher-operator/` — claude operator, **landed by #661 but not yet merged** (open PR #952). The most complete entrypoint: gosu root→node drop, stale-pidfile clear, AppleDouble `._*` strip, state-dirs-on-volume, config/launched-record seeding, plus a throwaway `measure-learning.sh` for headless visibility.

The build stages (1–2) are **byte-identical** across all three. The divergence is entirely in the entrypoints and the container-concern handling. The deepest, most valuable fixes (non-root drop, stale-pidfile reclaim, dotfile-skip, state-on-volume, IPFS pool fetch) live **only** in the launcher entrypoint — they benefit no other image, and they are invisible to the operator app. The codex deploy will hit #805 / zero-tasks the moment it leans on the generator.

This directly violates the canonical operator-app principle (panel-driven, no terminal after first run; `client/OPERATOR-APP-SPEC.md`) and makes every new hosted deploy a multi-hour re-discovery of the same gotchas (evidence: #661).

## Approach in one line

**Move the daemon-shaped fixes out of the launcher's bash entrypoint and into the daemon, so every image inherits them; then collapse the three Dockerfiles into one container-native base + thin per-harness overlays.** Strangler-fig: the daemon-internal fixes (slices S1–S6) ship first and independently of #952; the image consolidation (S7–S8) is gated on #952 landing as the regression reference.

## Current-state map

### The 10 gotchas × 3 images

Legend: ✅ solved here · ➖ not addressed · 🔁 duplicated logic.

| # | Gotcha | `client/Dockerfile` | `railway-operator-codex` | `railway-launcher-operator` (#952) | Right home |
|---|--------|---------------------|--------------------------|------------------------------------|-----------|
| 1 | Root → claude-code `--dangerously-skip-permissions` crashes every solve | ➖ root, no `USER` | ➖ root | ✅ gosu drop root→node (`entrypoint.sh:14-18`) | Image (non-root default) + minimal auto-drop shim |
| 2 | Stale pidfile crash-loop (#805): daemon is PID 1, pidfile on volume outlives container → exit 11 | ➖ `process.on('exit')` unlink only (`main.ts:2663-2670`) | ➖ | 🔁 `rm -f $EARNING_DIR/daemon.pid` (entrypoint) | **Daemon** (`pidfile-liveness.ts`) |
| 3 | Generator posts 0 tasks: vetted pool absent on fresh volume, no IPFS fetch | ➖ | ➖ (solver-only) | ✅ `JINN_SWE_REBENCH_V2_STATE_DIR=/data` — but a *truly* fresh volume still posts 0 | **Daemon** (IPFS fetch) |
| 4 | impl-state wiped each restart (defaults to `$HOME`) | ➖ | ➖ | ✅ `JINN_ENGINE_IMPL_STATE_DIR_ROOT=/data` | **Daemon** (single `JINN_STATE_DIR`) |
| 5 | macOS-tar AppleDouble `._*` files break the solvernet store | ➖ | ➖ | ✅ `find /data -name '._*' -delete` (entrypoint) | **Daemon** (`listJsonFiles` skip dotfiles) |
| 6 | Relayer `viem` not found (Yarn-4 PnP, missing `.yarnrc.yml` COPY) | n/a | n/a | ✅ relayer-only fix in #952 (`packages/claim-relayer/deploy/Dockerfile`, commits `59721ab2` + `9b1e1b33`) | Relayer package (already fixed in #952) |
| 7 | `VOLUME` directive rejected by Railway | 🔁 `VOLUME ["/data"]` (line 94) | ✅ omits it | ✅ omits it | Image (base must not hard-code `VOLUME`) |
| 8 | Earning needs a separate claim-relayer service (daemon is emit-only) | ➖ | ➖ | ➖ (relayer is a separate service `packages/claim-relayer`) | Deploy topology (documented two-service path) |
| 9 | State seeding via env tarball (clunky, order-dependent) | ➖ | 🔁 `CODEX_AUTH_JSON` + `CONFIG_TEMPLATE_JSON` | 🔁 `JINN_STATE_TARBALL_B64` + `CONFIG_TEMPLATE_JSON` + `LAUNCHED_RECORD_JSON` | Thin entrypoint seed (deployment-secret materialization stays image-side) |
| 10 | No headless visibility (had to `railway ssh` + read `/data/jinn.db`) | ➖ | ➖ | 🔁 `measure-learning.sh` reads `task_runs` + `git log` over SSH | **Daemon** (extend `GET /v1/status`) |

### State-dir inventory (the single-`JINN_STATE_DIR` target)

| Config key | Env override | Current default (`client/src/config.ts`) | Owner subsystem |
|---|---|---|---|
| `earningDir` | `JINN_EARNING_DIR` | `~/.jinn-client/earning` (`config.ts:61`) | keystore, fleet/stake state, **`solvernets/launched/`**, `daemon.pid` |
| `dbPath` | `JINN_DB_PATH` | `~/.jinn-client/jinn.db` (`config.ts:64`) | SQLite store (`task_runs`, activity, artifacts) |
| `engine.workingDirRoot` | `JINN_ENGINE_WORKING_DIR_ROOT` | `~/.jinn-client/engine/work` (`config.ts:644`) | per-task work dirs (ephemeral on purpose — reaped) |
| `engine.implStateDirRoot` | `JINN_ENGINE_IMPL_STATE_DIR_ROOT` | `~/.jinn-client/engine/impl-state` (`config.ts:645`) | learner self-state git repo (durable) |
| _(no config field)_ | `JINN_SWE_REBENCH_V2_STATE_DIR` | `$HOME/.jinn-client/swe-rebench-v2` (`swe-rebench-v2.ts:142-143`) | generator pool cache + `validated-pool.json` |

`JINN_SWE_REBENCH_V2_STATE_DIR` is the odd one out: read directly via `process.env` at `swe-rebench-v2.ts:799/815/852`, **not** threaded through `JinnConfig`, and **absent from `TRACKED_ENV_VARS`** (`config.ts:1274-1338`).

### Prior art — reconcile, do not reinvent

- **Preflight** (`client/src/preflight/`): a real, dependency-injected `CheckResult` system already exists — `pidfile-liveness.ts` (#649; discriminated `proceed` / `unlink-stale` / `refuse`), `rpc-network.ts`, `claude-binary.ts`, `claude-auth.ts` (with `detectAuthContext`, which already distinguishes container / compose / bare), `api-port.ts`. The `doctor` CLI (`client/src/cli/commands/doctor.ts`) aggregates them. **A5 extends this; there is no writable-volume check yet — that is the one genuine gap.**
- **Status surface** (`client/src/api/gather-status.ts` → `GET /v1/status`): already un-gated by the UI token (`server.ts:483`), already carries an `aiUnits` block (#815), earning/claims totals, `daemonRuntime` PID-liveness (`gather-status.ts:186-202`), and a harness rollup. **A6 extends this.** The only `measure-learning.sh` signals not yet present are loop-completion rate (from `task_runs.solution_outputs_json.gating.phasesCompleted`) and impl-state commit cadence (from `git log` on the impl-state repo).

## Target architecture

### Layer 0 — daemon-internal fixes (image-independent; ship first)

These are the heart of the refactor: each makes *any* image correct and deletes a line from every entrypoint.

- **A3a — stale-pidfile reclaim (PID-1/self container case).** Extend `checkPidfileLiveness` (`pidfile-liveness.ts:42-79`). `process.kill(pid, 0)` on a recorded PID 1 succeeds in a container → `refuse` → crash-loop (#805). Add a branch: `pid === 1` (we are becoming the container's PID 1) or `pid === process.pid` → `unlink-stale`, new `reason: 'self-or-pid1-container'`. Optional boot-id/start-time guard so a genuinely live sibling is never trampled. Deletes `rm -f daemon.pid` from the entrypoint.
- **A3b — dotfile-skip in the solvernet store.** Tighten the predicate in `listJsonFiles` (`store.ts:217-226`) to `name.endsWith('.json') && !name.startsWith('.')`. `readAndParse` already degrades gracefully (parse-fail → `null` → skipped, logged), so there is no hard crash today — but each `._*` file emits a spurious error log and an AppleDouble sidecar with coincidentally-valid JSON could mis-validate. Deletes `find /data -name '._*' -delete`.
- **A3c — single volume-aware `JINN_STATE_DIR` root.** New env key + config field `stateDir`. Per-key precedence: **explicit per-key override > `<stateDir>/<subdir>` > legacy `~/.jinn-client/<subdir>`**. Derivations: `earning → $STATE_DIR/earning`, `jinn.db → $STATE_DIR/jinn.db`, `engine/impl-state → $STATE_DIR/engine/impl-state`, `swe-rebench-v2 → $STATE_DIR/swe-rebench-v2`. `workingDirRoot` **stays ephemeral** (reaped per-task). Resolve in `loadConfig` so `JinnConfig` carries derived absolute paths; **thread the resolved swe-rebench dir through `JinnConfig`** so `swe-rebench-v2.ts` stops reading `process.env` directly (add it to `TRACKED_ENV_VARS`). Back-compat is load-bearing: `JINN_STATE_DIR` unset ⇒ byte-identical legacy defaults. Collapses four `ENV JINN_*_DIR` lines to one `ENV JINN_STATE_DIR=/data`.
- **A4 — IPFS vetted-pool fetch on empty local dir.** The env-var workaround only relocates state; a fresh volume still has no `validated-pool.json` → `admission-required-no-data` → 0 tasks (`swe-rebench-v2.ts:540-576`). The pieces exist: the vetted pool is published to IPFS (`resolvePublishedVettedPool` → `uploadToIpfs`, `swe-rebench-v2.ts:327`), advertised on-chain under metadata key `solvernet-artifact:<manifestCid>:swe-rebench-v2-vetted-pool` (the key is built by `sweRebenchV2VettedPoolArtifactMetadataKey`, `_swe-rebench-v2-validated-pool.ts:383-384`; the on-chain write goes through the ERC-8004 `IdentityPublisher`, `erc8004/identity.ts:526`), and a downloader exists (`fetchFromIpfs` / `buildIpfsFetchCidPathCandidates` in `adapters/mech/ipfs.ts`). Hook: when `validated-pool.json` is absent **AND** `admissionMode === 'required'` **AND** a manifest CID is available, resolve the artifact CID (read on-chain by manifestCid), `fetchFromIpfs`, **verify the hash** with `hashVettedPoolArtifact`, and write the pool. **Never overwrite a newer local pool** (existing `validatedNewer` guard, `swe-rebench-v2.ts:309`). Fetch failure falls through to the existing fail-closed warning path — never a silent floor.
- **A5 — deployment-readiness preflight (fail-loud).** Extend the existing preflight DI system (do not invent a parallel one). New aggregate answering, at boot: (1) **writable volume?** — attempt-write-then-unlink on `config.stateDir` (the genuine new primitive); (2) **state on the volume?** — resolved `stateDir` is on the mount, not the ephemeral fs; (3) **credentials resolvable?** — reuse `claude-auth.ts` / `detectAuthContext`; (4) **relayer reachable?** — probe the configured claim-relayer endpoint (daemon is emit-only); (5) **agent CLI non-root?** — assert effective UID dropped from root. Surfaced fail-loud at boot and as `doctor` checks.
- **A6 — extend `GET /v1/status`.** Add two read-only fields to `gather-status.ts`: (a) **loop-completion rollup** — count `task_runs` whose `gating.phasesCompleted` reached `execute` / `improve` / `memory-consolidation` (what `measure-learning.sh` computes over SSH); (b) **impl-state commit cadence** — HEAD commit count + last-commit timestamp per impl-state repo. `aiUnits` / earning / claims / `daemonRuntime` are already present. Makes `measure-learning.sh` obsolete and satisfies the OPERATOR-APP-SPEC read-only-surface discipline.

### Layer 1 — the consolidated container-native base image (A1/A2)

One base image = single source of truth; per-harness deploys become thin overlays.

- **Recommended (Option B): a base image published to GHCR, per-harness `FROM jinn-base` overlays.** `deploy/Dockerfile.base` lifts the byte-identical build+runtime stages, and encodes the A2 container concerns in one place: **no `VOLUME`**, **`USER node` non-root default**, pinned `git`/`curl`/`gosu`, **env-based auth default** (`CLAUDE_CODE_OAUTH_TOKEN` / `CODEX_AUTH_JSON` / `ANTHROPIC_API_KEY`), **`ENV JINN_STATE_DIR=/data`**, drop the `/root/.claude.json` symlink. The agent CLI is **not** in the base (kept agent-agnostic) — that is the overlay's job. Con: needs the GHCR publish reachable (the codex README flags it is currently private).
- **Fallback (Option A): one Dockerfile with a build `ARG AGENT_CLI`.** Ships today with no registry dependency; the cost is a full rebuild per target. The strangler-fig allows landing A as a bridge and cutting to B later.

**Non-root reconciliation (genuinely contestable — see DR §Decisions).** Railway mounts `/data` as root, so a pure `USER node` image can't write the volume. Recommendation: **ship both** — `USER node` image default (laptop/compose need no entrypoint at all) plus a minimal root→node gosu chown shim retained only for the Railway-mounts-as-root case.

### Layer 2 — thin entrypoint + one documented deploy path (A7)

After Layers 0–1 the entrypoint shrinks to: (1) chown `$JINN_STATE_DIR` + gosu-drop if root; (2) **idempotently seed config / launched-record / auth from env if absent** — legitimate deployment-secret materialization, stays image-side; (3) `exec node dist/bin/jinn.js`. Gotchas 2, 3, 4, 5 are **gone from bash**. One documented deploy path: **image + volume-at-`/data` + auth-env + a separate claim-relayer service** (gotcha #8). `railway.toml` config-as-code pinned to the per-harness Dockerfile path — **never the repo root** (the #846 incident, codex README:14). Codex and claude both `FROM` the base.

## Stacked-PR slices

Each slice is independently shippable, target `< ~200 LOC`, with the test discipline its shape requires (regression-test-first for `fix`, TDD for `feat`, container-surface integration tests for the deploy slices).

### Dependency graph

```
#952-INDEPENDENT (daemon-internal — ship now):
  S1  fix(store): dotfile-skip ................. zero deps, smallest
  S2  fix(preflight): pidfile PID-1/self ....... zero deps
  S3  feat(config): JINN_STATE_DIR root ........ zero deps; FOUNDATION
       └─ S4 feat(swe-rebench-v2): IPFS pool fetch   [depends on S3]
  S5  feat(preflight): deployment-readiness .... [soft-depends on S3]
  S6  feat(api): status loop+impl-state ........ zero deps

GATED ON #952 MERGE (image consolidation):
  S7  refactor(deploy): consolidated base image  [depends on S1–S5 + #952]
       └─ S8 chore(deploy): thin overlays + deploy doc + retire measure-learning.sh  [depends on S6 + S7]
```

### S1 — `fix(store): skip dotfiles in solvernet launched-record listing`
- **Satisfies:** A3b. **Files:** `client/src/solvernets/store.ts` (`listJsonFiles`), test `client/test/solvernets/store.test.ts`.
- **Approach:** Predicate → `name.endsWith('.json') && !name.startsWith('.')`. Deletes the `find -delete` entrypoint line (in S8).
- **Test (regression-first):** Write a real record + an AppleDouble `._foo.json` (valid-looking JSON); assert only the real record loads and no error is logged. Fails on `main`, passes after.
- **Size:** ~30 LOC.

### S2 — `fix(preflight): reclaim stale pidfile for self / PID-1-in-container`
- **Satisfies:** A3a. **Files:** `client/src/preflight/pidfile-liveness.ts:42-79`, test `client/test/preflight/pidfile-liveness.test.ts`.
- **Approach:** Branch before the `process.kill` probe: `parsed === 1 || parsed === process.pid` ⇒ `unlink-stale`, reason `'self-or-pid1-container'`. Optional boot-id guard (split to a hardening follow-up if it grows the slice). Deletes the `rm -f daemon.pid` entrypoint line (in S8).
- **Test (regression-first):** pidfile of `1` and of `String(process.pid)` ⇒ `unlink-stale` (not `refuse`); a different live PID still `refuse`s. Fails on `main`, passes after.
- **Size:** ~50 LOC.

### S3 — `feat(config): single JINN_STATE_DIR volume-aware state root`
- **Satisfies:** A3c, A2 (single-state-root half). **Files:** `client/src/config.ts` (schema field, `DEFAULT_ENGINE`, `loadConfig` resolution, `TRACKED_ENV_VARS`), `client/src/solver-types/swe-rebench-v2.ts:142-143,799-855`. Tests: `client/test/config.test.ts` + new `config-state-dir.test.ts`.
- **Approach:** Derive-don't-collapse (per-key overrides still win). Resolve in `loadConfig`; thread swe-rebench dir through `JinnConfig`. `workingDirRoot` stays ephemeral. Back-compat: unset ⇒ byte-identical.
- **Test (TDD, matrix):** (a) `JINN_STATE_DIR=/data` only ⇒ all four under `/data`, `workingDirRoot` unchanged; (b) `JINN_STATE_DIR` + a per-key override ⇒ override wins; (c) unset ⇒ byte-identical legacy defaults; (d) both env vars now appear in provenance.
- **Size:** ~150 LOC. Split point: carve the swe-rebench `process.env`-removal into a follow-on if it exceeds budget.

### S4 — `feat(swe-rebench-v2): fetch validated pool from IPFS on fresh volume`
- **Satisfies:** A4. **Depends on:** S3. **Files:** `client/src/solver-types/swe-rebench-v2.ts:421-576,309`, `client/src/adapters/mech/ipfs.ts`, `client/src/solver-types/_swe-rebench-v2-validated-pool.ts:383-384,669-684`; possibly `client/src/discovery/types.ts:80-105`. Tests: `client/test/e2e/swe-rebench-v2.test.ts` + focused units.
- **Approach:** Fetch only when absent AND admission-required AND a ref resolves; verify hash; never overwrite a newer local pool; fail-closed on fetch/verify failure.
- **Test (TDD, incl. security):** empty dir + mock IPFS ⇒ pool written, hash matches, generator leaves `admission-required-no-data`; **bad hash ⇒ rejected, no write**; newer local pool ⇒ no fetch/overwrite; e2e: empty `stateDir` → fetch → posts > 0.
- **Size:** ~180 LOC. Split point: a small `feat(discovery): expose solvernet-artifact ref read` ahead of S4 if the read-shape extension is non-trivial.

### S5 — `feat(preflight): deployment-readiness preflight (fail-loud)`
- **Satisfies:** A5. **Soft-depends on:** S3. **Files:** new `client/src/preflight/deployment-readiness.ts`, `client/src/cli/commands/doctor.ts`, reusing `claude-auth.ts` / `rpc-network.ts` / `pidfile-liveness.ts`. Tests: new `client/test/preflight/deployment-readiness.test.ts`.
- **Approach:** Extend the existing `CheckResult` DI system. New writable-volume probe is the only new primitive; the rest compose existing checks.
- **Test (TDD + integration):** each check green/red against injected deps; a container-shaped fixture (read-only mount) asserts the daemon **refuses to boot fail-loud** rather than silently writing to ephemeral fs.
- **Size:** ~180 LOC. Split point: writable-volume as its own slice if it grows.

### S6 — `feat(api): surface loop-completion + impl-state commit cadence on /v1/status`
- **Satisfies:** A6. **Files:** `client/src/api/gather-status.ts` (no `server.ts` route change — `/v1/status` already un-gated). Tests: `client/test/api/gather-status.test.ts` + focused test.
- **Approach:** Two read-only fields: phase-completion rollup from `task_runs.solution_outputs_json` and impl-state commit cadence. Retires `measure-learning.sh` (in S8).
- **Test (TDD):** seeded SQLite `task_runs` ⇒ correct phase counts; throwaway git repo ⇒ correct cadence; empty case ⇒ zeroes, not a throw.
- **Size:** ~140 LOC.

### S7 — `refactor(deploy): consolidated container-native base image` *(GATED on #952)*
- **Satisfies:** A1, A2. **Depends on:** S1–S5 + #952 merged. **Files:** new `deploy/Dockerfile.base`; reference `client/Dockerfile:12,54,68,76,94`, the codex and launcher Dockerfiles.
- **Approach:** Lift the byte-identical build stages into the base; no `VOLUME`; `USER node` default + minimal gosu shim; pinned tools; env-auth default; `ENV JINN_STATE_DIR=/data`; agent-agnostic. Option B (GHCR) target, Option A (ARG) bridge if GHCR is unreachable — decide at S7 start.
- **Test (container-surface integration — required for `refactor`):** build the base; `docker inspect` shows no `Volume` and `User=node`; `docker run` as root with a root-owned `/data` mount drops to `node` and S5's checks pass; pinned versions present.
- **Size:** ~120 LOC (small precisely because S1–S6 moved behavior into the daemon).

### S8 — `chore(deploy): thin per-harness overlays + one deploy path; retire measure-learning.sh` *(GATED on #952 + S6 + S7)*
- **Satisfies:** A7 (completes A2). **Depends on:** S6, S7. **Files:** rewrite `deploy/railway-operator-codex/*` and the #952 `deploy/railway-launcher-operator/*` as thin `FROM jinn-base` overlays; **delete `deploy/railway-launcher-operator/measure-learning.sh`**; one consolidated deploy README; `packages/claim-relayer/deploy/` stays as the separate relayer service.
- **Approach:** Each overlay ~4 lines (`FROM jinn-base` + pinned `RUN npm i -g <agent-cli>` + auth-env doc). Entrypoint shrinks to chown+gosu / idempotent env-seed / exec. `railway.toml` pinned to the per-harness Dockerfile path. Keep codex as a second reference overlay (proves the base is agent-agnostic).
- **Test (container-surface integration + regression-reference, see §7):** build each overlay, assert pinned CLI + `FROM jinn-base`; boot the new launcher overlay through the same env-seed inputs the #952 launcher used and assert identical launched/generating state **without** the four daemon-correctness bash lines; assert `measure-learning.sh` is gone and its readouts are on `/v1/status`.
- **Size:** ~150 LOC.

## §6 — Proposed child-issue breakdown (sub-issues of #951)

**Recommendation:** split **A3–A6 into `fix` / `feat`-shaped child issues** under #951, and keep **A1/A2/A7 as the `refactor` parent's own terminal slices** (S7/S8). Rationale: A3a/A3b are genuine bug fixes (#805 crash-loop, AppleDouble mis-validation) deserving standalone regression tests; A4/A6 are user-visible features. A `refactor` parent should not carry `fix`-shaped regression work as un-issued slices. This also lets the daemon-internal children proceed **in parallel while #952 is in flight**.

| # | Title | Shape | One-line context + acceptance | Blocked on #952 | Slice |
|---|---|---|---|---|---|
| C1 | Skip dotfiles in solvernet launched-record listing | `fix` | AppleDouble `._*.json` spam logs / risk mis-validation → exclude dotfiles; AC: dotfile present, real record still loads, no error logged. | No | S1 |
| C2 | Reclaim stale pidfile for self / PID-1-in-container | `fix` | Container restart sees recorded PID 1 "alive" → crash-loop (#805); AC: pidfile of `1`/own PID ⇒ unlink-stale, live sibling still refused. | No | S2 |
| C3 | Single `JINN_STATE_DIR` volume-aware state root | `feat` | Four scattered state dirs → one volume-aware root with per-key override; AC: matrix (root-only / override-wins / unset-byte-identical) green, swe-rebench dir from config not env, both env vars tracked. | No | S3 |
| C4 | Fetch validated pool from IPFS on fresh volume | `feat` | Fresh volume → 0 tasks even with state relocated; AC: empty dir + admission-required + manifest CID ⇒ fetch + hash-verify + post > 0; bad hash rejected; newer local never overwritten. | No | S4 |
| C5 | Deployment-readiness preflight (fail-loud) | `feat` | No boot-time deploy guard; AC: daemon fails loud when volume unwritable / state off-volume / creds unresolvable / relayer unreachable / running as root — extends `doctor`. | No | S5 |
| C6 | Surface loop-completion + impl-state cadence on `/v1/status` | `feat` | Headless visibility needs SSH `measure-learning.sh`; AC: `/v1/status` carries phase-completion rollup + impl-state cadence, empty case = zeroes. | No | S6 |
| C7 | Consolidated container-native base image | `refactor` (on #951, or own child) | Three near-identical Dockerfiles → one base (no VOLUME, non-root, pinned, env-auth, `JINN_STATE_DIR=/data`); AC: build + `docker inspect`/run invariants pass. | **Yes** | S7 |
| C8 | Thin per-harness overlays + one deploy path; retire measure-learning.sh | `chore` | Per-target Dockerfiles → ~4-line `FROM jinn-base` overlays + one README + Railway template; AC: codex+claude both FROM base, no daemon-correctness bash in entrypoint, regression-reference test green, `measure-learning.sh` deleted. | **Yes** | S8 |

(If a maintainer prefers fewer issues, C7+C8 collapse into #951 itself as its two terminal slices.)

## §7 — Regression-reference note

`deploy/railway-launcher-operator/` (once merged via #952) is the **golden behavioral reference**: it is the only image that currently solves the full gotcha set, and its entrypoint encodes the deployment contract operators depend on. The strangler discipline: **the consolidated base + thin launcher overlay (S7/S8) must reproduce that observable behavior before the old launcher Dockerfile is removed.** The pinning container-surface integration test (in S8) boots the new launcher overlay through the same env-seed inputs the #952 launcher used and asserts the daemon reaches the identical launched/generating state and the same `/v1/status` readouts — but with the four daemon-correctness bash lines absent, because S1–S4 moved those behaviors into the daemon. The reference design on the #952 branch (`docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md` §10 #1–2) explicitly left env-seed-launched-record and IPFS-fetch-pool as *open decisions* — this refactor resolves them (S4 + the S8 entrypoint contract), and the regression test proves the resolution is behavior-preserving.

## §8 — Risks + sequencing caveats

- **S3 back-compat (highest blast radius).** `JINN_STATE_DIR` changes default path-resolution for every operator config and the `e2e`/`staking` scripts. De-risk: **derive, don't collapse** — unset ⇒ byte-identical legacy defaults, asserted as a dedicated matrix case. Land S3 early so S4/S5/S7 build on a settled contract.
- **S4 hash-verify / never-overwrite (security + data-loss).** An unverified fetched pool is a poisoning vector; overwriting a newer local pool is data loss. De-risk: verify `hashVettedPoolArtifact` against the on-chain ref (explicit bad-hash-rejected test), honor `validatedNewer`, fall back to the existing fail-closed path. **Note the trust boundary:** the hash binds the fetched artifact to the on-chain ref (closing the IPFS-gateway-tampering / wrong-CID vector), but ref *authenticity* reduces to whoever holds the `setMetadata` write authority for that `manifestCid`. For a SolverNet that is the correct trust model (the manifest owner is the authority for their own pool); the residual assumption is named in open question §9.4.
- **Non-root Railway volume chown (S5/S7).** Railway mounts `/data` as root. De-risk: ship **both** — `USER node` default + minimal gosu chown shim; S5's writable-volume + non-root checks are the fail-loud guard.
- **#952 gate slippage.** If #952 stalls, S1–S6 still ship full value. If GHCR is unreachable, S7 falls back to the ARG-Dockerfile. The gate is on #952 merging, not on GHCR availability.
- **Slice budget.** S3/S4/S5 sit near the ~200-LOC ceiling — pre-identified split points named per slice; decide at slice start.

## §9 — Open questions deferred to the DR (ratification needed)

1. **GHCR base vs. ARG-Dockerfile** — is the GHCR publish reachable/public enough to depend on, or bridge via the single ARG-Dockerfile first?
2. **Non-root posture** — ratify image-default `USER node` + minimal gosu chown shim, vs. host-side volume chown.
3. **`JINN_STATE_DIR` naming + derivation precedence** — confirm derive-don't-collapse; confirm `workingDirRoot` stays ephemeral (not under `$JINN_STATE_DIR`).
4. **A4 artifact-CID resolution path** — read the on-chain metadata directly by `manifestCid` (`IdentityRegistry.getMetadata`, i.e. read what `setMetadata` wrote), vs. extend the DiscoveryAPI `PublishedArtifact` read-shape (currently plugin-only). Either way, ref authenticity reduces to the on-chain write authority for that `manifestCid` (see §8 trust-boundary note).
5. **`CLAUDE_CODE_OAUTH_TOKEN` headless lifecycle** — does the token survive container restarts or need periodic refresh? A5's credential check can assert presence but not fix expiry.
6. **Codex recipe fate** — keep as a second reference overlay (recommended) vs. deprecate.
7. **#951 scope vs. child issues** — resolved above (§6): split A3–A6 as `fix`/`feat` children, A1/A2/A7 stay on #951. The DR ratifies this.

## §10 — What this design pass does NOT do

- It does not implement any slice. No daemon code, no Dockerfiles, no entrypoints changed.
- It does not file the child issues (C1–C8) — that is the human's carve-up step after ratification.
- It does not unblock the #952 dependency — PR #952 must merge before S7/S8.
- **It deliberately excludes the AI-units recalibration follow-up.** The #951 body names a separate related item — the AI-units gate meters *claims* not *spend* (`projectAiUnits` books a flat 30 units/claim vs. a measured ~$1.36/learn-loop). That is its own issue and is **out of scope** here. A6 covers *displaying* ai-units consumption on `/v1/status` (already present via #815); it does **not** recalibrate the metering.
