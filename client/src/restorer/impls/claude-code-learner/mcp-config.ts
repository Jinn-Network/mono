/**
 * MCP-server config merger for Path 1 plug-ins. The Claude Code adapter
 * spawns the harness with a baseline `mcpServers` map (in-repo MCP
 * tools); this helper extends that map with `mcp-tool` and
 * `memory-backend` slots from the loaded plug-in registry.
 *
 * Slot key resolution:
 *   - mcp-tool        → `slot.namespace ?? plugInName`
 *   - memory-backend  → `memory-<plugInName>` (always prefixed so the
 *                       memory-consolidation skill can pattern-match)
 *
 * Collisions with the baseline (or between two plug-ins) throw — the
 * loader cannot silently overwrite an in-repo MCP server.
 *
 * Spec: spec/2026-04-30-plug-in-surface.md §4 (slots: mcp-tool,
 * memory-backend). Plan tasks 9 + 11.
 *
 * Slot integrations rely on Claude Code's `--mcp-config` argument; this
 * module only assembles the JSON shape — it does not write it to disk
 * or pass it to the adapter. The adapter materialises this output as a
 * temp `.mcp.json` and points the harness at it.
 */

import type { RegistrySlot } from '../../plug-ins/registry.js';
import type {
  McpToolSlot,
  MemoryBackendSlot,
} from '../../plug-ins/types.js';

export interface McpServerEntry {
  command: string;
  args: readonly string[];
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export function mergeMcpConfig(
  baseline: McpConfig,
  slots: ReadonlyArray<RegistrySlot<McpToolSlot>>,
): McpConfig {
  const out: McpConfig = { mcpServers: { ...baseline.mcpServers } };
  for (const reg of slots) {
    const key = reg.slot.namespace ?? reg.plugInName;
    if (key in out.mcpServers) {
      throw new Error(
        `MCP server name collision: ${key} (already in baseline or another plug-in)`,
      );
    }
    out.mcpServers[key] = { command: reg.slot.command, args: reg.slot.args };
  }
  return out;
}

export function mergeMemoryBackendsIntoMcpConfig(
  baseline: McpConfig,
  slots: ReadonlyArray<RegistrySlot<MemoryBackendSlot>>,
): McpConfig {
  const out: McpConfig = { mcpServers: { ...baseline.mcpServers } };
  for (const reg of slots) {
    const key = `memory-${reg.plugInName}`;
    if (key in out.mcpServers) {
      throw new Error(`MCP server name collision: ${key}`);
    }
    out.mcpServers[key] = { command: reg.slot.command, args: reg.slot.args };
  }
  return out;
}

/**
 * Skill-bundle integration uses Claude Code's `--plugin-dir` argument:
 * each plug-in's package root is its own loaded plugin. The bundled
 * claude-code-learner plugin always ships first; plug-in skill bundles
 * extend the list. See plan Task 10.
 */
export interface SerialisedRegistryLike {
  skillBundles: ReadonlyArray<{ packageRoot: string; slot: { skillsDir: string } }>;
}

export function pluginDirsForSession(
  registry: SerialisedRegistryLike,
  bundledPluginRoot: string,
): string[] {
  const dirs: string[] = [bundledPluginRoot];
  for (const r of registry.skillBundles) {
    dirs.push(r.packageRoot);
  }
  return dirs;
}
