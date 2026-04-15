import '../env/index.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { deliverViaSafe } from '@jinn-network/mech-client-ts/dist/post_deliver.js';
import { Web3 } from 'web3';
import { getMechChainConfig, getServiceSafeAddress, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import agentMechArtifact from '@jinn-network/mech-client-ts/dist/abis/AgentMech.json';

type UnclaimedRequest = {
  id: string;
  mech: string;
  sender?: string;
  ipfsHash?: string;
  delivered?: boolean;
};

const PONDER_GRAPHQL_URL = process.env.PONDER_GRAPHQL_URL || `http://localhost:${process.env.PONDER_PORT || '42069'}/graphql`;

async function fetchRecentRequests(limit: number = 20): Promise<UnclaimedRequest[]> {
  try {
    const query = `query RecentRequests($limit: Int!) {\n  requests(orderBy: \"blockTimestamp\", orderDirection: \"desc\", limit: $limit) {\n    items { id mech sender ipfsHash blockTimestamp delivered }\n  }\n}`;
    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { limit } })
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const json = await res.json();
    const items: any[] = json?.data?.requests?.items || [];
    return items.map((r: any) => ({
      id: String(r.id),
      mech: String(r.mech),
      sender: r?.sender ? String(r.sender) : undefined,
      ipfsHash: r?.ipfsHash ? String(r.ipfsHash) : undefined,
      delivered: Boolean(r?.delivered === true)
    }));
  } catch {
    return [];
  }
}

async function fetchRequestById(id: string): Promise<UnclaimedRequest | null> {
  try {
    const query = `query ($id: String!) { request(id: $id) { id mech sender ipfsHash delivered } }`;
    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { id } })
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const json = await res.json();
    const r = json?.data?.request;
    if (!r) return null;
    return {
      id: String(r.id),
      mech: String(r.mech),
      sender: r?.sender ? String(r.sender) : undefined,
      ipfsHash: r?.ipfsHash ? String(r.ipfsHash) : undefined,
      delivered: Boolean(r?.delivered === true)
    };
  } catch {
    return null;
  }
}

async function getUndeliveredSet(params: { mechAddress: string; rpcHttpUrl?: string; size?: number; offset?: number }): Promise<Set<string>> {
  const { mechAddress, rpcHttpUrl, size = 100, offset = 0 } = params;
  try {
    if (!rpcHttpUrl) return new Set<string>();
    const abi: any = (agentMechArtifact as any)?.abi || (agentMechArtifact as any);
    const web3 = new Web3(rpcHttpUrl);
    const contract = new (web3 as any).eth.Contract(abi, mechAddress);
    const ids: string[] = await contract.methods.getUndeliveredRequestIds(size, offset).call();
    return new Set((ids || []).map((x: string) => String(x).toLowerCase()));
  } catch {
    return new Set<string>();
  }
}

function toHex32(id: string): string {
  return String(id).startsWith('0x') ? String(id) : ('0x' + BigInt(String(id)).toString(16));
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('request-id', { type: 'string', describe: 'Request ID (0x hex or decimal string)' })
    .option('mech', { type: 'string', describe: 'Target mech address (0x...)' })
    .option('force', { type: 'boolean', default: false, describe: 'Skip preflight undelivered check' })
    .option('output', { type: 'string', default: '', describe: 'Delivery output text' })
    .option('artifacts-json', { type: 'string', describe: 'JSON stringified artifacts array to include in resultContent.artifacts' })
    .help()
    .parse();

  const chainConfig = getMechChainConfig();
  const safeAddress = getServiceSafeAddress();
  const rpcHttpUrl = process.env.RPC_URL || process.env.MECHX_CHAIN_RPC || process.env.MECH_RPC_HTTP_URL;
  const privateKey = getServicePrivateKey();

  if (!safeAddress) {
    console.error('Safe address not found in .operate profile or MECH_SAFE_ADDRESS env var');
    process.exit(1);
  }
  
  if (!privateKey) {
    console.error('Private key not found in .operate profile or MECH_PRIVATE_KEY env var');
    process.exit(1);
  }

  let target: UnclaimedRequest | null = null;
  if (argv['request-id']) {
    target = await fetchRequestById(String(argv['request-id']));
    if (!target) {
      console.error('Request not found in subgraph');
      process.exit(1);
    }
    if (argv.mech) target.mech = String(argv.mech);
  } else {
    const recent = await fetchRecentRequests(25);
    const undelivered = recent.filter(r => !r.delivered);
    if (undelivered.length === 0) {
      console.error('No undelivered requests found');
      process.exit(1);
    }
    target = undelivered[0];
  }

  const targetMechAddress = argv.mech ? String(argv.mech) : target.mech;
  if (!targetMechAddress) {
    console.error('Missing mech address for request');
    process.exit(1);
  }

  if (!argv.force) {
    try {
      const set = await getUndeliveredSet({ mechAddress: targetMechAddress, rpcHttpUrl });
      const idHex = toHex32(target.id).toLowerCase();
      if (set.size && !set.has(idHex)) {
        console.error('Preflight: request appears already delivered or not eligible');
        process.exit(1);
      }
    } catch {
      // best-effort
    }
  }

  const payload = {
    chainConfig,
    requestId: String(target.id),
    resultContent: {
      requestId: String(target.id),
      output: String(argv.output || ''),
      telemetry: {},
      artifacts: (() => {
        try {
          const s = (argv as any)['artifacts-json'];
          if (!s) return [];
          const parsed = JSON.parse(String(s));
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      })()
    },
    targetMechAddress,
    safeAddress,
    privateKey,
    ...(rpcHttpUrl ? { rpcHttpUrl } : {}),
    wait: true
  } as const;

  const delivery = await (deliverViaSafe as any)(payload);
  console.log(JSON.stringify({ ok: true, data: delivery }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  process.exit(1);
});


