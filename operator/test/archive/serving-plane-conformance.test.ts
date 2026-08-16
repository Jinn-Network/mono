/**
 * Runs the discovery kit's `runServingPlaneConformance` against the LIVE public archive
 * listener — the second half of the G-archive gate ("serving plane conformant against the
 * live surface"). A small replay window (2) lets the evicted-cursor case fire.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  runServingPlaneConformance,
  type ServingPlaneTailEvent,
  type ServingPlaneUnderTest,
} from '@jinn-network/record-discovery-testing';
import {
  startPublicArchiveServer,
  type PublicArchiveServer,
} from '../../src/api/public-archive-server.js';
import { seedArchiveFixture, type SeededArchive } from './_seed-archive.js';

let root: string;
let seeded: SeededArchive;
let server: PublicArchiveServer;
let servingRoot: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'jinn-archive-conf-'));
  // replayWindow 2 with 3 seeded relays evicts relay cursor 0000000000000001.
  seeded = await seedArchiveFixture({ rootDir: root, sourceName: 'marketplace', replayWindow: 2 });
  server = await startPublicArchiveServer({ handler: seeded.handler, host: '127.0.0.1', port: 0 });
  servingRoot = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

async function* parseSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<ServingPlaneTailEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame: ServingPlaneTailEvent = { data: '' };
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) frame.data += line.slice(5).trim();
      }
      yield frame;
    }
  }
}

// A late-bound plane: the server is only up after `beforeAll`, but `runServingPlaneConformance`
// registers its `it`s eagerly. Each probe reads `servingRoot` at call time, so registration
// before boot is fine.
const plane: ServingPlaneUnderTest = {
  get baseUrl() {
    return servingRoot;
  },
  async request(path, headers) {
    const res = await fetch(`${servingRoot}${path}`, headers ? { headers } : {});
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
  },
  async tail(lastEventId) {
    const res = await fetch(`${servingRoot}/sources/marketplace/tail`, {
      headers: lastEventId === undefined ? {} : { 'last-event-id': lastEventId },
    });
    const reader = res.body!.getReader();
    return {
      events: parseSse(reader),
      close: () => {
        void reader.cancel().catch(() => undefined);
      },
    };
  },
  forbiddenPaths: ['/v1/status', '/artifacts/search', '/', '/assets/index.js', '/api/stop-hook'],
  evictedTailCursor: '0000000000000001',
};

describe('operator public archive — record-discovery serving-plane conformance', () => {
  runServingPlaneConformance(plane);
});
