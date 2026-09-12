import { createPublicKey } from "node:crypto";
import { BENCHMARKING_REPORTS_SCOPE } from "@jinn-network/benchmarking-records";
import { sha256Hex, TRUST_KEY_BINDING_FORMAT, type ResolvedBinding, type VerifyEnvelopeBindingDeps } from "@jinn-network/trust-core";
import { verifyReportEnvelopeSignatures } from "./signing.js";

export interface PublicReportTrustMaterial {
  readonly author: string;
  readonly keyId: string;
  readonly didKey: string;
  readonly algorithm: "ed25519";
  readonly spkiDerBase64: string;
  readonly validFrom: string;
}

export function buildPublicReportTrustDeps(input: {
  readonly report: PublicReportTrustMaterial;
  readonly bindingEnvelopeBytes: Uint8Array;
}): VerifyEnvelopeBindingDeps {
  const { report, bindingEnvelopeBytes } = input;
  if (report.keyId !== report.didKey) throw new Error("report trust keyId must equal didKey");
  const spkiDer = Buffer.from(report.spkiDerBase64, "base64");
  const publicKey = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  const binding: ResolvedBinding = {
    binding: {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: report.author,
      key: { publicKey: report.spkiDerBase64, keyid: report.keyId, algorithm: report.algorithm, didKey: report.didKey },
      voucher: { kind: "agentId", caip19: "eip155:1/erc721:0x0000000000000000000000000000000000000000/1" },
      relationship: "controls",
      scope: [BENCHMARKING_REPORTS_SCOPE],
      validFrom: report.validFrom,
      ceremony: { type: "agentId", digest: `sha256:${sha256Hex(spkiDer)}` },
      strength: "strong",
      anchors: [],
    },
    envelopeBytes: bindingEnvelopeBytes,
    bindingDigest: `sha256:${sha256Hex(bindingEnvelopeBytes)}`,
    effectiveStart: report.validFrom,
    isGenesis: true,
    revocations: [],
  };
  return {
    dsseVerifier: (envelopeBytes) => verifyReportEnvelopeSignatures(envelopeBytes, { keyId: report.keyId, publicKey }),
    bindingResolver: { async resolveBinding(query) { return query.key === report.keyId && query.agent === report.author ? binding : null; } },
    witnessVerifier: { async verify1271Witness() { return { verified: false, reason: "no 1271 witnesses on the local venue" }; } },
  };
}
