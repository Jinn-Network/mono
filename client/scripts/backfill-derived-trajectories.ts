#!/usr/bin/env node
/**
 * backfill-derived-trajectories (#1672) — one-shot backfill of derived
 * jinn.trajectory.v1 records from historical `system_snapshot` transcripts.
 *
 * Thin `tsx` entry (mirrors audit-task-run-failures.ts): parses flags, opens the
 * real Store, wires the local walk (default) + optional indexer/IPFS second pass
 * + optional scrub+sign publish edge, then delegates to the tested core in
 * ./lib/backfill-derived-trajectories.ts and prints the recovery-rate summary.
 *
 * Usage:
 *   yarn backfill:trajectories                       # local-only, no publish
 *   yarn backfill:trajectories -- --indexer          # + indexer/IPFS second pass
 *   yarn backfill:trajectories -- --publish          # + scrub+sign+pin each record
 *   yarn backfill:trajectories -- --json             # machine summary
 *   yarn backfill:trajectories -- --db ./other.db --limit 100 --config ./cfg.json
 *
 * Flags:
 *   --db <path>      DB file (default: config dbPath → ~/.jinn-client/jinn.db)
 *   --config <path>  config file path (same resolution as the daemon)
 *   --indexer        additive indexer/IPFS pass for snapshots not held locally
 *   --publish        scrub (layer-2) + sign + pin each derived record to IPFS
 *   --limit <n>      cap the total number of source snapshots this run considers (bounded trial run)
 *   --json           machine summary output
 */

import { config as dotenvConfig } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, getConfigPathFromArgs } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { FleetStateStore } from '../src/earning/store.js';
import { decryptMnemonic, walletPrivateKeyAtIndex } from '../src/earning/wallet.js';
import { buildLayer2ScrubPipeline } from '../src/trajectory/scrub/layer2.js';
import {
  backfillDerivedTrajectories,
  type BackfillDeps,
  type BackfillSummary,
} from './lib/backfill-derived-trajectories.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const GRAPHQL = 'https://jinn-indexer-production.up.railway.app/graphql';
const GATEWAY = 'https://gateway.autonolas.tech/ipfs';
const MAX_IPFS_FETCH_BYTES = 64 * 1024 * 1024;

export interface BackfillArgs {
  db?: string;
  limit?: number;
  indexer: boolean;
  publish: boolean;
  json: boolean;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = { indexer: false, publish: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--db':
        args.db = readFlagValue(argv, i, a);
        i++;
        break;
      case '--limit':
        args.limit = Number(readFlagValue(argv, i, a));
        i++;
        if (!Number.isFinite(args.limit) || args.limit <= 0) {
          throw new Error(`--limit must be a positive number, got ${argv[i]}`);
        }
        break;
      case '--indexer':
        args.indexer = true;
        break;
      case '--publish':
        args.publish = true;
        break;
      case '--json':
        args.json = true;
        break;
      // --config is consumed by getConfigPathFromArgs; skip its value here.
      case '--config':
        readFlagValue(argv, i, a);
        i++;
        break;
      case '--':
        break;
      default:
        throw new Error(a.startsWith('--') ? `Unknown flag: ${a}` : `Unknown argument: ${a}`);
    }
  }
  return args;
}

/** Which optional capabilities the parsed args enable — pure, for the unit test. */
export function planBackfillCapabilities(args: BackfillArgs): { indexer: boolean; publish: boolean } {
  return { indexer: args.indexer, publish: args.publish };
}

async function gql<T>(query: string): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data: T; errors?: unknown };
  if (body.errors) throw new Error(`gql: ${JSON.stringify(body.errors)}`);
  return body.data;
}

async function ipfs(cid: string): Promise<unknown> {
  const res = await fetch(`${GATEWAY}/${cid}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ipfs ${cid}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IPFS_FETCH_BYTES) {
    throw new Error(`ipfs ${cid}: ${buf.byteLength} bytes exceeds the fetch ceiling`);
  }
  return JSON.parse(Buffer.from(buf).toString('utf8'));
}

/** Indexer list of system_snapshot artifacts (envelope + snapshot CID + sha256). */
async function listEnvelopeSnapshots(): Promise<
  Array<{ envelopeCid: string; snapshotCid: string; sha256: string }>
> {
  const data = await gql<{
    systemSnapshotArtifacts: {
      items: Array<{ envelopeCid: string; cid: string; sha256: string }>;
    };
  }>(
    `{ systemSnapshotArtifacts(limit: 1000) { items { envelopeCid cid sha256 } } }`,
  );
  return data.systemSnapshotArtifacts.items.map((it) => ({
    envelopeCid: it.envelopeCid,
    snapshotCid: it.cid,
    sha256: it.sha256,
  }));
}

async function resolvePublishSigner(
  earningDir: string,
): Promise<BackfillDeps['publish']> {
  const password = process.env.JINN_PASSWORD;
  if (!password) {
    throw new Error('--publish requires JINN_PASSWORD to decrypt the agent keystore');
  }
  const fleet = new FleetStateStore(earningDir);
  if (!fleet.hasMnemonicKeystore()) {
    throw new Error(`--publish: no keystore found under ${earningDir}`);
  }
  const mnemonic = await decryptMnemonic(await fleet.loadMnemonicKeystore(), password);
  const state = await fleet.load();
  const service = state.services.find((s) => s.index >= 1);
  if (!service) {
    throw new Error('--publish: no staked service found in earning state');
  }
  const signerPrivateKey = walletPrivateKeyAtIndex(mnemonic, service.index);
  const signerAddress = privateKeyToAccount(signerPrivateKey).address;
  return {
    signerPrivateKey,
    signerAddress,
    ipfsRegistryUrl: process.env.JINN_IPFS_REGISTRY_URL ?? 'https://registry.autonolas.tech',
    scrubPipeline: buildLayer2ScrubPipeline(),
  };
}

function printSummary(summary: BackfillSummary, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }
  const rows: Array<[string, number]> = [
    ['found', summary.found],
    ['fetched', summary.fetched],
    ['parsed', summary.parsed],
    ['skipped-unavailable', summary.skippedUnavailable],
    ['skipped-no-transcript', summary.skippedNoTranscript],
    ['already-done', summary.alreadyDone],
    ['published', summary.published],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  process.stdout.write('backfill-derived-trajectories — recovery rate\n');
  for (const [k, v] of rows) {
    process.stdout.write(`  ${k.padEnd(width)}  ${v}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv);
  const config = loadConfig(getConfigPathFromArgs(process.argv));
  const dbPath = args.db ?? config.dbPath;
  const store = new Store(dbPath);
  try {
    const deps: BackfillDeps = {
      store,
      logger: (line) => console.error(line),
    };
    if (args.limit !== undefined) {
      deps.limit = args.limit;
    }
    if (args.indexer) {
      deps.listEnvelopeSnapshots = listEnvelopeSnapshots;
      deps.ipfs = ipfs;
    }
    if (args.publish) {
      deps.publish = await resolvePublishSigner(config.earningDir);
    }
    const summary = await backfillDerivedTrajectories(deps);
    printSummary(summary, args.json);
  } finally {
    store.close();
  }
}

// Only run when invoked directly (not when imported by the arg-parse unit test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[backfill] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
