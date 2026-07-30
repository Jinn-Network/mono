import type { z } from "zod";
import { DeliveryRecordSchema } from "./schemas/delivery.js";
import { DispatchContextSchema } from "./schemas/dispatch-context.js";
import { ProtocolObservationSchema } from "./schemas/observation.js";
import { SubmissionRecordSchema } from "./schemas/submission.js";
import { TaskSpecificationSchema } from "./schemas/task.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  conforms: boolean;
  errors: readonly ValidationIssue[];
}

// Consumer-side rule: validators operate on the parsed view and never re-serialize; digest
// checks are the caller's job over exact received bytes (§6.1).
function validate(schema: z.ZodTypeAny, doc: unknown): ValidationResult {
  const result = schema.safeParse(doc);
  if (result.success) return { conforms: true, errors: [] };
  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return { conforms: false, errors };
}

export function validateTask(doc: unknown): ValidationResult {
  return validate(TaskSpecificationSchema, doc);
}

export function validateSubmission(doc: unknown): ValidationResult {
  return validate(SubmissionRecordSchema, doc);
}

export function validateDelivery(doc: unknown): ValidationResult {
  return validate(DeliveryRecordSchema, doc);
}

export function validateDispatchContext(doc: unknown): ValidationResult {
  return validate(DispatchContextSchema, doc);
}

export function validateObservation(doc: unknown): ValidationResult {
  return validate(ProtocolObservationSchema, doc);
}
