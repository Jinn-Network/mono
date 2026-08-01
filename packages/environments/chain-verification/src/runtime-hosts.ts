// SPDX-License-Identifier: Apache-2.0

/**
 * The three seams that let this package speak to a running simulator without holding any
 * ambient authority. A host that runs Anvil in a container, a host that runs a local binary,
 * and a test that runs neither all satisfy these; nothing here knows which it got.
 */

export interface SpawnedProcess {
  readonly pid: string;
  /** Runner-local endpoint the RPC transport dials. Never a public address. */
  readonly endpoint: string;
  wait(): Promise<{ readonly exitCode: number; readonly stderr: string }>;
  kill(): Promise<void>;
}

export interface ProcessHost {
  spawn(request: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<SpawnedProcess>;
}

export interface RpcTransport {
  send(request: {
    readonly endpoint: string;
    readonly method: string;
    readonly params: readonly unknown[];
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface WorkspaceHost {
  create(instanceId: string): Promise<{ readonly path: string }>;
  write(path: string, name: string, bytes: Uint8Array): Promise<string>;
  destroy(path: string): Promise<void>;
}

/** Materializer introspection RPC answered by the host or test fake. */
export const MATERIALIZATION_SNAPSHOT_RPC = "jinn_materializationSnapshot" as const;

export interface MaterializationSnapshot {
  readonly artifactEntries: {
    readonly accounts: readonly string[];
    readonly codeEntries: readonly string[];
    readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
  };
  readonly postFixtureCommitment: `0x${string}`;
}
