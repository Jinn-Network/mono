// Types for portal-closure.mjs. A declaration file, not TypeScript source, so the importing
// projects' `rootDir` (which must contain every compiled source file) does not have to reach it.

export interface PortalEdge {
  name: string;
  /** Consumer package directory, relative to the image's build context. */
  consumer: string;
  /** Portal target directory, relative to the image's build context. */
  target: string;
}

export function portalEntries(manifest: Record<string, unknown>): Map<string, string>;
export function reachablePortalEdges(packageRoot: string, contextRoot: string): PortalEdge[];
export function missingPortalManifestCopies(dockerfile: string, edges: PortalEdge[]): string[];
export function missingWatchPatterns(
  railwayConfig: string,
  watched: string[],
  prefix: string,
): string[];
