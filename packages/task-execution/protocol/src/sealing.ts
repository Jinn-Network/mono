import type { z } from "zod";
import { serializeCanonicalJson } from "./canonical.js";
import { cloneIJsonValue, type JsonValue } from "./json.js";
import { DeliveryRecordSchema } from "./schemas/delivery.js";
import { SubmissionRecordSchema } from "./schemas/submission.js";
import { TaskSpecificationSchema } from "./schemas/task.js";
import type { ValidationIssue } from "./validators.js";

/**
 * Thrown when a document fails schema validation at sealing time (§6.1). Carries the plain
 * `{ category: "invalid-document", errors }` shape the `backend` package wraps in
 * `TaskExecutionError` (Global Constraints: the error-category enum lives in `protocol`, the
 * error *class* in `backend` — no duplicate source of the enum).
 */
export class InvalidDocumentError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly errors: readonly ValidationIssue[]) {
    super("document failed schema validation at sealing (§6.1)");
    this.name = "InvalidDocumentError";
  }
}

function seal(schema: z.ZodTypeAny, document: unknown): Uint8Array {
  // Validate the caller's exact input before schema parsing can omit an explicit `undefined`
  // or otherwise normalize an unsupported runtime value.
  const parsed = schema.safeParse(cloneIJsonValue(document));
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new InvalidDocumentError(errors);
  }
  // I-JSON integer enforcement happens inside serializeCanonicalJson; a non-integer number
  // (e.g. an unvalidated `payload` field) throws IJsonNumberError, uncaught here (§6.1).
  return serializeCanonicalJson(parsed.data as JsonValue);
}

/** Validate → I-JSON enforce → JCS → exact bytes. Those bytes are the Task forever (§6.1). */
export function sealTask(document: unknown): Uint8Array {
  return seal(TaskSpecificationSchema, document);
}

export function sealSubmission(document: unknown): Uint8Array {
  return seal(SubmissionRecordSchema, document);
}

export function sealDelivery(document: unknown): Uint8Array {
  return seal(DeliveryRecordSchema, document);
}
