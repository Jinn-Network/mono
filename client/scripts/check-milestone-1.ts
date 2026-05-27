#!/usr/bin/env -S yarn tsx
/**
 * Check progress toward Milestone 1.
 *
 *   Milestone: https://github.com/Jinn-Network/mono/milestone/1
 *   Original proposal (closed): https://github.com/Jinn-Network/mono/discussions/604
 *   This rewrite: https://github.com/Jinn-Network/mono/issues/691
 *
 * Criterion (per milestone description as of 2026-05-27):
 *   Across 48 consecutive wall-clock hours divided into 8 UTC-aligned 6-hour
 *   blocks (00:00, 06:00, 12:00, 18:00), every block has at least 2 distinct
 *   operators that each earned ≥ 3 tJINN within that block.
 *
 * Source: `JinnDistributor.Claimed` events on Ethereum Sepolia L1
 * (chainId 11155111). The indexer aggregates these as `rewardDistributions`.
 *
 * Run from the client/ workspace:
 *   yarn tsx scripts/check-milestone-1.ts
 *
 * Optional:
 *   JINN_INDEXER_URL=<url>        override default indexer
 *   JINN_ETHEREUM_RPC_URL=<rpc>   override Ethereum Sepolia RPC (for block→ts)
 *   --md=path/to.md               also write a markdown snapshot to disk
 */

import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, formatEther } from 'viem';
import { sepolia, baseSepolia } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_PATH = resolve(__dirname, '../deployments/deployment-jinn-mvi-l1-sepolia-fast.json');
const STAKING_PROGRAM = '0x24e34E5037956a5Feca1AAAfaA30297084C228B8' as const;

const INDEXER_URL = process.env.JINN_INDEXER_URL ?? 'https://jinn-indexer-production.up.railway.app';
const L1_RPC_URL = process.env.JINN_ETHEREUM_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const L2_RPC_URL = process.env.JINN_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL ?? 'https://base-sepolia.publicnode.com';

const TARGET_HOURS = 48;
const BLOCK_HOURS = 6;
const NUM_BLOCKS = TARGET_HOURS / BLOCK_HOURS; // 8
const BLOCK_SECONDS = BLOCK_HOURS * 3600;
const REQUIRED_OPERATORS_PER_BLOCK = 2;
const REQUIRED_TJINN_PER_OPERATOR = 3n * 10n ** 18n; // 3 tJINN in wei

const L1_CHAIN_ID = 11155111;
const L2_CHAIN_ID = 84532;
const SEPOLIA_AVG_BLOCK_SEC = 12; // used to bound L1 lookback window
const BASE_SEPOLIA_AVG_BLOCK_SEC = 2; // used to bound L2 lookback window

interface Distribution {
  serviceId: string;
  multisig: string;
  operatorMinted: bigint;
  claimedAtBlock: bigint;
  claimedAtTx: string;
}

interface TaskCreation {
  id: string;
  createdAtBlock: bigint;
  manifestDigest: string;
}

