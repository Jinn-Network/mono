/**
 * ValidationRegistryClient — typed wrapper for the ERC-8004 ValidationRegistry
 * contract.
 *
 * Phase 1b challenge mechanism. Per
 * `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` §4.4,
 * Jinn challenges are anchored on the deployed `0x8004…` ValidationRegistry
 * keyed by `(validatorAddress, agentId, requestHash)` where
 * `requestHash = manifest.evidenceHash` — the same 32-byte hash JinnRouter
 * already commits in `claimDelivery`. No new contracts are deployed; this
 * client wraps the existing UUPS proxy.
 *
 * Wire shape (from /tmp/erc8004-ref/ValidationRegistryUpgradeable.sol):
 *   - validationRequest(validator, agentId, requestURI, requestHash) — only
 *     the agent owner / approved / operator can submit; reverts on duplicate
 *     `requestHash`.
 *   - validationResponse(requestHash, response, responseURI, responseHash, tag)
 *     — only the validator named in the request may respond; `response` is a
 *     0..100 score.
 *   - getValidationStatus(requestHash) returns
 *     (validator, agentId, response, responseHash, tag, lastUpdate). The
 *     contract reverts on unknown `requestHash`.
 *   - getAgentValidations(agentId) → bytes32[]
 *   - getValidatorRequests(validator) → bytes32[]
 *
 * This module is intentionally **not wired into the daemon, evaluator, or CLI**.
 * The UX of the challenge mechanism (who calls `requestValidation`, when, with
 * what UI, with what validator-selection model) is a separate Phase 1b spec.
 * This file ships the typed client; downstream beads consume it.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

// ── ABI ──────────────────────────────────────────────────────────────────────
//
// Minimal slice of `subgraph/abis/ValidationRegistry.json`. Only the surfaces
// this client touches are mirrored here, to keep the typed-ABI inference
// tight and avoid drift if the full ABI is regenerated. Cross-checked against
// `/tmp/erc8004-ref/ValidationRegistryUpgradeable.sol` (canonical
// erc-8004/erc-8004-contracts).

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

// ── Address book ─────────────────────────────────────────────────────────────
//
// Source of truth: `subgraph/networks.json` (populated by `jinn-mono-fud` and
// cross-checked against the canonical
// `erc-8004/erc-8004-contracts@0463311…` reference). The vanity `0x8004…`
// addresses are paired across mainnets and their respective testnets.

export const VALIDATION_REGISTRY_ADDRESSES: Record<number, Address> = {
  // Base mainnet
  8453: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
  // Base Sepolia
  84532: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
  // Ethereum mainnet (shares Base mainnet vanity)
  1: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
  // Sepolia (shares Base Sepolia vanity)
  11155111: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
};

// ── Types ────────────────────────────────────────────────────────────────────

export type ValidationStatus = 'REQUESTED' | 'RESPONDED';

export interface ValidationRecord {
  /** Same 32-byte hash committed by JinnRouter as `evidenceHash`. */
  requestHash: Hex;
  validatorAddress: Address;
  agentId: bigint;
  /**
   * The `requestURI` provided at request time. NOTE: the deployed contract
   * does not persist `requestURI` in storage — it appears only in the
   * `ValidationRequest` event. This field is therefore left as an empty
   * string when read back via `getStatus`; callers that need the URI must
   * recover it from the indexed event log. Documented here so call sites
   * don't accidentally rely on a value that round-trips through storage.
   */
  requestURI: string;
  status: ValidationStatus;
  /** uint8 0..100. Present only when `status === 'RESPONDED'`. */
  response?: number;
  /** Same caveat as requestURI: only present in events, not in storage. */
  responseURI?: string;
  responseHash?: Hex;
  tag?: string;
}

export interface ValidationRegistryConfig {
  validationRegistryAddress: Address;
  /** Required for every read path. */
  publicClient: PublicClient;
  /** Required for write paths (`requestValidation`, `submitResponse`). */
  walletClient?: WalletClient;
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

// ── Client ───────────────────────────────────────────────────────────────────

export class ValidationRegistryClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | undefined;
  private readonly contractAddress: Address;

  constructor(config: ValidationRegistryConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contractAddress = config.validationRegistryAddress;
  }

  // ── Write methods ──────────────────────────────────────────────────────────

