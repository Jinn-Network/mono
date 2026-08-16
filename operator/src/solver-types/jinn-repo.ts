/**
 * jinn-repo SolverType task schema — thin re-export of the SDK's schema.
 *
 * The SDK copy (`packages/sdk/src/jinn-repo.ts`, exported via
 * `@jinn-network/sdk/solvernets/jinn-repo`) is the load-bearing schema at
 * claim time: `operator/src/harnesses/engine/engine.ts`
 * `manifestBackedValidation` resolves the SolverNet contract via
 * `getSolverNetContract` → `packages/sdk/src/contracts.ts`
 * `JINN_REPO_V1_SOLVER_NET_CONTRACT.schemas.task.zod`, which is the SDK
 * schema, and safeParses every claimed task spec against it. This module
 * used to hand-mirror that schema (zod v4 vs. the SDK's zod/v3); the two
 * copies could silently diverge in `z.preprocess` + `z.discriminatedUnion`
 * + `z.never().optional()` behavior between zod major-version APIs. See PR
 * #1898 review (issue #1889): collapsed to a single source of truth,
 * following the `swe-rebench-v2` sibling pattern.
 *
 * A discriminated union on `source`:
 *   - `merged-pr` (retrospective): a real merged GitHub PR from the
 *     Jinn-Network/mono repo. The instance is defined by the PR that
 *     introduced the fix; the FAIL_TO_PASS gold is the PR's own test files.
 *   - `live-issue` (prospective): an open GitHub issue on Jinn-Network/mono,
 *     posted before a fix exists. No gold tests — grading is Stage 1's thin
 *     mechanical evaluator (patch applies, typecheck, policy-scoped tests),
 *     not FAIL_TO_PASS exact-match. See
 *     spec/2026-07-20-autopilot-marketplace-execution.md
 *     §"No new SolverType: a live variant of jinn-repo".
 *
 * `schemaVersion` stays `'jinn-repo.v1'` on both branches and the solverType
 * string is unchanged — corpus knowledge autoload keys on solverType, so
 * merged-PR-mined knowledge continues to autoload into live solves.
 *
 * Backward compatibility: a raw document with no `source` field is legacy
 * data and is treated as `source: 'merged-pr'` (the only branch that existed
 * before this union).
 *
 * Export surface is byte-compatible with the pre-collapse module: other
 * client modules (`jinn-repo-definition.ts`, `_jinn-repo-pool.ts`, the
 * jinn-repo evaluator harness) import from this path by name — do not
 * rename or drop exports here without updating those call sites.
 */

export {
  JINN_REPO_SCHEMA_VERSION,
  JinnRepoTaskSchema,
  JinnRepoMergedPrTaskSchema,
  JinnRepoLiveIssueTaskSchema,
  isMergedPrTask,
  isLiveIssueTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';
export type {
  JinnRepoTask,
  JinnRepoMergedPrTask,
  JinnRepoLiveIssueTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';
