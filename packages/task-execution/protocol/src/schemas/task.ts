import { z } from "zod";
import { PreferencesMap, RequirementsMap, ResourceDescriptorSchema } from "./common.js";

export const TaskOutputSlotSchema = z.object({
  name: z.string(),
  mediaType: z.string(),
  required: z.boolean(),
  schema: z.unknown().optional(), // embedded or digest-referenced JSON Schema 2020-12
});

// The sealed Task deliberately contains none of these mutable fields (§7.1).
const FORBIDDEN_TASK_FIELDS = [
  "deadline",
  "claimPolicy",
  "attempts",
  "nonce",
  "price",
  "reward",
  "credentials",
  "capabilityGrants",
] as const;

export const TaskSpecificationSchema = z
  .object({
    protocol: z.string().url(), // TEP profile URI (§7.1)
    profile: ResourceDescriptorSchema, // carried amendment 2: URI + digest (profiles §6.2)
    instructions: z.string(),
    payload: z.unknown().optional(), // profile-typed body
    inputs: z.array(ResourceDescriptorSchema).optional(),
    outputs: z.array(TaskOutputSlotSchema),
    requirements: RequirementsMap.optional(), // work-intrinsic only (profiles §5)
    preferences: PreferencesMap.optional(),
    evaluation: ResourceDescriptorSchema.optional(), // digest of the EvaluationSpec (§7.3)
    supersedes: ResourceDescriptorSchema.optional(), // predecessor Task digest (§6.5)
    author: z.string().optional(), // self-declared IRI (§7.4)
  })
  .loose() // open to namespaced extensions (§21.3)
  .superRefine((task, ctx) => {
    for (const field of FORBIDDEN_TASK_FIELDS) {
      if (Object.hasOwn(task, field)) {
        ctx.addIssue({
          code: "custom",
          message: `sealed Task must not carry the mutable field "${field}" (§7.1)`,
          path: [field],
        });
      }
    }
  });

export type TaskSpecification = z.infer<typeof TaskSpecificationSchema>;
