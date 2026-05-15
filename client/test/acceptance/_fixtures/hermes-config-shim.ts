/**
 * Local shim for `hermesConfigFromSolverPlugins` (r83r Task 8).
 *
 * When `8psp` (which adds the canonical `hermesConfigFromSolverPlugins` export
 * to the daemon) is not yet merged in this worktree, this shim provides the
 * same function so the cold-start E2E can run without blocking on 8psp landing.
 *
 * Shape mirrors the Hermes harness config format:
 *   { mcp_servers, skills, plugins }
 *
 * The `plugins[]` array is the load-bearing piece for the E2E: the cold-start
 * test asserts that the envelope's `executor.plugins[]` matches what this shim
 * produced when it was handed to stub-Hermes.
 *
 * spec §2.7 shape reference:
 *   mcp_servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
 *   skills:      { external_dirs: string[] }
 *   plugins:     Array<{ name: string; version: string; cid: string; sha256: string }>
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HermesPluginRef {
  /** npm package name. */
  name: string;
  /** Semver. */
  version: string;
  /** IPFS CID of the packed tarball. */
  cid: string;
  /** hex sha256 of the packed tarball (digestDirectory output). */
  sha256: string;
}

export interface HermesConfig {
  mcp_servers: Record<string, McpServerConfig>;
  skills: { external_dirs: string[] };
  plugins: HermesPluginRef[];
}

export interface SolverPluginInput {
  manifest: {
    name: string;
    version: string;
    jinn?: {
      skills?: string[];
    };
    [key: string]: unknown;
  };
  /** IPFS CID of the packed tarball (filled after publish). */
  cid: string;
  /** hex sha256 digest of the directory (digestDirectory output). */
  sha256: string;
  /** Absolute path to the package root on disk. */
  packageRoot: string;
}

/**
 * Translate an array of resolved SolverPlugins into a Hermes harness config.
 *
 * - Reads `<packageRoot>/.mcp.json` (if it exists) to extract MCP server
 *   declarations and expands `${CLAUDE_PLUGIN_ROOT}` placeholders to the
 *   resolved `packageRoot`.
 * - Collects `skills/<name>/SKILL.md` paths from `jinn.skills` in the manifest
 *   (they are directories, so the parent dir is added to `external_dirs`).
 * - Produces `plugins[]` with `{ name, version, cid, sha256 }` — the
 *   attribution fields the envelope assembler reads.
 */
export function hermesConfigFromSolverPlugins(plugins: SolverPluginInput[]): HermesConfig {
  const mcp_servers: Record<string, McpServerConfig> = {};
  const skillDirs = new Set<string>();
  const pluginRefs: HermesPluginRef[] = [];

  for (const plugin of plugins) {
    const { manifest, cid, sha256, packageRoot } = plugin;

    // Collect plugin ref.
    pluginRefs.push({
      name: manifest.name,
      version: manifest.version,
      cid,
      sha256,
    });

    // Collect skill dirs from jinn.skills (each entry is a path like
    // "skills/diffmin/SKILL.md"; the parent dir "skills/diffmin" gets added).
    const skillPaths = manifest.jinn?.skills ?? [];
    for (const skillPath of skillPaths) {
      const skillMdPath = join(packageRoot, skillPath);
      if (existsSync(skillMdPath)) {
        skillDirs.add(join(packageRoot, skillPath.replace(/\/[^/]+$/, '')));
      }
    }

    // Read .mcp.json and expand ${CLAUDE_PLUGIN_ROOT} placeholders.
    const mcpJsonPath = join(packageRoot, '.mcp.json');
    if (existsSync(mcpJsonPath)) {
      try {
        const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as {
          mcpServers?: Record<
            string,
            { command?: string; args?: string[]; env?: Record<string, string> }
          >;
        };
        const servers = mcpJson.mcpServers ?? {};
        for (const [serverName, serverCfg] of Object.entries(servers)) {
          const expandedArgs = (serverCfg.args ?? []).map((arg) =>
            arg.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, packageRoot),
          );
          mcp_servers[serverName] = {
            command: serverCfg.command ?? 'node',
            args: expandedArgs,
            ...(serverCfg.env ? { env: serverCfg.env } : {}),
          };
        }
      } catch {
        // Non-fatal: skip malformed .mcp.json.
      }
    }
  }

  return {
    mcp_servers,
    skills: { external_dirs: [...skillDirs] },
    plugins: pluginRefs,
  };
}
