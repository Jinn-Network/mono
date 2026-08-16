#!/usr/bin/env -S yarn tsx
/**
 * Pool + held-out-slate builder for the jinn-repo SolverType (Task P2.6).
 *
 * Two responsibilities:
 *
 *   1. `buildSlate` (unit-testable, pure) — turn a list of jinn-repo instance
 *      ids into a content-addressed `HeldOutSlateArtifact` the SHIPPED loader
 *      (`loadHeldOutSlate`) accepts. It reuses the loader's own
 *      `hashHeldOutSlateArtifact` so the declared `hash` matches the loader's
 *      recomputation byte-for-byte — no divergent reimplementation.
 *
 *   2. `main()` orchestration (NOT run in tests, an operator step) — fetch
 *      merged PRs of `Jinn-Network/mono` via `gh`, extract a pool item per
 *      candidate (real `git` against a local clone), gate each through
 *      `validateAdmissible` (real `runJinnRepoEval` — clones + installs), and
 *      write the admitted pool + a deterministic held-out slate to disk.
 *
 *      `main()` LOGS every rejection with its reason and a final
 *      admitted/rejected-by-reason summary. That rejection log is the only
 *      audit trail of what the pool excluded and why — it guards against
 *      silently shipping a slate biased toward easy / already-doable PRs.
 *
 * Run (operator only):
 *   yarn tsx scripts/build-jinn-repo-pool.ts [--held-out=K] [--limit=N]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HELD_OUT_SLATE_SCHEMA_VERSION,
  hashHeldOutSlateArtifact,
  type HeldOutSlateArtifact,
} from '../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import {
  selectCandidatePRs,
  extractPoolItem,
  type PrSummary,
} from '../src/solver-types/jinn-repo-extract.js';
import { validateAdmissible } from '../src/solver-types/jinn-repo-admit.js';
import { runJinnRepoEval } from '../src/harnesses/impls/jinn-repo-evaluator/eval-runner.js';
import type { JinnRepoPoolItem } from '../src/solver-types/_jinn-repo-pool.js';

const REPO = 'Jinn-Network/mono';
const SOLVER_TYPE = 'jinn-repo.v1';

// ---------------------------------------------------------------------------
// buildSlate — the unit-testable deliverable.
// ---------------------------------------------------------------------------

/**
 * Build a loader-conformant held-out slate. The returned object carries the
 * artifact fields PLUS a `hash` so `loadHeldOutSlate` validates it: the loader
 * recomputes `hashHeldOutSlateArtifact` over the canonicalised, sorted artifact
 * and fails loud if the declared `hash` differs. We compute the same hash here,
 * so a daemon reading this slate accepts it.
 *
 * `instanceIds` is sorted with the SAME comparator the loader's normalisation
 * uses (`localeCompare`) so the on-disk array is already canonical.
 */
export function buildSlate(
  instanceIds: string[],
  version: string,
  generatedAt: string,
): HeldOutSlateArtifact & { hash: `sha256:${string}` } {
  const artifact: HeldOutSlateArtifact = {
    schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
    solverType: SOLVER_TYPE,
    version,
    generatedAt,
    instanceIds: [...instanceIds].sort((a, b) => a.localeCompare(b)),
  };
  return { ...artifact, hash: hashHeldOutSlateArtifact(artifact) };
}

// ---------------------------------------------------------------------------
// main() orchestration — operator step, NOT run by the unit tests.
// ---------------------------------------------------------------------------

const sh = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** Fetch merged PRs of the mono repo via `gh`, mapped to `PrSummary`. */
async function ghListMergedPRs(limit: number): Promise<PrSummary[]> {
  const { stdout } = await sh(
    'gh',
    [
      'pr', 'list',
      '--repo', REPO,
      '--state', 'merged',
      '--limit', String(limit),
      '--json', 'number,files,closingIssuesReferences',
    ],
    { maxBuffer: MAX_BUFFER },
  );
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    files: Array<{ path: string }>;
    closingIssuesReferences: Array<{ number: number }>;
  }>;
  return raw.map((pr) => ({
    number: pr.number,
    files: (pr.files ?? []).map((f) => f.path),
    closingIssues: (pr.closingIssuesReferences ?? []).map((c) => c.number),
  }));
}

/** Resolve a PR's merge (or squash) commit sha via `gh`. */
async function ghMergeCommit(prNumber: number): Promise<string> {
  const { stdout } = await sh(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', REPO, '--json', 'mergeCommit'],
    { maxBuffer: MAX_BUFFER },
  );
  const parsed = JSON.parse(stdout) as { mergeCommit: { oid: string } | null };
  const oid = parsed.mergeCommit?.oid;
  if (!oid) throw new Error(`PR #${prNumber} has no merge commit`);
  return oid;
}

/** Fetch an issue's title + body via `gh`. */
async function ghFetchIssue(n: number): Promise<{ title: string; body: string }> {
  const { stdout } = await sh(
    'gh',
    ['issue', 'view', String(n), '--repo', REPO, '--json', 'title,body'],
    { maxBuffer: MAX_BUFFER },
  );
  const parsed = JSON.parse(stdout) as { title: string; body: string | null };
  return { title: parsed.title, body: parsed.body ?? '' };
}

