import { z } from "zod";
import { Sha256Digest, UrnUuid } from "./common.js";

/**
 * The dispatch-context input artifact (§9.3): media type
 * `application/vnd.jinn.task-execution.dispatch-context.v1+json`. Because the Attempt URI is
 * inside it, the artifact is unique per Attempt even though the nonce is per-Submission.
 */
export const DispatchContextSchema = z
  .object({
    taskDigest: Sha256Digest,
    submission: UrnUuid,
    nonce: z.string(),
    attempt: UrnUuid,
  })
  .loose();

export type DispatchContext = z.infer<typeof DispatchContextSchema>;
