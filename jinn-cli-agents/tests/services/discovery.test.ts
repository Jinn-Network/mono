import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock data storage
let mockServices: any[] = [];
let mockDeployments: any[] = [];
let mockInterfaces: any[] = [];

// Mock Supabase client with chaining support
const createMockQuery = (table: string) => {
  const getData = () => {
    switch (table) {
      case 'services': return mockServices;
      case 'deployments': return mockDeployments;
      case 'interfaces': return mockInterfaces;
      default: return [];
    }
  };

  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    or: vi.fn(() => query),
    contains: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    range: vi.fn(() => query),
    single: vi.fn(() => Promise.resolve({
      data: getData()[0] || null,
      error: getData()[0] ? null : { code: 'PGRST116' },
    })),
    then: (resolve: any) => resolve({
      data: getData(),
      error: null,
      count: getData().length,
    }),
  };
  return query;
};

const mockSupabase = {
  from: vi.fn((table: string) => createMockQuery(table)),
};

// Mock logging
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
  mockServices = [];
  mockDeployments = [];
  mockInterfaces = [];
  vi.clearAllMocks();
});

describe('search_services tool', () => {
  describe('discover mode', () => {
    beforeEach(() => {
      mockServices = [
        {
          id: 'svc-1',
          name: 'Auth Service',
          slug: 'auth-service',
          service_type: 'api',
          status: 'active',
          venture: { id: 'v-1', name: 'Jinn', slug: 'jinn' },
        },
        {
          id: 'svc-2',
          name: 'MCP Tools',
          slug: 'mcp-tools',
          service_type: 'mcp',
          status: 'active',
          venture: { id: 'v-1', name: 'Jinn', slug: 'jinn' },
        },
      ];
    });

    it('discovers all services', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'discover',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.services).toBeDefined();
    });

    it('filters by service type', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'discover',
        serviceType: 'mcp',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
    });

    it('supports text search', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'discover',
        query: 'auth',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
    });

    it('supports pagination', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'discover',
        limit: 10,
        offset: 0,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
    });
  });

  describe('mcp_tools mode', () => {
    beforeEach(() => {
      mockInterfaces = [
        {
          id: 'iface-1',
          name: 'create_venture',
          interface_type: 'mcp_tool',
          status: 'active',
          service: { id: 'svc-1', name: 'Ventures', slug: 'ventures' },
        },
        {
          id: 'iface-2',
          name: 'search_services',
          interface_type: 'mcp_tool',
          status: 'active',
          service: { id: 'svc-2', name: 'Discovery', slug: 'discovery' },
        },
      ];
    });

    it('finds MCP tool interfaces', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'mcp_tools',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.tools).toBeDefined();
    });

    it('searches MCP tools by name', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'mcp_tools',
        query: 'create',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
    });
  });

  describe('healthy mode', () => {
    beforeEach(() => {
      mockDeployments = [
        {
          id: 'dep-1',
          service_id: 'svc-1',
          environment: 'production',
          health_status: 'healthy',
          status: 'active',
          service: { id: 'svc-1', name: 'API' },
        },
      ];
    });

    it('finds healthy deployments', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'healthy',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.deployments).toBeDefined();
    });

    it('filters by environment', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'healthy',
        environment: 'production',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
    });
  });

  describe('by_venture mode', () => {
    it('requires id parameter', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'by_venture',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('lists services for a venture', async () => {
      mockServices = [
        { id: 'svc-1', venture_id: 'v-1', name: 'Service 1' },
      ];

      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'by_venture',
        id: '550e8400-e29b-41d4-a716-446655440000',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
    });
  });

  describe('details mode', () => {
    beforeEach(() => {
      mockServices = [{
        id: 'svc-1',
        name: 'Test Service',
        venture: { id: 'v-1', name: 'Jinn' },
      }];
      mockDeployments = [{ id: 'dep-1', service_id: 'svc-1' }];
      mockInterfaces = [{ id: 'iface-1', service_id: 'svc-1' }];
    });

    it('requires id parameter', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'details',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('returns service with all relations', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'details',
        id: '550e8400-e29b-41d4-a716-446655440000',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.service).toBeDefined();
    });
  });

  describe('validation', () => {
    it('validates mode parameter', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'invalid_mode',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
    });

    it('validates enum values', async () => {
      const { searchServices } = await import('../../gemini-agent/mcp/tools/search_services.js');

      const result = await searchServices({
        mode: 'discover',
        serviceType: 'invalid_type',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
    });
  });
});
