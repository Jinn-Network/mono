import { readFileSync } from "node:fs";

export const BUILD_METADATA_KIND = "colophon-package-build/1" as const;
/** v1 npm targets with cold-machine proofs. This is never inferred from a build host. */
export const DEFAULT_QUALIFIED_TARGETS = ["darwin/arm64", "linux/x64"] as const;

export interface ColophonBuildMetadata {
  readonly kind: typeof BUILD_METADATA_KIND;
  readonly packageVersion: string;
  readonly sourceCommit: string;
  readonly qualifiedTargets: readonly string[];
}

export interface RuntimeTarget {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TARGET = /^[a-z0-9]+\/[a-z0-9_]+$/;

export function parseBuildMetadata(value: unknown): ColophonBuildMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("build metadata must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== BUILD_METADATA_KIND) throw new TypeError(`build metadata kind must be ${BUILD_METADATA_KIND}`);
  if (typeof candidate.packageVersion !== "string" || !VERSION.test(candidate.packageVersion)) {
    throw new TypeError("build metadata packageVersion must be a semantic version");
  }
  if (typeof candidate.sourceCommit !== "string" || !COMMIT.test(candidate.sourceCommit)) {
    throw new TypeError("build metadata sourceCommit must be a lowercase 40-character Git commit");
  }
  if (!Array.isArray(candidate.qualifiedTargets) || candidate.qualifiedTargets.length === 0) {
    throw new TypeError("build metadata qualifiedTargets must contain at least one OS/architecture target");
  }
  const qualifiedTargets = candidate.qualifiedTargets.map((target) => {
    if (typeof target !== "string" || !TARGET.test(target)) {
      throw new TypeError("each qualified target must use the form os/architecture");
    }
    return target;
  });
  if (new Set(qualifiedTargets).size !== qualifiedTargets.length) {
    throw new TypeError("build metadata qualifiedTargets must not contain duplicates");
  }
  return {
    kind: BUILD_METADATA_KIND,
    packageVersion: candidate.packageVersion,
    sourceCommit: candidate.sourceCommit,
    qualifiedTargets,
  };
}

let packagedBuildMetadata: ColophonBuildMetadata | undefined;

export function readPackagedBuildMetadata(): ColophonBuildMetadata {
  if (packagedBuildMetadata !== undefined) return packagedBuildMetadata;
  try {
    packagedBuildMetadata = parseBuildMetadata(
      JSON.parse(readFileSync(new URL("./build-metadata.json", import.meta.url), "utf8")) as unknown,
    );
    return packagedBuildMetadata;
  } catch (cause) {
    throw new Error(
      `this Colophon installation has missing or invalid build metadata. Reinstall @colophon-claims/cli before trying again. ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export function assertQualifiedRuntime(
  metadata: ColophonBuildMetadata,
  target: RuntimeTarget = { platform: process.platform, architecture: process.arch },
): void {
  const found = `${target.platform}/${target.architecture}`;
  if (metadata.qualifiedTargets.includes(found)) return;
  throw new Error(
    `this Colophon package is not qualified for ${found}. Supported targets: ${metadata.qualifiedTargets.join(", ")}. No benchmark was started and nothing was created. Install a qualified package or use the contributor flow.`,
  );
}
