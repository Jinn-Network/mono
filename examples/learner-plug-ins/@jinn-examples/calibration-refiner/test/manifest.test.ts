import { describe, it, expect } from 'vitest';
import { loadPlugInManifest } from '@jinn-network/client/dist/restorer/plug-ins/manifest.js';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('@jinn-examples/calibration-refiner manifest', () => {
  it('validates against the jinn-plugin.json schema', async () => {
    const m = await loadPlugInManifest(PKG_ROOT);
    expect(m.name).toBe('@jinn-examples/calibration-refiner');
    expect(m.slots).toHaveLength(1);
    expect(m.slots[0].type).toBe('phase-agent-override');
  });

  it("targets the Execute phase's step-worker for prediction.v0", async () => {
    const m = await loadPlugInManifest(PKG_ROOT);
    const slot = m.slots[0];
    if (slot.type !== 'phase-agent-override') throw new Error('wrong slot type');
    expect(slot.phase).toBe('execute');
    expect(slot.agent).toBe('step-worker');
    expect(slot.scope?.matchKinds).toContain('prediction.v0');
  });
});
