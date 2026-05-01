import { describe, it, expect } from 'vitest';
import {
  mergeMcpConfig,
  mergeMemoryBackendsIntoMcpConfig,
  pluginDirsForSession,
} from '../../../../src/restorer/impls/claude-code-learner/mcp-config.js';

describe('mergeMcpConfig', () => {
  it('appends slot servers under their plug-in namespace', () => {
    const merged = mergeMcpConfig(
      { mcpServers: { 'in-repo-tool': { command: 'node', args: ['x.js'] } } },
      [
        {
          plugInName: '@x/news',
          plugInVersion: '0.1.0',
          packageRoot: '/tmp/news',
          slot: {
            type: 'mcp-tool',
            command: 'node',
            args: ['/tmp/news/server.js'],
          },
        },
        {
          plugInName: '@x/poly',
          plugInVersion: '0.1.0',
          packageRoot: '/tmp/poly',
          slot: {
            type: 'mcp-tool',
            command: 'node',
            args: ['/tmp/poly/server.js'],
            namespace: 'polymarket',
          },
        },
      ],
    );
    expect(Object.keys(merged.mcpServers)).toEqual(
      expect.arrayContaining(['in-repo-tool', '@x/news', 'polymarket']),
    );
    expect(merged.mcpServers['polymarket'].args).toEqual([
      '/tmp/poly/server.js',
    ]);
  });

  it('rejects collisions with in-repo MCP names', () => {
    expect(() =>
      mergeMcpConfig({ mcpServers: { foo: { command: 'a', args: [] } } }, [
        {
          plugInName: '@x/foo',
          plugInVersion: '0.1.0',
          packageRoot: '/tmp',
          slot: {
            type: 'mcp-tool',
            command: 'b',
            args: [],
            namespace: 'foo',
          },
        },
      ]),
    ).toThrow(/collision/i);
  });

  it('memory-backend slots merge under memory-* prefix', () => {
    const merged = mergeMemoryBackendsIntoMcpConfig({ mcpServers: {} }, [
      {
        plugInName: '@x/vec',
        plugInVersion: '0.1.0',
        packageRoot: '/tmp/vec',
        slot: { type: 'memory-backend', command: 'node', args: ['vec.js'] },
      },
    ]);
    expect(merged.mcpServers).toHaveProperty('memory-@x/vec');
  });
});

describe('pluginDirsForSession', () => {
  it('includes the bundled plugin and each skill-bundle slot package root', () => {
    const registry = {
      skillBundles: [
        {
          packageRoot: '/tmp/skills',
          slot: { skillsDir: 'skills' },
        },
      ],
    };
    const dirs = pluginDirsForSession(registry, '/bundled');
    expect(dirs).toEqual(['/bundled', '/tmp/skills']);
  });

  it('returns just the bundled plugin when no skill bundles installed', () => {
    expect(pluginDirsForSession({ skillBundles: [] }, '/bundled')).toEqual([
      '/bundled',
    ]);
  });
});
