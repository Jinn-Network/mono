/**
 * G-archive (one-swap #2461 fused gate, second probe): one daemon serves the public archive
 * listener; a second daemon, holding nothing but the serving URL, cold-syncs, retrieves every
 * announced record by digest, resumes from a high-water mark, and receives a live tail event —
 * and no operator route is reachable on the plane. This is the CI-runnable, in-process half;
 * `test/e2e/archive-second-daemon.ts` runs the same assertions over a booted process.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createHttpTransport,
  createSseStreamTransport,
} from '@jinn-network/record-discovery-transport-http';
import { coldSync, fetchHead, returningSync, subscribe } from '@jinn-network/record-discovery-client';
import { sealJson } from '@jinn-network/record-discovery-protocol';
import {
  startPublicArchiveServer,
  type PublicArchiveServer,
} from '../../src/api/public-archive-server.js';
import { appendOneRecord, seedArchiveFixture, type SeededArchive } from './_seed-archive.js';

let root: string;
let seeded: SeededArchive;
let server: PublicArchiveServer;
let servingRoot: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'jinn-daemon-a-'));
  seeded = await seedArchiveFixture({ rootDir: root, sourceName: 'marketplace' });
  server = await startPublicArchiveServer({ handler: seeded.handler, host: '127.0.0.1', port: 0 });
  servingRoot = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

/** Daemon B holds nothing but the URL. */
function daemonB() {
  const transport = createHttpTransport(servingRoot, fetch);
  return { transport, endpoint: seeded.endpoint(servingRoot) };
}

describe('second-daemon archive consumption (G-archive)', () => {
  it('fetches the head from the serving root alone', async () => {
    const { transport, endpoint } = daemonB();
    const synced = await fetchHead(endpoint, transport);
    expect(synced.head.origin).toContain('marketplace');
    expect(synced.head.sequence).toMatch(/^[0-9]{16}$/);
  });

  it('cold-syncs every announced entry', async () => {
    const { transport, endpoint } = daemonB();
    const seen: string[] = [];
    for await (const e of coldSync(endpoint, { transport })) seen.push(e.entry.sequence);
    expect(seen).toEqual(['0000000000000001', '0000000000000002', '0000000000000003']);
  });

  it('retrieves each announced record by digest and the bytes re-hash', async () => {
    const { transport, endpoint } = daemonB();
    let retrieved = 0;
    for await (const e of coldSync(endpoint, { transport })) {
      for (const announcement of e.entry.announcements) {
        if (announcement.action !== 'available') continue;
        const hex = announcement.record.digest.slice('sha256:'.length);
        const res = await transport['fetch'](`${servingRoot}/records/${hex}`);
        expect(res.status).toBe(200);
        expect(createHash('sha256').update(res.bytes).digest('hex')).toBe(hex);
        retrieved += 1;
      }
    }
    expect(retrieved).toBe(3);
  });

  it('resumes from a high-water mark and yields only new entries', async () => {
    await appendOneRecord(seeded, JSON.stringify({ n: 4 }));
    const { transport, endpoint } = daemonB();
    const highWaterMark = {
      sequence: '0000000000000003',
      entry: sealJson(seeded.entries[2]!.entry).digest,
    };
    const seen: string[] = [];
    for await (const e of returningSync(endpoint, highWaterMark, { transport })) {
      seen.push(e.entry.sequence);
    }
    expect(seen).toEqual(['0000000000000004']);
  });

  it('receives a live tail event for an entry appended after subscribe', async () => {
    const streamTransport = createSseStreamTransport(servingRoot, fetch);
    const received: unknown[] = [];
    const sub = subscribe({
      streamTransport,
      url: `${servingRoot}/sources/marketplace/tail`,
      onAnnouncement: (event) => received.push(event),
      onObservation: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await appendOneRecord(seeded, JSON.stringify({ n: 5 }));
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 5_000 });
    sub.close();
  });

  it('serves the archive and nothing else on the public plane', async () => {
    for (const path of ['/v1/status', '/artifacts/search', '/', '/assets/index.js', '/api/stop-hook']) {
      const res = await fetch(`${servingRoot}${path}`);
      expect(res.status, `${path} must not be served`).toBe(404);
    }
  });
});
