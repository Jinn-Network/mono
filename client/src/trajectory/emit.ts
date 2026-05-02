/**
 * Emit a signed jinn.trajectory.v1 blob and upload it to IPFS.
 *
 * Signing mirrors envelope-assembly.ts (§4.2a mechanics):
 *   hash = keccak256(JCS(trajectory minus signature))
 *   → signed with agent EOA key
 *   → signed blob uploaded to IPFS
 *   → { cid, sha256 } returned for the envelope.
 */

import { createHash } from 'node:crypto';
import { keccak256, toBytes, type Hex } from 'viem';
import { signCanonical } from '../harnesses/engine/signing.js';
import { canonicalJson } from '../harnesses/engine/canonical-json.js';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';
import type { TrajectoryCollector } from './collector.js';
import type { JinnTrajectoryV1 } from './schema.js';

export interface EmitTrajectoryParams {
  collector: TrajectoryCollector;
  runId: string;
  /** Set to the parent restoration envelope CID for a verdict trajectory; null otherwise. */
  parentEnvelopeCid?: string | null;
  signerPrivateKey: Hex;
  signerAddress: `0x${string}`;
  ipfsRegistryUrl: string;
}

export interface EmitTrajectoryResult {
  cid: string;
  sha256: string;
  signed: JinnTrajectoryV1;
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

export async function emitTrajectory(
  p: EmitTrajectoryParams,
): Promise<EmitTrajectoryResult> {
  const snap = p.collector.snapshot();
  const unsigned = {
    schemaVersion: 'jinn.trajectory.v1' as const,
    runId: p.runId,
    parentEnvelopeCid: p.parentEnvelopeCid ?? null,
    spans: snap.spans,
    redactionManifest: snap.redactionManifest,
  };

  const sig = await signCanonical(unsigned, p.signerPrivateKey, p.signerAddress);

  const signed: JinnTrajectoryV1 = {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: p.signerAddress,
      hash: sig.hash as Hex,
      sig: sig.sig as Hex,
    },
  };

  const serialized = JSON.stringify(signed);
  const sha256 = sha256Hex(serialized);
  const cid = await uploadToIpfs(p.ipfsRegistryUrl, signed);

  return { cid, sha256, signed };
}
