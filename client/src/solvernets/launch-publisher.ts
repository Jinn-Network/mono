/**
 * Launch-path publisher helpers that outlive the ERC-8004 registry client.
 *
 * Wave-4 D4 deleted `registry-client.ts` / `registry-client-erc8004.ts` (the
 * catalog + `publishManifest` producer). The launch state machine still pins
 * a canonical manifest to IPFS and broadcasts `IdentityRegistry.setMetadata`
 * via `MetadataPublisher.setMetadata` — those lower-level deps lived next to
 * the retired client and move here so launch recovery keeps working.
 *
 * The lifecycle WIRE VOCABULARY (`encodeLifecyclePayload`,
 * `SOLVERNET_MANIFEST_KEY_PREFIX`, `LIFECYCLE_PAYLOAD_SCHEMA_VERSION`) stays
 * because Wave-4 D3 retired the producer, not the on-wire shape.
 */

import { canonicalJson } from '../util/canonical-json.js';
import type {
  SetMetadataEvent,
  SetMetadataLifecyclePayload,
} from './most-recent-wins.js';

/**
 * Minimal "ready to sign" handle for the launcher's agent EOA. Held by the
 * launch state machine to (a) sign manifests via `signManifest` and
 * (b) send the on-chain `setMetadata` tx that anchors the manifest CID.
 */
export interface SignerWithAgentEoa {
  agentEoaAddress: `0x${string}`;
  agentEoaPrivateKey: `0x${string}`;
  agentId: string;
}

/**
 * Metadata-key prefix for SolverNet manifest anchors. The full key is
 * `solvernet-manifest:<cid>`; the prefix alone is what we hand to the
 * subgraph for `LIKE 'solvernet-manifest:%'` filtering.
 */
export const SOLVERNET_MANIFEST_KEY_PREFIX = 'solvernet-manifest:';

/**
 * Schema version embedded in every lifecycle payload. Keep in sync with
 * spec §6.3.
 */
export const LIFECYCLE_PAYLOAD_SCHEMA_VERSION = 'solvernet.lifecycle.v1';

/**
 * IPFS surface used by the launch state machine. Two methods, content-addressed.
 */
export interface IpfsClient {
  upload(data: unknown): Promise<string>;
  fetch(cid: string): Promise<unknown>;
}

/**
 * Result of a single `setMetadata` write.
 */
export interface SetMetadataPublishResult {
  txHash: `0x${string}`;
  blockNumber: number;
}

/**
 * Abstract handle for publishing `IdentityRegistry.setMetadata` writes.
 * SolverNet lifecycle payloads are JCS-canonical JSON bytes.
 */
export interface MetadataPublisher {
  setMetadata(args: {
    signer: SignerWithAgentEoa;
    agentId: string;
    key: string;
    value: Uint8Array;
  }): Promise<SetMetadataPublishResult>;
}

/**
 * Subgraph surface used by launch recovery (mempool-drop detection).
 */
export interface SubgraphClient {
  fetchSetMetadataEvents(args: {
    keyPrefix: string;
    sinceBlock?: number;
  }): Promise<SetMetadataEvent[]>;

  fetchSetMetadataEventsForCid(args: {
    manifestCid: string;
  }): Promise<SetMetadataEvent[]>;
}

/**
 * Encode a lifecycle payload into JCS-canonical UTF-8 JSON bytes — the on-wire
 * format passed to `IdentityRegistry.setMetadata` for `solvernet.lifecycle.v1`.
 */
export function encodeLifecyclePayload(payload: SetMetadataLifecyclePayload): Uint8Array {
  return new TextEncoder().encode(canonicalJson(payload));
}
