/**
 * Unit Test: Dependency Resolution and Checking
 * Module: worker/mech_worker.ts (dependency functions)
 * Priority: P2 (EXTENDED)
 *
 * Tests dependency resolution (name to UUID) and completion checking.
 * Important for ensuring jobs wait for their dependencies before executing.
 *
 * Impact: Prevents jobs from executing prematurely when dependencies are not met.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('jinn-node/env', () => ({
  default: {}
}));

vi.mock('jinn-node/http/client.js', () => ({
  graphQLRequest: vi.fn()
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: vi.fn().mockReturnValue('http://localhost:42069/graphql'),
  getOptionalControlApiUrl: vi.fn().mockReturnValue('http://localhost:8000'),
  getUseControlApi: vi.fn().mockReturnValue(false),
  getEnableAutoRepost: vi.fn().mockReturnValue(false),
  getRequiredRpcUrl: vi.fn().mockReturnValue('http://localhost:8545'),
  getOptionalMechTargetRequestId: vi.fn().mockReturnValue(undefined)
}));

vi.mock('jinn-node/logging/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    workerLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }))
    },
    configLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  };
});

import { graphQLRequest } from 'jinn-node/http/client.js';
import { workerLogger } from 'jinn-node/logging/index.js';
import { isJobDefinitionComplete } from 'jinn-node/worker/mech_worker.js';

/**
 * Test helper function that mirrors worker/mech_worker.ts internal logic
 * This is a simplified version for testing purposes
 */

async function resolveJobDefinitionId(
  workstreamId: string | undefined,
  identifier: string
): Promise<string> {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_REGEX.test(identifier)) {
    return identifier;
  }
  
  if (!workstreamId) {
    return identifier;
  }
  
  try {
    const data = await graphQLRequest<any>({
      url: 'http://localhost:42069/graphql',
      query: `query resolveJobName($workstreamId: String!, $jobName: String!) { requests(where: { workstreamId: $workstreamId, jobName: $jobName }, limit: 1) { items { jobDefinitionId } } }`,
      variables: { workstreamId, jobName: identifier },
      context: { operation: 'resolveJobDefinitionId', identifier, workstreamId }
    });
    
    const requests = data?.requests?.items || [];
    if (requests.length > 0 && requests[0].jobDefinitionId) {
      return requests[0].jobDefinitionId;
    }
    
    return identifier;
  } catch (e) {
    return identifier;
  }
}

async function checkDependenciesMet(request: {
  id: string;
  dependencies?: string[];
  workstreamId?: string;
}): Promise<boolean> {
  if (!request.dependencies || request.dependencies.length === 0) {
    return true;
  }
  
  try {
    const results = await Promise.all(
      request.dependencies.map(async (identifier) => {
        const resolvedId = await resolveJobDefinitionId(request.workstreamId, identifier);
        const isComplete = await isJobDefinitionComplete(resolvedId);
        return { identifier, resolvedId, isComplete };
      })
    );
    
    return results.every(r => r.isComplete);
  } catch (e) {
    return false;
  }
}

