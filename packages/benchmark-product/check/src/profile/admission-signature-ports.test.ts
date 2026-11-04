// SPDX-License-Identifier: Apache-2.0

/**
 * The two admission signature ports `verify.ts` hands `verifyBinaryJudgmentAdmissionClosure`.
 * Through a bundle a looser port cannot be told apart from these, because that function parses each
 * envelope exactly and counts its signatures before either port runs. So the ports are kept at that
 * seam and handed what a looser check would accept: the same envelope respelled, and the same
 * signature twice in the exact encoding.
 */

import { parseExactDsseEnvelope, sealDsseEnvelope } from "@jinn-network/trust-core";
import { describe, expect, test, vi } from "vitest";
import type { BinaryJudgmentAdmissionClosurePorts } from "../admission/verification.js";
import { operatorOnlyBundle, twoHumanBundle } from "../characterization/testing/binary-admission-bundles.js";
import { verifyPublicBundle } from "../verify.js";

type ReviewerInput = Parameters<BinaryJudgmentAdmissionClosurePorts["verifyReviewerSignature"]>[0];
type AuthorityInput = Parameters<BinaryJudgmentAdmissionClosurePorts["verifyAuthoritySignature"]>[0];
interface Kept {
  readonly ports: BinaryJudgmentAdmissionClosurePorts;
  readonly reviewer: ReviewerInput[];
  readonly authority: AuthorityInput[];
}

const kept = vi.hoisted((): Kept[] => []);

// MOCK_JUSTIFICATION: a pass-through, not a fake. The real closure check runs with the real ports and its answer is returned; the wrapper only keeps the ports and what they were asked, because both are closures inside verifyPublicBundleSnapshot with no export.
vi.mock("../admission/verification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../admission/verification.js")>();
  return {
    ...actual,
    verifyBinaryJudgmentAdmissionClosure: (...[input, ports]: Parameters<typeof actual.verifyBinaryJudgmentAdmissionClosure>) => {
      const record: Kept = { ports, reviewer: [], authority: [] };
      kept.push(record);
      return actual.verifyBinaryJudgmentAdmissionClosure(input, {
        ...ports,
        verifyReviewerSignature: (signed) => {
          record.reviewer.push(signed);
          return ports.verifyReviewerSignature(signed);
        },
        verifyAuthoritySignature: (signed) => {
          record.authority.push(signed);
          return ports.verifyAuthoritySignature(signed);
        },
      });
    },
  };
});

function respelled(envelopeBytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(envelopeBytes)), null, 2));
}

function signedTwice(envelopeBytes: Uint8Array): Uint8Array {
  const { payloadType, payloadBytes, signatures: [only] } = parseExactDsseEnvelope(envelopeBytes);
  const signature = { keyid: only!.keyid!, signature: Buffer.from(only!.sig, "base64") };
  return sealDsseEnvelope({ payloadType, payloadBytes, signatures: [signature, signature] });
}

async function keptFrom(bundleDir: string): Promise<Kept> {
  kept.length = 0;
  // These bundles reach the ports and are refused later, for reasons that are not signatures.
  await verifyPublicBundle(bundleDir).catch(() => undefined);
  expect(kept).toHaveLength(1);
  return kept[0]!;
}

describe("the admission signature ports in verify.ts", () => {
  test("the authority port accepts the sealed envelope and nothing looser", async () => {
    const { ports, authority } = await keptFrom(operatorOnlyBundle());
    expect(authority.length).toBeGreaterThan(0);
    for (const signed of authority) {
      expect(ports.verifyAuthoritySignature(signed)).toBe(true);
      expect(ports.verifyAuthoritySignature({ ...signed, envelopeBytes: respelled(signed.envelopeBytes) })).toBe(false);
      expect(ports.verifyAuthoritySignature({ ...signed, envelopeBytes: signedTwice(signed.envelopeBytes) })).toBe(false);
    }
  });

  test("the reviewer port accepts the sealed envelope and nothing looser", async () => {
    const { ports, reviewer } = await keptFrom(twoHumanBundle());
    expect(reviewer.length).toBeGreaterThan(0);
    for (const signed of reviewer) {
      expect(ports.verifyReviewerSignature(signed)).toBe(true);
      expect(ports.verifyReviewerSignature({ ...signed, envelopeBytes: respelled(signed.envelopeBytes) })).toBe(false);
      expect(ports.verifyReviewerSignature({ ...signed, envelopeBytes: signedTwice(signed.envelopeBytes) })).toBe(false);
    }
  });
});
