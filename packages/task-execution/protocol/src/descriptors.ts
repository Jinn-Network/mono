/**
 * in-toto v1 ResourceDescriptor (§6.4). Digest is identity; IPFS CIDs, gateway URLs, and git
 * object identifiers are locator hints riding in uri/downloadLocation/annotations — never
 * identity. Bounded inline `content` is permitted for small values and always accompanied by
 * its digest.
 */
export interface ResourceDescriptor {
  name?: string;
  uri?: string;
  digest?: Record<string, string>;
  mediaType?: string;
  downloadLocation?: string;
  annotations?: Record<string, unknown>;
  content?: string;
}

/** Structural check: a ResourceDescriptor must carry at least one of uri/digest/content (§6.4). */
export function resourceDescriptorHasLocator(descriptor: ResourceDescriptor): boolean {
  return descriptor.uri !== undefined
    || (descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0)
    || descriptor.content !== undefined;
}

/**
 * The structural Evidence Protocol seam (§6.4): a reference by family + digest only. This is a
 * structural convention, not a package dependency — no import of any evidence package.
 */
export type EvidenceRecordFamily =
  | "execution-evidence"
  | "result-evaluation"
  | "execution-verification";

export interface EvidenceRecordReference {
  family: EvidenceRecordFamily;
  digest: `sha256:${string}`;
}
