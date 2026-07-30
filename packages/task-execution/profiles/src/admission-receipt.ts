import { z } from "zod";
import { IN_TOTO_STATEMENT_TYPE } from "./identifiers.js";
import { RESOURCE_DESCRIPTOR_SHAPE, resourceDescriptorHasLocator } from "./resource-descriptor.js";

/**
 * An admission receipt is a DSSE-signed in-toto Statement (§7.6): subjects = the sealed Task
 * digest and the EvaluationSpec digest; issuer = the admission agent IRI; predicate = admission
 * evidence.
 */
const AdmissionReceiptSubjectSchema = z
  .looseObject(RESOURCE_DESCRIPTOR_SHAPE)
  .refine(resourceDescriptorHasLocator, {
    message: "admission-receipt subject requires at least one of uri/digest/content (§6.4)",
  });

export const AdmissionReceiptStatementSchema = z.looseObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.array(AdmissionReceiptSubjectSchema).min(2),
  predicateType: z.string(),
  predicate: z.looseObject({
    issuer: z.string(),
  }),
});
export type AdmissionReceiptStatement = z.infer<typeof AdmissionReceiptStatementSchema>;

const DsseSignatureSchema = z.looseObject({
  keyid: z.string().optional(),
  sig: z.string(),
});

export const DsseEnvelopeSchema = z.looseObject({
  payloadType: z.string(),
  payload: z.string(),
  signatures: z.array(DsseSignatureSchema).min(1),
});
export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;

export type CheckAdmissionReceiptResult =
  | { ok: true; issuer: string }
  | { ok: false; code: "invalid-document"; reason: string };

function digestHex(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

/**
 * Structural checks only (§7.6): the envelope carries at least one signature (unsigned → fail),
 * the decoded Statement's subject digests equal the two expected digests (subject-mismatch —
 * including a reused receipt whose subjects name a different Task/EvaluationSpec pair — → fail),
 * and an issuer IRI is present. Signature *validity* (cryptographic verification) is the
 * consuming binding's job, out of lane.
 */
export function checkAdmissionReceipt(input: {
  envelope: unknown;
  expectedTaskDigest: string;
  expectedEvaluationSpecDigest: string;
}): CheckAdmissionReceiptResult {
  const { envelope, expectedTaskDigest, expectedEvaluationSpecDigest } = input;

  const parsedEnvelope = DsseEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    return { ok: false, code: "invalid-document", reason: "envelope failed schema validation (unsigned or malformed)" };
  }

  let payloadJson: unknown;
  try {
    const decoded = Buffer.from(parsedEnvelope.data.payload, "base64").toString("utf8");
    payloadJson = JSON.parse(decoded);
  } catch (cause) {
    return { ok: false, code: "invalid-document", reason: "envelope payload is not valid base64-encoded JSON" };
  }

  const parsedStatement = AdmissionReceiptStatementSchema.safeParse(payloadJson);
  if (!parsedStatement.success) {
    return { ok: false, code: "invalid-document", reason: "decoded Statement failed schema validation" };
  }
  const statement = parsedStatement.data;

  const expectedTaskHex = digestHex(expectedTaskDigest);
  const expectedSpecHex = digestHex(expectedEvaluationSpecDigest);
  const subjectHexes = statement.subject
    .map((subject) => subject.digest?.sha256)
    .filter((hex): hex is string => hex !== undefined);
  const hasTask = subjectHexes.includes(expectedTaskHex);
  const hasSpec = subjectHexes.includes(expectedSpecHex);
  if (!hasTask || !hasSpec) {
    return {
      ok: false,
      code: "invalid-document",
      reason: "Statement subject does not name the expected Task and EvaluationSpec digests",
    };
  }

  return { ok: true, issuer: statement.predicate.issuer };
}
