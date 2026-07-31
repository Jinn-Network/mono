import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BenchOutcome {
  instanceId: string;
  arm: string;
  repeat: number;
  /** null = ungradeable (never coerced to fail — mirrors ArmResult in packages/layer/src/measurement.ts). */
  passed: boolean | null;
  unscorable: boolean;
  costUsd: number;
}

export interface BenchManifest {
  version: 'skills-bench-manifest.v1';
  /** Present for a --slate run; absent for a --task-set run (see
   *  `taskSetSha256`). Exactly one of the two is set for any real manifest —
   *  optional (not a union) so both paths share one `BenchManifest` shape
   *  and `assertManifestCompatible`'s byte-exact JSON guard needs no change. */
  slateSha256?: string;
  /** Present for a --task-set run (`SkillTaskSetV1.sha256`); absent for a
   *  --slate run. */
  taskSetSha256?: string;
  /** Which slate half this run actually covers. Recorded by run-bench.ts at
   *  the moment the run starts (not hand-typed later) so render-receipts.ts
   *  can derive the receipt's slateHalf from the manifest instead of trusting
   *  an operator-supplied --half flag that could silently disagree with what
   *  was actually run (final-review.md C2). */
  half: 'feedback' | 'holdout' | 'both';
  model: string;
  arms: { name: string; skillSha256: string | null }[];
  /** --task-set only: whether this run honored the discrimination gate (spec
   *  §2.4) — `false` when `--include-screened-out` was passed. Absent for a
   *  --slate run (no discrimination gate there). Binds the byte-exact
   *  manifest guard to the screening decision: without this (and
   *  `eligibleTaskIds` below), a screened run and an
   *  `--include-screened-out` run against the same --out dir would render
   *  byte-identical manifests despite measuring a different task population
   *  (final-review C1) — `assertManifestCompatible` would silently accept
   *  the second run as a resume of the first instead of refusing it. */
  screeningRespected?: boolean;
  /** --task-set only: sorted task ids actually eligible for measurement in
   *  this run — the discrimination-gate selection (spec §2.4,
   *  `selectTasksForMeasurement`) BEFORE any `--max-instances` slice. Absent
   *  for a --slate run. */
  eligibleTaskIds?: string[];
  /** Set only on a --dry-run manifest — the outcomes it guards are
   *  synthesized, not real solves/grades. render-receipts.ts refuses to
   *  render from a run dir carrying this flag, and the byte-exact manifest
   *  guard (assertManifestCompatible) makes a real run collide with a
   *  dry-run manifest in the same --out dir rather than silently resuming
   *  fabricated outcomes. */
  dryRun?: true;
  /** Final-review I4: `git rev-parse HEAD` of the repo, captured by
   *  run-bench.ts at the moment this run started — the exact rig commit
   *  that produced this manifest's outcomes, so a reader can pin it and
   *  reproduce the run (see bench/skills-repo-template/rig/README.md's
   *  "Reproduce" claim). `'unknown'` when `git rev-parse` itself failed
   *  (loud-logged, never blocks the run). Optional for back-compat with
   *  manifests written before this field existed — every manifest a current
   *  run-bench.ts writes carries it. */
  rigCommit?: string;
}

export function attemptKey(o: { instanceId: string; arm: string; repeat: number }): string {
  return `${o.instanceId}|${o.arm}|${o.repeat}`;
}

export async function appendAttempt(file: string, o: BenchOutcome): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(o)}\n`);
}

export async function loadAttempts(file: string): Promise<BenchOutcome[]> {
  if (!existsSync(file)) return [];
  const byKey = new Map<string, BenchOutcome>();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as BenchOutcome;
    byKey.set(attemptKey(o), o); // later wins — a rerun supersedes
  }
  return [...byKey.values()];
}

export async function assertManifestCompatible(file: string, manifest: BenchManifest): Promise<void> {
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const existing = await readFile(file, 'utf8');
  const wanted = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existing !== wanted) {
    throw new Error(
      `skills-bench manifest mismatch: ${file} was written by a different configuration ` +
      `(slate, model, or arm bytes changed). Use a fresh --out dir for a changed run.`,
    );
  }
}
