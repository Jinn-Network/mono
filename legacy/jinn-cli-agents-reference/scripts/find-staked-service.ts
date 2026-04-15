import { createPublicClient, http, parseAbiItem, type Hex } from 'viem';
import { base } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL || 'https://mainnet.base.org') });

const AGENTSFUN1 = '0x2585e63df7BD9De8e058884D496658a030b5c6ce' as const;
const JINN = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139' as const;
const MASTER_SAFE = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421' as const;
const MASTER_EOA = '0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2' as const;

async function find() {
  console.log('=== Finding Our Service via Events ===\n');
  console.log('Master Safe:', MASTER_SAFE);
  console.log('Master EOA:', MASTER_EOA);

  // ServiceStaked event: owner and multisig are indexed (topics)
  const serviceStakedEvent = parseAbiItem(
    'event ServiceStaked(uint256 epoch, uint256 indexed serviceId, address indexed owner, address indexed multisig, uint256[] nonces)'
  );

  // Search for ServiceStaked events where owner = Master Safe
  console.log('\n--- ServiceStaked events where owner = Master Safe ---');
  const safeStakedLogs = await client.getLogs({
    address: AGENTSFUN1,
    event: serviceStakedEvent,
    args: { owner: MASTER_SAFE },
    fromBlock: 20000000n,
    toBlock: 'latest',
  });
  for (const log of safeStakedLogs) {
    console.log(`  Block ${log.blockNumber}: serviceId=${log.args.serviceId} owner=${log.args.owner} multisig=${log.args.multisig}`);
  }
  if (safeStakedLogs.length === 0) console.log('  (none found)');

  // Search for ServiceStaked events where owner = Master EOA
  console.log('\n--- ServiceStaked events where owner = Master EOA ---');
  const eoaStakedLogs = await client.getLogs({
    address: AGENTSFUN1,
    event: serviceStakedEvent,
    args: { owner: MASTER_EOA },
    fromBlock: 20000000n,
    toBlock: 'latest',
  });
  for (const log of eoaStakedLogs) {
    console.log(`  Block ${log.blockNumber}: serviceId=${log.args.serviceId} owner=${log.args.owner} multisig=${log.args.multisig}`);
  }
  if (eoaStakedLogs.length === 0) console.log('  (none found)');

  // Also check where multisig = Master Safe
  console.log('\n--- ServiceStaked events where multisig = Master Safe ---');
  const safeMultisigLogs = await client.getLogs({
    address: AGENTSFUN1,
    event: serviceStakedEvent,
    args: { multisig: MASTER_SAFE },
    fromBlock: 20000000n,
    toBlock: 'latest',
  });
  for (const log of safeMultisigLogs) {
    console.log(`  Block ${log.blockNumber}: serviceId=${log.args.serviceId} owner=${log.args.owner} multisig=${log.args.multisig}`);
  }
  if (safeMultisigLogs.length === 0) console.log('  (none found)');

  // Check Jinn too
  console.log('\n--- Jinn ServiceStaked events where owner = Master Safe ---');
  const jinnSafeLogs = await client.getLogs({
    address: JINN,
    event: serviceStakedEvent,
    args: { owner: MASTER_SAFE },
    fromBlock: 20000000n,
    toBlock: 'latest',
  });
  for (const log of jinnSafeLogs) {
    console.log(`  Block ${log.blockNumber}: serviceId=${log.args.serviceId} owner=${log.args.owner} multisig=${log.args.multisig}`);
  }
  if (jinnSafeLogs.length === 0) console.log('  (none found)');

  // Also try getting ALL ServiceStaked events on AgentsFun1 with service 165 specifically
  console.log('\n--- All ServiceStaked for service 165 on AgentsFun1 ---');
  const s165Logs = await client.getLogs({
    address: AGENTSFUN1,
    event: serviceStakedEvent,
    args: { serviceId: 165n },
    fromBlock: 20000000n,
    toBlock: 'latest',
  });
  for (const log of s165Logs) {
    console.log(`  Block ${log.blockNumber}: serviceId=${log.args.serviceId} owner=${log.args.owner} multisig=${log.args.multisig}`);
  }
  if (s165Logs.length === 0) console.log('  (none found)');

  // Let's also check the Ponder endpoint if available
  try {
    const ponderUrl = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
    console.log('\n--- Checking Ponder for staked services ---');
    const query = `{
      stakedServices(where: { isStaked: true }) {
        items { serviceId stakingContract owner multisig }
      }
    }`;
    const resp = await fetch(ponderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await resp.json() as any;
    if (data.data?.stakedServices?.items) {
      for (const item of data.data.stakedServices.items) {
        const isOurs = item.owner?.toLowerCase() === MASTER_SAFE.toLowerCase() || item.owner?.toLowerCase() === MASTER_EOA.toLowerCase();
        if (isOurs) {
          console.log(`  OUR SERVICE: serviceId=${item.serviceId} stakingContract=${item.stakingContract} owner=${item.owner} multisig=${item.multisig}`);
        }
      }
      console.log(`  Total staked services in Ponder: ${data.data.stakedServices.items.length}`);
    } else {
      console.log('  Ponder response:', JSON.stringify(data).slice(0, 200));
    }
  } catch (e: any) {
    console.log('  Ponder query failed:', e.message?.slice(0, 100));
  }

  console.log('\nDone.');
}

find().catch(e => { console.error('Error:', e.message); process.exit(1); });
