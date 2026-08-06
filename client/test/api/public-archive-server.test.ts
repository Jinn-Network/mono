import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicArchiveApp } from '../../src/api/public-archive-server.js';
import { seedArchiveFixture, type SeededArchive } from '../archive/_seed-archive.js';

let root: string;
let seeded: SeededArchive;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jinn-public-archive-'));
  seeded = await seedArchiveFixture({ rootDir: root, sourceName: 'marketplace' });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Every route the MAIN operator API serves without authentication. None of them may be
 * reachable on the public archive plane. Cross-plan contract 7.
 */
const FORBIDDEN = [
  '/',
  '/v1/status',
  '/v1/notifications',
  '/assets/index.js',
  '/artifacts/search',
  '/artifacts/some-id/content',
  '/api/stop-hook',
  '/auth/handshake',
  '/v1/discovery/plugin-publications',
  '/v1/bootstrap',
  '/v1/operator/joined',
  '/api/admin/restart',
  '/some/deep/spa/route',
];

describe('public archive plane exposure scoping', () => {
  it('does not serve any operator route — every forbidden path 404s, never HTML', async () => {
    const app = buildPublicArchiveApp({ handler: seeded.handler });
    for (const path of FORBIDDEN) {
      const res = await app.request(path);
      expect(res.status, `${path} should 404`).toBe(404);
      const text = await res.text();
      expect(text.toLowerCase()).not.toContain('<!doctype html');
      expect(text.toLowerCase()).not.toContain('<html');
    }
  });

  it('serves the archive well-known document', async () => {
    const app = buildPublicArchiveApp({ handler: seeded.handler });
    const res = await app.request('/.well-known/jinn-record-discovery');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('well-known');
  });

  it('serves the head with an ETag and honors If-None-Match', async () => {
    const app = buildPublicArchiveApp({ handler: seeded.handler });
    const first = await app.request('/sources/marketplace/head');
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const second = await app.request('/sources/marketplace/head', {
      headers: { 'if-none-match': etag! },
    });
    expect(second.status).toBe(304);
  });

  it('rejects a non-GET method on an archive path', async () => {
    const app = buildPublicArchiveApp({ handler: seeded.handler });
    const res = await app.request('/sources/marketplace/head', { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('is boot-inert: building the app binds no listener — only startPublicArchiveServer does', () => {
    // The archive plane must not open a socket as a side effect of construction. main.ts gates
    // the actual bind behind COMPOSITION_MODE === "native" && publicArchive.enabled (default off),
    // so a default/legacy boot starts nothing. This asserts the construction half of that: the
    // returned value is a plain Hono app with no `listen`/`address`, not a live server.
    const app = buildPublicArchiveApp({ handler: seeded.handler });
    expect(app).toBeDefined();
    expect((app as unknown as { address?: unknown }).address).toBeUndefined();
    expect((app as unknown as { listen?: unknown }).listen).toBeUndefined();
  });
});