function loadDistributorAddress(): string {
  const raw = JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8'));
  const addr = raw?.contracts?.JinnDistributor;
  if (typeof addr !== 'string') {
    throw new Error(`Could not read JinnDistributor address from ${DEPLOYMENT_PATH}`);
  }
  return addr;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${INDEXER_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Indexer ${INDEXER_URL} returned HTTP ${res.status} ${res.statusText}`);
  }
  const payload = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`Indexer GraphQL errors: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  if (!payload.data) throw new Error('Indexer response missing data field');
  return payload.data;
}

/**
 * Fetch every rewardDistribution with claimedAtBlock >= sinceBlock, paginated.
 * Ponder caps `limit` at 1000; we walk by `offset` until a short page comes back.
 */
async function fetchDistributionsSince(sinceBlock: bigint): Promise<Distribution[]> {
  const PAGE = 1000;
  const out: Distribution[] = [];
  let offset = 0;
  // claimedAtBlock is a string in the indexer payload; use a string comparison
  // in the where filter via the gt operator, supplied as a stringified bigint.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastPageLen = PAGE;
  while (lastPageLen === PAGE) {
    const data = await gql<{
      rewardDistributions: {
        items: Array<{
          serviceId: string;
          multisig: string;
          operatorMinted: string;
          claimedAtBlock: string;
          claimedAtTx: string;
          chainId: number;
        }>;
      };
    }>(
      `query Distributions($since: BigInt!, $limit: Int!, $offset: Int!) {
        rewardDistributions(
          where: { claimedAtBlock_gte: $since, chainId: ${L1_CHAIN_ID} },
          orderBy: "claimedAtBlock",
          orderDirection: "asc",
          limit: $limit,
          offset: $offset
        ) {
          items {
            serviceId
            multisig
            operatorMinted
            claimedAtBlock
            claimedAtTx
            chainId
          }
        }
      }`,
      { since: sinceBlock.toString(), limit: PAGE, offset },
    );
    const items = data.rewardDistributions.items;
    for (const it of items) {
      out.push({
        serviceId: it.serviceId,
        multisig: it.multisig.toLowerCase(),
        operatorMinted: BigInt(it.operatorMinted),
        claimedAtBlock: BigInt(it.claimedAtBlock),
        claimedAtTx: it.claimedAtTx,
      });
    }
    lastPageLen = items.length;
    offset += items.length;
    if (offset > 100_000) {
      throw new Error('Refusing to walk past 100k rewardDistributions; widen since-cutoff');
    }
  }
  return out;
}

/**
 * Fetch every task with createdAtBlock >= sinceBlock on the L2 (Base Sepolia).
 * Used to surface launcher-side failures: if a block has no qualifying operators
 * AND no tasks were created in that window, the failure is upstream of the
 * operators (the launcher's task generator was quiet).
 */
async function fetchTasksSince(sinceBlock: bigint): Promise<TaskCreation[]> {
  const PAGE = 1000;
  const out: TaskCreation[] = [];
  let offset = 0;
  let lastPageLen = PAGE;
  while (lastPageLen === PAGE) {
    const data = await gql<{
      tasks: {
        items: Array<{
          id: string;
          createdAtBlock: string;
          manifestDigest: string;
        }>;
      };
    }>(
      `query Tasks($since: BigInt!, $limit: Int!, $offset: Int!) {
        tasks(
          where: { createdAtBlock_gte: $since, chainId: ${L2_CHAIN_ID} },
          orderBy: "createdAtBlock",
          orderDirection: "asc",
          limit: $limit,
          offset: $offset
        ) {
          items {
            id
            createdAtBlock
            manifestDigest
          }
        }
      }`,
      { since: sinceBlock.toString(), limit: PAGE, offset },
    );
    const items = data.tasks.items;
    for (const it of items) {
      out.push({
        id: it.id,
        createdAtBlock: BigInt(it.createdAtBlock),
        manifestDigest: it.manifestDigest,
      });
    }
    lastPageLen = items.length;
    offset += items.length;
    if (offset > 100_000) {
      throw new Error('Refusing to walk past 100k tasks; widen since-cutoff');
    }
  }
  return out;
}

/**
 * Batch-resolve unique block numbers to UNIX timestamps via getBlock.
 * Bounded concurrency to keep us well inside the script's 30s SLA on public RPCs.
 */
async function resolveBlockTimestamps(
  client: ReturnType<typeof createPublicClient>,
  blocks: bigint[],
): Promise<Map<bigint, number>> {
  const unique = Array.from(new Set(blocks.map((b) => b.toString()))).map((s) => BigInt(s));
  const map = new Map<bigint, number>();
  const CONCURRENCY = 16;
  let idx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= unique.length) return;
      const b = unique[i];
      const block = await client.getBlock({ blockNumber: b });
      map.set(b, Number(block.timestamp));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return map;
}

/** Floor to the nearest 6-hour UTC block boundary. */
function floorTo6hBlock(tsSec: number): number {
  return Math.floor(tsSec / BLOCK_SECONDS) * BLOCK_SECONDS;
}

interface BlockReport {
  startTs: number;
  endTs: number;
  earnings: Map<string, bigint>; // multisig → operatorMinted sum (wei)
  qualifiedOperators: string[]; // multisigs that earned ≥ 3 tJINN in this block
  tasksCreated: number; // tasks posted to the SolverNet during the block
  passed: boolean;
}

function buildBlocks(
  nowSec: number,
  distributions: Array<Distribution & { tsSec: number }>,
): BlockReport[] {
  // The "current" block (the one ticking now) is incomplete — don't grade it.
  // The most recent COMPLETED block ends at the last 6h boundary at-or-before now.
  const lastBoundary = floorTo6hBlock(nowSec);
  const blocks: BlockReport[] = [];
  for (let i = NUM_BLOCKS; i >= 1; i--) {
    const startTs = lastBoundary - i * BLOCK_SECONDS;
    const endTs = startTs + BLOCK_SECONDS;
    blocks.push({
      startTs,
      endTs,
      earnings: new Map(),
      qualifiedOperators: [],
      tasksCreated: 0,
      passed: false,
    });
  }
  for (const d of distributions) {
    for (const b of blocks) {
      if (d.tsSec >= b.startTs && d.tsSec < b.endTs) {
        b.earnings.set(d.multisig, (b.earnings.get(d.multisig) ?? 0n) + d.operatorMinted);
        break;
      }
    }
  }
  for (const b of blocks) {
    b.qualifiedOperators = [...b.earnings.entries()]
      .filter(([, amt]) => amt >= REQUIRED_TJINN_PER_OPERATOR)
      .map(([m]) => m)
      .sort();
    b.passed = b.qualifiedOperators.length >= REQUIRED_OPERATORS_PER_BLOCK;
  }
  return blocks;
}

