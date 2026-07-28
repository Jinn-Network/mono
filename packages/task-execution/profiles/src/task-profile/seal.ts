import { sealDocument } from "../bytes.js";
import { assertValidDocument, parseJsonDocument } from "../zod-parse.js";
import { TaskProfileDocumentSchema, type TaskProfileDocument } from "./schema.js";

export function parseTaskProfile(bytes: Uint8Array): TaskProfileDocument {
  return parseJsonDocument(TaskProfileDocumentSchema, bytes, "TaskProfileDocument");
}

export function sealTaskProfile(
  doc: TaskProfileDocument,
): { bytes: Uint8Array; digest: `sha256:${string}` } {
  const validated = assertValidDocument(TaskProfileDocumentSchema, doc, "TaskProfileDocument");
  return sealDocument(validated);
}
