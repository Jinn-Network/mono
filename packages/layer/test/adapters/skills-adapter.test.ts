import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSkillsPortContract } from '@jinn-network/plugin/testing';
import { createSkillsAdapter } from '../../src/adapters/skills-adapter.js';

function makeAdapter() {
  const installDir = mkdtempSync(join(tmpdir(), 'skills-'));
  return createSkillsAdapter({ installDir });
}

describeSkillsPortContract(makeAdapter);

describe('SkillsAdapter', () => {
  it('install records an installedAt timestamp', async () => {
    const adapter = makeAdapter();
    const result = await adapter.install('org/skill@1.0.0');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.ref).toBe('org/skill@1.0.0');
    expect(() => new Date(result.value.installedAt).toISOString()).not.toThrow();
  });

  it('uninstall of a never-installed ref is idempotent ok', async () => {
    const adapter = makeAdapter();
    const result = await adapter.uninstall('org/never@1.0.0');
    expect(result).toEqual({ status: 'ok', value: { ref: 'org/never@1.0.0' } });
  });

  it('installed refs survive a fresh adapter on the same dir', async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'skills-persist-'));
    const a = createSkillsAdapter({ installDir });
    await a.install('org/persist@1.0.0');
    const b = createSkillsAdapter({ installDir });
    const list = await b.list();
    expect(list.status).toBe('ok');
    if (list.status === 'ok') expect(list.value.map((s) => s.ref)).toContain('org/persist@1.0.0');
  });
});
