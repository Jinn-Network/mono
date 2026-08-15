/**
 * ERC-8004 plug-in registry surface (jinn-mono-1pbc).
 *
 * Plug-in records are anchored on the existing `IdentityRegistry.setMetadata`
 * write surface — there is NO new contract. The builder's agentId is the
 * subject; the metadataKey is `plugin:<pluginCid>`; the value is ABI-encoded
 * per the `PLUGIN_PAYLOAD_TUPLE` (or, for revocations, the
 * `REVOCATION_PAYLOAD_TUPLE`) declared in `./abis.js`.
 *
 * This is a BUILDER action, not an operator action: it accrues against the
 * fleet's Stage 1 identity Safe (`fleet_safe_address`), and never touches
 * Stage 2 (OLAS service / staking) state. The CLI verb that wraps this
 * publisher (`jinn solver-plugins publish`) lazily runs
 * `FleetBootstrapper.ensureStage1(password)` before any chain write so a
 * builder can complete the full publish flow without ever standing up a
 * Stage 2 service.
 *
 * See `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md`
 * §5.2 ("Plug-in registry = a new `kind=plugin` on `IdentityRegistry.setMetadata`")
 * and §6.3 ("Plug-in publication: `jinn solver-plugins publish`").
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { executeSafeTransaction, type VenueBroadcaster } from '../adapters/mech/safe.js';
import { waitForTransactionReceiptWithRetry } from '../tx-retry.js';
import {
  IDENTITY_REGISTRY_SET_METADATA_ABI,
  PLUGIN_PAYLOAD_TUPLE,
  REVOCATION_PAYLOAD_TUPLE,
} from './abis.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Plug-in publication payload (spec §5.2). */
export interface PluginPayload {
  /** Schema version (= 1 for this kind). */
  version: 1;
  /** npm package name, e.g. "@builder/swe-skill". Non-empty. */
  pluginName: string;
  /** Semver, e.g. "0.1.0". Non-empty. */
  pluginVersion: string;
  /** 32-byte hex digest of the packed tarball (`digestDirectory` output). */
  pluginSha256: Hex;
  /** SolverType ids — must include at least one (e.g. "swe-rebench-v2.v1"). */
  supports: string[];
  /** Unix seconds. Must fit in uint64. */
  publishedAt: number;
}

/** Plug-in revocation payload (spec §5.2 "Revocation"). */
export interface RevocationPayload {
  /** Schema version (= 2 for the revocation marker). */
  version: 2;
  /** Always `true` — a revocation cannot un-revoke; publish a new CID instead. */
  revoked: true;
  /** Non-empty human-readable reason (e.g. "security advisory CVE-2026-…"). */
  reason: string;
}

export class PluginPayloadValidationError extends Error {
  constructor(reason: string) {
    super(`plugin payload validation failed: ${reason}`);
    this.name = 'PluginPayloadValidationError';
  }
}

// ── Validators ───────────────────────────────────────────────────────────────

const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

export function validatePluginPayload(payload: PluginPayload): PluginPayload {
  if (payload.version !== 1) {
    throw new PluginPayloadValidationError(`version must be 1, got ${payload.version}`);
  }
  if (typeof payload.pluginName !== 'string' || payload.pluginName.length === 0) {
    throw new PluginPayloadValidationError('pluginName must be a non-empty string');
  }
  if (typeof payload.pluginVersion !== 'string' || payload.pluginVersion.length === 0) {
    throw new PluginPayloadValidationError('pluginVersion must be a non-empty string');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.pluginSha256)) {
    throw new PluginPayloadValidationError(
      `pluginSha256 must be 32-byte hex (0x + 64 hex chars)`,
    );
  }
  if (!Array.isArray(payload.supports) || payload.supports.length === 0) {
    throw new PluginPayloadValidationError('supports must be a non-empty string[]');
  }
  for (const s of payload.supports) {
    if (typeof s !== 'string' || s.length === 0) {
      throw new PluginPayloadValidationError('supports entries must be non-empty strings');
    }
  }
  if (!Number.isInteger(payload.publishedAt) || payload.publishedAt < 0) {
    throw new PluginPayloadValidationError(
      `publishedAt must be a non-negative integer; got ${payload.publishedAt}`,
    );
  }
  if (BigInt(payload.publishedAt) > MAX_UINT64) {
    throw new PluginPayloadValidationError(
      `publishedAt exceeds uint64 range; got ${payload.publishedAt}`,
    );
  }
  return payload;
}

export function validateRevocationPayload(payload: RevocationPayload): RevocationPayload {
  if (payload.version !== 2) {
    throw new PluginPayloadValidationError(`revocation version must be 2, got ${payload.version}`);
  }
  if (payload.revoked !== true) {
    throw new PluginPayloadValidationError('revocation payloads must set revoked=true');
  }
  if (typeof payload.reason !== 'string' || payload.reason.length === 0) {
    throw new PluginPayloadValidationError('revocation reason must be a non-empty string');
  }
  return payload;
}

