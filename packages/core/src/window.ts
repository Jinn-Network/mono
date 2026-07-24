import { z } from 'zod/v3';

export const WindowSchema = z.object({
  startTs: z.number().int(),
  endTs: z.number().int(),
});

export type Window = z.infer<typeof WindowSchema>;
