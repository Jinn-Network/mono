/**
 * Daemon-side freeze-fence for the Harness `mode: 'train' | 'frozen'`
 * contract. When `ctx.mode === 'frozen'`, the daemon snapshots
 * `implStateDir`, runs the harness, and verifies the post-run hash
 * matches the pre-run hash. Mismatch → envelope rejected, snapshot
 * restored.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 */

import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir, harnessHashOptions } from '../harnesses/freeze.js';
import type { Harness, HarnessContext, Solution } from '../harnesses/types.js';

export interface FreezeViolation {
  taskId: string;
  harnessName: string;
  harnessVersion: string;
  stateHashBefore: string;
  stateHashAfter: string;
  detectedAt: number;
}

export type FenceResult =
  | { ok: true; output: Solution; codeDigest: string }
  | { ok: false; violation: FreezeViolation };

/**
 * Wraps `harness.run(ctx)` with the freeze-fence behaviour:
 *
 *   - `ctx.mode === 'train'`: no fence overhead. Run the harness and
 *     compute the post-run codeDigest from the (now-mutated) implStateDir.
 *
 *   - `ctx.mode === 'frozen'`: hash implStateDir before, snapshot to a
 *     temp dir, run the harness, hash again. Mismatch → roll back from
 *     snapshot, return `{ ok: false, violation: ... }` so the caller
 *     skips envelope submission. Match → succeed and return the
 *     pre-hash as the codeDigest (stable for the frozen window).
 *
 * If the harness throws inside frozen mode, the snapshot is restored
 * defensively (covers partial writes before the throw).
 */
export async function runHarnessWithFreezeFence(
  harness: Harness,
  ctx: HarnessContext,
): Promise<FenceResult> {
  // The digest this returns is also the delivery envelope's `codeDigest`
  // (`harnesses/engine/engine.ts`), so this single resolution fixes the fence
  // identity and the on-chain identity together.
  const hashOpts = harnessHashOptions(harness);

  if (ctx.mode === 'train') {
    const output = await harness.run(ctx);
    const codeDigest = await hashImplStateDir(ctx.implStateDir, hashOpts);
    return { ok: true, output, codeDigest };
  }

  // Frozen mode: snapshot, run, verify, rollback if needed.
  const stateHashBefore = await hashImplStateDir(ctx.implStateDir, hashOpts);
  const snapDir = await mkdtemp(join(tmpdir(), 'jinn-freeze-snap-'));
  await cp(ctx.implStateDir, snapDir, { recursive: true });

  try {
    const output = await harness.run(ctx);
    const stateHashAfter = await hashImplStateDir(ctx.implStateDir, hashOpts);

    if (stateHashAfter !== stateHashBefore) {
      // Violation: rollback and return error.
      await rm(ctx.implStateDir, { recursive: true, force: true });
      await cp(snapDir, ctx.implStateDir, { recursive: true });
      await rm(snapDir, { recursive: true, force: true });
      return {
        ok: false,
        violation: {
          taskId: ctx.task.id,
          harnessName: harness.name,
          harnessVersion: harness.version,
          stateHashBefore,
          stateHashAfter,
          detectedAt: Date.now(),
        },
      };
    }

    // Hashes match: contract honoured, codeDigest is the (stable) pre-hash.
    await rm(snapDir, { recursive: true, force: true });
    return { ok: true, output, codeDigest: stateHashBefore };
  } catch (err) {
    // Defensive rollback even on throw.
    await rm(ctx.implStateDir, { recursive: true, force: true }).catch(() => {});
    await cp(snapDir, ctx.implStateDir, { recursive: true });
    await rm(snapDir, { recursive: true, force: true });
    throw err;
  }
}
