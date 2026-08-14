import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './_support/source-text.js';

const discoveryHttpSource = codeOnly(readFileSync(
  fileURLToPath(new URL('../../src/discovery/http.ts', import.meta.url)),
  'utf-8',
));
// One-swap R3b (issue #2494) relocated `queryEnvelopes` — and with it the
// delegation to core's HTTP corpus port — onto the neutral `discovery-client/`.
// The ownership assertion follows it there; `discovery/http.ts` must still not
// hand-roll the query it gave up.
const discoveryClientHttpSource = codeOnly(readFileSync(
  fileURLToPath(new URL('../../src/discovery-client/http.ts', import.meta.url)),
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
    expect(discoveryClientHttpSource).toMatch(
      /const corpusDiscovery = createHttpCorpusDiscovery\(\{/,
    );
    expect(discoveryClientHttpSource).toContain(
      'return await corpusDiscovery.queryEnvelopes(query);',
    );
    expect(discoveryClientHttpSource).not.toContain('QUERY_ENVELOPES_QUERY');
    expect(discoveryClientHttpSource).not.toContain('query QueryEnvelopes');
  });

  it('leaves no second envelope-query implementation behind in discovery/', () => {
    expect(discoveryHttpSource).not.toContain('QUERY_ENVELOPES_QUERY');
    expect(discoveryHttpSource).not.toContain('query QueryEnvelopes');
    expect(discoveryHttpSource).not.toContain('createHttpCorpusDiscovery');
  });

  it('keeps daemon and MCP compatibility entry points on the composed client adapter', () => {
    // The daemon still composes the full legacy `DiscoveryAPI`; MCP moved to
    // the relocated slice (R3b) because `queryEnvelopes` and
    // `getCodeDigestRewards` are all it ever drove.
    expect(discoveryFactorySource).toContain('createHttpDiscoveryAPI');
    expect(mcpServerSource).toContain('createHttpDiscoveryClient');
    expect(mcpServerSource).toContain("from '../discovery-client/http.js'");
    expect(mcpServerSource).not.toContain("from '../discovery/http.js'");
  });
});
