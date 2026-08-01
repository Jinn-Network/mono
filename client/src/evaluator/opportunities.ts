import type { ObservationMarketplaceEvent } from '@jinn-network/marketplace-projector';
import {
  selfEvaluationSkip,
  type EvaluationSkipReason,
  type OperatorIdentity,
} from './self-evaluation.js';

export interface EvaluationOpportunity {
  readonly chainId: number;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly solutionRequestId: `0x${string}`;
  readonly operatorAddress: string;
  readonly deliveryCid: string;
  readonly blockHash: `0x${string}`;
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Reconstructs the canonical raw-codec CIDv1 for a known sha256 digest (binding `computeRawCodecCid`). */
function rawCodecCidFromSha256Digest(digest: `sha256:${string}`): string {
  const digestHex = digest.slice('sha256:'.length);
  const multihash = new Uint8Array(4 + 32);
  multihash[0] = 0x01;
  multihash[1] = 0x55;
  multihash[2] = 0x12;
  multihash[3] = 0x20;
  multihash.set(hexToBytes(digestHex), 4);
  return `b${base32Encode(multihash)}`;
}

function resolveDeliveryCid(event: ObservationMarketplaceEvent): string | undefined {
  const correspondenceDigest = event.projection.deliveryCorrespondence?.sha256Digest;
  if (correspondenceDigest !== undefined) {
    return rawCodecCidFromSha256Digest(correspondenceDigest);
  }
  const facts = event.facts as { deliveryDigest?: `0x${string}` };
  if (facts.deliveryDigest !== undefined) {
    return rawCodecCidFromSha256Digest(`sha256:${facts.deliveryDigest.slice(2)}`);
  }
  return undefined;
}

/**
 * Evaluation opportunities are delivery announcements (binding §6.4) — the projector's
 * SolutionDeliveryClaimed observations, not a bespoke log scan. The operator's own solutions
 * are dropped here, before any material fetch.
 */
export function createOpportunitySource(deps: {
  readonly subscribeObservations: (handler: (event: ObservationMarketplaceEvent) => void) => () => void;
  readonly identity: OperatorIdentity;
  readonly onSkip?: (reason: EvaluationSkipReason, taskId: bigint, attemptIndex: number) => void;
}): { subscribe(handler: (opportunity: EvaluationOpportunity) => void): () => void } {
  return {
    subscribe(handler) {
      return deps.subscribeObservations((event) => {
        if (event.event !== 'SolutionDeliveryClaimed') return;
        const facts = event.facts as {
          taskId: bigint;
          attemptIndex: number;
          requestId: `0x${string}`;
          operator: string;
        };
        const skip = selfEvaluationSkip(deps.identity, { operatorAddress: facts.operator });
        if (skip !== undefined) {
          deps.onSkip?.(skip, facts.taskId, facts.attemptIndex);
          return;
        }
        const deliveryCid = resolveDeliveryCid(event);
        if (deliveryCid === undefined) return;
        handler({
          chainId: event.derivation.chainId,
          taskId: facts.taskId,
          attemptIndex: facts.attemptIndex,
          solutionRequestId: facts.requestId,
          operatorAddress: facts.operator,
          deliveryCid,
          blockHash: event.derivation.blockHash,
        });
      });
    },
  };
}
