// client/test/e2e/_archive-consumer-child.ts
/**
 * The G-archive consumer as a GENUINELY SEPARATE PROCESS (one-swap M7, umbrella #2461).
 *
 * The original `archive-second-daemon.ts` cold-syncs in-process against daemon A's listener. This
 * child is the "second daemon" for real: a distinct OS process that holds ONLY the serving URL +
 * source endpoint (passed as a JSON file on argv), and drives the same
 * `@jinn-network/record-discovery-client` cold-sync / digest-retrieval / resume / live-tail /
 * exposure-scoping legs against daemon A's TCP listener in the parent.
 *
 * Parent<->child coordination is a stdout-line / stdin-line handshake so the server-side appends
 * (resume, tail) stay ordered across the process boundary:
 *   child prints WANT_APPEND_4 -> parent appends n=4 + writes GO4 -> child resumes
 *   child prints SUBSCRIBED    -> parent appends n=5 (child is already tailing)
 * Any assertion failure exits non-zero; the parent asserts a 0 exit.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  createHttpTransport,
  createSseStreamTransport,
} from '@jinn-network/record-discovery-transport-http';
import { coldSync, fetchHead, returningSync, subscribe } from '@jinn-network/record-discovery-client';

interface ChildInput {
  readonly servingRoot: string;
  readonly endpoint: { readonly agent: string; readonly name: string; readonly servingRoot: string; readonly archiveRootUrl: string };
  readonly highWaterMark: { readonly sequence: string; readonly entry: string };
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(label: string, detail: unknown): never {
  process.stderr.write(`CHILD FAIL — ${label}: ${detail instanceof Error ? detail.message : String(detail)}\n`);
  process.exit(1);
}

/** Await one line from the parent on stdin (the append-done signal). */
function awaitLine(expected: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (line.trim() === expected) {
        rl.close();
        resolve();
      }
    });
  });
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (inputPath === undefined) fail('argv', 'missing input JSON path');
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as ChildInput;
  const { servingRoot, endpoint, highWaterMark } = input;
  const transport = createHttpTransport(servingRoot, fetch);

  // 1. head from the serving root alone
  const head = await fetchHead(endpoint, transport);
  if (!head.head.origin.includes('marketplace')) fail('fetch head', head.head.origin);
  say('ok — separate-process consumer fetched the head from the serving root alone');

  // 2. cold sync the seeded entries
  const cold: string[] = [];
  for await (const e of coldSync(endpoint, { transport })) cold.push(e.entry.sequence);
  if (cold.join(',') !== '0000000000000001,0000000000000002,0000000000000003') fail('cold sync', cold.join(','));
  say(`ok — separate-process consumer cold-synced ${cold.length} entries over TCP`);

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
  say(`ok — separate-process consumer retrieved and re-hashed ${retrieved} records by digest`);

  // 4. exposure scoping — nothing but the archive is reachable
  for (const path of ['/v1/status', '/artifacts/search', '/', '/assets/index.js', '/api/stop-hook']) {
    const res = await fetch(`${servingRoot}${path}`);
    if (res.status !== 404) fail(`exposure scoping ${path}`, res.status);
  }
  say('ok — the public plane serves the archive and nothing else');

  // 5. resume from a high-water mark (server appends n=4 on the parent side)
  say('WANT_APPEND_4');
  await awaitLine('GO4');
  const resumed: string[] = [];
  for await (const e of returningSync(endpoint, highWaterMark, { transport })) resumed.push(e.entry.sequence);
  if (resumed.join(',') !== '0000000000000004') fail('returning sync', resumed.join(','));
  say('ok — separate-process consumer resumed from a high-water mark and saw only the new entry');

  // 6. live tail (server appends n=5 once the parent sees SUBSCRIBED)
  const streamTransport = createSseStreamTransport(servingRoot, fetch);
  const received: unknown[] = [];
  const sub = subscribe({
    streamTransport,
    url: `${servingRoot}/sources/marketplace/tail`,
    onAnnouncement: (event) => received.push(event),
    onObservation: () => {},
  });
  // Give the SSE connection a moment, then tell the parent to append.
  await new Promise((resolve) => setTimeout(resolve, 200));
  say('SUBSCRIBED');
  const deadline = Date.now() + 5_000;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  sub.close();
  if (received.length === 0) fail('live tail', 'no announcement received within 5s');
  say('ok — separate-process consumer received a live tail event appended after subscribe');

  say('CHILD_DONE');
  process.exit(0);
}

main().catch((error) => fail('unexpected', error));
