/**
 * The single-host solver backend's evidence-graph identities (#36 follow-up).
 *
 * `native-evaluator-assembly.test.ts` pins the fix for the evaluator leg of #36: passing one
 * agent IRI as BOTH `source` and `executor` makes `LocalTaskExecutionBackend` refuse the graph
 * identity as "reused for incompatible contextual roles" once `recorderAvailability: 'always'`
 * is set. `buildNativeSolverBackend` (`native-solver-backend.ts`) had the identical defect —
 * `source: input.roles.agent, executor: input.roles.agent` — reachable via
 * `jinn run --native-config` -> native-main -> buildNativeSolverProductionHost ->
 * buildNativeSolverBackend (docs/runbooks/phase-b-native-vertical.md step 4). The evaluator's
 * fix converted every failed attempt into a boot-time constructor throw instead; this composition
 * had the same latent defect and would have failed to boot the moment the guard shipped.
 *
 * This test pins the fix on the real `LocalTaskExecutionBackend` constructor (no stubbing of the
 * guard itself): `executor` follows the same `urn:jinn:operator-runtime:<implVersion>`
 * convention as `composition-root.ts` and `native-evaluator-assembly.ts`; `source` stays the
 * agent IRI; and the two are distinct, so construction with capture enabled succeeds.
 */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInfo } from '../../src/build-info.js';

const captured: { source: string; executor: string }[] = [];

vi.mock('@jinn-network/task-execution-backend-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@jinn-network/task-execution-backend-local')>();
  return {
    ...actual,
    makeLocalTaskExecutionBackend: (config: { source: string; executor: string }) => {
      captured.push({ source: config.source, executor: config.executor });
      return actual.makeLocalTaskExecutionBackend(config as never);
    },
  };
});

const { buildNativeSolverBackend } = await import('../../src/daemon/native-solver-backend.js');

const AGENT_IRI = 'urn:uuid:44cfb891-0000-4000-8000-0000000000ee';
const roots: string[] = [];

afterEach(async () => {
  captured.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function actualRunningNodeDigest(): Promise<`sha256:${string}`> {
  const bytes = await readFile(process.execPath);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('native solver backend evidence identities (#36 follow-up)', () => {
  it('constructs cleanly with capture enabled and distinct, convention-following identities', async () => {
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), 'jinn-native-solver-identity-')));
    roots.push(stateRoot);

    const solver = await buildNativeSolverBackend({
      roles: { agent: AGENT_IRI, get: () => ({ keyId: 'did:key:solver-delivery' }) } as never,
      stateRoot,
      evidence: {} as never,
      nodeExecutableDigest: await actualRunningNodeDigest(),
    });

    try {
      // The defect: `source === executor` throws at LocalTaskExecutionBackend's constructor once
      // `recorderAvailability: 'always'` is set (which `buildNativeSolverBackend` always sets).
      // Resolving here (against the real, unstubbed backend constructor) proves the fix.
      expect(captured).toHaveLength(1);
      const { source, executor } = captured[0]!;
      expect(source).not.toBe(executor);
      // Same convention `composition-root.ts` and `native-evaluator-assembly.ts` build.
      expect(executor).toBe(`urn:jinn:operator-runtime:${buildInfo.implVersion}`);
      // `source` stays the operator's persistent agent IRI.
      expect(source).toBe(AGENT_IRI);
    } finally {
      await solver.close();
    }
  });
});
