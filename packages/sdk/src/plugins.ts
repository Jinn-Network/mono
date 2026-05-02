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
  jinn?: {
    supports?: string[];
    capabilities?: Record<string, unknown>;
    mcpServers?: Record<string, unknown>;
    skills?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LoadedSolverPlugin {
  name: string;
  version: string;
  supports: string[];
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

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function validateSolverPluginManifest(input: unknown): SolverPluginManifest {
  assertRecord(input, 'manifest');
  for (const key of Object.keys(input)) {
    if (key.startsWith('jinn.')) {
      throw new Error(`unknown top-level jinn extension key: ${key}; use manifest.jinn`);
    }
  }
  if (typeof input['name'] !== 'string' || input['name'].length === 0) {
    throw new Error('manifest.name is required');
  }
  if (typeof input['version'] !== 'string' || input['version'].length === 0) {
    throw new Error('manifest.version is required');
  }
  const jinn = input['jinn'];
  if (jinn !== undefined) {
    assertRecord(jinn, 'manifest.jinn');
    if ('solverType' in jinn) {
      throw new Error('manifest.jinn.solverType is no longer supported; SolverNet contracts define solverType authority');
    }
    if ('schemas' in jinn) {
      throw new Error('manifest.jinn.schemas is no longer supported; SolverNet contracts define canonical schemas');
    }
    const supports = jinn['supports'];
    if (supports !== undefined) {
      if (!Array.isArray(supports)) throw new Error('manifest.jinn.supports must be an array');
      for (const [idx, value] of supports.entries()) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`manifest.jinn.supports[${idx}] must be a non-empty string`);
        }
      }
    }
    if (jinn['capabilities'] !== undefined) assertRecord(jinn['capabilities'], 'manifest.jinn.capabilities');
    if (jinn['mcpServers'] !== undefined) assertRecord(jinn['mcpServers'], 'manifest.jinn.mcpServers');
    const skills = jinn['skills'];
    if (skills !== undefined) {
      if (!Array.isArray(skills)) throw new Error('manifest.jinn.skills must be an array');
      for (const [idx, value] of skills.entries()) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`manifest.jinn.skills[${idx}] must be a non-empty string`);
        }
      }
    }
  }
  return input as unknown as SolverPluginManifest;
}
