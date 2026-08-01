import type { AnnouncementRecordMaterial, ObservationMarketplaceEvent } from '@jinn-network/marketplace-projector';
import {
  gateVerdictObservation,
  type VerdictObservationGate,
  type VerdictObservationGateInput,
  type VerdictObservationGatePorts,
} from '@jinn-network/marketplace-binding';
import type { BindingResolver, DsseChainVerifier, WitnessVerifier } from '@jinn-network/trust-core';
import type { AssembledVerdictPolicies } from '../trust/policy-assembly.js';

export interface VerdictGateDeps {
  readonly policies: AssembledVerdictPolicies;
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
}

/**
 * The host side of the decision-grade verdict gate: it owns policy assembly and dependency
 * injection only. Every check lives in the binding (`gateVerdictObservation`); nothing here
 * re-implements one, and the gate never touches the on-chain settlement transaction
 * (binding §6.4 — today-mode on-chain finalization stays advisory).
 */
export function createVerdictGate(deps: VerdictGateDeps): {
  gate(input: VerdictObservationGateInput): Promise<VerdictObservationGate>;
} {
  const ports: VerdictObservationGatePorts = {
    bindingResolver: deps.bindingResolver,
    witnessVerifier: deps.witnessVerifier,
    dsseVerifier: deps.dsseVerifier,
    admissionAgentPolicy: deps.policies.admissionAgentPolicy,
    ...(deps.policies.evaluatorPolicy === undefined ? {} : { evaluatorPolicy: deps.policies.evaluatorPolicy }),
    ...(deps.policies.requesterPolicy === undefined ? {} : { requesterPolicy: deps.policies.requesterPolicy }),
  };
  return { gate: (input) => gateVerdictObservation(input, ports) };
}

/** Projector port backed by the assembled verdict gate (fail-closed until input derivation lands). */
export function buildVerifyVerdictObservationPort(
  _gate: ReturnType<typeof createVerdictGate>,
): (
  event: Extract<ObservationMarketplaceEvent, { event: 'VerdictDeliveryClaimed' }>,
  material: AnnouncementRecordMaterial,
) => Promise<{
  readonly gate: VerdictObservationGate;
  readonly statementVerdict?: 'pass' | 'fail' | 'inconclusive';
}> {
  return async (_event, _material) => ({
    gate: {
      decisionGrade: false,
      failures: [{
        check: 'verdict-observation-verifier',
        detail: 'event-to-gate input derivation is not wired for this observation yet',
      }],
    },
  });
}
