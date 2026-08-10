/**
 * G-archive gate (one-swap #2461, second probe): `yarn e2e:archive-second-daemon`.
 *
 * One daemon serves the public record-discovery archive listener over real TCP; a second
 * "daemon", holding nothing but the serving URL, cold-syncs, retrieves every announced record
 * by digest and re-hashes it, resumes from a high-water mark, receives a live tail event, and
 * confirms no operator route is reachable on the plane. Every assertion prints `ok`; a failure
 * exits non-zero.
 *
 * This process-boot probe pairs with the kit-driven `test/archive/serving-plane-conformance.test.ts`
 * (`runServingPlaneConformance` over the same listener). Daemon A's archive is produced through
 * `record-discovery-serve`'s own writers — the exact writers the native solution publisher drives
 * — so the gate exercises the production write path without a full fleet boot; the deploy-time
 * gate runs it over the booted native publisher.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHttpTransport,
  createSseStreamTransport,
} from '@jinn-network/record-discovery-transport-http';
import { coldSync, fetchHead, returningSync, subscribe } from '@jinn-network/record-discovery-client';
import { sealJson } from '@jinn-network/record-discovery-protocol';
import { startPublicArchiveServer } from '../../src/api/public-archive-server.js';
import { appendOneRecord, seedArchiveFixture } from '../archive/_seed-archive.js';

function ok(label: string): void {
  console.log(`ok — ${label}`);
}

function fail(label: string, detail: unknown): never {
  console.error(`FAIL — ${label}: ${detail instanceof Error ? detail.message : String(detail)}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'jinn-archive-e2e-a-'));
  const seeded = await seedArchiveFixture({ rootDir: root, sourceName: 'marketplace' });
  const server = await startPublicArchiveServer({ handler: seeded.handler, host: '127.0.0.1', port: 0 });
  const servingRoot = `http://127.0.0.1:${server.port}`;
  console.log(`[e2e] daemon A serving on ${servingRoot}`);

  try {
    const endpoint = seeded.endpoint(servingRoot);
    const transport = createHttpTransport(servingRoot, fetch);

    // 1. head from the serving root alone
    const head = await fetchHead(endpoint, transport);
    if (!head.head.origin.includes('marketplace')) fail('fetch head', head.head.origin);
    ok('daemon B fetched the head from the serving root alone');

    // 2. cold sync every announced entry
    const cold: string[] = [];
    for await (const e of coldSync(endpoint, { transport })) cold.push(e.entry.sequence);
    if (cold.join(',') !== '0000000000000001,0000000000000002,0000000000000003') {
      fail('cold sync', cold.join(','));
    }
    ok(`daemon B cold-synced ${cold.length} entries`);

    // 3. retrieve each announced record by digest and re-hash
    let retrieved = 0;
    for await (const e of coldSync(endpoint, { transport })) {
      for (const announcement of e.entry.announcements) {
        if (announcement.action !== 'available') continue;
        const hex = announcement.record.digest.slice('sha256:'.length);
        const res = await transport['fetch'](`${servingRoot}/records/${hex}`);
        if (res.status !== 200) fail('record retrieval status', res.status);
        if (createHash('sha256').update(res.bytes).digest('hex') !== hex) fail('record re-hash', hex);
        retrieved += 1;
      }
    }
    ok(`daemon B retrieved and re-hashed ${retrieved} records by digest`);

    // 4. resume from a high-water mark
    await appendOneRecord(seeded, JSON.stringify({ n: 4 }));
    const resumed: string[] = [];
    const highWaterMark = { sequence: '0000000000000003', entry: sealJson(seeded.entries[2]!.entry).digest };
    for await (const e of returningSync(endpoint, highWaterMark, { transport })) resumed.push(e.entry.sequence);
    if (resumed.join(',') !== '0000000000000004') fail('returning sync', resumed.join(','));
    ok('daemon B resumed from a high-water mark and saw only the new entry');

    // 5. live tail
    const streamTransport = createSseStreamTransport(servingRoot, fetch);
    const received: unknown[] = [];
    const sub = subscribe({
      streamTransport,
      url: `${servingRoot}/sources/marketplace/tail`,
      onAnnouncement: (event) => received.push(event),
      onObservation: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendOneRecord(seeded, JSON.stringify({ n: 5 }));
    const deadline = Date.now() + 5_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    sub.close();
    if (received.length === 0) fail('live tail', 'no announcement received within 5s');
    ok('daemon B received a live tail event for an entry appended after subscribe');

    // 6. exposure scoping — nothing but the archive is reachable
    for (const path of ['/v1/status', '/artifacts/search', '/', '/assets/index.js', '/api/stop-hook']) {
      const res = await fetch(`${servingRoot}${path}`);
      if (res.status !== 404) fail(`exposure scoping ${path}`, res.status);
    }
    ok('the public plane serves the archive and nothing else');

    console.log('\n[e2e] G-archive: all assertions passed.');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => fail('unexpected', error));
