/**
 * Single-source-of-truth guard (#820 Step 2).
 *
 * #817 ships the canonical held-out slate as a JSON artifact under operator/.
 * #820 embeds the same membership in the SDK so the indexer (which cannot
 * import operator/) can slate-scope frozenResolvedRate. We do NOT physically move
 * the artifact, so the two copies could drift. This test asserts the SDK's
 * embedded instanceId Set and content hash are byte-identical to the client
 * artifact, so any divergence fails CI loud.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  loadHeldOutSlate,
  HELD_OUT_SLATE_V1,
} from '../../src/solvernets/swe-rebench-v2-held-out-slate.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientArtifactPath = resolve(
  here,
  '../../../../operator/src/solver-types/slates/held-out-slate.swe-rebench-v2.v1.json',
);

describe('held-out slate cross-source parity (SDK ↔ client)', () => {
  const clientArtifact = JSON.parse(readFileSync(clientArtifactPath, 'utf8')) as {
    instanceIds: string[];
    hash: string;
    version: string;
    solverType: string;
  };

  it('SDK embedded instanceId set === client artifact instanceIds', () => {
    const slate = loadHeldOutSlate('v1');
    expect([...slate.instanceIds].sort()).toEqual([...clientArtifact.instanceIds].sort());
  });

  it('SDK declared hash === client artifact hash', () => {
    expect(HELD_OUT_SLATE_V1.hash).toBe(clientArtifact.hash);
  });

  it('SDK version + solverType === client artifact', () => {
    expect(HELD_OUT_SLATE_V1.version).toBe(clientArtifact.version);
    expect(HELD_OUT_SLATE_V1.solverType).toBe(clientArtifact.solverType);
  });
});
