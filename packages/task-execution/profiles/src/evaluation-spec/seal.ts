import { sealDocument } from "../bytes.js";
import { assertValidDocument, parseJsonDocument } from "../zod-parse.js";
import { EvaluationSpecSchema, type EvaluationSpec } from "./schema.js";

export function parseEvaluationSpec(bytes: Uint8Array): EvaluationSpec {
  return parseJsonDocument(EvaluationSpecSchema, bytes, "EvaluationSpec");
}

export function sealEvaluationSpec(
  spec: EvaluationSpec,
): { bytes: Uint8Array; digest: `sha256:${string}` } {
  const validated = assertValidDocument(EvaluationSpecSchema, spec, "EvaluationSpec");
  return sealDocument(validated);
}
