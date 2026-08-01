// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { preflightCanonicalInput } from "./preflight.js";

/** Public facade: descriptor preflight before any Zod object traversal. */
export function hardenedSchema<T>(inner: z.ZodType<T>): z.ZodType<T> {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      try {
        preflightCanonicalInput(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message:
            error instanceof Error ? error.message : "document failed canonical preflight at parse",
        });
      }
    })
    .pipe(inner);
}
