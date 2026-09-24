export const COMPILER_DEV_DEPENDENCY_NAMES: readonly [
  'typescript',
  '@types/node',
  '@types/semver',
  '@types/ws',
];

export function noLocalSpec(value: unknown, context: string): void;

export function sanitizedManifest(
  manifest: Record<string, unknown>,
  context: string,
  stripDevelopment?: boolean,
): Record<string, unknown>;

export function readPackageJson(root: string): Record<string, unknown>;

export function requirePackageRoot(
  packageRoots: Map<string, string>,
  name: string,
): string;

export function discoverPackageRoots(
  root: string,
  found?: Map<string, string>,
): Map<string, string>;

export function closurePackageNames(
  clientManifest: Record<string, unknown>,
  packageRoots: Map<string, string>,
): string[];

export function packedClosurePackageNames(
  operatorManifest: Record<string, unknown>,
  packageRoots: Map<string, string>,
): string[];

export function pinnedInstallArgs(): string[];

export function packedOverlayInstallArgs(archives: readonly string[]): string[];

export function refreshLockfileArgs(): string[];

export function buildConsumerThirdPartyDependencies(input: {
  operatorManifest: Record<string, unknown>;
  closureManifests: readonly Record<string, unknown>[];
}): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

export function firstPartyArchiveDependencies(
  consumerRoot: string,
  archives: Iterable<readonly [string, string]>,
): Record<string, string>;

export function withoutLocalArchiveIntegrity<
  T extends { packages?: Record<string, Record<string, unknown>> },
>(lock: T): T & { packages: Record<string, Record<string, unknown>> };

export function consumerManifest(input: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): {
  name: 'jinn-hermetic-packed-closure';
  private: true;
  type: 'module';
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

export function writeConsumerPackageJson(
  consumerRoot: string,
  fields: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
): void;

export function fixtureDir(scriptsRoot: string): string;

export function fixtureLockfilePath(scriptsRoot: string): string;

export function assertFixtureLockfilePresent(scriptsRoot: string): string;

export function installPinnedGraph(input: {
  run: (
    command: string,
    args: string[],
    context: string,
    options?: { cwd?: string },
  ) => unknown;
  consumerRoot: string;
  lockfileSource: string;
}): void;
