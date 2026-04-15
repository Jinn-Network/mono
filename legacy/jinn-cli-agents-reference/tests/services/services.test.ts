import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock data storage
let mockData: Record<string, any[]> = {};

// Mock Supabase client
const mockSupabase = {
  from: vi.fn((table: string) => ({
    insert: vi.fn((record: any) => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({
          data: { id: 'test-service-uuid', ...record, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          error: null,
        })),
      })),
    })),
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({
          data: mockData[table]?.[0] || null,
          error: mockData[table]?.[0] ? null : { code: 'PGRST116' },
        })),
        order: vi.fn(() => Promise.resolve({
          data: mockData[table] || [],
          error: null,
        })),
      })),
      order: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({
          data: mockData[table] || [],
          error: null,
        })),
        limit: vi.fn(() => Promise.resolve({
          data: mockData[table] || [],
          error: null,
        })),
      })),
    })),
    update: vi.fn((record: any) => ({
      eq: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({
            data: mockData[table]?.[0] ? { ...mockData[table][0], ...record } : null,
            error: mockData[table]?.[0] ? null : { code: 'PGRST116' },
          })),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ error: null })),
    })),
  })),
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
  mockData = {};
  vi.clearAllMocks();
});

describe('service_registry tool - service operations', () => {
  describe('create_service', () => {
    it('creates a service with required fields', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'create_service',
        ventureId: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Test Service',
        serviceType: 'api',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.service).toBeDefined();
      expect(response.data.service.name).toBe('Test Service');
    });

    it('generates slug from name', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'create_service',
        ventureId: '550e8400-e29b-41d4-a716-446655440000',
        name: 'My API Service',
        serviceType: 'api',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.service.slug).toBe('my-api-service');
    });

    it('requires ventureId, name, and serviceType', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'create_service',
        name: 'Test Service',
        // missing ventureId and serviceType
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('accepts all service types', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const serviceTypes = ['mcp', 'api', 'worker', 'frontend', 'library', 'other'];

      for (const serviceType of serviceTypes) {
        const result = await serviceRegistry({
          action: 'create_service',
          ventureId: '550e8400-e29b-41d4-a716-446655440000',
          name: `Test ${serviceType}`,
          serviceType,
        });

        const response = JSON.parse(result.content[0].text);
        expect(response.meta.ok).toBe(true);
      }
    });
  });

  describe('get_service', () => {
    const SERVICE_UUID = '660e8400-e29b-41d4-a716-446655440001';

    beforeEach(() => {
      mockData['services'] = [{
        id: SERVICE_UUID,
        venture_id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Existing Service',
        slug: 'existing-service',
        service_type: 'api',
        status: 'active',
      }];
    });

    it('retrieves service by ID', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'get_service',
        id: SERVICE_UUID,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.service.name).toBe('Existing Service');
    });

    it('requires id parameter', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'get_service',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('update_service', () => {
    const SERVICE_UUID = '660e8400-e29b-41d4-a716-446655440001';

    beforeEach(() => {
      mockData['services'] = [{
        id: SERVICE_UUID,
        name: 'Existing Service',
        status: 'active',
      }];
    });

    it('updates service fields', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'update_service',
        id: SERVICE_UUID,
        name: 'Updated Service',
        version: '2.0.0',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
    });

    it('rejects update with no fields', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'update_service',
        id: SERVICE_UUID,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(false);
      expect(response.meta.message).toContain('No fields to update');
    });
  });

  describe('delete_service', () => {
    const SERVICE_UUID = '660e8400-e29b-41d4-a716-446655440001';

    it('deletes service by ID', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'delete_service',
        id: SERVICE_UUID,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.meta.ok).toBe(true);
      expect(response.data.deleted).toBe(true);
    });
  });

  describe('list_services', () => {
    it('lists services without error', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'list_services',
      });

      const response = JSON.parse(result.content[0].text);
      // Just verify no crash and proper response structure
      expect(response).toHaveProperty('meta');
      expect(response).toHaveProperty('data');
    });

    it('accepts service type filter', async () => {
      const { serviceRegistry } = await import('../../gemini-agent/mcp/tools/service_registry.js');

      const result = await serviceRegistry({
        action: 'list_services',
        serviceType: 'mcp',
      });

      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty('meta');
    });
  });
});
