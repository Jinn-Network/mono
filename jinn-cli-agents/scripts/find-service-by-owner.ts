import { createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: http('https://base.llamarpc.com')
});

async function main() {
  const serviceRegistry = getAddress('0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE');
  const masterEOA = getAddress('0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2');
  const safeMultisig = getAddress('0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92');

  console.log('Searching for services owned by Master EOA:', masterEOA);
  console.log('With multisig:', safeMultisig);

  // Check recent services (352 down to 300)
  for (let i = 352; i >= 250; i--) {
    try {
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

      if (owner.toLowerCase() === masterEOA.toLowerCase()) {
        // Found a service owned by master EOA, check if multisig matches
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

        console.log(`\n✅ Service ID ${i}:`);
        console.log('   Owner:', owner);
        console.log('   Multisig:', service.multisig);
        console.log('   Bond:', (Number(service.securityDeposit) / 1e18).toFixed(2), 'OLAS');
        console.log('   State:', service.state);

        if (service.multisig.toLowerCase() === safeMultisig.toLowerCase()) {
          console.log('\n🎯 MATCH! This is your active service!');
          process.exit(0);
        }
      }

      if (i % 20 === 0) {
        console.log('Checked up to service', i);
      }
    } catch (e) {
      // Service doesn't exist
    }
  }

  console.log('\n❌ No matching service found in range 250-352');
}

main();
