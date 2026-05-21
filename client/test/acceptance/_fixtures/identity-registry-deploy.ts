/**
 * Deploy a minimal IdentityRegistry stub onto Anvil for acceptance-tier tests.
 *
 * The stub implements the same external surface the real ERC-8004 IdentityRegistry
 * exposes to the Jinn protocol:
 *   - `register(address owner) → agentId`
 *   - `setAgentWallet(uint256 agentId, address wallet)`
 *   - `setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)`
 *   - `MetadataSet(agentId, indexedMetadataKey, metadataKey, metadataValue)` event
 *   - `AgentRegistered(agentId, owner, wallet)` event
 *
 * The bytecode was compiled from a minimal Solidity stub using solc 0.8.30
 * (Foundry's default for this repo). The ABI and bytecode are embedded inline
 * so no compilation step is needed at test runtime.
 *
 * Uses the first Foundry deterministic account as deployer (100 ETH balance on
 * a fresh Anvil instance).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FOUNDRY_ACCOUNTS } from './anvil.js';

// ── Inline ABI + bytecode ────────────────────────────────────────────────────
// Compiled from contracts/src/stubs/IdentityRegistryStub.sol (solc 0.8.30).

export const IDENTITY_REGISTRY_STUB_ABI = [
  {
    type: 'function',
    name: 'register',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setAgentWallet',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'wallet', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setMetadata',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'agentIdByOwner',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'ownerByAgentId',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'walletByAgentId',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'nextAgentId',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'MetadataSet',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'indexedMetadataKey', type: 'string', indexed: true },
      { name: 'metadataKey', type: 'string', indexed: false },
      { name: 'metadataValue', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AgentRegistered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'wallet', type: 'address', indexed: true },
    ],
  },
] as const;

// Bytecode compiled from IdentityRegistryStub.sol (solc 0.8.30, optimizer 1_000_000 runs, via-ir).
export const IDENTITY_REGISTRY_STUB_BYTECODE =
  '0x608060405260016003553480156013575f5ffd5b5061092d806100215f395ff3fe608060405234801561000f575f5ffd5b506004361061007b575f3560e01c8063466648da11610059578063466648da146100fd578063636d2f6414610119578063c4045ca614610135578063f2c1941e146101655761007b565b806313f6d3341461007f57806330efc498146100af5780634420e486146100cd575b5f5ffd5b61009960048036038101906100949190610481565b610195565b6040516100a691906104eb565b60405180910390f35b6100b76101c5565b6040516100c49190610513565b60405180910390f35b6100e760048036038101906100e29190610556565b6101cb565b6040516100f49190610513565b60405180910390f35b61011760048036038101906101129190610637565b610352565b005b610133600480360381019061012e91906106c8565b6103af565b005b61014f600480360381019061014a9190610556565b610402565b60405161015c9190610513565b60405180910390f35b61017f600480360381019061017a9190610481565b610416565b60405161018c91906104eb565b60405180910390f35b6001602052805f5260405f205f915054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b60035481565b5f5f5f5f8473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f20541461024a576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161024190610760565b60405180910390fd5b60035f81548092919061025c906107ab565b919050559050805f5f8473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f20819055508160015f8381526020019081526020015f205f6101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505f73ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16827f8f041a5898b573cd1b50f3153fa5378e55053d1c42f4082ef64e0a97a7892cd660405160405180910390a4919050565b838360405161036292919061082e565b6040518091039020857f2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b868686866040516103a094939291906108be565b60405180910390a35050505050565b8060025f8481526020019081526020015f205f6101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505050565b5f602052805f5260405f205f915090505481565b6002602052805f5260405f205f915054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b5f5ffd5b5f5ffd5b5f819050919050565b6104608161044e565b811461046a575f5ffd5b50565b5f8135905061047b81610457565b92915050565b5f6020828403121561049657610495610446565b5b5f6104a38482850161046d565b91505092915050565b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6104d5826104ac565b9050919050565b6104e5816104cb565b82525050565b5f6020820190506104fe5f8301846104dc565b92915050565b61050d8161044e565b82525050565b5f6020820190506105265f830184610504565b92915050565b610535816104cb565b811461053f575f5ffd5b50565b5f813590506105508161052c565b92915050565b5f6020828403121561056b5761056a610446565b5b5f61057884828501610542565b91505092915050565b5f5ffd5b5f5ffd5b5f5ffd5b5f5f83601f8401126105a2576105a1610581565b5b8235905067ffffffffffffffff8111156105bf576105be610585565b5b6020830191508360018202830111156105db576105da610589565b5b9250929050565b5f5f83601f8401126105f7576105f6610581565b5b8235905067ffffffffffffffff81111561061457610613610585565b5b6020830191508360018202830111156106305761062f610589565b5b9250929050565b5f5f5f5f5f606086880312156106505761064f610446565b5b5f61065d8882890161046d565b955050602086013567ffffffffffffffff81111561067e5761067d61044a565b5b61068a8882890161058d565b9450945050604086013567ffffffffffffffff8111156106ad576106ac61044a565b5b6106b9888289016105e2565b92509250509295509295909350565b5f5f604083850312156106de576106dd610446565b5b5f6106eb8582860161046d565b92505060206106fc85828601610542565b9150509250929050565b5f82825260208201905092915050565b7f616c7265616479207265676973746572656400000000000000000000000000005f82015250565b5f61074a601283610706565b915061075582610716565b602082019050919050565b5f6020820190508181035f8301526107778161073e565b9050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f6107b58261044e565b91507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff82036107e7576107e661077e565b5b600182019050919050565b5f81905092915050565b828183375f83830152505050565b5f61081583856107f2565b93506108228385846107fc565b82840190509392505050565b5f61083a82848661080a565b91508190509392505050565b5f601f19601f8301169050919050565b5f6108618385610706565b935061086e8385846107fc565b61087783610846565b840190509392505050565b5f82825260208201905092915050565b5f61089d8385610882565b93506108aa8385846107fc565b6108b383610846565b840190509392505050565b5f6040820190508181035f8301526108d7818688610856565b905081810360208301526108ec818486610892565b90509594505050505056fea26469706673582212201ebac556120a6de296dfac118a0c2d9e681dbcbfa981cdbe1918f902d364907964736f6c634300081e0033' as const;

// ── Deploy helper ─────────────────────────────────────────────────────────────

export interface IdentityRegistryHandle {
  address: `0x${string}`;
  abi: typeof IDENTITY_REGISTRY_STUB_ABI;
}

export interface DeployIdentityRegistryOpts {
  rpcUrl: string;
  /** Deployer private key; defaults to first Foundry deterministic account. */
  deployerPrivateKey?: `0x${string}`;
  chainId?: number;
}

/**
 * Deploy the IdentityRegistryStub onto the given RPC endpoint and return its
 * address + ABI.
 */
export async function deployIdentityRegistry(
  opts: DeployIdentityRegistryOpts,
): Promise<IdentityRegistryHandle> {
  const { rpcUrl } = opts;
  const deployerKey = opts.deployerPrivateKey ?? FOUNDRY_ACCOUNTS[0]!.privateKey;
  const chainId = opts.chainId ?? 31337;

  const chain = defineChain({
    id: chainId,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const account = privateKeyToAccount(deployerKey);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const hash = await walletClient.deployContract({
    abi: IDENTITY_REGISTRY_STUB_ABI,
    bytecode: IDENTITY_REGISTRY_STUB_BYTECODE,
    account,
    chain,
    args: [],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`IdentityRegistryStub deployment failed: no contractAddress in receipt`);
  }

  return {
    address: receipt.contractAddress,
    abi: IDENTITY_REGISTRY_STUB_ABI,
  };
}
