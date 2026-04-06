import { createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: http('https://base.llamarpc.com')
});

async function main() {
  const serviceRegistry = getAddress('0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE');
  const safeMultisig = getAddress('0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92');

  console.log('Checking recent services for multisig:', safeMultisig);

  // Start from most recent and work backwards
  for (let i = 352; i >= 300; i--) {
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
        console.log('\n✅ FOUND SERVICE ID:', i);
        console.log('Multisig:', service.multisig);
        console.log('Bond:', (Number(service.securityDeposit) / 1e18).toFixed(2), 'OLAS');
        console.log('State:', service.state);
        process.exit(0);
      }

      // Show progress every 10
      if (i % 10 === 0) {
        console.log('Checked up to service', i);
      }
    } catch (e) {
      // Service doesn't exist
    }
  }

  console.log('❌ Service not found in range 300-352');
}

main();
