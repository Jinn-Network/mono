import type { ProjectorPortsInput } from './projector-ports.js';

/**
 * Exact public-record and decision-grade verdict ports owned by the B6/B7 native publishers.
 * This seam deliberately cannot synthesize bridge records or weaken a failed verdict gate.
 */
export interface NativeProjectorExactPorts {
  readonly resolveRecord: ProjectorPortsInput['resolveRecord'];
  readonly verifyVerdictObservation: ProjectorPortsInput['verifyVerdictObservation'];
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
