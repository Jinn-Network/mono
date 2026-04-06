/**
 * Unit tests for gemini-agent/mcp/tools/dispatch_new_job.ts
 *
 * Tests job delegation MCP tool - creates/updates job definitions and dispatches marketplace requests.
 * This is the MOST CRITICAL MCP tool - used for all job delegation in the system.
 *
 * Priority: P1 (HIGHEST Priority)
 * Business Impact: Agent Functionality - Job Delegation (Core Feature)
 * Coverage Target: 100% of dispatch logic
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { setToolRegistry } from 'jinn-node/agent/mcp/tools/shared/tool-registry.js';

// Mock dependencies
vi.mock('jinn-node/http/client.js', () => ({
  graphQLRequest: vi.fn(),
}));

vi.mock('@jinn-network/mech-client-ts/dist/marketplace_interact.js', () => ({
  marketplaceInteract: vi.fn(),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/context.js', () => ({
  getCurrentJobContext: vi.fn(),
}));

vi.mock('jinn-node/env/operate-profile.js', () => ({
  getMechAddress: vi.fn(),
  getMechChainConfig: vi.fn(),
  getServicePrivateKey: vi.fn(),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: vi.fn(),
}));

vi.mock('jinn-node/agent/shared/code_metadata.js', () => ({
  collectLocalCodeMetadata: vi.fn(),
  ensureJobBranch: vi.fn(),
}));

vi.mock('jinn-node/config/index.js', () => ({
  getCodeMetadataDefaultBaseBranch: vi.fn(),
}));

import { graphQLRequest } from '../../../../../http/client.js';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { getCurrentJobContext } from 'jinn-node/agent/mcp/tools/shared/context.js';
import { getMechAddress, getMechChainConfig, getServicePrivateKey } from '../../../../../env/operate-profile.js';
import { getPonderGraphqlUrl } from 'jinn-node/agent/mcp/tools/shared/env.js';
import { collectLocalCodeMetadata, ensureJobBranch } from 'jinn-node/agent/shared/code_metadata.js';
import { getCodeMetadataDefaultBaseBranch } from '../../../../../config/index.js';

// Helper to create valid blueprint JSON
function createBlueprint(invariants: Array<{
  id: string;
  condition: string;
  examples?: { do: string[]; dont: string[] };
  assessment?: string;
}>) {
  return JSON.stringify({
    invariants: invariants.map((inv) => ({
      id: inv.id,
      type: 'BOOLEAN',
      condition: inv.condition,
      assessment: inv.assessment || 'Verify condition is met',
      examples: inv.examples || { do: ['Example'], dont: ['Anti-example'] },
    })),
  });
}

function createInvariantBlueprint(invariants: Array<{
  id: string;
  type: 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';
  metric?: string;
  min?: number;
  max?: number;
  condition?: string;
  assessment: string;
  examples?: { do: string[]; dont: string[] };
}>) {
  return JSON.stringify({
    invariants: invariants.map((inv) => ({
      id: inv.id,
      type: inv.type,
      metric: inv.metric,
      min: inv.min,
      max: inv.max,
      condition: inv.condition,
      assessment: inv.assessment,
      examples: inv.examples || { do: ['Example'], dont: ['Anti-example'] },
    })),
  });
}

describe('dispatchNewJob', () => {
  // Suppress console.error and console.warn during tests
  const originalError = console.error;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.clearAllMocks();
    console.error = vi.fn();
    console.warn = vi.fn();

    // Set CODE_METADATA_REPO_ROOT so branch creation is enabled
    process.env.CODE_METADATA_REPO_ROOT = '/tmp/test-repo';

    // Default mock implementations
    (getCurrentJobContext as any).mockReturnValue({
      requestId: '0xParent123',
      jobDefinitionId: 'parent-job-uuid',
    });
    (getMechAddress as any).mockReturnValue('0xMechAddress');
    (getMechChainConfig as any).mockReturnValue('base');
    (getServicePrivateKey as any).mockReturnValue('0xPrivateKey');
    (getPonderGraphqlUrl as any).mockReturnValue('http://localhost:42069/graphql');
    (getCodeMetadataDefaultBaseBranch as any).mockReturnValue('main');

    // Mock graphQLRequest to return empty job list first (no existing job),
    // then return ipfsHash on poll
    (graphQLRequest as any).mockImplementation(async ({ query }: any) => {
      if (query.includes('jobDefinitions')) {
        return { jobDefinitions: { items: [] } };
      }
      if (query.includes('jobDefinition(id:')) {
        // Return null for jobDefinition queries (job doesn't exist yet)
        return { jobDefinition: null };
      }
      if (query.includes('request(id:')) {
        return { request: { ipfsHash: 'QmTestIpfsHash' } };
      }
      return {};
    });

    (ensureJobBranch as any).mockResolvedValue({ branchName: 'job/test-branch' });
    (collectLocalCodeMetadata as any).mockResolvedValue({ repo: 'test-repo', commit: 'abc123' });
    (marketplaceInteract as any).mockResolvedValue({ request_ids: ['0xRequest123'] });

    setToolRegistry([
      { name: 'create_artifact', schema: { description: 'Create artifact', inputSchema: {} } },
      { name: 'dispatch_new_job', schema: { description: 'Dispatch job', inputSchema: {} } },
      { name: 'read_file', schema: { description: 'Read file', inputSchema: {} } },
      { name: 'write_file', schema: { description: 'Write file', inputSchema: {} } },
      { name: 'replace', schema: { description: 'Replace content', inputSchema: {} } },
      { name: 'list_directory', schema: { description: 'List directory', inputSchema: {} } },
      { name: 'run_shell_command', schema: { description: 'Run shell command', inputSchema: {} } },
    ]);
  });

  afterEach(() => {
    console.error = originalError;
    console.warn = originalWarn;
    delete process.env.CODE_METADATA_REPO_ROOT;
  });

  describe('validation', () => {
    it('validates required jobName field', async () => {
      const args = {
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
      expect(response.meta.message).toContain('jobName');
    });

    it('validates minimum length for jobName (min 1 char)', async () => {
      const args = {
        jobName: '',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('requires blueprint field', async () => {
      const args = {
        jobName: 'test-job',
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
      expect(response.meta.message).toContain('blueprint');
    });

    it('accepts job with blueprint', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([
          { id: 'TST-001', condition: 'Must complete task successfully' },
        ]),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(marketplaceInteract).toHaveBeenCalled();
    });

    it('accepts job with all optional fields', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
        model: 'gemini-2.5-pro',
        enabledTools: ['read_file', 'write_file'],
        message: 'Please start working on this',
        dependencies: ['4eac1570-7980-4e2b-afc7-3f5159e99ea5', 'b2c3d4e5-6789-4abc-def0-123456789abc'],
        skipBranch: false,
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      // Debug: Log response if failed
      if (!response.meta.ok) {
        console.log('Dispatch failed:', response.meta);
      }

      expect(response.meta.ok).toBe(true);
      expect(marketplaceInteract).toHaveBeenCalled();
    });

    it('validates blueprint structure if provided', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: 'invalid json',
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('INVALID_BLUEPRINT');
    });

    it('validates blueprint has assertions array', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: JSON.stringify({ wrong: 'structure' }),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('INVALID_BLUEPRINT_STRUCTURE');
    });

    it('validates assertion structure', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: JSON.stringify({
          assertions: [
            { id: 'TST-001', assertion: 'Valid' }, // Missing examples and commentary
          ],
        }),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('INVALID_BLUEPRINT_STRUCTURE');
    });

  });

  describe('blueprint handling', () => {
    it('stores blueprint in IPFS metadata', async () => {
      const blueprint = createBlueprint([
        { id: 'TST-001', condition: 'Must complete successfully' },
      ]);
      const args = {
        jobName: 'test-job',
        blueprint,
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].blueprint).toBe(blueprint);
    });

    it('handles multiple assertions in blueprint', async () => {
      const blueprint = createBlueprint([
        { id: 'TST-001', condition: 'First requirement' },
        { id: 'TST-002', condition: 'Second requirement' },
        { id: 'TST-003', condition: 'Third requirement' },
      ]);
      const args = {
        jobName: 'test-job',
        blueprint,
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      const call = (marketplaceInteract as any).mock.calls[0][0];
      const storedBlueprint = JSON.parse(call.ipfsJsonContents[0].blueprint);
      expect(storedBlueprint.invariants).toHaveLength(3);
    });
  });

  describe('dependencies handling', () => {
    it('stores dependencies in IPFS metadata', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
        dependencies: ['4eac1570-7980-4e2b-afc7-3f5159e99ea5', 'b2c3d4e5-6789-4abc-def0-123456789abc'],
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].dependencies).toEqual(['4eac1570-7980-4e2b-afc7-3f5159e99ea5', 'b2c3d4e5-6789-4abc-def0-123456789abc']);
    });

    it('omits dependencies when empty array provided', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
        dependencies: [],
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].dependencies).toBeUndefined();
    });

    it('omits dependencies field when not provided', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].dependencies).toBeUndefined();
    });
  });

  describe('model parameter', () => {
    it('uses provided model', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
        model: 'gemini-2.5-pro',
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].model).toBe('gemini-2.5-pro');
    });

    it('defaults to auto-gemini-3 when not provided', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].model).toBe('auto-gemini-3');
    });
  });

  describe('enabledTools parameter', () => {
    it('includes enabledTools in IPFS metadata', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
        enabledTools: ['read_file', 'write_file', 'create_artifact'],
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].enabledTools).toEqual([
        'read_file',
        'write_file',
        'create_artifact',
        'list_tools',
        'get_details',
        'inspect_situation',
        'dispatch_new_job',
        'dispatch_existing_job',
        'create_measurement',
        'search_jobs',
        'search_artifacts',
        'google_web_search',
        'web_fetch',
        'list_directory',
        'search_file_content',
        'glob',
        'read_many_files',
      ]);
    });

    it('omits enabledTools when not provided', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].enabledTools).toEqual([
        'list_tools',
        'get_details',
        'inspect_situation',
        'dispatch_new_job',
        'dispatch_existing_job',
        'create_artifact',
        'create_measurement',
        'search_jobs',
        'search_artifacts',
        'google_web_search',
        'web_fetch',
        'list_directory',
        'read_file',
        'search_file_content',
        'glob',
        'read_many_files',
      ]);
    });
    it('includes tool policy from job context', async () => {
      (getCurrentJobContext as any).mockReturnValue({
        requestId: '0xParent123',
        jobDefinitionId: 'parent-job-uuid',
        requiredTools: ['read_file'],
      });
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].enabledTools).toContain('read_file');
      expect(call.ipfsJsonContents[0].tools).toEqual([
        { name: 'read_file', required: true },
      ]);
    });
  });

  describe('code metadata', () => {
    it('skips branch creation when skipBranch is true', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
        skipBranch: true,
      };

      await dispatchNewJob(args);

      expect(ensureJobBranch).not.toHaveBeenCalled();
      expect(collectLocalCodeMetadata).toHaveBeenCalled();
    });

    it('creates branch by default', async () => {
      const args = {
        jobName: 'branch-test',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      await dispatchNewJob(args);

      expect(ensureJobBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          jobName: 'branch-test',
        })
      );
    });

    it('calls collectLocalCodeMetadata after branch creation', async () => {
      const args = {
        jobName: 'metadata-test',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      await dispatchNewJob(args);

      expect(collectLocalCodeMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: 'job/test-branch',
        })
      );
    });

    it('includes code metadata in IPFS payload', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].codeMetadata).toEqual({
        repo: 'test-repo',
        commit: 'abc123',
      });
    });

    it('handles branch creation failure', async () => {
      (ensureJobBranch as any).mockRejectedValue(new Error('Git error'));
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.message).toContain('Git error');
    });
  });

  describe('message parameter', () => {
    it('includes message in additionalContext', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
        message: 'Please prioritize this task',
      };

      await dispatchNewJob(args);

      const call = (marketplaceInteract as any).mock.calls[0][0];
      expect(call.ipfsJsonContents[0].additionalContext.message.content).toBe('Please prioritize this task');
    });
  });

  describe('job definition creation', () => {
    it('always creates a new job definition with unique ID', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.jobDefinitionId).toMatch(/^[a-f0-9-]{36}$/); // UUID format
    });

    it('creates distinct job definitions for same job name', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      const result1 = await dispatchNewJob(args);
      const response1 = JSON.parse(result1.content[0].text);

      const result2 = await dispatchNewJob(args);
      const response2 = JSON.parse(result2.content[0].text);

      expect(response1.meta.ok).toBe(true);
      expect(response2.meta.ok).toBe(true);
      expect(response1.data.jobDefinitionId).not.toBe(response2.data.jobDefinitionId);
    });

    it('does not include reusedDefinition in meta', async () => {
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.meta.reusedDefinition).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('handles marketplace interaction failure', async () => {
      (marketplaceInteract as any).mockRejectedValue(new Error('Transaction failed'));
      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.message).toContain('Transaction failed');
    });

    it('handles Ponder polling timeout', async () => {
      (graphQLRequest as any).mockImplementation(async ({ query }: any) => {
        if (query.includes('jobDefinitions')) {
          return { jobDefinitions: { items: [] } };
        }
        if (query.includes('request(id:')) {
          return { request: null }; // Never indexed
        }
        return {};
      });

      const args = {
        jobName: 'test-job',
        blueprint: createBlueprint([{ id: 'TST-001', condition: 'Must complete task' }]),
      };

      const result = await dispatchNewJob(args);
      const response = JSON.parse(result.content[0].text);

      // Should still succeed but without ipfs_gateway_url
      expect(response.meta.ok).toBe(true);
      expect(response.data).toBeDefined();
      expect(response.data.ipfs_gateway_url).toBeNull();
    }, 15000); // Increase timeout for polling retries
  });
});
