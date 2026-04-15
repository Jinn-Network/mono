import { getServiceSafeAddress, getMechAddress } from '../jinn-node/src/env/operate-profile.js';
import { createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({ chain: base, transport: http() });

async function main() {
  const mechAddress = getMechAddress();
  const safeAddress = getServiceSafeAddress();

  console.log('From operate-profile:');
  console.log('- Mech:', mechAddress);
  console.log('- Safe:', safeAddress);

  if (!mechAddress || !safeAddress) {
    console.log('\n❌ Could not get mech or safe address from operate-profile');
    return;
  }

  // Get Safe owners
  const owners = await client.readContract({
    address: safeAddress as `0x${string}`,
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

  console.log('\nSafe owners:', owners);

  // Query the MechMarketplace to find the service ID
  const mechMarketplace = getAddress('0xB4B192C3BF621D1E0E3E0C66635E2601F8348973'); // Base mainnet

  try {
    const mechInfo = await client.readContract({
      address: mechMarketplace as `0x${string}`,
      abi: [{
        name: 'mapMechIdServiceInfo',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'mechAddress', type: 'address' }],
        outputs: [
          { name: 'serviceId', type: 'uint256' },
          { name: 'multisig', type: 'address' },
          { name: 'responseTimeout', type: 'uint32' },
          { name: 'maxNumServices', type: 'uint32' }
        ]
      }],
      functionName: 'mapMechIdServiceInfo',
      args: [mechAddress as `0x${string}`]
    });

    console.log('\nMech Marketplace Info:');
    console.log('- Service ID:', mechInfo[0].toString());
    console.log('- Multisig:', mechInfo[1]);
    console.log('- Response Timeout:', mechInfo[2]);
    console.log('- Max Num Services:', mechInfo[3]);

    // Get service owner from ServiceRegistry
    const serviceRegistry = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';

    const serviceOwner = await client.readContract({
      address: serviceRegistry,
      abi: [{
        name: 'ownerOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'serviceId', type: 'uint256' }],
        outputs: [{ name: '', type: 'address' }]
      }],
      functionName: 'ownerOf',
      args: [mechInfo[0]]
    });

    console.log('\nService NFT Owner:', serviceOwner);

    // Check OLAS balance of service owner
    const OLAS_TOKEN = '0xFc7AD9Ec1590f093BAb08f4523076b0A7e6c1E21'; // Base mainnet

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

    console.log('\n💰 OLAS Balance of Service Owner:', (Number(olasBalance) / 1e18).toFixed(2), 'OLAS');

    // Jinn staking requirements
    const jinnStaking = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
    const MIN_BOND_JINN = 5000; // 5,000 OLAS

    const currentBond = await client.readContract({
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
      args: [mechInfo[0]]
    });

    const currentBondOlas = Number(currentBond.securityDeposit) / 1e18;
    const neededOlas = Math.max(0, MIN_BOND_JINN - currentBondOlas);

    console.log('\n📊 Staking Requirements:');
    console.log('- Current bond:', currentBondOlas.toFixed(2), 'OLAS');
    console.log('- Jinn staking minimum:', MIN_BOND_JINN, 'OLAS');
    console.log('- Additional OLAS needed:', neededOlas.toFixed(2), 'OLAS');

    console.log('\n✅ OLAS TRANSFER INSTRUCTIONS:');
    console.log('='.repeat(60));
    console.log('Send', neededOlas.toFixed(2), 'OLAS to:', serviceOwner);
    console.log('='.repeat(60));

  } catch (error: any) {
    console.error('\n❌ Error querying MechMarketplace:', error.message);
  }
}

main();
