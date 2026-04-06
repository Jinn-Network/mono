import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('jinn-node/agent/mcp/tools/shared/context.js', () => ({
  getCurrentJobContext: vi.fn(() => ({
    requestId: null,
    jobDefinitionId: null,
    jobName: null,
    threadId: null,
    projectRunId: null,
    sourceEventId: null,
    projectDefinitionId: null,
    mechAddress: null,
    baseBranch: 'main',
    workstreamId: null,
    parentRequestId: null,
    branchName: null,
    requiredTools: null,
    availableTools: null,
    allowedModels: null,
    defaultModel: null,
  })),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/job-context-utils.js', () => ({
  getJobContextForDispatch: vi.fn(async () => null),
}));

import { buildIpfsPayload } from 'jinn-node/agent/shared/ipfs-payload-builder.js';

describe('buildIpfsPayload github capability marker', () => {
  afterEach(() => {
    delete process.env.JINN_CTX_INHERITED_ENV;
  });

  it('adds process_branch to enabledTools when codeMetadata is present', async () => {
    const result = await buildIpfsPayload({
      blueprint: '{"invariants":[]}',
      jobName: 'coding-job',
      jobDefinitionId: '00000000-0000-0000-0000-000000000001',
      enabledTools: ['read_file'],
      codeMetadata: {
        jobDefinitionId: '00000000-0000-0000-0000-000000000001',
        baseBranch: 'main',
        branch: { name: 'job/coding-job' },
        repo: { remoteUrl: 'https://github.com/Jinn-Network/jinn-node.git' },
      } as any,
    });

    const tools = result.ipfsJsonContents[0].enabledTools as string[];
    expect(tools).toContain('process_branch');
  });

  it('does not duplicate process_branch when already requested', async () => {
    const result = await buildIpfsPayload({
      blueprint: '{"invariants":[]}',
      jobName: 'coding-job',
      jobDefinitionId: '00000000-0000-0000-0000-000000000002',
      enabledTools: ['process_branch', 'read_file'],
      codeMetadata: {
        jobDefinitionId: '00000000-0000-0000-0000-000000000002',
        baseBranch: 'main',
        branch: { name: 'job/coding-job' },
        repo: { remoteUrl: 'https://github.com/Jinn-Network/jinn-node.git' },
      } as any,
    });

    const tools = result.ipfsJsonContents[0].enabledTools as string[];
    const processBranchCount = tools.filter((tool) => tool === 'process_branch').length;
    expect(processBranchCount).toBe(1);
  });
});
