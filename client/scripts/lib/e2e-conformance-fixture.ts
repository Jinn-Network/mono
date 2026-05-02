/**
 * Conformance fixture for the e2e gate (Phase 8c).
 *
 * Builds a known-good portfolio.v0 restoration envelope in-process so the
 * e2e script can run `runConformance` without hitting real IPFS. The fixture
 * is identical to the one used in unit tests — the e2e just proves the harness
 * works in the full production-code environment.
 */

import { buildGoodTrajectoryFixture } from '../../test/conformance/fixtures/good-trajectory.js';
import {
  buildGoodRestorationFixture as buildEnvFixture,
  type RestorationFixture,
} from '../../test/conformance/fixtures/good-envelope.js';
import type { Task } from '../../src/types/task.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';

export interface E2eConformanceFixture {
  envelopeCid: string;
  envelopeBytes: Uint8Array;
  task: Task;
  envelope: SignedEnvelope;
  trajectory: unknown;
}

export async function buildGoodRestorationFixture(): Promise<E2eConformanceFixture> {
  const fx: RestorationFixture = await buildEnvFixture();
  const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
  return {
    envelopeCid: fx.envelopeCid,
    envelopeBytes: fx.envelopeBytes,
    task: fx.task,
    envelope: fx.envelope,
    trajectory: traj,
  };
}
