// JinnManifest — the signed package manifest each external impl ships.
// See `spec/2026-05-executor-trust-boundary.md` §5.

export interface CapabilityAllowEntry {
  chainId: number;
  to: `0x${string}`;
  selector: `0x${string}`;
  description?: string;
}

/**
 * EIP-712 typed-data domain allow-list entry.
 *
 * The daemon's scoped signer refuses any `signTypedData` call whose
 * domain does not match one of these entries:
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

export interface ManifestSecretSpec {
  name: string;
  description: string;
  required: boolean;
}

export interface JinnManifest {
  schemaVersion: '1.0.0';
  name: string;
  version: string;
  description?: string;
  /** Each entry follows `<domain>.v<major>(>=<semver>)` from spec/2026-05-schema-versioning.md */
  supportedKinds: readonly string[];
  /** Path to the entrypoint module, relative to the package root. */
  entry: string;
  /** Tarball CID + sha256 (set at publish time). */
  package: { cid: string; hash: `sha256:${string}` };
  capabilities: {
    signer?: {
      selectors: ReadonlyArray<CapabilityAllowEntry>;
      typedDataDomains?: ReadonlyArray<TypedDataAllowEntry>;
    };
    rpc?: ReadonlyArray<ManifestRpcAllow>;
    secrets?: ReadonlyArray<ManifestSecretSpec>;
  };
  /** Detached signature object — not part of the canonicalised manifest. */
  signature: {
    alg: 'ed25519';
    publicKey: string; // base64
    sig: string; // base64
  };
  author?: { name: string; url?: string };
  license?: string;
}
