import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugInManifest } from '@jinn-network/client/dist/restorer/plug-ins/manifest.js';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('@jinn-examples/forecasting-techniques manifest', () => {
  it('validates and declares a skill-bundle slot', async () => {
    const m = await loadPlugInManifest(PKG_ROOT);
    expect(m.name).toBe('@jinn-examples/forecasting-techniques');
    const slot = m.slots[0];
    if (slot.type !== 'skill-bundle') throw new Error('wrong slot type');
    expect(slot.skillsDir).toBe('skills');
    expect(slot.scope?.matchKinds).toContain('prediction.v0');
  });

  it('ships three SKILL.md files under skills/', () => {
    for (const skill of [
      'reference-class-forecasting',
      'base-rate-anchoring',
      'calibration-techniques',
    ]) {
      expect(existsSync(join(PKG_ROOT, 'skills', skill, 'SKILL.md'))).toBe(
        true,
      );
    }
  });

  it('ships a Claude Code plugin.json', () => {
    const plug = JSON.parse(
      readFileSync(join(PKG_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name?: string };
    expect(plug.name).toBe('forecasting-techniques');
  });
});
