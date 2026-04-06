import { beforeEach, describe, it, expect, vi } from 'vitest';
import { extractSchemaEnvVars } from 'jinn-node/shared/job-env.js';

// ── Mocks for dispatchFromTemplate wiring tests ──
// buildIpfsPayload is the assertion target — we reject it with a sentinel
// to halt execution before the dynamic marketplaceInteract import, which
// resolves to jinn-node's nested node_modules and can't be intercepted
// by vi.mock from the test file's resolution context.

vi.mock('jinn-node/scripts/templates/crud.js', () => ({
  getTemplate: vi.fn(),
}));
vi.mock('jinn-node/agent/shared/ipfs-payload-builder.js', () => ({
  buildIpfsPayload: vi.fn(),
}));
vi.mock('jinn-node/shared/template-tools.js', () => ({
  extractToolPolicyFromBlueprint: vi.fn(),
}));
vi.mock('jinn-node/env/operate-profile.js', () => ({
  getMechAddress: vi.fn(),
  getServicePrivateKey: vi.fn(),
  getMechChainConfig: vi.fn(),
}));
vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getRequiredRpcUrl: vi.fn(),
}));
vi.mock('jinn-node/worker/filters/stakingFilter.js', () => ({
  getRandomStakedMech: vi.fn(),
}));
vi.mock('jinn-node/logging/index.js', () => {
  const makeLog = (): any => {
    const fns: any = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    fns.child.mockReturnValue(fns);
    return fns;
  };
  return { workerLogger: makeLog(), logger: makeLog() };
});

import { getTemplate } from 'jinn-node/scripts/templates/crud.js';
import { buildIpfsPayload } from 'jinn-node/agent/shared/ipfs-payload-builder.js';
import { extractToolPolicyFromBlueprint } from 'jinn-node/shared/template-tools.js';
import { dispatchFromTemplate } from 'jinn-node/worker/ventures/ventureDispatch.js';

const mockGetTemplate = vi.mocked(getTemplate);
const mockBuildIpfsPayload = vi.mocked(buildIpfsPayload);
const mockExtractToolPolicy = vi.mocked(extractToolPolicyFromBlueprint);

// Sentinel error thrown by buildIpfsPayload mock to halt before marketplace call.
const HALT = '__test_halt_before_marketplace__';

// ── extractSchemaEnvVars (pure helper) ──

describe('extractSchemaEnvVars', () => {
  it('extracts env vars from schema properties with envVar + matching input', () => {
    const schema = {
      properties: {
        websiteId: { type: 'string', envVar: 'JINN_JOB_WEBSITE_ID' },
        apiKey: { type: 'string', envVar: 'JINN_JOB_API_KEY' },
      },
    };
    const input = { websiteId: 'site-123', apiKey: 'key-abc' };

    const result = extractSchemaEnvVars(schema, input, 'test');

    expect(result).toEqual({
      JINN_JOB_WEBSITE_ID: 'site-123',
      JINN_JOB_API_KEY: 'key-abc',
    });
  });

  it('returns undefined when no envVar fields exist in schema', () => {
    const schema = {
      properties: {
        name: { type: 'string' },
        count: { type: 'number', default: 5 },
      },
    };
    const input = { name: 'test', count: 10 };

    expect(extractSchemaEnvVars(schema, input, 'test')).toBeUndefined();
  });

  it('returns undefined when schema has no properties', () => {
    expect(extractSchemaEnvVars({}, { foo: 'bar' }, 'test')).toBeUndefined();
    expect(extractSchemaEnvVars({ type: 'object' }, { foo: 'bar' }, 'test')).toBeUndefined();
  });

  it('skips envVar fields when input value is missing', () => {
    const schema = {
      properties: {
        websiteId: { type: 'string', envVar: 'JINN_JOB_WEBSITE_ID' },
        apiKey: { type: 'string', envVar: 'JINN_JOB_API_KEY' },
      },
    };
    const input = { websiteId: 'site-123' };

    const result = extractSchemaEnvVars(schema, input, 'test');

    expect(result).toEqual({ JINN_JOB_WEBSITE_ID: 'site-123' });
  });

  it('returns undefined when all envVar fields lack input values', () => {
    const schema = {
      properties: {
        websiteId: { type: 'string', envVar: 'JINN_JOB_WEBSITE_ID' },
      },
    };
    const input = {};

    expect(extractSchemaEnvVars(schema, input, 'test')).toBeUndefined();
  });

  it('coerces non-string input values via String()', () => {
    const schema = {
      properties: {
        count: { type: 'number', envVar: 'JINN_JOB_COUNT' },
        enabled: { type: 'boolean', envVar: 'JINN_JOB_ENABLED' },
      },
    };
    const input = { count: 42, enabled: true };

    const result = extractSchemaEnvVars(schema, input, 'test');

    expect(result).toEqual({
      JINN_JOB_COUNT: '42',
      JINN_JOB_ENABLED: 'true',
    });
  });

  it('throws on invalid non-JINN_JOB_ env key', () => {
    const schema = {
      properties: {
        secret: { type: 'string', envVar: 'SECRET_KEY' },
      },
    };
    const input = { secret: 'val' };

    expect(() => extractSchemaEnvVars(schema, input, 'test')).toThrow(
      /invalid env key "SECRET_KEY"/
    );
  });
});

