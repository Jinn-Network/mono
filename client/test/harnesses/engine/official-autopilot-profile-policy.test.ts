import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskEngine } from '../../../src/harnesses/engine/engine.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import { Store } from '../../../src/store/store.js';
import type { Task } from '../../../src/types/task.js';
import {
  buildPredictionV1ManifestStub,
  makeStubManifestResolver,
} from './manifest-resolver-stub.js';

const MANIFEST_CID = 'bafy-jinn-repo-official-profile';
const V2_ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function manifest() {
  const base = buildPredictionV1ManifestStub();
  return {
    ...base,
    contract: {
      ...base.contract,
      id: 'jinn-repo',
      version: 'v1',
    },
  };
}

function task(input: {
  repository: string;
  verificationProfile: string;
  role: 'restoration' | 'evaluation';
  solverNetManifestCid?: string | null;
}): Task {
  return {
    id: `autopilot:${V2_ATTEMPT_ID}`,
    description: 'Official-profile policy test',
    solverType: 'jinn-repo.v1',
    contractId: 'jinn-repo',
    contractVersion: 'v1',
    ...(input.solverNetManifestCid === null
      ? {}
      : {
          solverNetManifestCid:
            input.solverNetManifestCid ?? MANIFEST_CID,
        }),
    role: input.role,
    spec: {
      schemaVersion: 'jinn-repo.v1',
      source: 'autopilot-session',
      instance_id: `autopilot:${V2_ATTEMPT_ID}`,
      repo: input.repository,
      base_commit: 'a'.repeat(40),
      language: 'typescript',
      verificationProfile: input.verificationProfile,
      problem_statement: 'Implement the claimed issue.',
      session: {
        schemaVersion: 'jinn-autopilot-session.v1',
        workflow: 'implement',
        repository: input.repository,
        language: 'typescript',
        verificationProfile: input.verificationProfile,
        issueNumber: 42,
        prNumber: 84,
        targetBase: 'next',
        branch: 'codex/issue-42',
        claimOid: 'b'.repeat(40),
        expectedHead: 'c'.repeat(40),
        v2AttemptId: V2_ATTEMPT_ID,
        runnerId: 'runner-1',
        taskSnapshot: {
          title: 'Issue 42',
          body: 'Implement it.',
          prBody: 'Draft',
          baseSha: 'd'.repeat(40),
          targetBaseOid: 'd'.repeat(40),
        },
        workflowContract: {
          skill: 'implement-issue',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
        deadline: '2026-07-25T00:00:00.000Z',
        receiptAuthors: ['trusted-host'],
      },
    },
  };
}

describe('TaskEngine official Autopilot profile policy', () => {
  let directory: string;
  let store: Store;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jinn-official-profile-'));
    store = new Store(join(directory, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
  // Task 16): canAcceptTask({ taskRole: 'restoration', ... }) is now always refused
  // before the official-profile guard runs (see
  // test/daemon/solution-path-retired.test.ts). officialAutopilotTaskProfileFailure()
  // is role-agnostic (no role parameter), so the 'restoration'-labeled case below now
  // uses taskRole: 'evaluation' — the identical code path, still reachable.
  it.each([
    {
      name: 'unsupported profile before the restoration solver',
      repository: 'Jinn-Network/mono',
      verificationProfile: 'other-repository.v1',
      role: 'evaluation' as const,
      reason: "unsupported Autopilot verification profile 'other-repository.v1'",
    },
    {
      name: 'mono profile repository mismatch before the evaluator',
      repository: 'example/other-repository',
      verificationProfile: 'jinn-mono.v1',
      role: 'evaluation' as const,
      reason: "requires repository 'Jinn-Network/mono'",
    },
  ])('rejects $name', async ({
    repository,
    verificationProfile,
    role,
    reason,
  }) => {
    const canAttempt = vi.fn().mockResolvedValue({ ok: true });
    const harness: Harness = {
      name: 'must-not-run',
      version: '1.0.0',
      supports: () => true,
      canAttempt,
      run: vi.fn(async (): Promise<Solution> => ({
        venueRef: { name: 'must-not-run' },
        gating: {},
      })),
    };
    const engine = new TaskEngine({
      store,
      paths: {
        workingDirRoot: join(directory, 'work'),
        implStateDirRoot: join(directory, 'impl'),
      },
      manifestResolver: makeStubManifestResolver({
        [MANIFEST_CID]: manifest(),
      }),
      implRegistry: { findFor: () => harness },
    });

    const result = await engine.canAcceptTask({
      solverType: 'jinn-repo.v1',
      taskRole: role,
      task: task({ repository, verificationProfile, role }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining(reason),
    });
    expect(canAttempt).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'without a manifest CID before the restoration solver',
      repository: 'Jinn-Network/mono',
      verificationProfile: 'unsupported.v1',
      role: 'evaluation' as const,
      solverNetManifestCid: null,
      includeResolver: true,
      reason: "unsupported Autopilot verification profile 'unsupported.v1'",
    },
    {
      name: 'without a manifest resolver before the evaluator',
      repository: 'example/other-repository',
      verificationProfile: 'jinn-mono.v1',
      role: 'evaluation' as const,
      solverNetManifestCid: MANIFEST_CID,
      includeResolver: false,
      reason: "requires repository 'Jinn-Network/mono'",
    },
  ])('cannot bypass the profile guard $name', async ({
    repository,
    verificationProfile,
    role,
    solverNetManifestCid,
    includeResolver,
    reason,
  }) => {
    const canAttempt = vi.fn().mockResolvedValue({ ok: true });
    const harness: Harness = {
      name: 'must-not-run',
      version: '1.0.0',
      supports: () => true,
      canAttempt,
      run: vi.fn(async (): Promise<Solution> => ({
        venueRef: { name: 'must-not-run' },
        gating: {},
      })),
    };
    const engine = new TaskEngine({
      store,
      paths: {
        workingDirRoot: join(directory, 'work'),
        implStateDirRoot: join(directory, 'impl'),
      },
      ...(includeResolver
        ? {
            manifestResolver: makeStubManifestResolver({
              [MANIFEST_CID]: manifest(),
            }),
          }
        : {}),
      implRegistry: { findFor: () => harness },
    });

    const result = await engine.canAcceptTask({
      solverType: 'jinn-repo.v1',
      taskRole: role,
      task: task({
        repository,
        verificationProfile,
        role,
        solverNetManifestCid,
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining(reason),
    });
    expect(canAttempt).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });
});
