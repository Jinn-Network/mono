/**
 * The evaluator backend's two evidence-graph identities (#36).
 *
 * Live gate round 21 died 122ms into CP6 grading — before the harness spawned — because the
 * evaluator assembly passed ONE agent IRI as both `source` and `executor`. The backend-local
 * evidence join derives the recording's `producer` descriptor from `source`, so one IRI ended up
 * registered twice as an `agent`-kind graph identity under two descriptors with different names;
 * the execution recorder correctly refused ("reused for incompatible contextual roles"), and
 * `recorderAvailability: "always"` turned that refusal into a terminal
 * `failed / infrastructure / dependency-unavailable` attempt.
 *
 * The solver backend has always passed two DISTINCT identities (`composition-root.ts`:
 * `source: urn:jinn:operator:<safe>`, `executor: urn:jinn:operator-runtime:<implVersion>`), which
 * is why only the evaluator leg was broken and why CP6 was the first time that line ran live.
 * These tests pin the evaluator onto the same convention and prove the recorder accepts it.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEvidenceCatalog } from '@jinn-network/evidence-discovery';
import { InMemoryEvidenceRepository } from '@jinn-network/evidence-repository/testing';
import { createEvidenceJoin } from '@jinn-network/task-execution-backend-local';
import type { WorkspacePaths } from '@jinn-network/task-execution-workspace';
import { buildInfo } from '../../src/build-info.js';

const built = vi.hoisted(() => ({ calls: [] as { readonly source: string; readonly executor: string }[] }));

vi.mock('../../src/daemon/native-evaluator-composition.js', () => ({
  buildNativeEvaluatorComposition: vi.fn(async (input: { backend: { source: string; executor: string } }) => {
    built.calls.push({ source: input.backend.source, executor: input.backend.executor });
    return { composition: 'stub' };
  }),
}));

const { assembleNativeEvaluatorComposition } = await import('../../src/daemon/native-evaluator-assembly.js');

const AGENT_IRI = 'urn:uuid:44cfb891-0000-4000-8000-0000000000ff';
const SAFE = `0x${'2'.repeat(40)}`;
const roots: string[] = [];

afterEach(async () => {
  built.calls.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every collaborator the assembly only forwards is a bare stub; only the two identities matter. */
async function assemble(): Promise<{ readonly source: string; readonly executor: string }> {
  const trust = {
    bindingResolver: {},
    witnessVerifier: {},
    dsseVerifier: {},
    policy: () => ({}),
    verifyOnchainAuthority: async () => undefined,
  };
  await assembleNativeEvaluatorComposition({
    roles: { agent: AGENT_IRI, get: () => ({ keyId: 'did:key:evaluator' }) },
    state: {},
    trust,
    evidence: {},
    launcherDeployment: {},
    opportunities: {
      sourceId: 'urn:jinn:solver:golden/solver-records',
      deadline: () => '2026-08-03T00:00:00.000Z',
    },
    verdictPorts: {},
    chainReads: { chain: {}, preSettlementClaimTime: {}, blockTime: {} },
    identity: {
      safeAddress: SAFE,
      marketplaceAgentAddress: `0x${'4'.repeat(40)}`,
      agentIri: AGENT_IRI,
      taskCoordinator: `0x${'3'.repeat(40)}`,
      publicBaseUrl: 'https://evaluator.example/native',
      stateDir: '/tmp/jinn-evaluator-assembly-fixture',
      sources: [{ role: 'solver', agent: 'https://agents.example/solver', name: 'solver', baseUrl: 'https://solver.example' }],
    },
    deployment: {
      module: 'file:///dev/null',
      moduleDigest: `sha256:${'6'.repeat(64)}`,
      signerHandle: 'evaluator.pem',
      evaluationMethodDigest: {},
    },
  } as never);
  expect(built.calls).toHaveLength(1);
  return built.calls[0]!;
}

async function workspace(): Promise<WorkspacePaths> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jinn-evaluator-identity-')));
  roots.push(root);
  const paths: WorkspacePaths = {
    root,
    input: join(root, 'input'),
    work: join(root, 'work'),
    out: join(root, 'out'),
    logs: join(root, 'logs'),
    harnessState: join(root, 'harness-state'),
    secrets: join(root, 'secrets'),
    tmp: join(root, 'tmp'),
    meta: join(root, 'meta'),
  };
  await Promise.all(Object.values(paths).filter((path) => path !== root)
    .map((path) => mkdir(path, { recursive: true })));
  return paths;
}

describe('native evaluator backend evidence identities (#36)', () => {
  it('passes two distinct identities on the solver backend\'s convention', async () => {
    const { source, executor } = await assemble();
    // The defect: one IRI in both roles.
    expect(source).not.toBe(executor);
    // Same convention `composition-root.ts` builds for the solver backend.
    expect(executor).toBe(`urn:jinn:operator-runtime:${buildInfo.implVersion}`);
    // `source` stays the operator's persistent agent IRI: it is also the protocol observation
    // envelope source the attempt log's authoritative-source pin is keyed on, so moving it would
    // orphan any in-flight attempt's observations.
    expect(source).toBe(AGENT_IRI);
  });

  it('starts evidence capture cleanly with the identities the assembly actually passes', async () => {
    const { source, executor } = await assemble();
    const bytes = new TextEncoder().encode('exact');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;

    // The exact chain that died at CP6: assembly identities -> evidence join -> execution recorder.
    await expect(createEvidenceJoin({
      ports: {
        repository: new InMemoryEvidenceRepository(),
        catalog: new InMemoryEvidenceCatalog(),
        async awaitIndexed(reference) { return { status: 'not-announced', reference }; },
      },
      source: source as `${string}:${string}`,
      executor: executor as `${string}:${string}`,
      now: () => '2026-08-11T00:00:00.000Z',
    }).start({
      paths: await workspace(),
      attempt: 'urn:uuid:10000000-0000-4000-8000-0000000000a1',
      taskDigest: digest,
      taskBytes: bytes,
      dispatchContextBytes: bytes,
      launchPlanBytes: bytes,
      startedAt: '2026-08-11T00:00:00.000Z',
    })).resolves.toBeDefined();
  });
});
