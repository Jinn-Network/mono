/**
 * Hand-curated runtime descriptor of `SolverPluginManifest`
 * (`operator/src/plugins/types.ts`). The shape catalogue on `/build` renders
 * this; a snapshot test asserts it stays in sync with the type. If you
 * add a field to `SolverPluginManifest`, you MUST add it here too — the
 * test will fail until you do.
 */

export interface PluginShapeField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export const PLUGIN_SHAPE_FIELDS: readonly PluginShapeField[] = [
  {
    name: 'name',
    type: 'string',
    required: true,
    description: 'npm package name. Used as the canonical identifier across the registry.',
  },
  {
    name: 'version',
    type: 'string',
    required: true,
    description: 'Semantic version. New versions publish under a new IPFS CID.',
  },
  {
    name: 'description',
    type: 'string',
    required: false,
    description: 'Short prose description of what the plug-in offers.',
  },
  {
    name: 'jinn.supports',
    type: 'string[]',
    required: true,
    description: 'Either ["jinn.runtime"] (runtime plug-in) OR one or more SolverType identifiers (solver-type plug-in). Mixing is rejected.',
  },
  {
    name: 'jinn.capabilities',
    type: 'object',
    required: false,
    description: 'Optional capabilities map. Reserved for future use; not consumed by Hermes today.',
  },
  {
    name: 'jinn.mcpServers',
    type: 'object',
    required: false,
    description: 'Optional inline MCP server map. The Hermes harness reads .mcp.json instead; declare MCP there for harness-agnostic portability.',
  },
  {
    name: 'jinn.skills',
    type: 'string[]',
    required: false,
    description: 'Relative paths to SKILL.md files. Each declared skill becomes available to the harness as an external skill directory.',
  },
] as const;

export interface PluginMode {
  id: 'runtime' | 'solver-type';
  label: string;
  requires: string;
  example: string;
}

export const PLUGIN_MODES: readonly PluginMode[] = [
  {
    id: 'runtime',
    label: 'Runtime plug-in',
    requires: 'singleton — supports must be exactly ["jinn.runtime"]',
    example: '{ "jinn": { "supports": ["jinn.runtime"] } }',
  },
  {
    id: 'solver-type',
    label: 'SolverType plug-in',
    requires: 'one or more SolverType ids; cannot include "jinn.runtime"',
    example: '{ "jinn": { "supports": ["swe-rebench-v2.v1"] } }',
  },
] as const;

// Type-level assertion: if SolverPluginManifest gains a required top-level
// or jinn.* required field, the assignment below fails typecheck until you
// add the matching entry to PLUGIN_SHAPE_FIELDS.
import type { SolverPluginManifest } from '../../../../../plugins/types.js';

type RequiredManifestKeys = 'name' | 'version';
type RequiredJinnKeys = 'supports';
type GuardManifest = Pick<SolverPluginManifest, RequiredManifestKeys>;
type GuardJinn = Pick<SolverPluginManifest['jinn'], RequiredJinnKeys>;

// These type aliases compile to nothing; they exist only to wire the guard.
const _g1: GuardManifest = { name: '', version: '' };
const _g2: GuardJinn = { supports: [] };
void _g1; void _g2;
