/**
 * Regression test for issue #1363: the explorer SPA catch-all shadowing
 * JSON API routes.
 *
 * `src/api/index.ts` gates the SPA static handler + index.html fallback on
 * `existsSync('./public/index.html')`. CI and this suite normally run without
 * an explorer build, so the catch-all never registers and route-order bugs
 * pass silently — while the production Docker image always ships the build,
 * where a JSON route registered after the catch-all is unreachable (Hono
 * matches in registration order). That is exactly how /capture-meta,
 * /distribution-signal, /plugins and /builders/* went dark on
 * jinn-indexer-production while every test stayed green.
 *
 * This test fabricates a SPA build in a temp CWD before importing the app, so
 * the catch-all IS registered, then asserts every JSON route still answers
 * with JSON and the SPA still serves the shell, deep links, and assets.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';

// graphql() refuses to initialise outside a Ponder project; the /graphql
// mount is not under test here. Everything else stays the real module.
vi.mock('ponder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ponder')>();
  return {
    ...actual,
    graphql: () => async (_c: unknown, next: () => Promise<void>) => {
      await next();
    },
  };
});

const SHELL = '<!doctype html><html><body>spa shell probe</body></html>';
const CSS = 'body{color:red}';

let app: Hono;
let dir: string;
let prevCwd: string;

beforeAll(async () => {
  prevCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'jinn-indexer-spa-'));
  mkdirSync(join(dir, 'public', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'public', 'index.html'), SHELL);
  writeFileSync(join(dir, 'public', 'assets', 'probe.css'), CSS);
  // hasSpaBuild and serveStatic both resolve ./public against the CWD, so the
  // chdir must happen before the app module is imported.
  process.chdir(dir);
  app = (await import('../src/api/index.js')).default;
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('JSON API routes are not shadowed by the SPA catch-all (#1363)', () => {
  // Every JSON route must reach its handler: a JSON content-type (the
  // handlers' own success/400/503 shapes) — never the SPA HTML shell.
  const routes = [
    '/supply?chainId=84532',
    '/capture-meta?q=tdd',
    '/distribution-signal',
    '/plugins', // no params → the handler's own 400 JSON
    '/builders/0x0000000000000000000000000000000000000001/artifacts',
    '/builders/1/runs',
    '/plugins/bafyprobecid/scores',
    '/builders/0x0000000000000000000000000000000000000001/scores',
  ];

  for (const route of routes) {
    it(`${route} answers JSON, not the SPA shell`, async () => {
      const res = await app.request(route);
      const body = await res.text();
      expect(body, `${route} served the SPA shell`).not.toContain('spa shell probe');
      expect(res.headers.get('content-type') ?? '').toContain('application/json');
    });
  }
});

describe('SPA serving still works with routes registered first', () => {
  it('/ serves the shell', async () => {
    const res = await app.request('/');
    expect(await res.text()).toBe(SHELL);
  });

  it('deep links fall back to the shell for client-side routing', async () => {
    const res = await app.request('/solvernet/bafyprobecid');
    expect(await res.text()).toBe(SHELL);
  });

  it('/assets/* serves real files', async () => {
    const res = await app.request('/assets/probe.css');
    expect(await res.text()).toBe(CSS);
  });
});
