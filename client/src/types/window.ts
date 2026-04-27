import { z } from 'zod';

export const WindowSchema = z.object({
  startTs: z.number().int(),
  endTs: z.number().int(),
});

export type Window = z.infer<typeof WindowSchema>;
