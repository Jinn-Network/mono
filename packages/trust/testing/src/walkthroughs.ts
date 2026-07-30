// SPDX-License-Identifier: Apache-2.0

import {
  authenticateRequester,
  settlementJoinCheck,
  verifyEnvelopeBinding,
} from "@jinn-network/trust-core";
import type {
  AuthorizationStatement,
  RequesterAuthenticationOutcome,
  SettlementJoinOutcome,
  VerificationOutcome,
} from "@jinn-network/trust-core";

import type { FakeTrustResolvers } from "./fakes.js";
import {
  accountVoucher,
  buildAuthorizationFixture,
  buildResolvedBindingFixture,
  createEoaTestSigner,
  testAgentIri,
  testDidKey,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// The four §13 verification walkthroughs, as executable end-to-end
// integration fixtures (Task T16). Each function seeds a `FakeTrust-
// Resolvers` instance with the scenario's records and drives it through
// the real `@jinn-network/trust-core` procedures -- these are integration
// tests of the whole verification stack (core's procedures + the kit's
// fixtures), not unit tests of a single function.
// ---------------------------------------------------------------------------

const FAMILY = "verdicts";

// ---------------------------------------------------------------------------
// Walkthrough 1: old verdict after key rotation.
// ---------------------------------------------------------------------------

export interface OldVerdictAfterKeyRotationResult {
  readonly verdictOutcome: VerificationOutcome;
  readonly settlementJoin: SettlementJoinOutcome;
}

/**
 * "A 2026 verdict envelope is audited in 2028. The evaluator rotated
 * working keys twice since." Verification resolves the (2026 key,
 * evaluator IRI) pair at the envelope's OWN effective time (2026, not
 * the 2028 audit wall-clock) -- the superseded-but-then-valid binding;
 * ceremony content match, window, scope, consent chain (self-extension:
 * the same voucher account re-vouches each successive working key), and
 * absence of revocation all pass; the §7.5a join to the settling account
 * lands on the same Agent IRI.
 */
export async function runOldVerdictAfterKeyRotationWalkthrough(
  fakes: FakeTrustResolvers,
): Promise<OldVerdictAfterKeyRotationResult> {
  const evaluatorAgent = testAgentIri("walkthrough-rotation-evaluator");
  const evaluatorSigner = createEoaTestSigner("walkthrough-rotation-evaluator-account");
  const voucher = accountVoucher(84532, evaluatorSigner.address);

  const key2026 = testDidKey("walkthrough-rotation-key-2026");
  const binding2026 = await buildResolvedBindingFixture({
    agent: evaluatorAgent,
    workingKeyDidKey: key2026,
    ceremonyType: "eoa",
    voucher,
    eoaCeremony: { signer: evaluatorSigner, chainId: 84532 },
    validFrom: "2026-01-01T00:00:00.000Z",
    scope: ["verdicts"],
    isGenesis: true,
  });
  fakes.registerBinding({
    key: key2026,
    agent: evaluatorAgent,
    resolved: binding2026.resolved,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2027-01-01T00:00:00.000Z", // superseded by the first rotation
  });

  const key2027 = testDidKey("walkthrough-rotation-key-2027");
  const binding2027 = await buildResolvedBindingFixture({
    agent: evaluatorAgent,
    workingKeyDidKey: key2027,
    ceremonyType: "eoa",
    voucher,
    eoaCeremony: { signer: evaluatorSigner, chainId: 84532 },
    validFrom: "2027-01-01T00:00:00.000Z",
    scope: ["verdicts"],
    isGenesis: false,
    incumbentControlVoucher: voucher, // self-extension: the same account re-vouches
  });
  fakes.registerBinding({
    key: key2027,
    agent: evaluatorAgent,
    resolved: binding2027.resolved,
    validFrom: "2027-01-01T00:00:00.000Z",
    validTo: "2028-01-01T00:00:00.000Z", // superseded by the second rotation
  });

  const key2028 = testDidKey("walkthrough-rotation-key-2028");
  const binding2028 = await buildResolvedBindingFixture({
    agent: evaluatorAgent,
    workingKeyDidKey: key2028,
    ceremonyType: "eoa",
    voucher,
    eoaCeremony: { signer: evaluatorSigner, chainId: 84532 },
    validFrom: "2028-01-01T00:00:00.000Z",
    scope: ["verdicts"],
    isGenesis: false,
    incumbentControlVoucher: voucher,
  });
  fakes.registerBinding({
    key: key2028,
    agent: evaluatorAgent,
    resolved: binding2028.resolved,
    validFrom: "2028-01-01T00:00:00.000Z",
  });

  // The settling account's own declaration, bound the same way and still
  // current (not revoked) at the 2028 audit/claim time.
  const settlementKey = testDidKey("walkthrough-rotation-settlement-key");
  const settlementBinding = await buildResolvedBindingFixture({
    agent: evaluatorAgent,
    workingKeyDidKey: settlementKey,
    ceremonyType: "eoa",
    voucher,
    eoaCeremony: { signer: evaluatorSigner, chainId: 84532 },
    validFrom: "2026-01-01T00:00:00.000Z",
    scope: ["verdicts"],
    isGenesis: false,
    incumbentControlVoucher: voucher,
  });
  fakes.registerBinding({
    key: settlementKey,
    agent: evaluatorAgent,
    resolved: settlementBinding.resolved,
    validFrom: "2026-01-01T00:00:00.000Z",
  });

  // The verdict envelope itself was sealed in 2026, by the 2026 key.
  const verdictEffectiveTime = "2026-06-01T00:00:00.000Z";
  const verdictOutcome = await verifyEnvelopeBinding(
    { envelopeBytes: binding2026.envelopeBytes, key: key2026, agent: evaluatorAgent, family: FAMILY, atTime: verdictEffectiveTime },
    { bindingResolver: fakes.bindingResolver, witnessVerifier: fakes.witnessVerifier, dsseVerifier: fakes.dsseVerifier },
  );

  const settlementJoin = await settlementJoinCheck(
    {
      verdictKey: key2026,
      settlementDeclarationKey: settlementKey,
      claimedEvaluatorAgent: evaluatorAgent,
      family: FAMILY,
      envelopeEffectiveTime: verdictEffectiveTime,
      claimTime: "2028-06-01T00:00:00.000Z", // the 2028 audit
    },
    { bindingResolver: fakes.bindingResolver },
  );

  return { verdictOutcome, settlementJoin };
}

// ---------------------------------------------------------------------------
// Walkthrough 2: open-fleet adoption settlement.
//
// Note (per the trust-layer plan): this exercises the adoption-
// authorization Statement TWIN resolution only -- the EIP-712 enforcement
// struct and its schema/bijection live in the marketplace tree (§8.2, out
// of scope). This fixture stubs the launcher-IRI binding a marketplace
// consumer would supply, and confirms: the signing key's binding resolves
// to the launcher IRI, the ceremony is NOT a GitHub login (`eoa` here),
// and the Statement carries no `predicate.revocation` reference (the form
// is irrevocable-until-expiry by design -- revocation is never consulted).
// ---------------------------------------------------------------------------

export interface OpenFleetAdoptionSettlementResult {
  readonly statementOutcome: VerificationOutcome;
  readonly statement: AuthorizationStatement;
}

export async function runOpenFleetAdoptionSettlementWalkthrough(
  fakes: FakeTrustResolvers,
): Promise<OpenFleetAdoptionSettlementResult> {
  const launcherAgent = testAgentIri("walkthrough-adoption-launcher");
  const launcherSigner = createEoaTestSigner("walkthrough-adoption-launcher-account");
  const launcherKey = testDidKey("walkthrough-adoption-launcher-key");

  const launcherBinding = await buildResolvedBindingFixture({
    agent: launcherAgent,
    workingKeyDidKey: launcherKey,
    ceremonyType: "eoa", // never a GitHub login
    voucher: accountVoucher(84532, launcherSigner.address),
    eoaCeremony: { signer: launcherSigner, chainId: 84532 },
    scope: ["authorizations"],
    isGenesis: true,
  });
  fakes.registerBinding({
    key: launcherKey,
    agent: launcherAgent,
    resolved: launcherBinding.resolved,
    validFrom: launcherBinding.binding.validFrom,
  });

  // The Statement twin: an open-fleet adoption authorization, irrevocable
  // until expiry -- no `predicate.revocation` field is set.
  const { statement, envelopeBytes } = await buildAuthorizationFixture({
    issuer: launcherAgent,
    capabilities: ["fleet:adopt"],
    signerKeyid: launcherKey,
  });

  const statementOutcome = await verifyEnvelopeBinding(
    {
      envelopeBytes,
      key: launcherKey,
      agent: launcherAgent,
      family: "authorizations",
      atTime: "2026-06-01T00:00:00.000Z",
    },
    { bindingResolver: fakes.bindingResolver, witnessVerifier: fakes.witnessVerifier, dsseVerifier: fakes.dsseVerifier },
  );

  return { statementOutcome, statement };
}

// ---------------------------------------------------------------------------
// Walkthrough 3: confidential input, leaked documents.
// ---------------------------------------------------------------------------

export interface ConfidentialLeakedDocumentsResult {
  readonly outcome: RequesterAuthenticationOutcome;
}

/**
 * "An attacker replays a leaked Task + Submission. `submit` authenticates
 * the requester (§7.5b); the grant's issuer binding does not match the
 * attacker's IRI; resolution fails closed with `access-denied`. The
 * attacker holds bytes, not authority."
 */
export async function runConfidentialLeakedDocumentsWalkthrough(
  fakes: FakeTrustResolvers,
): Promise<ConfidentialLeakedDocumentsResult> {
  const victimRequesterAgent = testAgentIri("walkthrough-leaked-victim");

  const attackerSigner = createEoaTestSigner("walkthrough-leaked-attacker-account");
  const attackerAgent = testAgentIri("walkthrough-leaked-attacker");
  const attackerKey = testDidKey("walkthrough-leaked-attacker-key");
  const attackerBinding = await buildResolvedBindingFixture({
    agent: attackerAgent,
    workingKeyDidKey: attackerKey,
    ceremonyType: "eoa",
    voucher: accountVoucher(84532, attackerSigner.address),
    eoaCeremony: { signer: attackerSigner, chainId: 84532 },
    scope: ["authorizations"],
    isGenesis: true,
  });
  fakes.registerBinding({
    key: attackerKey,
    agent: attackerAgent,
    resolved: attackerBinding.resolved,
    validFrom: attackerBinding.binding.validFrom,
  });

  // The attacker replays the leaked Submission's bytes (signed by their
  // OWN key, since they never held the victim's key -- only the leaked
  // document bytes) but claims the victim's requester IRI.
  const outcome = await authenticateRequester(
    {
      envelopeBytes: attackerBinding.envelopeBytes,
      key: attackerKey,
      requesterAgent: victimRequesterAgent,
      sealingTime: "2026-06-01T00:00:00.000Z",
    },
    { bindingResolver: fakes.bindingResolver, dsseVerifier: fakes.dsseVerifier },
  );

  return { outcome };
}

// ---------------------------------------------------------------------------
// Walkthrough 4: two-Safe evaluator distinctness.
// ---------------------------------------------------------------------------

export interface TwoSafeEvaluatorDistinctnessResult {
  readonly fleetOutcome: VerificationOutcome;
  readonly stakingOutcome: VerificationOutcome;
  /** True when both Safes' verified declarations resolve to the SAME
   * Agent IRI -- the design's `distinctEvaluator` check unsatisfied. */
  readonly distinctEvaluatorSatisfied: boolean;
  readonly freshIriOutcome: VerificationOutcome;
}

/**
 * "An operator's fleet Safe solves; its staking Safe claims the
 * evaluation, declaring an IRI. Both Safes' verified declarations
 * resolve to the same Agent IRI -> one party -> `distinctEvaluator`
 * unsatisfied. Had the operator declared a fresh, unbound IRI instead,
 * the `evaluator-eligibility` policy purpose (no history, not listed)
 * rejects it."
 */
export async function runTwoSafeEvaluatorDistinctnessWalkthrough(
  fakes: FakeTrustResolvers,
): Promise<TwoSafeEvaluatorDistinctnessResult> {
  const evaluatorAgent = testAgentIri("walkthrough-two-safe-evaluator");
  const evaluatorSigner = createEoaTestSigner("walkthrough-two-safe-fleet-account");

  // The fleet Safe's genesis binding.
  const fleetKey = testDidKey("walkthrough-two-safe-fleet-key");
  const fleetBinding = await buildResolvedBindingFixture({
    agent: evaluatorAgent,
    workingKeyDidKey: fleetKey,
    ceremonyType: "eoa",
    voucher: accountVoucher(84532, evaluatorSigner.address),
    eoaCeremony: { signer: evaluatorSigner, chainId: 84532 },
    scope: ["verdicts", "bindings"],
    isGenesis: true,
  });
  fakes.registerBinding({ key: fleetKey, agent: evaluatorAgent, resolved: fleetBinding.resolved, validFrom: fleetBinding.binding.validFrom });

  // The staking Safe -- a DIFFERENT account -- cross-account-attaches to
  // the SAME Agent IRI via a `bindings`-scoped consent countersignature
  // from the fleet Safe's own working key.
  const stakingSigner = createEoaTestSigner("walkthrough-two-safe-staking-account");
  const stakingKey = testDidKey("walkthrough-two-safe-staking-key");
  const stakingBinding = await buildResolvedBindingFixture({
    agent: evaluatorAgent,
    workingKeyDidKey: stakingKey,
    ceremonyType: "eoa",
    voucher: accountVoucher(84532, stakingSigner.address),
    eoaCeremony: { signer: stakingSigner, chainId: 84532 },
    scope: ["verdicts"],
    isGenesis: false,
    consent: { keyid: fleetKey, sig: btoa("walkthrough-two-safe-consent-signature") },
  });
  fakes.registerBinding({ key: stakingKey, agent: evaluatorAgent, resolved: stakingBinding.resolved, validFrom: stakingBinding.binding.validFrom });

  const deps = { bindingResolver: fakes.bindingResolver, witnessVerifier: fakes.witnessVerifier, dsseVerifier: fakes.dsseVerifier };
  const atTime = "2026-06-01T00:00:00.000Z";
  const fleetOutcome = await verifyEnvelopeBinding(
    { envelopeBytes: fleetBinding.envelopeBytes, key: fleetKey, agent: evaluatorAgent, family: FAMILY, atTime },
    deps,
  );
  const stakingOutcome = await verifyEnvelopeBinding(
    { envelopeBytes: stakingBinding.envelopeBytes, key: stakingKey, agent: evaluatorAgent, family: FAMILY, atTime },
    deps,
  );
  const distinctEvaluatorSatisfied = Boolean(
    fleetOutcome.ok
    && stakingOutcome.ok
    && fleetOutcome.resolvedBinding
    && stakingOutcome.resolvedBinding
    && fleetOutcome.resolvedBinding.binding.agent !== stakingOutcome.resolvedBinding.binding.agent,
  );

  // Had the operator declared a fresh, unbound IRI instead: it has no
  // binding at all, so it never resolves -- and even a policy purpose
  // that only accepts the genuine evaluator IRI would reject it.
  const freshAgent = testAgentIri("walkthrough-two-safe-fresh-unbound");
  const freshOutcome = await verifyEnvelopeBinding(
    { envelopeBytes: stakingBinding.envelopeBytes, key: stakingKey, agent: freshAgent, family: FAMILY, atTime },
    deps,
  );

  return {
    fleetOutcome,
    stakingOutcome,
    distinctEvaluatorSatisfied,
    freshIriOutcome: freshOutcome,
  };
}
