import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './_support/source-text.js';

const discoveryHttpSource = codeOnly(readFileSync(
  fileURLToPath(new URL('../../src/discovery/http.ts', import.meta.url)),
  'utf-8',
));
const discoveryFactorySource = codeOnly(readFileSync(
  fileURLToPath(new URL('../../src/discovery/factory.ts', import.meta.url)),
  'utf-8',
));
const mcpServerSource = codeOnly(readFileSync(
  fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url)),
  'utf-8',
));

describe('core owns corpus HTTP discovery', () => {
  it('ignores ownership markers in prose without hiding a real query definition', () => {
    const prose = codeOnly([
      '/** QUERY_ENVELOPES_QUERY is named here as historical context. */',
      '// query QueryEnvelopes is not an implementation.',
      'const safe = true;',
    ].join('\n'));
    expect(prose).not.toContain('QUERY_ENVELOPES_QUERY');
    expect(prose).not.toContain('query QueryEnvelopes');
    expect(codeOnly('/** safe */\nconst QUERY_ENVELOPES_QUERY = `query QueryEnvelopes { id }`;'))
      .toContain('QUERY_ENVELOPES_QUERY');
  });

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
