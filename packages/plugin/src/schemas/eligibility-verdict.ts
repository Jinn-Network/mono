/** Cheap candidate verdict (architecture spec §5). Authoritative validation is sidecar-side. */
import { z } from 'zod';

export const EligibilityVerdictSchema = z.strictObject({
  eligible: z.boolean(),
  reason: z.string().min(1),
  checkedAt: z.iso.datetime(),
});

export type EligibilityVerdict = z.infer<typeof EligibilityVerdictSchema>;
