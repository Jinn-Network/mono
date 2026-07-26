// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export const derivationDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u);

export const publicComponentIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

export const publicVersionSchema = z
  .string()
  .regex(/^[0-9][0-9A-Za-z.+-]{0,127}$/u);

export const implementationPackageNameSchema = z
  .string()
  .regex(/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u);

export const derivationDetectorDescriptorSchema = z.strictObject({
  id: publicComponentIdSchema,
  version: publicVersionSchema,
  implementationDigest: derivationDigestSchema,
  reproducibility: z.enum(["byte-stable", "best-effort"]),
  configurationDigest: derivationDigestSchema.optional(),
});