  /**
   * Submit a challenge — `validationRequest(validator, agentId, requestURI, requestHash)`.
   *
   * `requestHash` MUST equal `manifest.evidenceHash` (the same 32-byte hash
   * JinnRouter committed in `claimDelivery`); see DR §4.4. The contract
   * enforces uniqueness on `requestHash`, so duplicate calls revert.
   *
   * **Validator selection is open** at the contract level: any address may
   * be passed as `validatorAddress`, and any caller authorised by the agent
   * NFT (owner / approved / operator-for-all) may submit a request. Whether
   * Jinn imposes an additional gating layer (whitelist, stake, randomized
   * pool) is **deferred to a follow-up Phase 1b spec** and not enforced
   * here.
   *
   * The agent-NFT permission check inside the contract means the caller's
   * EOA / Safe must be authorised on `agentId` via `IdentityRegistry`
   * (owner, getApproved, or isApprovedForAll). Callers should ensure this
   * upstream — e.g. the operator submits requests against their own
   * agentId.
   *
   * Returns the transaction hash. Caller is responsible for waiting on the
   * receipt if they need confirmation semantics (kept off this path so the
   * client is reusable from both EOA-direct and Safe-wrapped contexts —
   * higher layers add the appropriate retry/confirm helper).
   */
  async requestValidation(args: {
    validatorAddress: Address;
    agentId: bigint;
    requestURI: string;
    requestHash: Hex;
  }): Promise<Hex> {
    const wallet = this.requireWallet('requestValidation');
    const account = wallet.account;
    if (!account) {
      throw new Error('[ValidationRegistryClient] walletClient has no account');
    }

    return wallet.writeContract({
      address: this.contractAddress,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'validationRequest',
      args: [args.validatorAddress, args.agentId, args.requestURI, args.requestHash],
      account,
      chain: wallet.chain ?? null,
    });
  }

  /**
   * Submit a response — `validationResponse(requestHash, response, responseURI,
   * responseHash, tag)`.
   *
   * Validators only. The contract checks `msg.sender === validatorAddress`
   * and `response <= 100`. Callers must use the wallet that was named as
   * `validatorAddress` in the matching `requestValidation` call.
   */
  async submitResponse(args: {
    requestHash: Hex;
    /** uint8 0..100 score. */
    response: number;
    responseURI: string;
    responseHash: Hex;
    tag: string;
  }): Promise<Hex> {
    if (!Number.isInteger(args.response) || args.response < 0 || args.response > 100) {
      throw new Error(
        `[ValidationRegistryClient] response must be an integer in [0, 100]; got ${args.response}`,
      );
    }

    const wallet = this.requireWallet('submitResponse');
    const account = wallet.account;
    if (!account) {
      throw new Error('[ValidationRegistryClient] walletClient has no account');
    }

    return wallet.writeContract({
      address: this.contractAddress,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'validationResponse',
      args: [
        args.requestHash,
        args.response,
        args.responseURI,
        args.responseHash,
        args.tag,
      ],
      account,
      chain: wallet.chain ?? null,
    });
  }

  // ── Read methods ───────────────────────────────────────────────────────────

  /**
   * Fetch the current validation status for a given `requestHash`.
   *
   * Returns `null` if no request has been recorded for that hash. The
   * deployed contract reverts (`"unknown"`) on unknown hashes; we catch and
   * map that to `null` so callers can treat "not found" as a value rather
   * than an exception.
   *
   * `requestURI` and `responseURI` are not persisted in contract storage —
   * they appear only in the `ValidationRequest` / `ValidationResponse`
   * events. The returned record therefore leaves `requestURI` empty and
   * omits `responseURI`; callers that need them must read the indexed
   * events.
   */
  async getStatus(requestHash: Hex): Promise<ValidationRecord | null> {
    let raw: readonly [Address, bigint, number, Hex, string, bigint];
    try {
      raw = (await this.publicClient.readContract({
        address: this.contractAddress,
        abi: VALIDATION_REGISTRY_ABI,
        functionName: 'getValidationStatus',
        args: [requestHash],
      })) as readonly [Address, bigint, number, Hex, string, bigint];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unknown')) return null;
      throw err;
    }

    const [validatorAddress, agentId, response, responseHash, tag /*, lastUpdate */] = raw;

    if (validatorAddress === ZERO_ADDRESS) return null;

    // Contract initialises responseHash=0 / tag="" until the validator
    // responds; a non-zero responseHash OR a non-empty tag both indicate
    // a response has landed (the validator may legitimately submit
    // responseHash=0 with a non-empty tag, or vice versa). The
    // `lastUpdate` block-timestamp also moves on response, but we treat
    // the storage fields as the authoritative signal.
    const hasResponded = responseHash !== ZERO_BYTES32 || tag !== '';

    if (!hasResponded) {
      return {
        requestHash,
        validatorAddress,
        agentId,
        requestURI: '',
        status: 'REQUESTED',
      };
    }

    return {
      requestHash,
      validatorAddress,
      agentId,
      requestURI: '',
      status: 'RESPONDED',
      response,
      responseHash,
      tag,
    };
  }

  /**
   * All `requestHash` values ever filed against `agentId`. Order is
   * insertion order from contract storage (per
   * `_agentValidations[agentId]`).
   */
  async getAgentValidations(agentId: bigint): Promise<Hex[]> {
    const result = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'getAgentValidations',
      args: [agentId],
    })) as readonly Hex[];
    return [...result];
  }

  /**
   * All `requestHash` values ever assigned to `validatorAddress`. Order is
   * insertion order from contract storage (per
   * `_validatorRequests[validator]`).
   */
  async getValidatorRequests(validatorAddress: Address): Promise<Hex[]> {
    const result = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'getValidatorRequests',
      args: [validatorAddress],
    })) as readonly Hex[];
    return [...result];
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private requireWallet(method: string): WalletClient {
    if (!this.walletClient) {
      throw new Error(
        `[ValidationRegistryClient] ${method} requires a walletClient; ` +
          `pass one via ValidationRegistryConfig.walletClient.`,
      );
    }
    return this.walletClient;
  }
}
