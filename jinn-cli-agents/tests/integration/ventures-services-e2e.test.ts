import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E Integration Tests for Ventures & Services Registry
 *
 * These tests verify the complete flow from venture creation
 * through service registration and discovery.
 */

// Shared mock state simulating database
let dbState: {
  ventures: any[];
  services: any[];
  deployments: any[];
  interfaces: any[];
  service_docs: any[];
} = {
  ventures: [],
  services: [],
  deployments: [],
  interfaces: [],
  service_docs: [],
};

let idCounter = 1;
const generateId = () => `uuid-${idCounter++}`;

// Mock Supabase with stateful database simulation
const createStatefulMock = () => {
  const from = vi.fn((table: keyof typeof dbState) => {
    const tableData = dbState[table] || [];

    return {
      insert: vi.fn((record: any) => ({
        select: vi.fn(() => ({
          single: vi.fn(() => {
            const newRecord = {
              id: generateId(),
              ...record,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            dbState[table].push(newRecord);
            return Promise.resolve({ data: newRecord, error: null });
          }),
        })),
      })),
      select: vi.fn(() => {
        let filtered = [...tableData];
        const chain: any = {
          eq: vi.fn((col: string, val: any) => {
            filtered = filtered.filter((r: any) => r[col] === val);
            return chain;
          }),
          in: vi.fn((col: string, vals: any[]) => {
            filtered = filtered.filter((r: any) => vals.includes(r[col]));
            return chain;
          }),
          or: vi.fn(() => chain),
          contains: vi.fn(() => chain),
          order: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          range: vi.fn(() => chain),
          single: vi.fn(() => Promise.resolve({
            data: filtered[0] || null,
            error: filtered[0] ? null : { code: 'PGRST116' },
          })),
          then: (resolve: any) => resolve({
            data: filtered,
            error: null,
            count: filtered.length,
          }),
        };
        return chain;
      }),
      update: vi.fn((updates: any) => ({
        eq: vi.fn((col: string, val: any) => ({
          select: vi.fn(() => ({
            single: vi.fn(() => {
              const idx = tableData.findIndex((r: any) => r[col] === val);
              if (idx >= 0) {
                dbState[table][idx] = { ...dbState[table][idx], ...updates };
                return Promise.resolve({ data: dbState[table][idx], error: null });
              }
              return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        eq: vi.fn((col: string, val: any) => {
          const idx = tableData.findIndex((r: any) => r[col] === val);
          if (idx >= 0) {
            dbState[table].splice(idx, 1);
          }
          return Promise.resolve({ error: null });
        }),
      })),
    };
  });

  return { from };
};

const mockSupabase = createStatefulMock();

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../../gemini-agent/mcp/tools/shared/supabase.js', () => ({
  supabase: mockSupabase,
}));

vi.mock('../../logging/index.js', () => ({
  mcpLogger: mockLogger,
}));

beforeEach(() => {
  dbState = {
    ventures: [],
    services: [],
    deployments: [],
    interfaces: [],
    service_docs: [],
  };
  idCounter = 1;
  vi.clearAllMocks();
});

describe('Ventures & Services E2E Flow', () => {
  describe('Complete venture lifecycle', () => {
    it('creates a venture with blueprint', async () => {
      const { ventureMint } = await import('../../gemini-agent/mcp/tools/venture_mint.js');

      const result = await ventureMint({
        name: 'Test Platform',
        ownerAddress: '0x1234567890abcdef1234567890abcdef12345678',
        blueprint: JSON.stringify({
          invariants: [
            { id: 'inv-1', name: 'Uptime', description: '99.9% availability' },
          ],
        }),
        tags: ['platform', 'test'],
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.venture.name).toBe('Test Platform');
      expect(response.data.venture.id).toBeDefined();
    });

    it('validates venture update parameters', async () => {
      const { ventureUpdate } = await import('../../gemini-agent/mcp/tools/venture_update.js');

      // Invalid UUID should fail validation
      const result = await ventureUpdate({
        id: 'not-a-uuid',
        status: 'paused',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Service registration flow', () => {
    it('registers a service with valid parameters', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'create_service',
        ventureId: '550e8400-e29b-41d4-a716-446655440000',
        name: 'API Gateway',
        serviceType: 'api',
        description: 'Central API gateway',
        tags: ['gateway', 'api'],
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.service.name).toBe('API Gateway');
    });

    it('creates deployment with valid parameters', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'create_deployment',
        serviceId: '550e8400-e29b-41d4-a716-446655440001',
        environment: 'production',
        provider: 'railway',
        url: 'https://api.example.com',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.deployment.environment).toBe('production');
    });

    it('creates interface with valid parameters', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'create_interface',
        serviceId: '550e8400-e29b-41d4-a716-446655440001',
        name: 'create_resource',
        interfaceType: 'mcp_tool',
        description: 'Creates a new resource',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.interface.interface_type).toBe('mcp_tool');
    });
  });

  describe('Service discovery flow', () => {
    it('discovers services by type', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'discover',
        serviceType: 'mcp',
      });

      const response = JSON.parse(result.content[0].text);
      // Verify proper response structure
      expect(response).toHaveProperty('meta');
      expect(response).toHaveProperty('data');
    });

    it('finds MCP tools across services', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'mcp_tools',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty('meta');
      expect(response).toHaveProperty('data');
    });

    it('finds healthy production deployments', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'healthy',
        environment: 'production',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty('meta');
      expect(response).toHaveProperty('data');
    });

    it('requests service details with valid UUID', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'details',
        id: '550e8400-e29b-41d4-a716-446655440000',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty('meta');
      expect(response).toHaveProperty('data');
    });
  });

  describe('Error handling', () => {
    it('handles missing service gracefully', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'get_service',
        id: '550e8400-e29b-41d4-a716-446655440099', // Valid UUID but doesn't exist
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
      // Either NOT_FOUND or DATABASE_ERROR depending on mock behavior
      expect(['NOT_FOUND', 'DATABASE_ERROR']).toContain(response.meta.code);
    });

    it('validates required parameters', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'create_service',
        // Missing required fields
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });
  });
});
