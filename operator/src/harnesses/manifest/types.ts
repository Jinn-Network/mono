/**
 * Daemon-side manifest types. Same shape as the SDK manifest type;
 * mirrored locally so the client doesn't have to depend on
 * @jinn-network/sdk/harness at runtime (the SDK is a publish-time
 * boundary).
 */

export interface CapabilityAllowEntry {
  chainId: number;
  to: `0x${string}`;
  selector: `0x${string}`;
  description?: string;
}

/**
 * EIP-712 typed-data domain allow-list entry. The daemon's scoped
 * signer refuses any `signTypedData` call whose domain does not
 * match one of these entries.
 *
 * - `chainId` MUST match exactly.
 * - `verifyingContract` / `name` / `version` match only when set on
 *   the entry; an unset field on the entry means "any value".
 * - An empty / omitted `typedDataDomains` array means default-deny:
 *   every `signTypedData` call throws.
 */
export interface TypedDataAllowEntry {
  chainId: number;
  name?: string;
  version?: string;
  verifyingContract?: `0x${string}`;
}

export interface ManifestRpcAllow {
  chainId: number;
  methods: ReadonlyArray<
    | 'eth_call'
    | 'eth_getBlockByNumber'
    | 'eth_getLogs'
    | 'eth_getTransactionReceipt'
    | 'eth_chainId'
    | 'eth_blockNumber'
    | 'eth_getBalance'
    | 'eth_getCode'
  >;
  rateLimit?: { perSec: number };
}

export interface JinnManifest {
  schemaVersion: '1.0.0';
  name: string;
  version: string;
  description?: string;
  supportedSolverTypes: readonly string[];
  entry: string;
  package: { cid: string; hash: `sha256:${string}` };
  capabilities: {
    signer?: {
      selectors: ReadonlyArray<CapabilityAllowEntry>;
      typedDataDomains?: ReadonlyArray<TypedDataAllowEntry>;
    };
    rpc?: ReadonlyArray<ManifestRpcAllow>;
    secrets?: ReadonlyArray<{
      name: string;
      description: string;
      required: boolean;
    }>;
  };
  signature: {
    alg: 'ed25519';
    publicKey: string;
    sig: string;
  };
  author?: { name: string; url?: string };
  license?: string;
}

export interface SignerTrustEntry {
  alg: 'ed25519';
  publicKey: string;
  label?: string;
}
