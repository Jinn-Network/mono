import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

// Use Alchemy or another provider to avoid rate limiting
const client = createPublicClient({
  chain: base,
  transport: http('https://base.llamarpc.com')
});

async function main() {
  const mechAddress = '0x8c083Dfe9bee719a05Ba3c75A9B16BE4ba52c299';
  const safeAddress = '0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92';

  console.log('🔍 Querying service info for mech:', mechAddress);
  console.log('Safe multisig:', safeAddress);

  // Query ServiceRegistry directly with the safe address
  // Services are typically owned by their Safe multisig
  const serviceRegistry = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';

  // Get service count to know range
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

  console.log('\nTotal services registered:', totalServices.toString());
  console.log('Checking recent services...\n');

  // Check the last 50 services for one with matching multisig
  const startId = Number(totalServices) - 50;
  let found = false;

  for (let i = Number(totalServices); i >= startId && i > 0; i--) {
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

      if (service.multisig.toLowerCase() === safeAddress.toLowerCase()) {
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

        console.log('✅ FOUND MATCHING SERVICE!');
        console.log('='.repeat(60));
        console.log('Service ID:', i);
        console.log('Multisig:', service.multisig);
        console.log('NFT Owner:', owner);
        console.log('Security Deposit:', (Number(service.securityDeposit) / 1e18).toFixed(2), 'OLAS');
        console.log('State:', service.state, service.state === 4 ? '(DEPLOYED)' : '');
        console.log('='.repeat(60));

        // Check OLAS balance of owner
        const OLAS_TOKEN = '0xFc7AD9Ec1590f093BAb08f4523076b0A7e6c1E21';

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
          args: [owner]
        });

        const currentBondOlas = Number(service.securityDeposit) / 1e18;
        const currentBalanceOlas = Number(olasBalance) / 1e18;
        const MIN_BOND_JINN = 5000;
        const neededOlas = Math.max(0, MIN_BOND_JINN - currentBondOlas);

        console.log('\n💰 OLAS ANALYSIS:');
        console.log('='.repeat(60));
        console.log('Current bond:', currentBondOlas.toFixed(2), 'OLAS');
        console.log('Current balance (owner):', currentBalanceOlas.toFixed(2), 'OLAS');
        console.log('Jinn staking minimum:', MIN_BOND_JINN, 'OLAS');
        console.log('Additional OLAS needed for bond:', neededOlas.toFixed(2), 'OLAS');
        console.log('='.repeat(60));

        console.log('\n📋 ACTION REQUIRED:');
        console.log('='.repeat(60));
        if (neededOlas > 0) {
          console.log(`Send ${neededOlas.toFixed(2)} OLAS to: ${owner}`);
          console.log('\nThis address needs OLAS to increase the service bond from');
          console.log(`${currentBondOlas.toFixed(2)} OLAS to ${MIN_BOND_JINN} OLAS before staking in Jinn.`);
        } else {
          console.log('✅ Service already has sufficient bond for Jinn staking!');
        }
        console.log('='.repeat(60));

        found = true;
        break;
      }
    } catch (e) {
      // Service doesn't exist or error reading
      continue;
    }
  }

  if (!found) {
    console.log('❌ No service found with multisig', safeAddress);
    console.log('Checked service IDs from', startId, 'to', totalServices.toString());
  }
}

main().catch(console.error);
