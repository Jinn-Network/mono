// SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------
// ABI constants for the on-chain reads `trust-resolve` performs. Copied
// from `client/src/erc8004/abis.ts` (`IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI`)
// plus the standard ERC-721 `ownerOf` and EIP-1271 `isValidSignature`
// fragments this tree additionally needs (§7.2/§7.2a).
// ---------------------------------------------------------------------------

/** ERC-8004 IdentityRegistry -- publisher-agent Safe binding read (§7.2's
 * agentId composition leg: `getAgentWallet`-at-block). */
export const IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI = [
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** Standard ERC-721 `ownerOf` -- the CAIP-19 agent asset's on-chain owner
 * (§7.2's registry-fact half of the agentId composition leg). */
export const ERC721_OWNER_OF_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** EIP-1271 `isValidSignature` -- the archive re-execution fallback for a
 * Safe-ceremony's 1271 witness (§7.2a). */
export const ERC1271_IS_VALID_SIGNATURE_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

/** EIP-1271's expected magic-value return for a valid signature. */
export const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;
