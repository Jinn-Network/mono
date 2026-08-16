import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { gatherStatusForApi } from '../../src/api/gather-status.js';

describe('/v1/status costSurface block', () => {
  let store: Store;
  afterEach(() => {
    store?.close();
    vi.unstubAllEnvs();
  });

  it('exposes claude-code usesPaidApiKey from daemon env', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    store = new Store(join(mkdtempSync(join(tmpdir(), 'status-cost-')), 'jinn.db'));
    const body = await gatherStatusForApi(store, {});
    expect(body.costSurface.harnesses['claude-code']?.usesPaidApiKey).toBe(true);
    expect(body.costSurface.harnesses['claude-code']?.credentialId).toBe('anthropic:api-key');
  });
});
