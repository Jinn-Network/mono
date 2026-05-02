import { describe, expect, it } from 'vitest';
import { validateSolverPluginManifest } from '../src/plugins.js';
import type { SolverPluginManifest } from '../src/plugins.js';

describe('@jinn-network/sdk/plugins', () => {
  it('validates a standard SolverPlugin manifest', () => {
    const manifest: SolverPluginManifest = validateSolverPluginManifest({
      name: '@jinn-network/prediction-plugin',
      version: '1.0.0',
      jinn: {
        supports: ['prediction.v1'],
        mcpServers: {
          polymarket: { command: 'node', args: ['mcp/polymarket-server.mjs'] },
        },
        skills: ['skills/base-rate-forecasting'],
      },
    });
    expect(manifest.jinn?.supports).toEqual(['prediction.v1']);
  });

  it('rejects canonical schema authority in plugins', () => {
    expect(() =>
      validateSolverPluginManifest({
        name: '@x/plugin',
        version: '1.0.0',
        jinn: { schemas: {} },
      }),
    ).toThrow(/schemas is no longer supported/);
  });
});
