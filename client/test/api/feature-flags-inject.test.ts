import { describe, expect, it } from 'vitest';
import { injectFeatureFlags, isEmbeddedAgentEnabled } from '../../src/api/server.js';

/**
 * Issue #327: the daemon injects `window.__JINN_FEATURES__` into the served
 * SPA `index.html` so the operator app can gate builder surfaces off by
 * default. These tests cover the pure injection helper — the env-var → flag
 * mapping (`resolveFeatureFlags`) is exercised indirectly by the SPA's
 * `lib/features.test.ts`.
 */
const SPA_INDEX = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <title>jinn operator</title>',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '    <script type="module" src="/assets/main.js"></script>',
  '  </body>',
  '</html>',
].join('\n');

describe('injectFeatureFlags', () => {
  it('injects window.__JINN_FEATURES__ before the SPA module script', () => {
    const out = injectFeatureFlags(SPA_INDEX, { pluginBuilderUi: false });
    expect(out).toContain('window.__JINN_FEATURES__={"pluginBuilderUi":false}');
    // The flags script must run before the SPA module loads.
    const flagsIdx = out.indexOf('__JINN_FEATURES__');
    const moduleIdx = out.indexOf('type="module"');
    expect(flagsIdx).toBeGreaterThanOrEqual(0);
    expect(flagsIdx).toBeLessThan(moduleIdx);
  });

  it('serialises an enabled flag as true', () => {
    const out = injectFeatureFlags(SPA_INDEX, { pluginBuilderUi: true });
    expect(out).toContain('window.__JINN_FEATURES__={"pluginBuilderUi":true}');
  });

  it('preserves the original SPA markup', () => {
    const out = injectFeatureFlags(SPA_INDEX, { pluginBuilderUi: false });
    expect(out).toContain('<div id="root"></div>');
    expect(out).toContain('src="/assets/main.js"');
  });

  it('falls back to </head> when no module script is present', () => {
    const noModule = '<html><head><title>x</title></head><body></body></html>';
    const out = injectFeatureFlags(noModule, { pluginBuilderUi: true });
    expect(out).toContain('__JINN_FEATURES__');
    expect(out.indexOf('__JINN_FEATURES__')).toBeLessThan(out.indexOf('</head>'));
  });

  it('falls back to </body> when neither module script nor </head> is present', () => {
    const noHead = '<html><body><div id="root"></div></body></html>';
    const out = injectFeatureFlags(noHead, { pluginBuilderUi: false });
    expect(out).toContain('__JINN_FEATURES__');
    expect(out.indexOf('__JINN_FEATURES__')).toBeLessThan(out.indexOf('</body>'));
  });
});

/**
 * Issue #326 / #367: the embedded Claude agent chat surface is gated behind
 * `JINN_ENABLE_EMBEDDED_AGENT`. Per #367 this flag converged onto the same
 * `window.__JINN_FEATURES__` channel as the builder UI flag — `resolveFeatureFlags`
 * derives `embeddedAgent` from it. `isEmbeddedAgentEnabled` stays a standalone
 * helper because the daemon also reads it directly to gate the `/api/agent/ws`
 * bridge.
 */
describe('isEmbeddedAgentEnabled', () => {
  it('defaults to false when the env var is unset', () => {
    expect(isEmbeddedAgentEnabled({})).toBe(false);
  });

  it('is true for "1"', () => {
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: '1' })).toBe(true);
  });

  it('is true for "true" (case-insensitive, trimmed)', () => {
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: 'true' })).toBe(true);
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: ' TRUE ' })).toBe(true);
  });

  it('is false for any other value', () => {
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: '0' })).toBe(false);
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: 'yes' })).toBe(false);
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: '' })).toBe(false);
  });
});