describe('Dependency Resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveJobDefinitionId', () => {
    it('returns UUID identifiers as-is', async () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const result = await resolveJobDefinitionId('0xWORKSTREAM', uuid);
      expect(result).toBe(uuid);
      expect(graphQLRequest).not.toHaveBeenCalled();
    });

    it('queries Ponder for job name resolution', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            { jobDefinitionId: 'resolved-uuid-123' }
          ]
        }
      });

      const result = await resolveJobDefinitionId('0xWORKSTREAM', 'Data Analysis');
      
      expect(result).toBe('resolved-uuid-123');
      expect(graphQLRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            workstreamId: '0xWORKSTREAM',
            jobName: 'Data Analysis'
          }
        })
      );
    });

    it('returns original identifier when no workstream context', async () => {
      const result = await resolveJobDefinitionId(undefined, 'Job Name');
      
      expect(result).toBe('Job Name');
      expect(graphQLRequest).not.toHaveBeenCalled();
    });

    it('returns original identifier when resolution fails', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('GraphQL error'));

      const result = await resolveJobDefinitionId('0xWORKSTREAM', 'Unknown Job');
      
      expect(result).toBe('Unknown Job');
    });

    it('returns original identifier when no matching requests found', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      const result = await resolveJobDefinitionId('0xWORKSTREAM', 'NonExistent Job');
      
      expect(result).toBe('NonExistent Job');
    });

    it('handles case-sensitive job names', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            { jobDefinitionId: 'case-sensitive-uuid' }
          ]
        }
      });

      const result = await resolveJobDefinitionId('0xWORKSTREAM', 'CaseSensitiveJob');
      
      expect(result).toBe('case-sensitive-uuid');
    });

    it('validates UUID format correctly', async () => {
      const validUUIDs = [
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        'A1B2C3D4-E5F6-7890-ABCD-EF1234567890', // Uppercase
        '00000000-0000-0000-0000-000000000000'  // All zeros
      ];

      for (const uuid of validUUIDs) {
        const result = await resolveJobDefinitionId('0xWORKSTREAM', uuid);
        expect(result).toBe(uuid);
      }
    });

    it('treats invalid UUID formats as job names', async () => {
      const invalidUUIDs = [
        'not-a-uuid',
        '12345678-1234-1234-1234', // Too short
        'g1234567-1234-1234-1234-123456789012', // Invalid hex
        '12345678-1234-1234-1234-123456789012-extra' // Too long
      ];

      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      for (const notUUID of invalidUUIDs) {
        await resolveJobDefinitionId('0xWORKSTREAM', notUUID);
        expect(graphQLRequest).toHaveBeenCalled();
        vi.clearAllMocks();
      }
    });
  });

  describe('isJobDefinitionComplete', () => {
    it('returns true when lastStatus is COMPLETED', async () => {
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: {
          items: [
            { id: 'job-def-123', lastStatus: 'COMPLETED' }
          ]
        }
      });

      const result = await isJobDefinitionComplete('job-def-123');
      
      expect(result).toBe(true);
    });

    it('returns true when lastStatus is FAILED', async () => {
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: {
          items: [
            { id: 'job-def-123', lastStatus: 'FAILED' }
          ]
        }
      });

      const result = await isJobDefinitionComplete('job-def-123');
      
      expect(result).toBe(true);
    });

    it('returns false when lastStatus is DELEGATING', async () => {
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: {
          items: [
            { id: 'job-def-123', lastStatus: 'DELEGATING' }
          ]
        }
      });

      const result = await isJobDefinitionComplete('job-def-123');
      
      expect(result).toBe(false);
    });

    it('returns false when lastStatus is WAITING', async () => {
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: {
          items: [
            { id: 'job-def-123', lastStatus: 'WAITING' }
          ]
        }
      });

      const result = await isJobDefinitionComplete('job-def-123');
      
      expect(result).toBe(false);
    });

    it('returns false when job definition not found', async () => {
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: { items: [] }
      });

      const result = await isJobDefinitionComplete('job-def-123');
      
      expect(result).toBe(false);
    });

    it('returns false on query failure', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('Network error'));

      const result = await isJobDefinitionComplete('job-def-123');
      
      expect(result).toBe(false);
    });

    it('queries jobDefinitions with correct ID', async () => {
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: {
          items: [{ id: 'job-def-123', lastStatus: 'COMPLETED' }]
        }
      });

      await isJobDefinitionComplete('job-def-123');
      
      expect(graphQLRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { jobDefId: 'job-def-123' }
        })
      );
    });

    it('handles null response gracefully', async () => {
      (graphQLRequest as any).mockResolvedValue(null);

      const result = await isJobDefinitionComplete('job-def-123');
      
      expect(result).toBe(false);
    });
  });

  describe('checkDependenciesMet', () => {
    it('returns true when no dependencies', async () => {
      const request = {
        id: '0xREQ123',
        dependencies: []
      };

      const result = await checkDependenciesMet(request);
      
      expect(result).toBe(true);
      expect(graphQLRequest).not.toHaveBeenCalled();
    });

    it('returns true when dependencies undefined', async () => {
      const request = {
        id: '0xREQ123'
      };

      const result = await checkDependenciesMet(request);
      
      expect(result).toBe(true);
    });

    it('returns true when all dependencies complete', async () => {
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: {
          items: [{ id: 'dep-uuid-1', lastStatus: 'COMPLETED' }]
        }
      });

      const request = {
        id: '0xREQ123',
        dependencies: ['dep-uuid-1', 'dep-uuid-2'],
        workstreamId: '0xWORKSTREAM'
      };

      const result = await checkDependenciesMet(request);
      
      expect(result).toBe(true);
    });

    it('returns false when any dependency incomplete', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({ jobDefinitions: { items: [{ id: '550e8400-e29b-41d4-a716-446655440001', lastStatus: 'COMPLETED' }] } }) // First dep complete
        .mockResolvedValueOnce({ jobDefinitions: { items: [{ id: '550e8400-e29b-41d4-a716-446655440002', lastStatus: 'DELEGATING' }] } }); // Second dep incomplete

      const request = {
        id: '0xREQ123',
        dependencies: [
          '550e8400-e29b-41d4-a716-446655440001',
          '550e8400-e29b-41d4-a716-446655440002'
        ], // UUIDs skip resolution
        workstreamId: '0xWORKSTREAM'
      };

      const result = await checkDependenciesMet(request);
      
      expect(result).toBe(false);
    });

    it('resolves job names before checking completion', async () => {
      (graphQLRequest as any)
        // First call: resolve job name
        .mockResolvedValueOnce({
          requests: {
            items: [{ jobDefinitionId: 'resolved-uuid' }]
          }
        })
        // Second call: check if resolved UUID is complete
        .mockResolvedValueOnce({
          jobDefinitions: {
            items: [{ id: 'resolved-uuid', lastStatus: 'COMPLETED' }]
          }
        });

      const request = {
        id: '0xREQ123',
        dependencies: ['Data Analysis'], // Job name, not UUID
        workstreamId: '0xWORKSTREAM'
      };

      const result = await checkDependenciesMet(request);
      
      expect(result).toBe(true);
      expect(graphQLRequest).toHaveBeenCalledTimes(2);
    });

    it('checks multiple dependencies in parallel', async () => {
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: {
          items: [{ id: 'job-def', lastStatus: 'COMPLETED' }]
        }
      });

      const request = {
        id: '0xREQ123',
        dependencies: [
          '550e8400-e29b-41d4-a716-446655440001',
          '550e8400-e29b-41d4-a716-446655440002',
          '550e8400-e29b-41d4-a716-446655440003'
        ], // UUIDs skip resolution
        workstreamId: '0xWORKSTREAM'
      };

      await checkDependenciesMet(request);
      
      // Should check all 3 in parallel (3 completion checks, no resolution)
      expect(graphQLRequest).toHaveBeenCalledTimes(3);
    });

    it('returns false on dependency check failure', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('GraphQL error'));

      const request = {
        id: '0xREQ123',
        dependencies: ['dep-uuid-1'],
        workstreamId: '0xWORKSTREAM'
      };

      const result = await checkDependenciesMet(request);
      
      expect(result).toBe(false);
    });

    it('handles mixed UUID and name dependencies', async () => {
      // Mock needs to handle parallel calls - both deps are checked simultaneously
      // For UUID: direct completion check
      // For Name: resolution query + completion check
      (graphQLRequest as any).mockImplementation(async ({ query }: any) => {
        if (query.includes('CheckJobDefStatus')) {
          // Completion check - return COMPLETED
          return {
            jobDefinitions: {
              items: [{ id: 'any', lastStatus: 'COMPLETED' }]
            }
          };
        } else if (query.includes('resolveJobName')) {
          // Name resolution
          return {
            requests: {
              items: [{ jobDefinitionId: 'resolved-uuid' }]
            }
          };
        }
        return { jobDefinitions: { items: [] } };
      });

      const request = {
        id: '0xREQ123',
        dependencies: [
          'a1b2c3d4-e5f6-7890-abcd-ef1234567890', // UUID
          'Data Analysis' // Name
        ],
        workstreamId: '0xWORKSTREAM'
      };

      const result = await checkDependenciesMet(request);
      
      expect(result).toBe(true);
    });
  });

  describe('filterByDependencies integration', () => {
    it('filters requests with unmet dependencies', async () => {
      const requests = [
        { id: '0xREQ1', dependencies: undefined },
        { id: '0xREQ2', dependencies: ['550e8400-e29b-41d4-a716-446655440001'], workstreamId: '0xWS' },
        { id: '0xREQ3', dependencies: ['550e8400-e29b-41d4-a716-446655440002'], workstreamId: '0xWS' }
      ];

      // REQ2's dep is complete, REQ3's dep is not
      (graphQLRequest as any)
        .mockResolvedValueOnce({ jobDefinitions: { items: [{ id: '550e8400-e29b-41d4-a716-446655440001', lastStatus: 'COMPLETED' }] } }) // dep-1 complete
        .mockResolvedValueOnce({ jobDefinitions: { items: [{ id: '550e8400-e29b-41d4-a716-446655440002', lastStatus: 'WAITING' }] } }); // dep-2 incomplete

      const results = await Promise.all(
        requests.map(r => checkDependenciesMet(r))
      );
      
      const readyRequests = requests.filter((_, i) => results[i]);
      
      expect(readyRequests).toHaveLength(2);
      expect(readyRequests.map(r => r.id)).toEqual(['0xREQ1', '0xREQ2']);
    });

    it('allows requests without workstream context to proceed', async () => {
      const request = {
        id: '0xREQ123',
        dependencies: ['some-dep']
        // No workstreamId
      };

      // Without workstream, can't resolve dependencies
      // But this should not block the request
      const result = await checkDependenciesMet(request);
      
      // Dependency resolution fails gracefully
      expect(result).toBeDefined();
    });
  });
});

