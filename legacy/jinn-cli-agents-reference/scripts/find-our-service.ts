import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL || 'https://mainnet.base.org') });

const ERC721_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)',
]);

const STAKING_ABI = parseAbi([
  'function getServiceIds() view returns (uint256[])',
]);

const AGENTSFUN1 = '0x2585e63df7BD9De8e058884D496658a030b5c6ce' as const;
const JINN = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139' as const;
const SERVICE_REGISTRY = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE' as const;
const MASTER_SAFE = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421' as const;
const MASTER_EOA = '0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2' as const;

async function find() {
  console.log('Searching for services owned by Master Safe or Master EOA...\n');
  console.log('Master Safe:', MASTER_SAFE);
  console.log('Master EOA:', MASTER_EOA);
  console.log('AgentsFun1:', AGENTSFUN1);
  console.log();

  // Get total supply to know range
  let totalSupply: bigint;
  try {
    totalSupply = await client.readContract({ address: SERVICE_REGISTRY, abi: ERC721_ABI, functionName: 'totalSupply' });
    console.log('Total services:', totalSupply.toString());
  } catch {
    totalSupply = 500n;
    console.log('Could not get totalSupply, scanning up to 500');
  }

  // Also get staked IDs for context
  const agentsfunIds = await client.readContract({ address: AGENTSFUN1, abi: STAKING_ABI, functionName: 'getServiceIds' });
  console.log('AgentsFun1 staked:', agentsfunIds.map(id => id.toString()).join(', '));

  const found: { id: number; owner: string; ownedBy: string }[] = [];

  const batchSize = 20;
  const max = Math.min(Number(totalSupply), 500);

  for (let start = 1; start <= max; start += batchSize) {
    const promises = [];
    for (let i = start; i < start + batchSize && i <= max; i++) {
      promises.push(
        client.readContract({ address: SERVICE_REGISTRY, abi: ERC721_ABI, functionName: 'ownerOf', args: [BigInt(i)] })
          .then(owner => ({ id: i, owner: owner.toLowerCase() }))
          .catch(() => null)
      );
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      if (!r) continue;
      if (r.owner === MASTER_SAFE.toLowerCase()) {
        found.push({ ...r, ownedBy: 'Master Safe' });
        console.log(`✅ Service ${r.id}: owned by Master Safe`);
      } else if (r.owner === MASTER_EOA.toLowerCase()) {
        found.push({ ...r, ownedBy: 'Master EOA' });
        console.log(`✅ Service ${r.id}: owned by Master EOA`);
      } else if (r.owner === AGENTSFUN1.toLowerCase()) {
        // Could be evicted - check if multisig matters
        // We'll note it for now
      }
    }
    // Throttle
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n=== Results ===');
  if (found.length === 0) {
    console.log('No services owned by Master Safe or Master EOA found.');
    console.log('Services may be staked (owned by staking contract).');
    console.log('\nLet me also check for services owned by AgentsFun1 staking contract:');

    // Show which services are owned by AgentsFun1 (could be active or evicted)
    for (let i = 1; i <= max; i += batchSize) {
      const promises = [];
      for (let j = i; j < i + batchSize && j <= max; j++) {
        promises.push(
          client.readContract({ address: SERVICE_REGISTRY, abi: ERC721_ABI, functionName: 'ownerOf', args: [BigInt(j)] })
            .then(owner => ({ id: j, owner: owner.toLowerCase() }))
            .catch(() => null)
        );
      }
      const results = await Promise.all(promises);
      for (const r of results) {
        if (r && r.owner === AGENTSFUN1.toLowerCase()) {
          const isActive = agentsfunIds.includes(BigInt(r.id));
          console.log(`  Service ${r.id}: owned by AgentsFun1 (${isActive ? 'ACTIVE' : 'EVICTED'})`);
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
  } else {
    for (const s of found) {
      console.log(`Service ${s.id}: owned by ${s.ownedBy} (${s.owner})`);
    }
  }
}

find().catch(e => { console.error('Error:', e.message); process.exit(1); });