/** Count tasks created in each block's UTC window. Mutates `blocks` in place. */
function annotateBlocksWithTasks(
  blocks: BlockReport[],
  tasks: Array<TaskCreation & { tsSec: number }>,
): void {
  for (const t of tasks) {
    for (const b of blocks) {
      if (t.tsSec >= b.startTs && t.tsSec < b.endTs) {
        b.tasksCreated += 1;
        break;
      }
    }
  }
}

function formatTs(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().replace(':00.000', '');
}

function formatTjinn(wei: bigint): string {
  // 1e15 precision so 0.001 tJINN is visible.
  const milli = wei / 10n ** 15n;
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/, '') || '0';
  return frac === '0' ? `${whole}` : `${whole}.${frac}`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const mdArg = process.argv.find((a) => a.startsWith('--md='));
  const mdPath = mdArg ? mdArg.slice('--md='.length) : null;
  const distributor = loadDistributorAddress();

  const lines: string[] = [];
  const out = (s: string) => {
    console.log(s);
    lines.push(s);
  };

  out(`# Milestone 1 progress — ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`);
  out('');
  out(`Staking program: \`${STAKING_PROGRAM}\` (Base Sepolia)`);
  out(`JinnDistributor: \`${distributor}\` (Ethereum Sepolia, chainId ${L1_CHAIN_ID})`);
  out(`Indexer: ${INDEXER_URL}`);
  out(`Criterion: 8 UTC-aligned 6h blocks, each with ≥${REQUIRED_OPERATORS_PER_BLOCK} distinct operators that each earned ≥${formatTjinn(REQUIRED_TJINN_PER_OPERATOR)} tJINN.`);
  out('');

  // Define the window: most recently completed 6h boundary minus 48h, with a
  // small safety margin for clock skew between indexer / RPC / local clock.
  const nowSec = Math.floor(Date.now() / 1000);
  const lastBoundary = floorTo6hBlock(nowSec);
  const windowStartTs = lastBoundary - NUM_BLOCKS * BLOCK_SECONDS;

  const l1Client = createPublicClient({ chain: sepolia, transport: http(L1_RPC_URL) });
  const headBlock = await l1Client.getBlockNumber();
  // Translate windowStartTs → approximate L1 block to bound the indexer query.
  // SEPOLIA_AVG_BLOCK_SEC is conservative; widen by 50% for safety on slow days.
  const lookbackSec = nowSec - windowStartTs + 4 * 3600; // +4h buffer
  const lookbackBlocks = BigInt(Math.ceil((lookbackSec * 3 / 2) / SEPOLIA_AVG_BLOCK_SEC));
  const sinceBlock = headBlock > lookbackBlocks ? headBlock - lookbackBlocks : 0n;
  process.stderr.write(`Querying indexer for distributions since L1 block ${sinceBlock} (head ${headBlock}, ~${(lookbackSec / 3600).toFixed(1)}h lookback)...\n`);

  let distributions: Distribution[];
  try {
    distributions = await fetchDistributionsSince(sinceBlock);
  } catch (err) {
    out(`**Indexer query failed:** ${err instanceof Error ? err.message : String(err)}`);
    out('');
    out('The on-chain `getLogs` floor is not yet implemented in this rewrite — file as follow-up.');
    if (mdPath) writeFileSync(mdPath, lines.join('\n'));
    process.exit(1);
  }
  process.stderr.write(`Fetched ${distributions.length} rewardDistribution rows.\n`);

  if (distributions.length === 0) {
    out('No distributions in window. **NOT HIT.**');
    if (mdPath) writeFileSync(mdPath, lines.join('\n'));
    return;
  }

  process.stderr.write(`Resolving ${new Set(distributions.map((d) => d.claimedAtBlock.toString())).size} unique L1 blocks → timestamps...\n`);
  const tsMap = await resolveBlockTimestamps(l1Client, distributions.map((d) => d.claimedAtBlock));
  const enriched = distributions
    .map((d) => ({ ...d, tsSec: tsMap.get(d.claimedAtBlock)! }))
    .filter((d) => d.tsSec >= windowStartTs);

  const blocks = buildBlocks(nowSec, enriched);

  // Self-diagnosis: count tasks created in each block on the L2 SolverNet, so
  // failures can be attributed launcher-side (0 tasks created) vs operator-side
  // (tasks were posted but operators didn't earn enough). Without this you have
  // to manually dig into the indexer to figure out which.
  const l2Client = createPublicClient({ chain: baseSepolia, transport: http(L2_RPC_URL) });
  const l2Head = await l2Client.getBlockNumber();
  const l2LookbackBlocks = BigInt(Math.ceil((lookbackSec * 3 / 2) / BASE_SEPOLIA_AVG_BLOCK_SEC));
  const l2SinceBlock = l2Head > l2LookbackBlocks ? l2Head - l2LookbackBlocks : 0n;
  process.stderr.write(`Querying indexer for tasks since L2 block ${l2SinceBlock} (head ${l2Head})...\n`);
  let tasks: TaskCreation[] = [];
  try {
    tasks = await fetchTasksSince(l2SinceBlock);
    process.stderr.write(`Fetched ${tasks.length} task rows.\n`);
    if (tasks.length > 0) {
      process.stderr.write(`Resolving ${new Set(tasks.map((t) => t.createdAtBlock.toString())).size} unique L2 blocks → timestamps...\n`);
      const l2TsMap = await resolveBlockTimestamps(l2Client, tasks.map((t) => t.createdAtBlock));
      const enrichedTasks = tasks
        .map((t) => ({ ...t, tsSec: l2TsMap.get(t.createdAtBlock)! }))
        .filter((t) => t.tsSec >= windowStartTs);
      annotateBlocksWithTasks(blocks, enrichedTasks);
    }
  } catch (err) {
    process.stderr.write(`L2 task query failed (non-fatal): ${err instanceof Error ? err.message : err}\n`);
  }

  out('## Per-6h-block results (most recent 48h)');
  out('');
  out('| Block (UTC) | Tasks created | Operators qualifying (≥3 tJINN) | Verdict |');
  out('|---|---:|---:|:---:|');
  for (const b of blocks) {
    const opCount = b.qualifiedOperators.length;
    const totalOps = b.earnings.size;
    let verdict: string;
    if (b.passed) {
      verdict = 'PASS';
    } else if (b.tasksCreated === 0 && totalOps === 0) {
      // No tasks created AND no operator earned anything ⇒ the pipeline was
      // silent end-to-end. Almost certainly launcher-side (generator paused).
      verdict = 'FAIL (no work flowed)';
    } else {
      // Either tasks were posted but operators didn't clear the bar, or
      // operators worked backlog but only one (or none) qualified.
      verdict = 'FAIL (under threshold)';
    }
    out(
      `| ${formatTs(b.startTs)} → ${formatTs(b.endTs)} | ${b.tasksCreated} | ${opCount} qualifying / ${totalOps} earning | ${verdict} |`,
    );
  }
  out('');

  // Per-operator breakdown
  out('## Per-operator breakdown');
  out('');
  out('| Operator | Total tJINN in window | Blocks with ≥3 tJINN | Blocks active |');
  out('|---|---:|---:|---:|');
  const perOp = new Map<string, { total: bigint; qualifyingBlocks: number; activeBlocks: number }>();
  for (const b of blocks) {
    for (const [m, amt] of b.earnings) {
      const cur = perOp.get(m) ?? { total: 0n, qualifyingBlocks: 0, activeBlocks: 0 };
      cur.total += amt;
      cur.activeBlocks += 1;
      if (amt >= REQUIRED_TJINN_PER_OPERATOR) cur.qualifyingBlocks += 1;
      perOp.set(m, cur);
    }
  }
  const opRows = [...perOp.entries()].sort((a, b) => Number(b[1].total - a[1].total));
  for (const [m, s] of opRows) {
    const short = `${m.slice(0, 6)}…${m.slice(-4)}`;
    out(`| \`${short}\` | ${formatTjinn(s.total)} | ${s.qualifyingBlocks} / ${NUM_BLOCKS} | ${s.activeBlocks} / ${NUM_BLOCKS} |`);
  }
  out('');

  // Trailing streak from the most recent block backwards
  let trailing = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].passed) trailing += 1;
    else break;
  }
  const allPass = blocks.every((b) => b.passed);

  out('## Verdict');
  out('');
  out(`- Most recent completed block: ${formatTs(blocks[blocks.length - 1].startTs)} → ${formatTs(blocks[blocks.length - 1].endTs)}`);
  out(`- Trailing consecutive passing blocks: **${trailing} / ${NUM_BLOCKS}**`);
  out(`- Progress: **${((trailing / NUM_BLOCKS) * 100).toFixed(1)}%** of the ${NUM_BLOCKS}-block target.`);
  out(`- **${allPass ? 'MILESTONE HIT.' : 'NOT HIT.'}**`);

  process.stderr.write(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

  if (mdPath) {
    writeFileSync(mdPath, lines.join('\n'));
    process.stderr.write(`Wrote markdown summary to ${mdPath}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
