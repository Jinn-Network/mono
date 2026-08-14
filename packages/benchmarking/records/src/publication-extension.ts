import { z } from "zod";
import { DigestBearingResourceDescriptorSchema } from "./descriptors.js";
import { BENCHMARK_PUBLICATION_EXTENSION } from "./identifiers.js";

const AbsoluteIriSchema = z.string().refine(
  (value) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value),
  "must be an absolute IRI",
);

/** A registration artifact commits a Run to bytes whose meaning remains adapter-owned. */
export const RegistrationArtifactSchema = z.object({
  role: AbsoluteIriSchema,
  artifact: DigestBearingResourceDescriptorSchema,
});

export const RunPublicationExtensionSchema = z.object({
  registrationArtifacts: z.array(RegistrationArtifactSchema),
}).superRefine((extension, ctx) => {
  for (let index = 1; index < extension.registrationArtifacts.length; index += 1) {
    const previous = extension.registrationArtifacts[index - 1]!;
    const current = extension.registrationArtifacts[index]!;
    const previousKey = `${previous.role}\u001f${previous.artifact.digest.sha256}`;
    const currentKey = `${current.role}\u001f${current.artifact.digest.sha256}`;
    if (previousKey >= currentKey) {
      ctx.addIssue({
        code: "custom",
        path: ["registrationArtifacts", index],
        message: "registrationArtifacts must be sorted and unique by role then sha256 (UTF-16 code-unit order)",
      });
    }
  }
});

export const MatrixPublicationExtensionSchema = z.object({
  accounting: DigestBearingResourceDescriptorSchema,
});

export type RegistrationArtifact = z.infer<typeof RegistrationArtifactSchema>;
export type RunPublicationExtension = z.infer<typeof RunPublicationExtensionSchema>;
export type MatrixPublicationExtension = z.infer<typeof MatrixPublicationExtensionSchema>;

type ExtensibleRecord = Record<string, unknown>;

/** Construct the typed namespaced Run extension without taking ownership of artifact semantics. */
export function runPublicationExtension(value: unknown): RunPublicationExtension {
  return RunPublicationExtensionSchema.parse(value);
}

/** Construct the typed namespaced Matrix extension that binds assembly v2 to accounting. */
export function matrixPublicationExtension(value: unknown): MatrixPublicationExtension {
  return MatrixPublicationExtensionSchema.parse(value);
}

export function withRunPublicationExtension<T extends ExtensibleRecord>(
  record: T,
  extension: RunPublicationExtension,
): T & { [BENCHMARK_PUBLICATION_EXTENSION]: RunPublicationExtension } {
  return {
    ...record,
    [BENCHMARK_PUBLICATION_EXTENSION]: runPublicationExtension(extension),
  } as T & { [BENCHMARK_PUBLICATION_EXTENSION]: RunPublicationExtension };
}

export function withMatrixPublicationExtension<T extends ExtensibleRecord>(
  record: T,
  extension: MatrixPublicationExtension,
): T & { [BENCHMARK_PUBLICATION_EXTENSION]: MatrixPublicationExtension } {
  return {
    ...record,
    [BENCHMARK_PUBLICATION_EXTENSION]: matrixPublicationExtension(extension),
  } as T & { [BENCHMARK_PUBLICATION_EXTENSION]: MatrixPublicationExtension };
}

export function readRunPublicationExtension(record: ExtensibleRecord): RunPublicationExtension | undefined {
  const value = record[BENCHMARK_PUBLICATION_EXTENSION];
  return value === undefined ? undefined : runPublicationExtension(value);
}

export function readMatrixPublicationExtension(record: ExtensibleRecord): MatrixPublicationExtension | undefined {
  const value = record[BENCHMARK_PUBLICATION_EXTENSION];
  return value === undefined ? undefined : matrixPublicationExtension(value);
}
