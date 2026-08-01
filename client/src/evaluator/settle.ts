import {
  decisionGradeVerdictCode,
  uploadRawCodecCid,
  type IpfsPinPort,
} from '@jinn-network/marketplace-binding';

/**
 * Settles one verdict on the today-mode venue: pin the sealed Delivery, deliver it through the
 * mech, then claim it with the code the delivered Statement carries. The code is
 * envelope-authoritative — `decisionGradeVerdictCode` throws rather than defaulting, which is
 * the whole point (binding §6.4, §7.41).
 */
export async function settleVerdict(input: {
  readonly requestId: `0x${string}`;
  readonly sealedDeliveryBytes: Uint8Array;
  readonly statementVerdict: unknown;
  readonly pin: IpfsPinPort;
  readonly verdict: {
    deliverVerdictToMarketplace(input: { requestId: `0x${string}`; deliveryDigest: `0x${string}` }): Promise<{ txHash: `0x${string}` }>;
    claimVerdictDelivery(input: { requestId: `0x${string}`; verdictDigest: `0x${string}`; verdictCode: number }): Promise<{ status: string }>;
  };
  readonly keccakEvidenceHash: `0x${string}`;
}): Promise<{ readonly status: string }> {
  const verdictCode = decisionGradeVerdictCode(input.statementVerdict);
  await uploadRawCodecCid(input.sealedDeliveryBytes, input.pin);
  await input.verdict.deliverVerdictToMarketplace({
    requestId: input.requestId,
    deliveryDigest: input.keccakEvidenceHash,
  });
  return input.verdict.claimVerdictDelivery({
    requestId: input.requestId,
    verdictDigest: input.keccakEvidenceHash,
    verdictCode,
  });
}
