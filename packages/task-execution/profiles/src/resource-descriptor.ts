import { z } from "zod";

// Independently authored structural mirror of TEP's in-toto v1 ResourceDescriptor (§6.4).
// Profiles imports only the `ResourceDescriptor` *type* from task-execution-protocol (Global
// Constraints: imports protocol only, no shared runtime schema dependency) — the same
// re-implementation philosophy sealing follows: shape-compatible with the protocol type, proven
// by fixtures, never by a runtime import of protocol's own zod schema.
export const RESOURCE_DESCRIPTOR_SHAPE = {
  name: z.string().optional(),
  uri: z.string().optional(),
  digest: z.record(z.string(), z.string()).optional(),
  mediaType: z.string().optional(),
  downloadLocation: z.string().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
};

/** Structural check: a descriptor must carry at least one of uri/digest/content (§6.4). */
export function resourceDescriptorHasLocator(descriptor: {
  uri?: string;
  digest?: Record<string, string>;
  content?: string;
}): boolean {
  return descriptor.uri !== undefined
    || (descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0)
    || descriptor.content !== undefined;
}

export const ResourceDescriptorSchema = z
  .looseObject(RESOURCE_DESCRIPTOR_SHAPE)
  .refine(resourceDescriptorHasLocator, {
    message: "ResourceDescriptor requires at least one of uri/digest/content (§6.4)",
  });

export type ResourceDescriptorLike = z.infer<typeof ResourceDescriptorSchema>;