/** Real `git` exec helper for `extractPoolItem` (runs in the local clone). */
function gitExec(repoDir: string): (cmd: string, args: string[]) => Promise<string> {
  return async (cmd, args) => {
    const { stdout } = await sh(cmd, args, { cwd: repoDir, maxBuffer: MAX_BUFFER });
    return stdout;
  };
}

async function main(): Promise<void> {
  const limit = Number(
    process.argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ?? '200',
  );
  const heldOutK = Number(
    process.argv.find((a) => a.startsWith('--held-out='))?.slice('--held-out='.length) ?? '10',
  );
  // Early-stop: stop scanning candidates once this many are admitted. Defaults
  // to Infinity (scan every candidate, the original behaviour). Bounds wall-clock
  // when only a small admitted pool is needed (each candidate runs two slow evals).
  const maxAdmitted = Number(
    process.argv.find((a) => a.startsWith('--max-admitted='))?.slice('--max-admitted='.length) ?? 'Infinity',
  );
  // Local clone of the mono repo against which `git show` / `git diff` run.
  // Operator points this at a checkout (env override, defaults to cwd's repo).
  const repoDir = process.env.JINN_MONO_DIR ?? process.cwd();
  // Clone source the admission evals fetch base_commit from. A local `file://`
  // checkout is far faster than GitHub https for the shallow per-commit fetch.
  const monoRepoUrl = process.env.JINN_MONO_REPO_URL ?? 'https://github.com/Jinn-Network/mono.git';
  const generatedAt = new Date().toISOString();

  const log = (s: string) => process.stderr.write(`${s}\n`);

  log(`[pool] fetching up to ${limit} merged PRs of ${REPO} via gh…`);
  const candidates = selectCandidatePRs(await ghListMergedPRs(limit));
  log(`[pool] ${candidates.length} candidate PRs (closing-issue + test-file touch)`);

  const admitted: JinnRepoPoolItem[] = [];
  const rejectedByReason = new Map<string, number>();
  let rejected = 0;

  for (const pr of candidates) {
    try {
      const mergeCommit = await ghMergeCommit(pr.number);
      const item = await extractPoolItem(pr, {
        exec: gitExec(repoDir),
        fetchIssue: ghFetchIssue,
        mergeCommit,
      });
      const verdict = await validateAdmissible(item, { run: runJinnRepoEval, monoRepoUrl });
      if (verdict.admitted) {
        admitted.push(item);
        log(`[pool] ADMIT  ${item.instance_id}: ${verdict.reason} (${admitted.length}${Number.isFinite(maxAdmitted) ? `/${maxAdmitted}` : ''})`);
        if (admitted.length >= maxAdmitted) {
          log(`[pool] reached --max-admitted=${maxAdmitted}; stopping candidate scan early`);
          break;
        }
      } else {
        rejected++;
        // Bucket by a coarse reason key so the summary stays readable even
        // when log excerpts vary; keep the full reason in the per-item line.
        const key = verdict.reason.split(':')[0]!.trim();
        rejectedByReason.set(key, (rejectedByReason.get(key) ?? 0) + 1);
        log(`[pool] REJECT ${item.instance_id}: ${verdict.reason}`);
      }
    } catch (e) {
      rejected++;
      const key = 'extract/eval error';
      rejectedByReason.set(key, (rejectedByReason.get(key) ?? 0) + 1);
      log(`[pool] REJECT PR#${pr.number}: ${key}: ${String(e)}`);
    }
  }

  // Deterministic held-out split: first K by sorted instance_id, train = rest.
  const sortedIds = admitted
    .map((i) => i.instance_id)
    .sort((a, b) => a.localeCompare(b));
  const heldOutIds = sortedIds.slice(0, heldOutK);
  const trainCount = sortedIds.length - heldOutIds.length;

  const here = dirname(fileURLToPath(import.meta.url));
  const solverTypesDir = join(here, '..', 'src', 'solver-types');
  // Output overrides let a build run to a scratch path without clobbering the
  // bundled pool/slate (e.g. while another process is reading the live pool).
  const poolPath = process.env.JINN_POOL_OUT ?? join(solverTypesDir, 'jinn-repo-pool.json');
  const slatesDir = join(solverTypesDir, 'slates');
  const slatePath = process.env.JINN_SLATE_OUT ?? join(slatesDir, 'held-out-slate.jinn-repo.v1.json');

  writeFileSync(poolPath, `${JSON.stringify(admitted, null, 2)}\n`);
  mkdirSync(slatesDir, { recursive: true });
  const slate = buildSlate(heldOutIds, 'v1', generatedAt);
  writeFileSync(slatePath, `${JSON.stringify(slate, null, 2)}\n`);

  // Final audit summary — mandatory.
  log('');
  log('[pool] ===== summary =====');
  log(`[pool] candidates: ${candidates.length}`);
  log(`[pool] admitted:   ${admitted.length}`);
  log(`[pool] rejected:   ${rejected}`);
  for (const [reason, count] of [...rejectedByReason.entries()].sort((a, b) => b[1] - a[1])) {
    log(`[pool]   - ${reason}: ${count}`);
  }
  log(`[pool] held-out:   ${heldOutIds.length} (first ${heldOutK} by sorted instance_id)`);
  log(`[pool] train:      ${trainCount}`);
  log(`[pool] wrote ${poolPath}`);
  log(`[pool] wrote ${slatePath}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
