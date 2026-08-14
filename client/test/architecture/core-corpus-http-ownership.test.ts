import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './_support/source-text.js';

const discoveryClientHttpSource = codeOnly(readFileSync(
  fileURLToPath(new URL('../../src/discovery-client/http.ts', import.meta.url)),
  'utf-8',
));
const mcpServerSource = codeOnly(readFileSync(
  fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url)),
  'utf-8',
));
const mainSource = codeOnly(readFileSync(
  fileURLToPath(new URL('../../src/main.ts', import.meta.url)),
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
    expect(discoveryClientHttpSource).toMatch(
      /const corpusDiscovery = createHttpCorpusDiscovery\(\{/,
    );
    expect(discoveryClientHttpSource).toContain(
      'return await corpusDiscovery.queryEnvelopes(query);',
    );
    expect(discoveryClientHttpSource).not.toContain('QUERY_ENVELOPES_QUERY');
    expect(discoveryClientHttpSource).not.toContain('query QueryEnvelopes');
  });

  it('keeps daemon corpus and MCP on core / discovery-client, not a second HTTP client', () => {
    expect(mainSource).toContain('createHttpCorpusDiscovery');
    expect(mcpServerSource).toContain('createHttpDiscoveryClient');
    expect(mcpServerSource).toContain("from '../discovery-client/http.js'");
    expect(mcpServerSource).not.toContain("from '../discovery/http.js'");
    expect(mainSource).not.toContain('createHttpDiscoveryAPI');
    expect(mainSource).not.toContain('createDiscoveryAPI');
  });
});