// ── dispatchFromTemplate wiring ──
// Each test asserts on the options passed to buildIpfsPayload, which is
// called BEFORE the marketplace posting step. buildIpfsPayload rejects
// with a sentinel to stop execution there — args are still recorded.

describe('dispatchFromTemplate', () => {
  const VENTURE = {
    id: 'v-1',
    name: 'Test Venture',
    slug: 'test-venture',
    description: null,
    owner_address: '0xabc',
    blueprint: { invariants: [] },
    root_workstream_id: null,
    root_job_instance_id: null,
    status: 'active',
    dispatch_schedule: [],
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };

  function makeTemplate(overrides: Record<string, any> = {}) {
    return {
      id: 't-1',
      name: 'Analytics',
      slug: 'analytics',
      description: null,
      version: '1',
      blueprint: { invariants: [] },
      input_schema: null,
      output_spec: {},
      enabled_tools: ['search'],
      tags: [],
      price_wei: null,
      price_usd: null,
      safety_tier: 'standard',
      default_cyclic: false,
      venture_id: 'v-1',
      status: 'active',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      ...overrides,
    };
  }

  function makeEntry(overrides: Record<string, any> = {}) {
    return {
      id: 'e-1',
      templateId: 't-1',
      cron: '0 9 * * 1',
      ...overrides,
    };
  }

  /** Call dispatchFromTemplate and ignore the sentinel rejection. */
  async function callAndCapture(
    venture: any,
    entry: any,
    opts?: any,
  ) {
    await expect(dispatchFromTemplate(venture, entry, opts)).rejects.toThrow(HALT);
    return mockBuildIpfsPayload.mock.calls[0][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractToolPolicy.mockReturnValue({ availableTools: [], blockedTools: [] } as any);
    mockBuildIpfsPayload.mockRejectedValue(new Error(HALT));
  });

  it('passes schema-extracted env vars to buildIpfsPayload', async () => {
    mockGetTemplate.mockResolvedValue(makeTemplate({
      input_schema: {
        properties: {
          websiteId: { type: 'string', envVar: 'JINN_JOB_WEBSITE_ID' },
        },
      },
    }));

    const opts = await callAndCapture(
      VENTURE,
      makeEntry({ input: { websiteId: 'site-42' } }),
    );

    expect(opts.additionalContextOverrides?.env).toEqual({
      JINN_JOB_WEBSITE_ID: 'site-42',
    });
  });

  it('merges schema-extracted and explicit env (explicit wins)', async () => {
    mockGetTemplate.mockResolvedValue(makeTemplate({
      input_schema: {
        properties: {
          websiteId: { type: 'string', envVar: 'JINN_JOB_WEBSITE_ID' },
          apiKey: { type: 'string', envVar: 'JINN_JOB_API_KEY' },
        },
      },
    }));

    const opts = await callAndCapture(
      VENTURE,
      makeEntry({
        input: {
          websiteId: 'from-schema',
          apiKey: 'key-123',
          env: { JINN_JOB_WEBSITE_ID: 'explicit-override' },
        },
      }),
    );

    expect(opts.additionalContextOverrides?.env).toEqual({
      JINN_JOB_WEBSITE_ID: 'explicit-override',
      JINN_JOB_API_KEY: 'key-123',
    });
  });

  it('passes no env when template has no input_schema', async () => {
    mockGetTemplate.mockResolvedValue(makeTemplate({ input_schema: null }));

    const opts = await callAndCapture(
      VENTURE,
      makeEntry({ input: { foo: 'bar' } }),
    );

    expect(opts.additionalContextOverrides?.env).toBeUndefined();
  });

  it('passes no env when schema has no envVar fields', async () => {
    mockGetTemplate.mockResolvedValue(makeTemplate({
      input_schema: {
        properties: {
          name: { type: 'string' },
        },
      },
    }));

    const opts = await callAndCapture(
      VENTURE,
      makeEntry({ input: { name: 'hello' } }),
    );

    expect(opts.additionalContextOverrides?.env).toBeUndefined();
  });

  it('uses schema defaults merged with entry input for env extraction', async () => {
    mockGetTemplate.mockResolvedValue(makeTemplate({
      input_schema: {
        properties: {
          websiteId: { type: 'string', default: 'default-site', envVar: 'JINN_JOB_WEBSITE_ID' },
        },
      },
    }));

    const opts = await callAndCapture(
      VENTURE,
      makeEntry({ input: {} }),
    );

    expect(opts.additionalContextOverrides?.env).toEqual({
      JINN_JOB_WEBSITE_ID: 'default-site',
    });
  });
});
