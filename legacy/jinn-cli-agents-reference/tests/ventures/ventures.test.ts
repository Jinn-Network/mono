import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock data storage
let mockData: Record<string, any[]> = {};
let insertedRecords: any[] = [];

// Mock Supabase client
const mockSupabase = {
  from: vi.fn((table: string) => ({
    insert: vi.fn((record: any) => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({
          data: { id: 'test-uuid', ...record, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
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
  insertedRecords = [];
  vi.clearAllMocks();
});

describe('venture_mint tool', () => {
  it('creates a venture with valid blueprint', async () => {
    const { ventureMint } = await import('../../gemini-agent/mcp/tools/venture_mint.js');

    const result = await ventureMint({
      name: 'Test Venture',
      ownerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      blueprint: JSON.stringify({ invariants: [{ id: 'inv-1', name: 'Test Invariant' }] }),
    });

    expect(result.content).toHaveLength(1);
    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(true);
    expect(response.data.venture).toBeDefined();
    expect(response.data.venture.name).toBe('Test Venture');
  });

  it('rejects invalid blueprint JSON', async () => {
    const { ventureMint } = await import('../../gemini-agent/mcp/tools/venture_mint.js');

    const result = await ventureMint({
      name: 'Test Venture',
      ownerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      blueprint: 'not valid json',
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(false);
    expect(response.meta.code).toBe('VALIDATION_ERROR');
    expect(response.meta.message).toContain('Invalid blueprint JSON');
  });

  it('rejects blueprint without invariants array', async () => {
    const { ventureMint } = await import('../../gemini-agent/mcp/tools/venture_mint.js');

    const result = await ventureMint({
      name: 'Test Venture',
      ownerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      blueprint: JSON.stringify({ someField: 'value' }),
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(false);
    expect(response.meta.code).toBe('VALIDATION_ERROR');
    expect(response.meta.message).toContain('invariants');
  });

  it('generates slug from name if not provided', async () => {
    const { ventureMint } = await import('../../gemini-agent/mcp/tools/venture_mint.js');

    const result = await ventureMint({
      name: 'My Test Venture',
      ownerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      blueprint: JSON.stringify({ invariants: [] }),
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(true);
    expect(response.data.venture.slug).toBe('my-test-venture');
  });

  it('validates required fields', async () => {
    const { ventureMint } = await import('../../gemini-agent/mcp/tools/venture_mint.js');

    const result = await ventureMint({
      name: 'Test',
      // missing ownerAddress and blueprint
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(false);
    expect(response.meta.code).toBe('VALIDATION_ERROR');
  });
});

describe('venture_update tool', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    mockData['ventures'] = [{
      id: VALID_UUID,
      name: 'Existing Venture',
      slug: 'existing-venture',
      owner_address: '0x1234567890abcdef1234567890abcdef12345678',
      blueprint: { invariants: [] },
      status: 'active',
    }];
  });

  it('updates venture name', async () => {
    const { ventureUpdate } = await import('../../gemini-agent/mcp/tools/venture_update.js');

    const result = await ventureUpdate({
      id: VALID_UUID,
      name: 'Updated Venture Name',
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(true);
  });

  it('updates venture status', async () => {
    const { ventureUpdate } = await import('../../gemini-agent/mcp/tools/venture_update.js');

    const result = await ventureUpdate({
      id: VALID_UUID,
      status: 'paused',
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(true);
  });

  it('validates blueprint on update', async () => {
    const { ventureUpdate } = await import('../../gemini-agent/mcp/tools/venture_update.js');

    const result = await ventureUpdate({
      id: VALID_UUID,
      blueprint: 'invalid json',
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(false);
    expect(response.meta.code).toBe('VALIDATION_ERROR');
  });

  it('rejects update with no fields', async () => {
    const { ventureUpdate } = await import('../../gemini-agent/mcp/tools/venture_update.js');

    const result = await ventureUpdate({
      id: VALID_UUID,
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(false);
    expect(response.meta.message).toContain('No fields to update');
  });

  it('requires valid UUID for id', async () => {
    const { ventureUpdate } = await import('../../gemini-agent/mcp/tools/venture_update.js');

    const result = await ventureUpdate({
      id: 'not-a-uuid',
      name: 'New Name',
    });

    const response = JSON.parse(result.content[0].text);
    expect(response.meta.ok).toBe(false);
    expect(response.meta.code).toBe('VALIDATION_ERROR');
  });
});
