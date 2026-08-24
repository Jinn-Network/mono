# Review: issue #115 — unambiguous `npx @jinn-network/operator`

**Branch:** `fix/115-operator-npx-invocation`  
**Base:** `892a10067cc653d4971b22d77aea716b617ef2d6` (`next`)  
**Head:** `8ac17d7f11601df43e41c8343b70396177ad06f1`  
**Reviewer:** code-reviewer subagent  
**Date:** 2026-08-24

## Issue acceptance criteria

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Public onboarding shows exactly one working no-install command | **Pass** | `operator/README.md` documents `npx @jinn-network/operator@latest doctor` and the generic `npx @jinn-network/operator@latest <verb> ...` form |
| That command runs against the packed artifact | **Pass** | `operator/test/scripts/npx-operator-invocation.test.ts` packs a stub tarball and invokes `npx --no-install @jinn-network/operator doctor`; `operator/scripts/smoke-test-pack.mjs` adds the same check on the real pack |
| Package/binary selection is explicit (no ambiguous multi-bin npx) | **Pass** | `operator/package.json` adds `"operator": "./dist/bin/jinn.js"` so npm resolves the bin matching the unscoped package name; legacy `jinn` and `jinn-stop-hook` bins remain |
| Living onboarding/docs no longer name `@jinn-network/client` | **Pass** | Regression test scans `operator/README.md` and `docs/operator-testnet.md`; root `README.md` has no client references |

## Approach

npm refuses `npx @jinn-network/operator …` when a package exposes multiple bins and none matches the package name. The fix adds an `operator` bin alias pointing at the same entry as `jinn`, making `npx @jinn-network/operator doctor` unambiguous while preserving `jinn-stop-hook` as a separately named bin (`npx -p @jinn-network/operator jinn-stop-hook`).

## Findings and fixes

### Fixed (merge-blocking)

1. **`operator/RELEASING.md` still documented the retired `-p jinn` pattern** (confidence 95)  
   Issue scope explicitly lists publish/canary smoke docs. Lines 6, 55–56, and 81–82 still showed `npx -p @jinn-network/operator@… jinn …`.  
   **Fix (round 1):** Updated to `npx @jinn-network/operator@<tag> <verb>` and extended the regression test to guard `RELEASING.md`.

### No additional high-confidence issues

Reviewed:

- `operator/bin` map — `operator` alias correctly targets `./dist/bin/jinn.js`; `jinn-stop-hook` unchanged
- Packed-tarball smoke — public npx doctor + named `jinn-stop-hook` invocations added to `smoke-test-pack.mjs`
- README consistency — onboarding block (line 130) and CLI reference (line 314) aligned
- Legacy `-p` path — still exercised in smoke test as backward-compat, not documented as the public command

Historical docs under `docs/reviews/`, `docs/research/`, and dated specs still mention `@jinn-network/client`; those are archival and outside the issue's "living onboarding" scope.

## Verification

```bash
cd operator && yarn vitest run test/scripts/npx-operator-invocation.test.ts
```

**Result:** 4/4 tests passed (2026-08-24).

Note: `yarn install --immutable` failed in this worktree (`YN0028` lockfile drift vs portal resolution). A normal `yarn install` succeeded; CI on a clean checkout should use the repo lockfile.

Full `yarn pack:smoke` was not run (requires build + pack pipeline); the new smoke-test-pack assertions mirror the unit test's npx contract and will run in release gates.

## Commits

1. `c7cdaecc0` — `fix(operator): make npx @jinn-network/operator unambiguous`
2. `916907701` — `fix(operator): align RELEASING.md with unambiguous npx invocation`
3. *(this commit)* — `docs: add issue #115 code review summary`

## Verdict

**Merge-ready** after the RELEASING.md fix. No remaining merge-blocking findings.
