import { createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: http('https://base.llamarpc.com')
});

async function main() {
  const serviceId = 165n;
  const agentsFun1Staking = getAddress('0x2585e63df7BD9De8e058884D496658a030b5c6ce');
  const masterEOA = getAddress('0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2');
  const safeMultisig = getAddress('0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92');

  console.log('Checking staking rights for service', serviceId.toString());
  console.log('AgentsFun1 Staking:', agentsFun1Staking);
  console.log('Master EOA:', masterEOA);
  console.log('Safe Multisig:', safeMultisig);
  console.log('='.repeat(60));

  // Check mapServiceInfo - this tells us who staked it
  try {
    const serviceInfo = await client.readContract({
      address: agentsFun1Staking,
      abi: [{
        name: 'mapServiceInfo',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'serviceId', type: 'uint256' }],
        outputs: [
          { name: 'securityDeposit', type: 'uint96' },
          { name: 'multisig', type: 'address' },
          { name: 'nonces', type: 'uint256[]' }
        ]
      }],
      functionName: 'mapServiceInfo',
      args: [serviceId]
    });

    console.log('\n📋 Service Info in AgentsFun1:');
    console.log('Security Deposit:', (Number(serviceInfo[0]) / 1e18).toFixed(2), 'OLAS');
    console.log('Multisig:', serviceInfo[1]);
    console.log('Nonces:', serviceInfo[2].map(n => n.toString()));

    // Check if in active staked set
    const stakedServices = await client.readContract({
      address: agentsFun1Staking,
      abi: [{
        name: 'getServiceIds',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256[]' }]
      }],
      functionName: 'getServiceIds',
      args: []
    });

    const isStaked = stakedServices.includes(serviceId);
    console.log('\n📊 Staking Status:');
    console.log('Currently staked:', isStaked ? '✅ YES' : '❌ NO (evicted or unstaked)');
    console.log('Total staked services:', stakedServices.length);

    // Check Safe owners to verify Master EOA relationship
    const safeOwners = await client.readContract({
      address: serviceInfo[1], // The multisig from staking contract
      abi: [{
        name: 'getOwners',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'address[]' }]
      }],
      functionName: 'getOwners',
      args: []
    });

    console.log('\n🔑 Safe Owners:', safeOwners);
    console.log('Master EOA is owner:', safeOwners.some(o => o.toLowerCase() === masterEOA.toLowerCase()));

    // Check service registry for actual owner
    const serviceRegistry = getAddress('0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE');
    const nftOwner = await client.readContract({
      address: serviceRegistry,
      abi: [{
        name: 'ownerOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'serviceId', type: 'uint256' }],
        outputs: [{ name: '', type: 'address' }]
      }],
      functionName: 'ownerOf',
      args: [serviceId]
    });

    console.log('\n🎫 Service NFT Owner:', nftOwner);
    console.log('Owned by staking contract:', nftOwner.toLowerCase() === agentsFun1Staking.toLowerCase());

    console.log('\n' + '='.repeat(60));
    console.log('✅ CONCLUSION:');
    if (nftOwner.toLowerCase() === agentsFun1Staking.toLowerCase()) {
      console.log('Service 165 IS staked in AgentsFun1');
      console.log('Multisig', serviceInfo[1], 'can unstake it');
      if (serviceInfo[1].toLowerCase() === safeMultisig.toLowerCase()) {
        console.log('✅ This matches your Safe - you can migrate!');
      } else {
        console.log('⚠️  This does NOT match your Safe:', safeMultisig);
      }
    }
    console.log('='.repeat(60));

  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

main();
