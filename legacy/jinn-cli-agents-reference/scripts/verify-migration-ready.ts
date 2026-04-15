import { createPublicClient, http, parseEther, getAddress } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: http('https://base.llamarpc.com')
});

async function main() {
  const serviceOwner = getAddress('0x62fb5FC6ab3206b3C817b503260B90075233f7dD');
  const safeMultisig = getAddress('0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92');
  const OLAS_TOKEN = getAddress('0xFc7AD9Ec1590f093BAb08f4523076b0A7e6c1E21');
  const agentsFun1Staking = getAddress('0x2585e63df7BD9De8e058884D496658a030b5c6ce');
  const jinnStaking = getAddress('0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139');
  const serviceRegistry = getAddress('0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE');

  console.log('🔍 Pre-Migration Verification\n');
  console.log('='.repeat(60));

  // 1. Check OLAS balance
  const olasBalance = await client.readContract({
    address: OLAS_TOKEN,
    abi: [{
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }]
    }],
    functionName: 'balanceOf',
    args: [serviceOwner]
  });

  const balanceOlas = Number(olasBalance) / 1e18;
  console.log('✅ OLAS Balance:', balanceOlas.toFixed(2), 'OLAS');

  if (balanceOlas < 5000) {
    console.log('❌ INSUFFICIENT OLAS! Need 5000, have', balanceOlas.toFixed(2));
    return;
  }

  // 2. Find service ID by checking Safe multisig
  console.log('\n🔍 Finding service ID...');

  const totalServices = await client.readContract({
    address: serviceRegistry,
    abi: [{
      name: 'totalSupply',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint256' }]
    }],
    functionName: 'totalSupply',
    args: []
  });

  let serviceId: bigint | null = null;
  const startId = Math.max(Number(totalServices) - 100, 1);

  for (let i = Number(totalServices); i >= startId; i--) {
    try {
      const service = await client.readContract({
        address: serviceRegistry,
        abi: [{
          name: 'getService',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'serviceId', type: 'uint256' }],
          outputs: [{
            name: '',
            type: 'tuple',
            components: [
              { name: 'securityDeposit', type: 'uint96' },
              { name: 'multisig', type: 'address' },
              { name: 'configHash', type: 'bytes32' },
              { name: 'threshold', type: 'uint32' },
              { name: 'maxNumAgentInstances', type: 'uint32' },
              { name: 'numAgentInstances', type: 'uint32' },
              { name: 'state', type: 'uint8' }
            ]
          }]
        }],
        functionName: 'getService',
        args: [BigInt(i)]
      });

      if (service.multisig.toLowerCase() === safeMultisig.toLowerCase()) {
        const owner = await client.readContract({
          address: serviceRegistry,
          abi: [{
            name: 'ownerOf',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'serviceId', type: 'uint256' }],
            outputs: [{ name: '', type: 'address' }]
          }],
          functionName: 'ownerOf',
          args: [BigInt(i)]
        });

        console.log('✅ Found Service ID:', i);
        console.log('   Multisig:', service.multisig);
        console.log('   Owner:', owner);
        console.log('   Current Bond:', (Number(service.securityDeposit) / 1e18).toFixed(2), 'OLAS');
        console.log('   State:', service.state);

        serviceId = BigInt(i);

        // 3. Check current staking status in AgentsFun1
        try {
          const agentsFun1ServiceInfo = await client.readContract({
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

          console.log('\n📊 AgentsFun1 Staking Status:');
          console.log('   Staked Deposit:', (Number(agentsFun1ServiceInfo[0]) / 1e18).toFixed(2), 'OLAS');
          console.log('   Multisig:', agentsFun1ServiceInfo[1]);

          // Check if in active set
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
          console.log('   In Active Set:', isStaked ? '✅ YES' : '❌ NO (may be evicted)');

          if (!isStaked && Number(agentsFun1ServiceInfo[0]) > 0) {
            console.log('\n⚠️  Service is EVICTED from AgentsFun1');
            console.log('   Unstaking will NOT lose rewards (already lost)');
            console.log('   Bond will be returned');
          }
        } catch (e) {
          console.log('\n❌ Not staked in AgentsFun1 or error reading status');
        }

        // 4. Check Jinn staking requirements
        console.log('\n📊 Jinn Staking Requirements:');
        const minBond = await client.readContract({
          address: jinnStaking,
          abi: [{
            name: 'minStakingDeposit',
            type: 'function',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ name: '', type: 'uint96' }]
          }],
          functionName: 'minStakingDeposit',
          args: []
        });

        console.log('   Minimum Bond:', (Number(minBond) / 1e18).toFixed(2), 'OLAS');
        console.log('   Current Bond:', (Number(service.securityDeposit) / 1e18).toFixed(2), 'OLAS');
        console.log('   Owner Balance:', balanceOlas.toFixed(2), 'OLAS');

        const totalNeeded = Number(minBond) / 1e18;
        const currentBond = Number(service.securityDeposit) / 1e18;
        const additional = totalNeeded - currentBond;

        console.log('\n✅ VERIFICATION SUMMARY:');
        console.log('='.repeat(60));
        console.log('Total bond needed:', totalNeeded.toFixed(2), 'OLAS');
        console.log('Current bond:', currentBond.toFixed(2), 'OLAS');
        console.log('Additional needed:', additional.toFixed(2), 'OLAS');
        console.log('Owner has:', balanceOlas.toFixed(2), 'OLAS');

        if (balanceOlas >= additional) {
          console.log('\n✅ SUFFICIENT FUNDS - Migration can proceed safely');
          console.log('\nMigration will:');
          console.log('1. Unstake from AgentsFun1 (returns ~', currentBond.toFixed(2), 'OLAS)');
          console.log('2. Top up bond by', additional.toFixed(2), 'OLAS to reach', totalNeeded, 'OLAS');
          console.log('3. Stake in Jinn staking');
          console.log('\n⚠️  No funds will be lost if migration fails');
          console.log('   Worst case: Service returns to unstaked state with bond intact');
        } else {
          console.log('\n❌ INSUFFICIENT FUNDS!');
        }

        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (!serviceId) {
    console.log('❌ Could not find service with multisig', safeMultisig);
  }
}

main().catch(console.error);
