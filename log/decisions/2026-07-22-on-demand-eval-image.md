# DR-2026-07-22 — On-demand eval image for arbitrary public repo @ commit (#1640)

- **ID:** DR-2026-07-22
- **Date:** 2026-07-22
- **Status:** accepted (architecture); live empirical AC deferred to follow-on `feat`
- **Issue:** [#1640](https://github.com/Jinn-Network/mono/issues/1640)
- **Shape:** spike finding (Stages 1–2 only; no product merge from this session)

## Finding

**Keep the shipped Jinn execution stack. Discover recipes in ladder order; do not extend the SWE-rebench image builder as the primary path.**

Admission-grade eval images for public repos outside `validated-pool.json` must come from:

`EnvironmentBuildRecipeV1` → `DockerBuildxEnvironmentBuilder` → digest-qualified publish → explicitRecipe / minted-pool v2 harvest

Discovery order (same ladder as the approved public-repo substrate design):

1. **Explicit** presets / operator recipes (already shipped) — first proof target.
2. **Deterministic** recipe resolver (metadata → `EnvironmentBuildRecipeV1`, fail closed to `awaiting_input`) — substrate milestone E.
3. **Agentic** SWE-smith-class / RepoLaunch env machinery — deferred to substrate milestone F / rung 4.

The three handoff options (extend Rebench builder / generic Python + loose `install_config` / fork SWE-smith env) mainly differ on **discovery**. The **execution** half is already in-tree; this DR locks that split.

## Decision criteria (issue order)

| Criterion | Winner (Jinn stack + ladder) | Option A (extend Rebench builder) | Option B (literal generic Python + install_config) | Option C (SWE-smith env machinery) |
|---|---|---|---|---|
| **1. Admission yield** (5 sample fix-commits) | Strong once explicit proof lands; then deterministic expands coverage. Not claimed for 5 unfamiliar commits in this spike. | Strong for Python Rebench-like repos; **weak for jinn-mono** (TS/Yarn/Vitest). | Moderate on simple Python; **fails jinn-mono / unjs/destr** without generalizing. | Potentially high *after* agentic discovery + human verify — not a CI-automatic admit bar. |
| **2. Solver-side reproducibility** | Strong: digest-qualified `TaskEnvironmentSpecV1`, trusted parsers, verdict-time digest recheck (DR-2026-05-14). | Good *if* digest-pinned; today's pool often tag-shaped `imageName` + separate digest. | Weak if deps install at eval time; strong only if inference emits a recipe into the Jinn builder. | Good once an image exists (one image per repo); still must normalize into TaskEnvironmentSpec + trusted parsers. |
| **3. Build cost** | Best potential: thin bases + one image per `(repo, baseCommit, recipeHash, platform)`. | High (~3 GB / instance Rebench baseline; per-instance sprawl). | Best *potential* if scoped as recipe→bake; bad if non-hermetic install-at-eval. | Image size better than per-instance Rebench; wall-clock dominated by agentic discovery. |
| **4. Maintenance surface** | Own one stack already shipped. | **Worst** — second build stack beside Buildx; diverges from rights gates / parser allowlist. | Small if heuristics + fail-closed; large if unowned “guess the build”. | High Python surface; conflicts with “generator never builds environments” unless wrapped as agentic resolver. |

**Primary path:** winner column. **Reject A as primary.** **Promote B** into deterministic resolver feeding the Jinn builder (not a parallel Python eval path). **Defer C** as agentic provider behind spend caps + `awaiting_input` for parser review.

## What is already shipped

- Contracts: `EnvironmentBuildRecipeV1`, `TaskEnvironmentSpecV1`, digest-qualified images (`client/src/task-creator/environment/contracts.ts`).
- Buildx builder + publication controller (rights → build → scan → SBOM → push → attest → IPFS).
- Explicit presets: `JINN_MONO_RECIPE_V1`, `UNJS_DESTR_RECIPE_V1`; resolvers are **explicit only** today.
- Harvest `repos[].explicitRecipe` bootstrap (`parseExplicitRecipeBootstrap`) when a pre-published environment binding exists.
- Fixture identities for dogfood (outside validated pool): `JINN_MONO_DIFFERENTIAL_PROOF_SOURCE` (`ae8093a8…` / `ef960887…`), `JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE` (`c7701007…` / `5b76bade…`), `UNJS_DESTR_PUBLIC_REPO_PROOF`.
- Runbooks: `docs/runbooks/task-creator-environment-publish.md`, `docs/runbooks/task-creator-public-repo-proof.md` (architecture ready; live differential receipt historically blocked on operator publish / attester config).

Invariant retained: builder never receives gold / fix commit — recipe source is **baseCommit only**.

## What remains (follow-on `feat`, not this spike)

1. **Live AC gate** — admit a minted instance for a public repo ∉ `validated-pool.json` with a freshly built image + pinned digest, and record wall-clock + image size (primary target: jinn-mono via explicit recipe).
2. **Harvest bootstrap without `findSourceInstanceForRepo`** when a recipe can be resolved (handoff WP3).
3. **Deterministic resolver** (milestone E) after the explicit proof.
4. **Agentic resolver** (milestone F / option C) deferred.

Plan: [`docs/superpowers/plans/2026-07-22-on-demand-eval-image.md`](../../docs/superpowers/plans/2026-07-22-on-demand-eval-image.md).

## Explicit non-claims (this spike session)

- **No live 5-commit admission yield** was measured. That bar belongs to the deterministic-resolver feat after the first explicit proof.
- **No live Docker AC** (wall-clock, image size, digest stability, second-machine grade) was recorded in this session. Stage 1 found Docker CLI unresponsive in the attempt environment; this Stage 2 does not re-run builds. Architecture is accepted; empirical admit remains a **proof gate** on the follow-on feat / operator runbook.
- Spike code that would merge as finished product was **not** produced. Artifacts are this DR + the follow-on plan only.

## Rejected / deferred

- **Option A as primary** — extend / vendor SWE-rebench (or SWE-bench-style) per-instance image construction as the default public-repo path. Optional thin **compatibility adapter** later if a true Rebench-shaped external image must bind into minted-pool v2.
- **Option B as literal scope** — generic Python base + loose `install_config.install` at eval time without baking through `EnvironmentBuildRecipeV1`.
- **Option C for the first unlock** — SWE-smith `build_repo` / RepoProfile agentic discovery as the feat that first unlocks public-repo minting (keep for milestone F).
- Per-repo SolverTypes; RepoLaunch-as-native format; building images inside the long-running daemon process (keep disposable builder / publish controller).

## Revisit triggers

- Explicit jinn-mono (or equivalent) live proof repeatedly fails for reasons the Jinn builder cannot fix without a second substrate — reopen option A **only** as a compatibility adapter for Rebench-shaped images, not as a replacement ladder.
- Deterministic resolver yield on a documented 5-commit sample stays near zero after a good-faith heuristics pass — escalate to agentic resolver (F) earlier than planned, still behind spend caps + human parser verify.
- Maintenance cost of the deterministic heuristics exceeds owning a thin adapter to an upstream builder for a narrow language class — document in an amendment DR before changing the primary path.

## References

- Parent design (architecture SoT): `docs/superpowers/specs/2026-07-10-task-creator-public-repo-substrate-design.md`
- Handoff WP2/WP3: `docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md`
- Related DRs: `log/decisions/2026-07-09-swe-smith-spike-task-creator.md` (machinery yes, dataset no); `log/decisions/2026-05-14-swe-rebench-eval-admission.md` (digest / rowHash recheck)
- Spec: `spec/2026-07-08-task-creator-v0.md`
- Spike origin in e2e plan Task 10: `docs/superpowers/plans/2026-07-13-task-creator-real-usage-e2e.md`
- Follow-on implementation plan: `docs/superpowers/plans/2026-07-22-on-demand-eval-image.md`
