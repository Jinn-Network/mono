// SPDX-License-Identifier: Apache-2.0

/**
 * The `integrity-anchors` reports, in full. The golden bundle carries no anchors, so nothing else
 * in this suite reaches the check's reports. These are the records
 * `anchor/integrity-anchors.test.ts` builds, plus the outcomes it leaves unbuilt; that suite asserts
 * what each one means and this one pins every byte of what each one says, reason strings included.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { MATRIX_RECORD_KIND, RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE } from "@jinn-network/trust-core";
import {
  buildAnchorEvidenceRecord,
  buildOpenTimestampsAnchorEvidenceRecord,
  buildRfc3161AnchorEvidenceRecord,
  createFixtureAuthority,
  createOpenTimestampsKitFixtures,
} from "@jinn-network/trust-testing";
import { evaluateIntegrityAnchors, type EvaluateIntegrityAnchorsInput } from "../../anchor/check.js";

const require = createRequire(import.meta.url);

const RUN_SHA256 = "1".repeat(64);
const MATRIX_SHA256 = "2".repeat(64);
const UNRELATED_SHA256 = "3".repeat(64);
const CLOSE_AT = "2026-06-01T00:00:00Z";
const GEN_TIME_DER = "20260501120000Z";
const LATER_GEN_TIME_DER = "20260601120000Z";
/** The two committed real captures share one subject digest (`capture-provenance.md`). */
const CAPTURED_SUBJECT_SHA256 = "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c";

const authority = createFixtureAuthority("integrity-anchors");
const otherAuthority = createFixtureAuthority("integrity-anchors-other");
const lockOts = createOpenTimestampsKitFixtures(hexToBytes(RUN_SHA256));
const matrixOts = createOpenTimestampsKitFixtures(hexToBytes(MATRIX_SHA256));
const blockHeaders = lockOts.blockHeaders.map(({ height, header }) => ({ height, header }));

type Carried = EvaluateIntegrityAnchorsInput["records"][number];

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function carried(built: { readonly bytes: Uint8Array; readonly recordDigest: string }): Carried {
  return { recordSha256: built.recordDigest.slice("sha256:".length), bytes: built.bytes };
}

function rfc3161Lock(options: {
  readonly genTimeDer?: string;
  readonly subjectSha256?: string;
  readonly tokenSubjectSha256?: string;
} = {}): Carried {
  const subjectSha256 = options.subjectSha256 ?? RUN_SHA256;
  return carried(buildRfc3161AnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256,
    proofBytes: authority.mintTimeStampToken({
      subjectSha256: options.tokenSubjectSha256 ?? subjectSha256,
      genTime: options.genTimeDer ?? GEN_TIME_DER,
    }).tokenDer,
  }));
}

function chainLock(proofBytes: Uint8Array): Carried {
  return carried(buildOpenTimestampsAnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256: RUN_SHA256,
    proofBytes,
  }));
}

function capturedToken(name: string): Carried {
  return carried(buildRfc3161AnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256: CAPTURED_SUBJECT_SHA256,
    proofBytes: new Uint8Array(readFileSync(
      require.resolve(`@jinn-network/trust-testing/fixtures/anchor-kit-v1/${name}`),
    )),
  }));
}

function report(
  records: readonly Carried[],
  extra: Partial<EvaluateIntegrityAnchorsInput> = {},
): () => unknown {
  return () => evaluateIntegrityAnchors({
    records,
    runSha256: RUN_SHA256,
    matrixSha256: MATRIX_SHA256,
    closeAt: CLOSE_AT,
    ...extra,
  });
}

