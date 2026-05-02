import type { JSONSchemaType } from 'ajv';

export type SolverPluginSourceKind =
  | 'bundled'
  | 'local'
  | 'npm'
  | 'git'
  | 'github'
  | 'claude';

export type SolverPluginEntry =
  | string
  | {
      name?: string;
      source: string;
      version?: string;
    };

export interface SolverPluginManifest {
  name: string;
  version: string;
  description?: string;
  jinn: {
    solverType: string;
    schemas: {
      task: JSONSchemaType<unknown> | Record<string, unknown>;
      solution: JSONSchemaType<unknown> | Record<string, unknown>;
      verdict: JSONSchemaType<unknown> | Record<string, unknown>;
    };
    mcpServers?: Record<string, unknown>;
    skills?: string[];
  };
  [key: string]: unknown;
}

export interface LoadedSolverPlugin {
  name: string;
  version: string;
  solverType: string;
  source: string;
  sourceKind: SolverPluginSourceKind;
  root: string;
  manifestPath: string;
  manifest: SolverPluginManifest;
  sha256: string;
  cid?: string;
}

export interface ResolveSolverPluginOptions {
  bundledRoot?: string;
  vendorRoot?: string;
}
