import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const discoveryHttpSource = readFileSync(
  fileURLToPath(new URL('../../src/discovery/http.ts', import.meta.url)),
  'utf-8',
);
const discoveryFactorySource = readFileSync(
  fileURLToPath(new URL('../../src/discovery/factory.ts', import.meta.url)),
  'utf-8',
);
const mcpServerSource = readFileSync(
  fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url)),
  'utf-8',
);

describe('core owns corpus HTTP discovery', () => {
  it('delegates corpus envelope queries to the core HTTP port', () => {
    expect(discoveryHttpSource).toMatch(
      /const corpusDiscovery = createHttpCorpusDiscovery\(\{/,
    );
    expect(discoveryHttpSource).toContain(
      'return await corpusDiscovery.queryEnvelopes(query);',
    );
    expect(discoveryHttpSource).not.toContain('QUERY_ENVELOPES_QUERY');
    expect(discoveryHttpSource).not.toContain('query QueryEnvelopes');
  });

  it('keeps daemon and MCP compatibility entry points on the composed client adapter', () => {
    expect(discoveryFactorySource).toContain('createHttpDiscoveryAPI');
    expect(mcpServerSource).toContain('createHttpDiscoveryAPI');
  });
});
