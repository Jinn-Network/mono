import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeContributionPortContract } from '@jinn-network/plugin/testing';
import {
  createContributionAdapter,
  createContributionStatusStore,
} from '../../src/adapters/contribution-adapter.js';

function tmpStatusFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'contrib-adapter-')), 'status.json');
}

function makeAdapter() {
  return createContributionAdapter({ statusStore: createContributionStatusStore(tmpStatusFile()) });
}

describeContributionPortContract(makeAdapter);

describe('ContributionAdapter — unknown record', () => {
  it('mintStatus on an unknown recordId is unavailable', async () => {
    const adapter = makeAdapter();
    const result = await adapter.mintStatus('nope');
    expect(result.status).toBe('unavailable');
  });

  it('veto on an unknown recordId is unavailable', async () => {
    const adapter = makeAdapter();
    const result = await adapter.veto('nope');
    expect(result.status).toBe('unavailable');
  });
});
