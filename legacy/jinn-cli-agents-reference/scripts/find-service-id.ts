import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: http('https://base.llamarpc.com')
});

async function main() {
  const serviceRegistry = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';
  const safeMultisig = '0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92';

  console.log('Searching for service with multisig:', safeMultisig);

  // Get Transfer events (ERC721) to this Safe
  try {
    const logs = await client.getLogs({
      address: serviceRegistry,
      event: {
        type: 'event',
        name: 'Transfer',
        inputs: [
          { indexed: true, name: 'from', type: 'address' },
          { indexed: true, name: 'to', type: 'address' },
          { indexed: true, name: 'tokenId', type: 'uint256' }
        ]
      },
      args: {
        to: safeMultisig
      },
      fromBlock: 25_000_000n,
      toBlock: 'latest'
    });

    if (logs.length > 0) {
      const serviceId = logs[logs.length - 1].args.tokenId!;
      console.log('\n✅ Found Service ID:', serviceId.toString());

      // Verify it still has this multisig
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
        args: [serviceId]
      });

      console.log('Multisig:', service.multisig);
      console.log('Bond:', (Number(service.securityDeposit) / 1e18).toFixed(2), 'OLAS');
      console.log('State:', service.state);
    } else {
      console.log('❌ No Transfer events found for this Safe');
    }
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

main();