// ── Encoders ─────────────────────────────────────────────────────────────────

export function encodePluginPayload(payload: PluginPayload): Hex {
  validatePluginPayload(payload);
  return encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
    payload.version,
    payload.pluginName,
    payload.pluginVersion,
    payload.pluginSha256,
    payload.supports,
    BigInt(payload.publishedAt),
  ]);
}

export function encodeRevocationPayload(payload: RevocationPayload): Hex {
  validateRevocationPayload(payload);
  return encodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, [
    payload.version,
    payload.revoked,
    payload.reason,
  ]);
}

// ── Metadata key ─────────────────────────────────────────────────────────────

/**
 * Canonical prefix for plug-in metadata keys on the IdentityRegistry.
 * Duplicated as `PLUGIN_KEY_PREFIX` in packages/indexer/src/types.ts
 * (cross-package imports are not wired in this codebase).
 */
export const PLUGIN_METADATA_KEY_PREFIX = 'plugin:';

/** Build `plugin:<cid>` per spec §5.2. Never strips, never normalises. */
export function buildPluginMetadataKey(pluginCid: string): string {
  if (typeof pluginCid !== 'string' || pluginCid.length === 0) {
    throw new PluginPayloadValidationError('pluginCid must be a non-empty string');
  }
  return `${PLUGIN_METADATA_KEY_PREFIX}${pluginCid}`;
}

// ── Publisher ────────────────────────────────────────────────────────────────

export interface PluginRegistryPublisherConfig {
  identityRegistryAddress: Address;
  /** Builder's ERC-8004 agentId (= `fleet_agent_id` from FleetState). */
  builderAgentId: bigint;
  /** Stage 1 fleet identity Safe (= `fleet_safe_address`). Required. */
  safeAddress: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /**
   * The Safe broadcaster this publisher's writes route through (finding E16 / the C2 ruling: no
   * process-global — each CLI verb constructs its own, bound to `safeAddress`, e.g. via
   * `createDirectSafeBroadcaster`).
   */
  broadcaster: VenueBroadcaster;
}

export interface PublishPluginArgs {
  pluginCid: string;
  payload: PluginPayload;
}

export interface RevokePluginArgs {
  pluginCid: string;
  payload: RevocationPayload;
}

/**
 * High-level publisher for plug-in records.
 *
 * Routes writes through the operator's Stage 1 identity Safe via
 * `executeSafeTransaction`, mirroring `ReputationRegistryClient.sendWrite`'s
 * Safe-routed path. We require `safeAddress` (no direct-EOA escape hatch) —
 * the on-chain `msg.sender` must be the operator's canonical Stage 1 Safe
 * for the metadata write to bind to the right agentId owner.
 */
export class PluginRegistryPublisher {
  private readonly identityRegistryAddress: Address;
  private readonly builderAgentId: bigint;
  private readonly safeAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly broadcaster: VenueBroadcaster;

  constructor(config: PluginRegistryPublisherConfig) {
    this.identityRegistryAddress = config.identityRegistryAddress;
    this.builderAgentId = config.builderAgentId;
    this.safeAddress = config.safeAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.broadcaster = config.broadcaster;
  }

  get agentId(): bigint {
    return this.builderAgentId;
  }

  get safe(): Address {
    return this.safeAddress;
  }

  /** Publish a `plugin:<cid>` record. Returns the tx hash. */
  async publish(args: PublishPluginArgs): Promise<Hex> {
    const metadataKey = buildPluginMetadataKey(args.pluginCid);
    const metadataValue = encodePluginPayload(args.payload);
    return this._setMetadata(metadataKey, metadataValue);
  }

  /** Overwrite a `plugin:<cid>` record with a revoked-marker payload. */
  async revoke(args: RevokePluginArgs): Promise<Hex> {
    const metadataKey = buildPluginMetadataKey(args.pluginCid);
    const metadataValue = encodeRevocationPayload(args.payload);
    return this._setMetadata(metadataKey, metadataValue);
  }

  private async _setMetadata(metadataKey: string, metadataValue: Hex): Promise<Hex> {
    const calldata = encodeFunctionData({
      abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
      functionName: 'setMetadata',
      args: [this.builderAgentId, metadataKey, metadataValue],
    });

    const txHash = await executeSafeTransaction(this.publicClient, this.walletClient, {
      safeAddress: this.safeAddress,
      to: this.identityRegistryAddress,
      value: 0n,
      data: calldata,
    }, this.broadcaster);

    await waitForTransactionReceiptWithRetry(this.publicClient, txHash);
    return txHash;
  }
}
