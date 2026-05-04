import type { SolverPluginManifest } from './types.js';

import * as AjvModule from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';

const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (
  opts: Record<string, unknown>,
) => AjvModule.default;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (
  ajv: AjvModule.default,
) => void;
const ajv = new AjvCtor({ allErrors: true, strict: false });
addFormats(ajv);

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
  assertRecord(jinn, 'manifest.jinn');
  if ('solverType' in jinn || 'schemas' in jinn) {
    throw new Error('SolverNet contracts own canonical solverType and schemas; plugin manifests must declare manifest.jinn.supports only');
  }
  const supports = jinn['supports'];
  if (!Array.isArray(supports) || supports.length === 0 || supports.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error('manifest.jinn.supports must be a non-empty string array');
  }
  // Two exclusive modes (per spec/2026-05-01-harness-pack-architecture.md §5.1):
  //   - Runtime plugin: supports === ['jinn.runtime'] (singleton, no SolverType entries).
  //   - SolverType plugin: every entry is a SolverType identifier; 'jinn.runtime' may not appear.
  // Mixed mode is rejected so a SolverType plugin can't claim runtime status to bypass solverType checks.
  const hasRuntime = supports.includes('jinn.runtime');
  if (hasRuntime && supports.length !== 1) {
    throw new Error(
      `manifest.jinn.supports may not mix 'jinn.runtime' with SolverType identifiers; got [${supports.join(', ')}]`,
    );
  }
  return input as unknown as SolverPluginManifest;
}

export function validateWithSchema(schema: Record<string, unknown>, value: unknown): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(ajv.errorsText(validate.errors, { separator: '; ' }));
  }
}
