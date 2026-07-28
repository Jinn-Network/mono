import { z } from "zod";
import { Rfc3339, RequirementsMap, ResourceDescriptorSchema, UrnUuid } from "./common.js";

const AttemptBoundsSchema = z.object({
  maxTotal: z.number().int().positive().optional(),
  maxConcurrent: z.number().int().positive().optional(),
});

/**
 * The Submission dispatch record (§8). `requirements` here is the Submission-level run-pinning
 * map (carried TEP amendment 1, profiles §5) sharing the Task-requirements vocabulary. Namespaced
 * `annotations` are correlation annotations (§6.4), widened per carried amendment 3 (profiles
 * §5.3/§13) to admit application context (e.g. `runId`, `cellKey`) as namespaced extensions.
 */
// §8: the Submission's `task` reference commits to "the sealed Task digest plus locator hints" —
// unlike a general ResourceDescriptor (§6.4, satisfiable by uri/digest/content alone), the
// Submission's task binding always requires a sha256 digest entry.
const TaskReferenceSchema = ResourceDescriptorSchema.refine(
  (descriptor) => typeof descriptor.digest?.sha256 === "string",
  { message: "Submission's task ResourceDescriptor requires a sha256 digest entry (§8)" },
);

export const SubmissionRecordSchema = z
  .object({
    protocol: z.string().url(),
    submission: UrnUuid,
    task: TaskReferenceSchema,
    requester: z.string(),
    idempotencyKey: z.string(),
    nonce: z.string(),
    deadline: Rfc3339,
    closeAt: Rfc3339.optional(),
    attempts: AttemptBoundsSchema.optional(),
    evaluationRequirements: z.record(z.string(), z.unknown()).optional(),
    capabilityGrants: z.record(z.string(), z.unknown()).optional(),
    requirements: RequirementsMap.optional(), // carried amendment 1: run-pinning map
    profileParameters: z.record(z.string(), z.unknown()).optional(),
    annotations: z.record(z.string(), z.unknown()).optional(), // correlation annotations (§6.4)
  })
  .loose(); // open to namespaced extensions (§21.3)

export type SubmissionRecord = z.infer<typeof SubmissionRecordSchema>;
