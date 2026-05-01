import { describe, it, expect } from 'vitest';
import { loadPlugInManifest } from '@jinn-network/client/dist/restorer/plug-ins/manifest.js';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('@jinn-examples/news-context-topic manifest', () => {
  it('validates against the jinn-plugin.json schema', async () => {
    const m = await loadPlugInManifest(PKG_ROOT);
    expect(m.name).toBe('@jinn-examples/news-context-topic');
    expect(m.slots).toHaveLength(1);
    expect(m.slots[0].type).toBe('topic-explorer');
  });

  it('targets the Orient phase with topic news-context for prediction.v0', async () => {
    const m = await loadPlugInManifest(PKG_ROOT);
    const slot = m.slots[0];
    if (slot.type !== 'topic-explorer') throw new Error('wrong slot type');
    expect(slot.phase).toBe('orient');
    expect(slot.topic).toBe('news-context');
    expect(slot.scope?.matchKinds).toContain('prediction.v0');
  });
});
