import { createPublicClient, http, parseAbi, formatEther } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL || 'https://mainnet.base.org') });

const STAKING_ABI = parseAbi([
  'function getServiceIds() view returns (uint256[])',
  'function mapServiceInfo(uint256 serviceId) view returns (address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity)',
  'function minStakingDeposit() view returns (uint256)',
  'function maxNumServices() view returns (uint256)',
]);

const SERVICE_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
]);

const TOKEN_UTILITY_ABI = parseAbi([
  'function mapServiceIdTokenDeposit(uint256 serviceId) view returns (uint256 securityDeposit, address token)',
]);

const AGENTSFUN1 = '0x2585e63df7BD9De8e058884D496658a030b5c6ce' as const;
const JINN = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139' as const;
const SERVICE_REGISTRY = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE' as const;
const TOKEN_UTILITY = '0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5' as const;
const OLAS = '0x54330d28ca3357F294334BDC454a032e7f353416' as const;
const MASTER_EOA = '0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2' as const;

const SERVICE_ID = 165n;

async function check() {
  console.log('=== Preflight Check: Service', SERVICE_ID.toString(), '===\n');

  const agentsfunIds = await client.readContract({ address: AGENTSFUN1, abi: STAKING_ABI, functionName: 'getServiceIds' });
  const isStakedAgentsFun = agentsfunIds.includes(SERVICE_ID);
  console.log('Staked in AgentsFun1:', isStakedAgentsFun);
  if (isStakedAgentsFun) {
    console.log('  AgentsFun1 staked IDs:', agentsfunIds.map(id => id.toString()).join(', '));
  }

  const jinnIds = await client.readContract({ address: JINN, abi: STAKING_ABI, functionName: 'getServiceIds' });
  const isStakedJinn = jinnIds.includes(SERVICE_ID);
  console.log('Staked in Jinn:', isStakedJinn);
  console.log('  Jinn staked IDs:', jinnIds.map(id => id.toString()).join(', '));

  const owner = await client.readContract({ address: SERVICE_REGISTRY, abi: SERVICE_ABI, functionName: 'ownerOf', args: [SERVICE_ID] });
  console.log('\nNFT Owner:', owner);

  if (isStakedAgentsFun) {
    const info = await client.readContract({ address: AGENTSFUN1, abi: STAKING_ABI, functionName: 'mapServiceInfo', args: [SERVICE_ID] });
    console.log('AgentsFun1 multisig:', info[0]);
    console.log('AgentsFun1 owner:', info[1]);
  }

  const [bond] = await client.readContract({ address: TOKEN_UTILITY, abi: TOKEN_UTILITY_ABI, functionName: 'mapServiceIdTokenDeposit', args: [SERVICE_ID] });
  console.log('\nCurrent Bond:', formatEther(bond), 'OLAS');

  const jinnMin = await client.readContract({ address: JINN, abi: STAKING_ABI, functionName: 'minStakingDeposit' });
  console.log('Jinn Min Stake:', formatEther(jinnMin), 'OLAS');
  const needsTopup = bond < jinnMin;
  console.log('Needs Bond Top-up:', needsTopup, needsTopup ? `(${formatEther(jinnMin - bond)} OLAS needed)` : '');

  const olasBalance = await client.readContract({ address: OLAS, abi: ERC20_ABI, functionName: 'balanceOf', args: [MASTER_EOA] });
  console.log('Master EOA OLAS Balance:', formatEther(olasBalance));

  const jinnMax = await client.readContract({ address: JINN, abi: STAKING_ABI, functionName: 'maxNumServices' });
  console.log('\nJinn Slots:', jinnIds.length.toString(), '/', jinnMax.toString());
  console.log('Jinn has available slots:', jinnIds.length < Number(jinnMax));

  // Check if service is evicted (owned by staking contract but not in active list)
  const isEvicted = !isStakedAgentsFun && owner.toLowerCase() === AGENTSFUN1.toLowerCase();
  if (isEvicted) {
    console.log('\n⚠️  Service 165 appears EVICTED from AgentsFun1');
    console.log('   NFT owned by staking contract but not in active list');
    console.log('   unstake() should still work to reclaim the NFT');
  }

  // List all AgentsFun1 staked services
  console.log('\nAll AgentsFun1 staked service IDs:', agentsfunIds.map(id => id.toString()).join(', ') || '(none)');
  console.log('All Jinn staked service IDs:', jinnIds.map(id => id.toString()).join(', ') || '(none)');

  const ready = (isStakedAgentsFun || isEvicted) && !isStakedJinn && jinnIds.length < Number(jinnMax);
  console.log('\n=== Ready for Migration:', ready ? 'YES (may need eviction handling)' : 'ISSUES FOUND', '===');

  if (!ready) {
    if (!isStakedAgentsFun && !isEvicted) console.log('  BLOCKER: Service 165 not staked or evicted in AgentsFun1');
    if (isStakedJinn) console.log('  BLOCKER: Service 165 already staked in Jinn');
    if (jinnIds.length >= Number(jinnMax)) console.log('  BLOCKER: Jinn staking contract is full');
  }
}

check().catch(e => { console.error('Error:', e.message); process.exit(1); });
