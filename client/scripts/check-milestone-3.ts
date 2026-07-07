#!/usr/bin/env -S yarn tsx
/**
 * Check progress toward Milestone 3.
 *
 *   Milestone: https://github.com/Jinn-Network/mono/milestone/3
 *
 * Criterion:
 *   At least 10 distinct operators have each earned ≥ 25 tJINN cumulatively
 *   across all time ("ever"). "Operator" = the Safe multisig that received the
 *   emission, so a service evicted and re-staked into a new service ID still
 *   counts as the same operator (matches Milestone 1's operator definition).
 *
 * Source: `JinnDistributor.Claimed` events on Ethereum Sepolia L1
 * (chainId 11155111), aggregated by the indexer as `rewardDistributions`.
 * Lifetime totals — no time window.
 *
 * Run from the client/ workspace:
 *   yarn tsx scripts/check-milestone-3.ts
 *
 * Optional:
 *   JINN_INDEXER_URL=<url>        override default indexer
 *   --md=path/to.md               also write a markdown snapshot to disk
 */

import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_PATH = resolve(__dirname, '../deployments/deployment-jinn-mvi-l1-sepolia-fast.json');

const INDEXER_URL = process.env.JINN_INDEXER_URL ?? 'https://jinn-indexer-production.up.railway.app';

const L1_CHAIN_ID = 11155111;
const REQUIRED_OPERATORS = 10;
const REQUIRED_TJINN_PER_OPERATOR = 25n * 10n ** 18n; // 25 tJINN in wei

interface Distribution {
  multisig: string;
  operatorMinted: bigint;
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
 * Fetch every L1 rewardDistribution (lifetime — no since-block floor), paginated.
 * Ponder caps `limit` at 1000; we walk by `offset` until a short page comes back.
 */
async function fetchAllDistributions(): Promise<Distribution[]> {
  const PAGE = 1000;
  const out: Distribution[] = [];
  let offset = 0;
  let lastPageLen = PAGE;
  while (lastPageLen === PAGE) {
    const data = await gql<{
      rewardDistributions: {
        items: Array<{ multisig: string; operatorMinted: string }>;
      };
    }>(
      `query Distributions($limit: Int!, $offset: Int!) {
        rewardDistributions(
          where: { chainId: ${L1_CHAIN_ID} },
          orderBy: "claimedAtBlock",
          orderDirection: "asc",
          limit: $limit,
          offset: $offset
        ) {
          items {
            multisig
            operatorMinted
          }
        }
      }`,
      { limit: PAGE, offset },
    );
    const items = data.rewardDistributions.items;
    for (const it of items) {
      out.push({ multisig: it.multisig.toLowerCase(), operatorMinted: BigInt(it.operatorMinted) });
    }
    lastPageLen = items.length;
    offset += items.length;
    if (offset > 100_000) {
      throw new Error('Refusing to walk past 100k rewardDistributions');
    }
  }
  return out;
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

  out(`# Milestone 3 progress — ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`);
  out('');
  out(`JinnDistributor: \`${distributor}\` (Ethereum Sepolia, chainId ${L1_CHAIN_ID})`);
  out(`Indexer: ${INDEXER_URL}`);
  out(
    `Criterion: ≥${REQUIRED_OPERATORS} distinct operators that have each earned ≥${formatTjinn(REQUIRED_TJINN_PER_OPERATOR)} tJINN cumulatively (all-time).`,
  );
  out('');

  process.stderr.write('Querying indexer for all L1 rewardDistributions...\n');
  let distributions: Distribution[];
  try {
    distributions = await fetchAllDistributions();
  } catch (err) {
    out(`**Indexer query failed:** ${err instanceof Error ? err.message : String(err)}`);
    if (mdPath) writeFileSync(mdPath, lines.join('\n'));
    process.exit(1);
  }
  process.stderr.write(`Fetched ${distributions.length} rewardDistribution rows.\n`);

  // Aggregate lifetime tJINN per operator (Safe multisig).
  const perOp = new Map<string, bigint>();
  for (const d of distributions) {
    perOp.set(d.multisig, (perOp.get(d.multisig) ?? 0n) + d.operatorMinted);
  }

  const ranked = [...perOp.entries()].sort((a, b) => Number(b[1] - a[1]));
  const qualifying = ranked.filter(([, total]) => total >= REQUIRED_TJINN_PER_OPERATOR);

  out('## Per-operator lifetime totals');
  out('');
  out('| Operator | Lifetime tJINN | Qualifies (≥25)? |');
  out('|---|---:|:---:|');
  for (const [m, total] of ranked) {
    const short = `${m.slice(0, 6)}…${m.slice(-4)}`;
    const ok = total >= REQUIRED_TJINN_PER_OPERATOR ? 'yes' : '';
    out(`| \`${short}\` | ${formatTjinn(total)} | ${ok} |`);
  }
  out('');

  out('## Verdict');
  out('');
  out(`- Distinct operators with any earnings: **${perOp.size}**`);
  out(`- Operators ≥ 25 tJINN (lifetime): **${qualifying.length} / ${REQUIRED_OPERATORS}**`);
  out(`- Progress: **${((qualifying.length / REQUIRED_OPERATORS) * 100).toFixed(1)}%** of the target.`);
  out(`- **${qualifying.length >= REQUIRED_OPERATORS ? 'MILESTONE HIT.' : 'NOT HIT.'}**`);

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
