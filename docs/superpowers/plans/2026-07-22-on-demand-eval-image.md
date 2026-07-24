# On-Demand Eval Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close handoff WP2/WP3 for public-repo minting outside `validated-pool.json` by completing the live admission AC on the shipped Jinn Buildx path, then bootstrap harvest without `findSourceInstanceForRepo` when a recipe resolves, then add the deterministic recipe resolver — deferring agentic discovery.

**Architecture:** Per [DR-2026-07-22](../../log/decisions/2026-07-22-on-demand-eval-image.md): execution stays `EnvironmentBuildRecipeV1` → Buildx → digest-qualified publish → explicitRecipe / minted v2. Discovery ladder is explicit → deterministic → agentic. No second image-builder substrate; do not vendor SWE-rebench builders; do not build images inside the long-running daemon.

**Tech Stack:** TypeScript, Docker Buildx (linux/amd64), GHCR, IPFS, EIP-191 attestation, Vitest, existing harvest / minted-pool v2 paths.

**Authority:** Human-ratified on 2026-07-24 by DR-2026-07-22 (#1640 spike). Implements substrate milestones remaining after A–D (explicit proof + E deterministic; F deferred).

## Global Constraints

- Base: `next`; PRs are `feat(task-creator): …` targeting `next`.
- New evaluator environments are **linux/amd64** and **digest-pinned** (`DigestQualifiedImageV1`).
- Builder input never includes `fixCommit`, gold-patch data, or test-patch content — recipe source is **baseCommit only**.
- Public-repo rows use `swe-rebench-v2-minted-pool.v2` and `rowHashVersion: 2`; verdict-time digest / environment / parser recheck stays fail-closed (DR-2026-05-14).
- `EVAL_SEMANTICS_VERSION` remains `4`. No generator selection, quota, escrow, claim, or `MechAdapter.postTask` behavior change.
- Do **not** claim live AC until wall-clock, image size, digest, and mint receipt exist as real artifacts (no fabricated receipts).
- All feature behavior is TDD: focused test fails before production code.
- Prefer stacked PRs if any layer exceeds ~300 LOC.

## File map

| Path | Role |
|---|---|
| `client/scripts/task-creator-on-demand-image-proof.ts` (or extend publish / differential scripts) | Records wall-clock, `docker image inspect` Size, digest; writes proof report JSON |
| `docs/runbooks/task-creator-on-demand-image.md` | Operator AC procedure |
| `client/src/task-creator/environment/deterministic-resolver.ts` | Metadata → `EnvironmentBuildRecipeV1` (fail closed) |
| `client/test/task-creator/environment/deterministic-resolver.test.ts` | Resolver unit coverage |
| `client/src/task-creator/environment/resolver.ts` / `recipes.ts` / `policy.ts` | Register deterministic after explicit; base allowlist growth |
| `client/src/daemon/harvest-loop.ts` | Resolve → publish/reuse → bind when no source instance / no inline explicitRecipe |
| `client/src/solver-types/_swe-rebench-v2-harvest.ts` | Bootstrap without HF source (WP3); keep `findSourceInstanceForRepo` for Rebench-backed echo |
| `client/src/solver-types/_swe-rebench-v2-session-echo.ts` | Same bootstrap once harvest proves it |
| `docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md` | Mark WP2 decided; remaining E/F |
| `docs/superpowers/specs/2026-07-10-task-creator-public-repo-substrate-design.md` | Cross-link DR; milestone status |
| `spec/2026-07-08-task-creator-v0.md` | Cross-link DR; clarify rung 1.5 / 4a status |

**Do not create:** vendored SWE-rebench `build_images` trees; SWE-smith HF dataset adapters; per-repo SolverTypes.

## Suggested issue split

| Issue | Type | Scope |
|---|---|---|
| **[#2110](https://github.com/Jinn-Network/mono/issues/2110) — Live explicit AC** | `feat` | Tasks 1–2 below (proof script + runbook + recorded metrics on jinn-mono). Closes #1640 AC empirically. |
| **[#2112](https://github.com/Jinn-Network/mono/issues/2112) — Harvest bootstrap without source row** | `feat` | Task 3 (WP3). Depends on #2110's environment binding existing or publish-on-demand reuse. |
| **[#2111](https://github.com/Jinn-Network/mono/issues/2111) — Deterministic resolver** | `feat` | Tasks 4–5 (milestone E). Depends on #2110's proof pattern; optional after #2112. |
| **Defer — Agentic resolver** | `spike` or later `feat` | Milestone F / option C. **Out of this plan's merge scope.** |

The three bounded Issues were filed at ratification time. Do not reopen #1640's three options casually (DR stands), and do not file the agentic resolver until the revisit trigger is met.

---

### Task 1: Proof report schema + on-demand image proof script

**Files:**
- Create: `client/scripts/task-creator-on-demand-image-proof.ts`
- Create: `client/test/task-creator/on-demand-image-proof.test.ts` (hermetic: schema / CLI arg parsing / fail-closed when Docker absent)
- Modify: `client/package.json` (script entry, e.g. `task-creator:on-demand-image-proof`)
- Prefer reuse of: `client/scripts/task-creator-environment-publish.ts`, `client/src/task-creator/proofs/public-repo-fixtures.ts`

**Interfaces:**
- Consumes: `JINN_MONO_RECIPE_V1` / `resolveJinnMonoRecipeV1` (or equivalent), publication controller outputs, fixture `JINN_MONO_DIFFERENTIAL_PROOF_SOURCE` (`baseCommit` `ae8093a8848e70e581f46d66dcdb56789c0808a3`, `fixCommit` `ef9608876511b4dff000cda1537ff7c1a227677d`).
- Produces proof report JSON (suggested shape):

```ts
type OnDemandImageProofReportV1 = {
  schema: 'jinn.on-demand-image-proof.v1';
  repo: string;                 // e.g. Jinn-Network/mono
  baseCommit: string;
  platform: 'linux/amd64';
  image: { reference: string; digest: `sha256:${string}` };
  metrics: {
    wallClockMs: number;        // git fetch + install + smoke + push (as measured)
    imageSizeBytes: number;     // docker image inspect Size
  };
  environmentCid?: string;
  environmentHash?: string;
  comparedToRebenchBaselineGb?: number; // optional note field; ~3 from docs, not a live pull
  recordedAt: string;           // ISO-8601
};
```

- [ ] **Step 1:** Write failing tests for report schema validation and CLI rejection when required publish outputs / Docker inspect fields are missing.
- [ ] **Step 2:** Implement script wrapping publish (or consuming a prior publish output) + inspect + atomic report write. No fabricated digests.
- [ ] **Step 3:** Run focused tests; commit `feat(task-creator): on-demand image proof report script`.

### Task 2: Operator runbook + live AC recording (Feat A gate)

**Files:**
- Create: `docs/runbooks/task-creator-on-demand-image.md`
- Modify: `docs/runbooks/task-creator-environment-publish.md` (link)
- Modify: `docs/runbooks/task-creator-public-repo-proof.md` (link; keep honesty about prior blockers)
- Modify: `docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md` (WP2 → decided per DR-2026-07-22)

**AC (must all be true before claiming #1640 empirical close):**

1. Public repo **not** in operator `validated-pool.json` scorable set (jinn-mono qualifies).
2. Freshly built **linux/amd64** image via Jinn publication path.
3. **Pinned digest** on the minted / bound environment.
4. **Admitted minted instance** (differential path preferred: gold resolves + known-bad fails with `vitest-json.v1`).
5. **Wall-clock + image size** written into the proof report from Task 1.
6. Optional but preferred: second-machine (or second daemon) `docker pull` by digest and grade gold — solver-side reproducibility.

- [ ] **Step 1:** Document exact operator sequence (credentials, attester policy, publish, proof script, harvest/differential admit, where artifacts land).
- [ ] **Step 2:** Run live only when GHCR + IPFS + signer + amd64 Docker are available. If blocked, leave runbook + script green and record the blocker — do not invent a receipt.
- [ ] **Step 3:** Commit docs (and any checked-in redacted sample report path policy). Commit message: `docs(task-creator): on-demand eval image proof runbook`.

**Verification:** Proof report file exists with real digest + size + wallClockMs; minted-pool v2 row or differential receipt binds that digest; repo absent from validated-pool scorable probe.

### Task 3: Harvest / mint bootstrap without `findSourceInstanceForRepo` (WP3)

**Files:**
- Modify: `client/src/daemon/harvest-loop.ts`
- Modify: `client/src/solver-types/_swe-rebench-v2-harvest.ts`
- Modify: `client/src/solver-types/_swe-rebench-v2-session-echo.ts` (only after harvest path is proven; same bootstrap)
- Modify: focused harvest / session-echo tests under `client/test/`

**Interfaces:**
- When no scorable source instance **and** no inline `explicitRecipe`: resolve recipe (explicit preset first; later deterministic) → publish or reuse cached env by `(repo, baseCommit, recipeHash, platform)` → bind as explicitRecipe-equivalent for admission.
- Else fail closed: `awaiting_input` / existing `AWAITING_RECIPE_REQUIRED` disposition — never invent install_config.
- Keep `findSourceInstanceForRepo` for Rebench-backed commit-echo.
- Keep public-repo gate, denylist, held-out checks (spec §11).

- [ ] **Step 1:** Failing tests: candidate for jinn-mono-shaped repo with resolvable preset admits without pool source; unknown repo without recipe → awaiting / error string unchanged in spirit.
- [ ] **Step 2:** Implement resolve → bind path; cache reuse must key on recipe hash + baseCommit + platform.
- [ ] **Step 3:** Do **not** call Docker Buildx inside the long-running harvest tick process — invoke publish controller / disposable builder the same way the CLI does (or enqueue a job). Prefer reuse of already-published environments from Feat A.
- [ ] **Step 4:** Focused tests green; commit `feat(task-creator): harvest bootstrap without HF source row`.

### Task 4: Deterministic recipe resolver (milestone E)

**Files:**
- Create: `client/src/task-creator/environment/deterministic-resolver.ts`
- Create: `client/test/task-creator/environment/deterministic-resolver.test.ts`
- Modify: `client/src/task-creator/environment/resolver.ts`
- Modify: `client/src/task-creator/environment/recipes.ts` (if shared helpers)
- Modify: `client/src/task-creator/environment/policy.ts` (approved base allowlist growth only when needed)

**Interfaces:**
- `EnvironmentRecipeResolver` with confidence `deterministic`.
- Input: public repo metadata (package manifests, Dockerfile, CI, language conventions) — **not** gold/fix commits.
- Output: `EnvironmentBuildRecipeV1` **or** fail closed (no partial / guessed `install_config` at eval time).
- Register **after** explicit presets in the resolver chain.
- Language scope for v1: at least Node/Yarn|pnpm|npm + Vitest patterns that cover jinn-mono / unjs/destr classes; Python pyproject is allowed as an additional heuristic, not the only one.

- [ ] **Step 1:** Failing unit tests for: known fixture layouts → expected recipe shape; ambiguous / unsupported → null / awaiting, never throw-open admit.
- [ ] **Step 2:** Minimal heuristics implementation; smoke command required in recipe.
- [ ] **Step 3:** Wire into `createPresetEnvironmentRecipeResolvers()` (or successor factory) after explicit.
- [ ] **Step 4:** Focused tests; commit `feat(task-creator): deterministic environment recipe resolver`.

### Task 5: Deterministic yield sample + docs cross-links (optional bar, not Feat A blocker)

**Files:**
- Modify: `docs/runbooks/task-creator-on-demand-image.md` (appendix: 5-commit sample protocol)
- Modify: `docs/superpowers/specs/2026-07-10-task-creator-public-repo-substrate-design.md`
- Modify: `spec/2026-07-08-task-creator-v0.md` (cross-link DR; rung status)
- Modify: handoff WP2/WP3 status lines

**Protocol:** Mix of preset-covered + out-of-preset public repos; record admit/fail reasons. Do **not** block Feat A on this sample.

- [ ] **Step 1:** Document sample selection + scoring table template.
- [ ] **Step 2:** Run sample when operator time allows; attach results to the Feat C PR or a follow-up Issue.
- [ ] **Step 3:** Commit doc cross-links: `docs(task-creator): cross-link on-demand eval image DR`.

### Task 6: Explicitly deferred — agentic resolver (milestone F)

**Out of merge scope for this plan.**

- SWE-smith / RepoLaunch-class env construction remains the **agentic** provider behind spend caps + human parser verify (`awaiting_input`).
- File a separate `spike` or `feat` only when Feat C yield is insufficient per DR revisit triggers.
- Do not vendor SWE-smith dataset; do not make agentic the first unlock.

---

## Verification checklist (before claiming done)

- [ ] DR-2026-07-22 linked from runbook + substrate design + handoff.
- [ ] Live proof report exists with real `digest`, `imageSizeBytes`, `wallClockMs` for jinn-mono (or documented infra blocker — never a fake admit).
- [ ] Minted / differential path binds that digest; repo ∉ validated-pool scorable set.
- [ ] Harvest can mint without `findSourceInstanceForRepo` when recipe resolves (Feat B).
- [ ] Deterministic resolver fail-closed tests pass (Feat C).
- [ ] `yarn typecheck` and focused `yarn test` paths green for touched packages.
- [ ] No SWE-rebench image-builder tree added; no daemon-inline Buildx.

## Cost comparison note (for proof report / runbook)

Record Jinn recipe image size vs the documented Rebench baseline (~**3 GB** per instance from `docs/superpowers/specs/2026-05-21-swe-rebench-eval-cleanup-robustness-design.md`). Prefer measuring the Jinn image live; the Rebench figure may stay documentary unless a live pull is justified.
