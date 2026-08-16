import { createHash } from "node:crypto";

export interface CachePolicyInput {
  generatedAt: string;
  maxAgeSeconds?: number;
}

export function cachePolicyHeaders(input: CachePolicyInput): Record<string, string> {
  const maxAge = input.maxAgeSeconds ?? 3;
  const etag = `"${createHash("sha256").update(input.generatedAt).digest("hex").slice(0, 16)}"`;
  return {
    "Cache-Control": `private, max-age=${maxAge}, must-revalidate`,
    ETag: etag,
    "Last-Modified": new Date(input.generatedAt).toUTCString(),
  };
}
