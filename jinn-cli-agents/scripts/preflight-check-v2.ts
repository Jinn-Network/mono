import { createPublicClient, http, parseAbi, formatEther } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL || 'https://mainnet.base.org') });

const STAKING_ABI = parseAbi([
  'function getServiceIds() view returns (uint256[])',
  'function mapServiceInfo(uint256 serviceId) view returns (address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity)',
  'function minStakingDeposit() view returns (uint256)',
  'function maxNumServices() view returns (uint256)',
]);

const SERVICE_ABI = [
  { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { name: 'getService', type: 'function', stateMutability: 'view', inputs: [{ name: 'serviceId', type: 'uint256' }], outputs: [{ name: '', type: 'tuple', components: [{ name: 'securityDeposit', type: 'uint96' }, { name: 'multisig', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'threshold', type: 'uint32' }, { name: 'maxNumAgentInstances', type: 'uint32' }, { name: 'numAgentInstances', type: 'uint32' }, { name: 'state', type: 'uint8' }] }] },
] as const;

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
]);

const TOKEN_UTILITY_ABI = parseAbi([
  'function getOperatorBalance(address operator, uint256 serviceId) view returns (uint256)',
]);

const SAFE_ABI = parseAbi([
  'function getOwners() view returns (address[])',
]);

const AGENTSFUN1 = '0x2585e63df7BD9De8e058884D496658a030b5c6ce' as const;
const JINN = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139' as const;
const SERVICE_REGISTRY = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE' as const;
const OLAS = '0x54330d28ca3357F294334BDC454a032e7f353416' as const;
const MASTER_EOA = '0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2' as const;
const MASTER_SAFE = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421' as const;

const SERVICE_ID = 165n;

async function check() {
  console.log('=== Deep Preflight Check: Service', SERVICE_ID.toString(), '===\n');

  // Service info from registry
  const serviceInfo = await client.readContract({ address: SERVICE_REGISTRY, abi: SERVICE_ABI, functionName: 'getService', args: [SERVICE_ID] });
  console.log('Service Registry Info:');
  console.log('  Security Deposit:', formatEther(serviceInfo.securityDeposit), 'OLAS');
  console.log('  Multisig:', serviceInfo.multisig);
  console.log('  State:', serviceInfo.state, '(1=PreRegistration, 2=ActiveRegistration, 3=FinishedRegistration, 4=Deployed, 5=TerminatedBonded)');

  // NFT owner
  const owner = await client.readContract({ address: SERVICE_REGISTRY, abi: SERVICE_ABI, functionName: 'ownerOf', args: [SERVICE_ID] });
  console.log('  NFT Owner:', owner);

  // Check if multisig is our Safe
  const isOurService = serviceInfo.multisig.toLowerCase() === MASTER_SAFE.toLowerCase();
  console.log('  Is our service (Safe matches):', isOurService);

  // Safe owners
  try {
    const safeOwners = await client.readContract({ address: MASTER_SAFE, abi: SAFE_ABI, functionName: 'getOwners' });
    console.log('\nMaster Safe owners:', safeOwners);
  } catch (e: any) {
    console.log('\nCould not read Safe owners:', e.message?.slice(0, 100));
  }

  // Staking status
  const agentsfunIds = await client.readContract({ address: AGENTSFUN1, abi: STAKING_ABI, functionName: 'getServiceIds' });
  const jinnIds = await client.readContract({ address: JINN, abi: STAKING_ABI, functionName: 'getServiceIds' });

  const isActiveAgentsFun = agentsfunIds.includes(SERVICE_ID);
  const isEvicted = !isActiveAgentsFun && owner.toLowerCase() === AGENTSFUN1.toLowerCase();

  console.log('\nStaking Status:');
  console.log('  Active in AgentsFun1:', isActiveAgentsFun);
  console.log('  Evicted from AgentsFun1:', isEvicted);
  console.log('  In Jinn:', jinnIds.includes(SERVICE_ID));
  console.log('  AgentsFun1 active IDs:', agentsfunIds.map(id => id.toString()).join(', '));
  console.log('  Jinn active IDs:', jinnIds.map(id => id.toString()).join(', ') || '(none)');

  // OLAS balances
  const eoaBalance = await client.readContract({ address: OLAS, abi: ERC20_ABI, functionName: 'balanceOf', args: [MASTER_EOA] });
  const safeBalance = await client.readContract({ address: OLAS, abi: ERC20_ABI, functionName: 'balanceOf', args: [MASTER_SAFE] });

  console.log('\nOLAS Balances:');
  console.log('  Master EOA:', formatEther(eoaBalance), 'OLAS');
  console.log('  Master Safe:', formatEther(safeBalance), 'OLAS');

  // Jinn requirements
  const jinnMin = await client.readContract({ address: JINN, abi: STAKING_ABI, functionName: 'minStakingDeposit' });
  const jinnMax = await client.readContract({ address: JINN, abi: STAKING_ABI, functionName: 'maxNumServices' });

  console.log('\nJinn Staking:');
  console.log('  Min Deposit:', formatEther(jinnMin), 'OLAS');
  console.log('  Slots:', jinnIds.length, '/', Number(jinnMax));

  const currentBond = serviceInfo.securityDeposit;
  const needsTopup = currentBond < jinnMin;
  const topupNeeded = needsTopup ? jinnMin - currentBond : 0n;
  console.log('  Current bond sufficient:', !needsTopup);
  if (needsTopup) {
    console.log('  Top-up needed:', formatEther(topupNeeded), 'OLAS');
    const totalAvailable = eoaBalance + safeBalance;
    console.log('  Total OLAS available:', formatEther(totalAvailable));
    console.log('  Can afford top-up:', totalAvailable >= topupNeeded);
  }

  // Migration plan
  console.log('\n=== Migration Plan ===');
  if (isEvicted) {
    console.log('1. Unstake (evicted) service 165 from AgentsFun1 → reclaims NFT to Master Safe');
    if (needsTopup) {
      console.log('2. Transfer OLAS to Master EOA for bond top-up');
      console.log('3. Approve and increase security deposit');
      console.log('4. Stake in Jinn');
    } else {
      console.log('2. Stake in Jinn');
    }
    console.log('\nNOTE: Migration script needs update to handle evicted services');
  } else if (isActiveAgentsFun) {
    console.log('Standard migration flow applies');
  } else {
    console.log('Service not in AgentsFun1 at all — check ownership');
  }
}

check().catch(e => { console.error('Error:', e.message); process.exit(1); });
