// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export const derivationDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u);

const unsafePublicDescriptorMaterial =
  /(?:^|[._+-])(?:private|secret|credential|token|nonce|operator|hostname|machine|device|home|path|environment|env|aws)(?:$|[._+-])|ghp_|github_pat_|npm_|AIza|xox[baprs]-|(?:sk|rk)_(?:live|test|prod)_|sk-/iu;
const hostnameLike =
  /^(?=.*[A-Za-z])(?:[A-Za-z0-9-]+\.){2,}[A-Za-z]{2,}$/u;

function publiclySafe(value: string): boolean {
  return (
    !unsafePublicDescriptorMaterial.test(value) &&
    !hostnameLike.test(value)
  );
}

export const publicComponentIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .refine(publiclySafe);

export const publicVersionSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9]+(?:[.+-][A-Za-z0-9]+)*$/u)
  .refine(publiclySafe);

export const implementationPackageNameSchema = z
  .string()
  .max(214)
  .regex(
    /^(?:@[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  )
  .refine(publiclySafe);

export const publicRuntimeFamilySchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .refine(publiclySafe);

export const derivationDetectorDescriptorSchema = z.strictObject({
  id: publicComponentIdSchema,
  version: publicVersionSchema,
  implementationDigest: derivationDigestSchema,
  reproducibility: z.enum(["byte-stable", "best-effort"]),
  configurationDigest: derivationDigestSchema.optional(),
});
