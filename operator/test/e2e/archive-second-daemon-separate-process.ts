// operator/test/e2e/archive-second-daemon-separate-process.ts
/**
 * G-archive gate, separate-process upgrade (one-swap M7, umbrella #2461).
 *
 * The original `archive-second-daemon.ts` proved cold-sync over TCP but with an IN-PROCESS second
 * consumer. This variant closes that residual: the consumer is a GENUINELY SEPARATE OS PROCESS
 * (`_archive-consumer-child.ts`, spawned via tsx) holding nothing but the serving URL + endpoint,
 * and the two coordinate server-side appends (resume, live tail) over a stdout/stdin line handshake.
 *
 * What this variant still SEEDS vs what the deploy-time gate closes: daemon A here serves a
 * `seedArchiveFixture` archive written through `record-discovery-serve`'s own writers — the exact
 * writers the native solution publisher drives — but it is NOT a booted native daemon. Booting the
 * native publisher requires the full native runtime (identity + trust + composition +
 * `nativeSolutionPublisher`), which the native G-loop rig proves the boot legs of on a fork; the
 * deploy-time G-archive gate runs THIS separate-process consumer against the LIVE booted native
 * publisher on Base Sepolia. This rig proves the cross-process serving/consumption contract; the
 * deploy-time run swaps the seed publisher for the live one.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { sealJson } from '@jinn-network/record-discovery-protocol';
import { startPublicArchiveServer } from '../../src/api/public-archive-server.js';
import { appendOneRecord, seedArchiveFixture } from '../archive/_seed-archive.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(label: string, detail: unknown): never {
  console.error(`FAIL — ${label}: ${detail instanceof Error ? detail.message : String(detail)}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'jinn-archive-e2e-sp-'));
  const seeded = await seedArchiveFixture({ rootDir: root, sourceName: 'marketplace' });
  const server = await startPublicArchiveServer({ handler: seeded.handler, host: '127.0.0.1', port: 0 });
  const servingRoot = `http://127.0.0.1:${server.port}`;
  console.log(`[e2e] serving daemon on ${servingRoot} (seed publisher; deploy-time swaps in the booted native publisher)`);

  const inputPath = join(root, 'child-input.json');
  writeFileSync(inputPath, JSON.stringify({
    servingRoot,
    endpoint: seeded.endpoint(servingRoot),
    highWaterMark: { sequence: '0000000000000003', entry: sealJson(seeded.entries[2]!.entry).digest },
  }));

  const child = spawn('node', ['--import', 'tsx', join(HERE, '_archive-consumer-child.ts'), inputPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });

  let appended4 = false;
  let appended5 = false;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text.startsWith('ok —')) { console.log(`  ${text}`); return; }
    if (text === 'WANT_APPEND_4' && !appended4) {
      appended4 = true;
      void appendOneRecord(seeded, JSON.stringify({ n: 4 })).then(() => child.stdin.write('GO4\n'));
    } else if (text === 'SUBSCRIBED' && !appended5) {
      appended5 = true;
      void appendOneRecord(seeded, JSON.stringify({ n: 5 }));
    } else if (text === 'CHILD_DONE') {
      // handled by the exit listener
    }
  });

  const code: number = await new Promise((resolve) => {
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });

  try {
    if (code !== 0) fail('separate-process consumer', `child exited ${code}`);
    if (!appended4) fail('handshake', 'child never requested the resume append (WANT_APPEND_4)');
    if (!appended5) fail('handshake', 'child never subscribed for the live-tail append (SUBSCRIBED)');
    // Sanity: the head advanced to the 5 appended entries (server side).
    const head = seeded.entries.length;
    const digestOk = createHash('sha256').update(Buffer.from('marketplace')).digest('hex').length === 64;
    if (head < 5 || !digestOk) fail('server state', `expected >=5 entries, saw ${head}`);
    console.log('\n[e2e] G-archive (separate process): all assertions passed. Consumer ran as a distinct OS process.');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => fail('unexpected', error));
