/**
 * Shared ABI table for the three ERC-8004 registries Jinn touches.
 *
 * Minimal slices of the deployed contract ABIs — only the surfaces the
 * consolidated clients actually call. Cross-checked against:
 *   - `/tmp/erc8004-ref/IdentityRegistryUpgradeable.sol`
 *   - `/tmp/erc8004-ref/ReputationRegistryUpgradeable.sol`
 *   - `/tmp/erc8004-ref/ValidationRegistryUpgradeable.sol`
 *
 * Keep the slices tight: typed-ABI inference from viem/abitype is what makes
 * the client surface stay sharp, and full ABIs widen the inferred types
 * unnecessarily.
 */

// ── IdentityRegistry ──────────────────────────────────────────────────────────

/** Canonical v1 ABI tuple for per-execution payloads. See payload-schema §3.1. */
export const PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'tier', type: 'uint8' },
  { name: 'manifestHash', type: 'bytes32' },
  { name: 'attestationQuoteCid', type: 'bytes' },
  { name: 'sourceMeasurement', type: 'bytes32' },
] as const;

/**
 * Canonical v2 ABI tuple for per-execution payloads.
 *
 * Append-not-reorder per payload-schema §3 — the first five fields keep their
 * v1 semantics + offsets so a v1 prefix decode still finds them. The trailing
 * three fields surface harness identity to the subgraph indexer:
 *
 *   - `codeDigest`: 32-byte raw bytes of the executor's implStateDir hash
 *     (NOT the textual `sha256:` prefix). Empty bytes32 when not produced.
 *   - `implName`: harness implementation name, e.g. "claude-code-learner".
 *     Empty string when not produced.
 *   - `modeFlag`: 0 = train, 1 = frozen. Aligned with HarnessExecutionMode in
 *     the off-chain SignedEnvelope.
 *
 * See `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §6
 * (executor.mode + codeDigest) and `docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md`.
 */
export const PAYLOAD_TUPLE_V2 = [
  { name: 'version', type: 'uint8' },
  { name: 'tier', type: 'uint8' },
  { name: 'manifestHash', type: 'bytes32' },
  { name: 'attestationQuoteCid', type: 'bytes' },
  { name: 'sourceMeasurement', type: 'bytes32' },
  { name: 'codeDigest', type: 'bytes32' },
  { name: 'implName', type: 'string' },
  { name: 'modeFlag', type: 'uint8' },
] as const;

/** ERC-8004 IdentityRegistry — only the function the publisher calls. */
export const IDENTITY_REGISTRY_SET_METADATA_ABI = [
  {
    type: 'function',
    name: 'setMetadata',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// ── ReputationRegistry ────────────────────────────────────────────────────────
//
// `giveFeedback` takes `value: int128, valueDecimals: uint8` (signed
// fixed-point), not `score: uint8`. The higher-level surface exposes a
// numeric-friendly `score` parameter.

export const REPUTATION_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'appendResponse',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'readFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'readAllFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'includeRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'clients', type: 'address[]' },
      { name: 'feedbackIndexes', type: 'uint64[]' },
      { name: 'values', type: 'int128[]' },
      { name: 'valueDecimals', type: 'uint8[]' },
      { name: 'tag1s', type: 'string[]' },
      { name: 'tag2s', type: 'string[]' },
      { name: 'revokedStatuses', type: 'bool[]' },
    ],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
] as const;

// ── ValidationRegistry ────────────────────────────────────────────────────────

export const VALIDATION_REGISTRY_ABI = [
  // ── Write functions ──────────────────────────────────────────────────────────
  {
    name: 'validationRequest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'requestURI', type: 'string' },
      { name: 'requestHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'validationResponse',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestHash', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
    ],
    outputs: [],
  },

  // ── Read functions ──────────────────────────────────────────────────────────
  {
    name: 'getValidationStatus',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestHash', type: 'bytes32' }],
    outputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'response', type: 'uint8' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
      { name: 'lastUpdate', type: 'uint256' },
    ],
  },
  {
    name: 'getAgentValidations',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    name: 'getValidatorRequests',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'validatorAddress', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },

  // ── Events (kept for parity with the deployed ABI; consumers may decode
  //   logs directly with this fragment). ───────────────────────────────────────
  {
    type: 'event',
    name: 'ValidationRequest',
    inputs: [
      { name: 'validatorAddress', type: 'address', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'requestURI', type: 'string', indexed: false },
      { name: 'requestHash', type: 'bytes32', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ValidationResponse',
    inputs: [
      { name: 'validatorAddress', type: 'address', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'requestHash', type: 'bytes32', indexed: true },
      { name: 'response', type: 'uint8', indexed: false },
      { name: 'responseURI', type: 'string', indexed: false },
      { name: 'responseHash', type: 'bytes32', indexed: false },
      { name: 'tag', type: 'string', indexed: false },
    ],
  },
] as const;
