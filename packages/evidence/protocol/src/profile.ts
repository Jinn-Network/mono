import { z } from "zod";

import { EXECUTION_EVIDENCE_PROFILE_URI } from "./identifiers.js";
import {
  DsseEnvelopeSchema,
  ExecutionEvidenceDocumentSchema,
  ExecutionVerificationStatementSchema,
  ResourceDescriptorSchema,
  ResultEvaluationStatementSchema,
} from "./schemas.js";

const PROFILE_SCHEMAS = {
  "dsse-envelope.schema.json": DsseEnvelopeSchema,
  "execution-evidence-document.schema.json": ExecutionEvidenceDocumentSchema,
  "execution-verification-statement.schema.json":
    ExecutionVerificationStatementSchema,
  "resource-descriptor.schema.json": ResourceDescriptorSchema,
  "result-evaluation-statement.schema.json": ResultEvaluationStatementSchema,
} as const;

export type ProfileJsonSchema = Record<string, unknown> & {
  readonly $schema: string;
  readonly $id: string;
};

export function profileJsonSchemas(): Record<string, ProfileJsonSchema> {
  return Object.fromEntries(
    Object.entries(PROFILE_SCHEMAS).map(([name, schema]) => {
      const generated = z.toJSONSchema(schema, {
        target: "draft-2020-12",
        unrepresentable: "any",
      }) as ProfileJsonSchema;
      return [
        name,
        {
          ...generated,
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: `${EXECUTION_EVIDENCE_PROFILE_URI}/schemas/${name}`,
        },
      ];
    }),
  );
}
