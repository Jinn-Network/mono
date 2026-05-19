import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { ManifestSchema, type TopupResult, type Manifest } from './types';
import { goldPath } from './substrate-paths';

const TARGET_ETH_WEI = 5_000_000_000_000_000n;       // 0.005 ETH
const TARGET_USDC_UNITS = 1_000_000n;                // 1.00 USDC (6 decimals)
const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface TopupOptions {
  substrateRoot?: string;
}

export async function checkSubstrateTopup(opName: string, opts: TopupOptions = {}): Promise<TopupResult> {
  const opDir = goldPath(opName, opts.substrateRoot);
  const manifestRaw = await fs.readFile(path.join(opDir, 'manifest.json'), 'utf-8');
  const manifest: Manifest = ManifestSchema.parse(JSON.parse(manifestRaw));

  const client = createPublicClient({ chain: baseSepolia, transport: http(manifest.config.rpcUrl) });
  const needs: TopupResult['needs'] = [];

  // ETH on master EOA (for posting txs from substrate ops)
  const ethBalance = await client.getBalance({ address: manifest.operator.masterAddress as Address });
  if (ethBalance < TARGET_ETH_WEI) {
    needs.push({ resource: 'ETH', have: ethBalance, want: TARGET_ETH_WEI });
  }

  // USDC on Safe (for x402 payments — only if op participates in donation scenarios)
  try {
    const usdcBalance = await client.readContract({
      address: USDC_BASE_SEPOLIA,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [manifest.operator.safeAddress as Address],
    });
    if (usdcBalance < TARGET_USDC_UNITS) {
      needs.push({ resource: 'USDC', have: usdcBalance, want: TARGET_USDC_UNITS });
    }
  } catch {
    // USDC token might not be deployed on the local fork; treat as zero
    needs.push({ resource: 'USDC', have: 0n, want: TARGET_USDC_UNITS });
  }

  return { opName, needs, ok: needs.length === 0 };
}

async function cliMain(): Promise<void> {
  const opName = process.argv[2];
  if (!opName) {
    console.error('usage: substrate-topup <op-name>');
    process.exit(2);
  }
  const result = await checkSubstrateTopup(opName);
  console.log(JSON.stringify(
    {
      opName: result.opName,
      ok: result.ok,
      needs: result.needs.map((n) => ({ ...n, have: n.have.toString(), want: n.want.toString() })),
    },
    null,
    2,
  ));
  if (!result.ok) {
    console.error('\nSubstrate op has low balances. Fund manually or via release-bot wallet:');
    for (const n of result.needs) {
      console.error(`  - ${n.resource}: have ${n.have.toString()}, want ${n.want.toString()}`);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
