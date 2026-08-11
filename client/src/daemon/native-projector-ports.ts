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