function respelledRecord(): Carried {
  const record = rfc3161Lock();
  const bytes = new TextEncoder().encode(
    JSON.stringify(JSON.parse(new TextDecoder().decode(record.bytes)), null, 2),
  );
  return { recordSha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

function capturedReport(token: string, closeAt: string): () => unknown {
  return report([capturedToken(token)], { runSha256: CAPTURED_SUBJECT_SHA256, closeAt });
}

export const ANCHOR_CASES: Readonly<Record<string, () => unknown>> = {
  "nothing-carried": report([]),
  "declared-and-nothing-carried": report([], { declaredProfiles: [RFC3161_TSA_ANCHOR_PROFILE] }),
  "two-declared-one-carried": report([rfc3161Lock()], {
    declaredProfiles: [OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE],
  }),
  "one-declared-one-carried": report([rfc3161Lock()], { declaredProfiles: [RFC3161_TSA_ANCHOR_PROFILE] }),

  "rfc3161-lock/no-trust-material": report([rfc3161Lock()]),
  "rfc3161-lock/trust-material-supplied": report([rfc3161Lock()], {
    trust: { rfc3161: { trustAnchorsDer: [authority.certificateDer] } },
  }),
  "rfc3161-lock/trust-material-from-another-authority": report([rfc3161Lock()], {
    trust: { rfc3161: { trustAnchorsDer: [otherAuthority.certificateDer] } },
  }),
  "rfc3161-lock/token-covers-another-digest": report([rfc3161Lock({ tokenSubjectSha256: UNRELATED_SHA256 })]),
  "rfc3161-lock/after-the-close-instant": report([rfc3161Lock({ genTimeDer: LATER_GEN_TIME_DER })]),
  "rfc3161-lock/close-instant-is-not-comparable": report([rfc3161Lock()], { closeAt: "not an instant" }),
  "rfc3161-matrix/after-the-close-instant": report([carried(buildRfc3161AnchorEvidenceRecord({
    subjectKind: MATRIX_RECORD_KIND,
    subjectSha256: MATRIX_SHA256,
    proofBytes: authority.mintTimeStampToken({
      subjectSha256: MATRIX_SHA256,
      genTime: LATER_GEN_TIME_DER,
    }).tokenDer,
  }))]),

  "dangling-digest": report([rfc3161Lock({ subjectSha256: UNRELATED_SHA256 })]),
  "kind-label-misdescribes-its-digest": report([carried(buildRfc3161AnchorEvidenceRecord({
    subjectKind: MATRIX_RECORD_KIND,
    subjectSha256: RUN_SHA256,
    proofBytes: authority.mintTimeStampToken({ subjectSha256: RUN_SHA256, genTime: GEN_TIME_DER }).tokenDer,
  }))]),
  "unimplemented-provider": report([carried(buildAnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256: RUN_SHA256,
    provider: "https://spec.jinn.network/trust/anchor-profiles/not-implemented/v1",
    proofMediaType: "application/octet-stream",
    proofBytes: Uint8Array.of(1, 2, 3, 4),
  }))]),
  "respelled-record": report([respelledRecord()]),

  "chain-lock/complete-no-headers": report([chainLock(lockOts.completeProof)]),
  "chain-lock/complete-with-headers": report([chainLock(lockOts.completeProof)], {
    trust: { opentimestamps: { blockHeaders } },
  }),
  "chain-lock/pending-and-complete": report([chainLock(lockOts.pendingProof), chainLock(lockOts.completeProof)]),
  "chain-lock/fabricated-no-headers": report([chainLock(lockOts.fabricatedCompleteProof)]),
  "chain-lock/fabricated-with-headers": report([chainLock(lockOts.fabricatedCompleteProof)], {
    trust: { opentimestamps: { blockHeaders } },
  }),
  "chain-matrix/complete-no-headers": report([carried(buildOpenTimestampsAnchorEvidenceRecord({
    subjectKind: MATRIX_RECORD_KIND,
    subjectSha256: MATRIX_SHA256,
    proofBytes: matrixOts.completeProof,
  }))]),

  "chain-lock/records-given-out-of-digest-order": report([chainLock(lockOts.completeProof), chainLock(lockOts.pendingProof)]),
  "chain-lock/pending-only": report([chainLock(lockOts.pendingProof)]),
  "two-declared-none-carried": report([], {
    declaredProfiles: [RFC3161_TSA_ANCHOR_PROFILE, OPENTIMESTAMPS_ANCHOR_PROFILE],
  }),
  "rfc3161-lock/at-the-close-instant": report([rfc3161Lock({ genTimeDer: "20260601000000Z" })]),
  "rfc3161-lock/after-the-close-instant-with-trust-material": report([rfc3161Lock({ genTimeDer: LATER_GEN_TIME_DER })], {
    trust: { rfc3161: { trustAnchorsDer: [authority.certificateDer] } },
  }),
  "rfc3161-lock/trust-material-for-the-other-provider": report([rfc3161Lock()], {
    trust: { opentimestamps: { blockHeaders } },
  }),

  "captured/digicert-token": capturedReport("token-digicert.der", "2026-08-18T00:00:00Z"),
  "captured/sslcom-token": capturedReport("token-sslcom.der", "2026-08-18T00:00:00Z"),
  "captured/digicert-token-after-the-close-instant": capturedReport("token-digicert.der", "2026-08-17T00:00:00Z"),
};
