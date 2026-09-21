export const COMPILER_DEV_DEPENDENCY_NAMES: readonly [
  'typescript',
  '@types/node',
  '@types/semver',
  '@types/ws',
];

export function readPackageJson(root: string): Record<string, unknown>;

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

export function thirdPartyInstallArgs(): string[];

export function packedOverlayInstallArgs(archives: readonly string[]): string[];

export function refreshLockfileArgs(): string[];

export function buildConsumerThirdPartyDependencies(input: {
  operatorManifest: Record<string, unknown>;
  closureManifests: readonly Record<string, unknown>[];
}): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

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

export function installThirdPartyGraph(input: {
  run: (
    command: string,
    args: string[],
    context: string,
    options?: { cwd?: string },
  ) => unknown;
  consumerRoot: string;
  lockfileSource: string;
}): void;
