export const SAMPLE_LIFECYCLE_MODES: Readonly<{
  CONTRIBUTOR_PROOF: "contributor-proof";
  PRODUCT_DEMO: "product-demo";
}>;

export interface SampleLifecycleEvent {
  readonly type: "progress" | "result";
  readonly stage?: string;
  readonly label?: string;
  readonly message?: string;
  readonly ok?: boolean;
  readonly mode?: "contributor-proof" | "product-demo";
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}

export interface SampleLifecycleResult {
  readonly package: string;
  readonly runtime: string;
  readonly interface: string;
  readonly venue: string;
  readonly ambientCredentialsForwarded: false;
  readonly ambientNetworkConfigurationForwarded: false;
  readonly sampleContract: {
    readonly accountRequired: false;
    readonly apiKeyRequired: false;
    readonly fundsRequired: false;
    readonly dockerRequired: false;
    readonly providerCallsMade: false;
  };
  readonly sourceWorkspaceDeleted: true;
  readonly arms: readonly string[];
  readonly conclusion: string;
  readonly expectedCells: number;
  readonly quoteCells: number;
  readonly resumedOutstandingCells: number;
  readonly runOutcome: string;
  readonly digests: {
    readonly benchmarkSha256: string;
    readonly runSha256: string;
    readonly matrixSha256: string;
    readonly reportSha256: string;
    readonly bundleIdentity: string;
  };
  readonly workspaceChecks: readonly string[];
  readonly portableChecks: readonly string[];
  readonly commands: readonly { readonly label: string; readonly exitCode: number }[];
  readonly mode?: "product-demo";
  readonly output?: {
    readonly root: string;
    readonly bundle: string;
    readonly retained: true;
  };
  readonly cleanup: { readonly temporaryRootRemoved: true };
}

export interface ProductDemoLifecycleResult extends SampleLifecycleResult {
  readonly mode: "product-demo";
  readonly output: {
    readonly root: string;
    readonly bundle: string;
    readonly retained: true;
  };
}

export function runSampleLifecycle(options: {
  readonly mode: "product-demo";
  readonly outputRoot: string;
  readonly temporaryBase?: string;
  readonly onProgress?: (event: SampleLifecycleEvent) => void;
  readonly prepareBuild?: (input: { readonly emit: (event: SampleLifecycleEvent) => void }) => void;
}): ProductDemoLifecycleResult;

export function runSampleLifecycle(options?: {
  readonly mode?: "contributor-proof" | "product-demo";
  readonly outputRoot?: string;
  readonly temporaryBase?: string;
  readonly onProgress?: (event: SampleLifecycleEvent) => void;
  readonly prepareBuild?: (input: { readonly emit: (event: SampleLifecycleEvent) => void }) => void;
}): SampleLifecycleResult;
