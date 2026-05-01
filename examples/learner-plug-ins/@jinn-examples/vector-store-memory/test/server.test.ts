import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugInManifest } from '@jinn-network/client/dist/restorer/plug-ins/manifest.js';
import { InMemoryStore } from '../src/in-memory-store.js';
import { buildHandler } from '../src/server.js';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('InMemoryStore', () => {
  it('embeds, retrieves nearest neighbours', () => {
    const s = new InMemoryStore();
    s.embed('a', 'apple banana orange');
    s.embed('b', 'rocket launch space');
    s.embed('c', 'apple pie recipe');
    const r = s.query('apple fruit', 2);
    expect(r).toHaveLength(2);
    expect(['a', 'c']).toContain(r[0]?.id);
  });

  it('prune removes old entries', () => {
    const s = new InMemoryStore();
    s.embed('a', 'x');
    expect(s.size()).toBe(1);
    expect(s.prune(0)).toBe(1); // maxAge=0 prunes everything
    expect(s.size()).toBe(0);
  });
});

describe('@jinn-examples/vector-store-memory manifest + server', () => {
  it('manifest validates and declares a memory-backend slot', async () => {
    const m = await loadPlugInManifest(PKG_ROOT);
    expect(m.name).toBe('@jinn-examples/vector-store-memory');
    const slot = m.slots[0];
    if (slot.type !== 'memory-backend') throw new Error('wrong slot type');
    expect(slot.command).toBe('node');
  });

  it('tools/list lists embed, query, prune', async () => {
    const handle = buildHandler();
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const result = res.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['embed', 'query', 'prune']));
  });

  it('embed → query round-trip via JSON-RPC', async () => {
    const handle = buildHandler();
    await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'embed',
        arguments: { id: 'a', text: 'apple banana' },
      },
    });
    const res = await handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'query', arguments: { query: 'apple', k: 1 } },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const hits = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    expect(hits[0]?.id).toBe('a');
  });
});
