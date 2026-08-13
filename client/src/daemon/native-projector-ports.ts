import type { ProjectorPortsInput } from './projector-ports.js';

/**
 * Exact public-record and decision-grade verdict ports owned by the B6/B7 native publishers.
 * This seam deliberately cannot synthesize bridge records or weaken a failed verdict gate.
 */
export interface NativeProjectorExactPorts {
  readonly resolveRecord: ProjectorPortsInput['resolveRecord'];
  readonly verifyVerdictObservation: ProjectorPortsInput['verifyVerdictObservation'];
  /**
   * HTTP-first delivery-content resolution over the configured record-source locations, digest
   * verified (undefined on any miss). Native deliveries are HTTP-served and may never reach the
   * IPFS gateway the projector otherwise queries, so without this the today-mode delivery
   * correspondence that CP7 adopt reads never resolves. Composition layers the IPFS gateway after
   * it; absent leaves the projector on the IPFS-only path (the legacy composition has no record
   * source).
   */
  readonly resolveDeliveryBytes?: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;
  /**
   * Defect #48, Gate C. Content addresses this operator holds a SIGNED record-plane statement for,
   * newest first, capped at `limit`.
   *
   * Today-generation `SolutionDeliveryClaimed` carries no digest and the coordinator stores only
   * the keccak evidence hash, so a requester has no content address to key `resolveDeliveryBytes`
   * off. This is the catalog it keys off instead: each candidate is fetched through the
   * digest-verified resolver above and kept only when its keccak equals the coordinator's own
   * anchor for the attempt (see `buildRecordPlaneSolutionDeliveryPort`). The catalog is therefore
   * a HINT — every entry is untrusted until that anchor check passes — which is why an over-broad
   * or stale catalog can only cost fetches, never admit a wrong record.
   *
   * Newest-first ordering is the whole performance story: the Delivery being claimed is normally
   * the most recently announced record, so the common case terminates on the first candidate.
   * Absent leaves the requester leg off entirely (the reducer's mech-fact requirement stands).
   */
  readonly listRecordPlaneDigests?: (limit: number) => readonly `sha256:${string}`[];
}

export function assertNativeProjectorExactPorts(
  ports: NativeProjectorExactPorts | undefined,
): asserts ports is NativeProjectorExactPorts {
  if (
    ports === undefined
    || typeof ports.resolveRecord !== 'function'
    || typeof ports.verifyVerdictObservation !== 'function'
  ) {
    throw new Error(
      'native operator boot requires exact public solution/evaluation record resolution and the decision-grade verdict gate',
    );
  }
}
