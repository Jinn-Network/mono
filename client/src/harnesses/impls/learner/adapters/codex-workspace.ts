import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

export interface CodexMcpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PreparedCodexWorkspace {
  pluginRoots: string[];
  skillLinks: string[];
  mcpServers: Record<string, CodexMcpServerConfig>;
  marketplacePath: string;
  configArgs: string[];
}

export interface PrepareCodexWorkspaceInput {
  workingDir: string;
  pluginRoots: string[];
  clientRoot: string;
  mcpEnv?: Record<string, string>;
  copyPlugins?: boolean;
}

interface CodexPluginManifest {
  name?: string;
  skills?: string;
  mcpServers?: string;
}

interface PluginInfo {
  name: string;
  manifest: CodexPluginManifest | null;
}

interface CodexMarketplacePlugin {
  name: string;
  source: {
    source: 'local';
    path: string;
  };
  policy: {
    installation: 'INSTALLED_BY_DEFAULT';
    authentication: 'NONE';
  };
  category: 'Coding';
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function readCodexManifest(root: string): CodexPluginManifest | null {
  const raw = readJson(join(root, '.codex-plugin', 'plugin.json'));
  if (!raw) return null;
  return {
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
    ...(typeof raw['skills'] === 'string' ? { skills: raw['skills'] } : {}),
    ...(typeof raw['mcpServers'] === 'string' ? { mcpServers: raw['mcpServers'] } : {}),
  };
}

function pluginInfo(root: string): PluginInfo {
  const manifest = readCodexManifest(root);
  return {
    name: manifest?.name && manifest.name.trim() ? manifest.name.trim() : basename(root),
    manifest,
  };
}

function cleanSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
}

function removeIfExists(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { force: true, recursive: true });
}

function materializePluginRoot(sourceRoot: string, targetRoot: string, copy: boolean): void {
  removeIfExists(targetRoot);
  mkdirSync(resolve(targetRoot, '..'), { recursive: true });
  if (copy) {
    cpSync(sourceRoot, targetRoot, { recursive: true, dereference: true });
    return;
  }
  try {
    symlinkSync(sourceRoot, targetRoot, 'dir');
  } catch {
    cpSync(sourceRoot, targetRoot, { recursive: true, dereference: true });
  }
}

function skillDirs(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const stat = lstatSync(skillsRoot);
  if (stat.isDirectory() && existsSync(join(skillsRoot, 'SKILL.md'))) return [skillsRoot];
  if (!stat.isDirectory()) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'SKILL.md')));
}

function configPath(parts: string[]): string {
  return parts.map((part) =>
    /^[A-Za-z0-9_-]+$/.test(part)
      ? part
      : `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  ).join('.');
}

function configValue(value: string | string[]): string {
  return JSON.stringify(value);
}

function toConfigArgs(servers: Record<string, CodexMcpServerConfig>): string[] {
  const args: string[] = [];
  for (const [name, server] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    const prefix = ['mcp_servers', name];
    args.push(`${configPath([...prefix, 'command'])}=${configValue(server.command)}`);
    if (server.args) args.push(`${configPath([...prefix, 'args'])}=${configValue(server.args)}`);
    if (server.cwd) args.push(`${configPath([...prefix, 'cwd'])}=${configValue(server.cwd)}`);
    if (server.env) {
      for (const [key, value] of Object.entries(server.env).sort(([a], [b]) => a.localeCompare(b))) {
        args.push(`${configPath([...prefix, 'env', key])}=${configValue(value)}`);
      }
    }
  }
  return args;
}

function writeMarketplace(
  workingDir: string,
  plugins: CodexMarketplacePlugin[],
): string {
  const marketplacePath = join(workingDir, '.agents', 'plugins', 'marketplace.json');
  mkdirSync(resolve(marketplacePath, '..'), { recursive: true });
  writeFileSync(marketplacePath, JSON.stringify({
    name: 'jinn-runtime',
    interface: {
      displayName: 'Jinn Runtime',
    },
    plugins,
  }, null, 2));
  return marketplacePath;
}

function resolveRelative(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function readMcpServers(
  projectedRoot: string,
  manifest: CodexPluginManifest | null,
  pluginName: string,
  clientRoot: string,
  mcpEnv: Record<string, string>,
): Record<string, CodexMcpServerConfig> {
  const rel = manifest?.mcpServers;
  if (!rel) return {};
  const raw = readJson(resolveRelative(projectedRoot, rel));
  const mcpServers = raw?.['mcpServers'];
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return {};

  const out: Record<string, CodexMcpServerConfig> = {};
  for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record['command'] !== 'string') continue;
    const args = Array.isArray(record['args'])
      ? record['args'].filter((item): item is string => typeof item === 'string')
      : undefined;
    const cwd = typeof record['cwd'] === 'string'
      ? resolveRelative(projectedRoot, record['cwd'])
      : projectedRoot;
    const declaredEnv = record['env'] && typeof record['env'] === 'object' && !Array.isArray(record['env'])
      ? Object.fromEntries(
          Object.entries(record['env'] as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : {};
    out[name] = {
      command: record['command'],
      ...(args ? { args } : {}),
      cwd,
      env: {
        ...mcpEnv,
        ...(pluginName === 'network-tools' ? { JINN_NETWORK_TOOLS_CLIENT_ROOT: clientRoot } : {}),
        ...declaredEnv,
      },
    };
  }
  return out;
}

export function prepareCodexPluginWorkspace(input: PrepareCodexWorkspaceInput): PreparedCodexWorkspace {
  const pluginRoots = Array.from(new Set(input.pluginRoots.map((root) => resolve(root))));
  const projectedPluginsDir = join(input.workingDir, 'plugins');
  const skillsDir = join(input.workingDir, '.agents', 'skills');
  mkdirSync(projectedPluginsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  const projectedRoots: string[] = [];
  const skillLinks: string[] = [];
  const mcpServers: Record<string, CodexMcpServerConfig> = {};
  const marketplacePlugins: CodexMarketplacePlugin[] = [];

  for (const root of pluginRoots) {
    const info = pluginInfo(root);
    const safeName = cleanSegment(info.name);
    const projectedRoot = join(projectedPluginsDir, safeName);
    materializePluginRoot(root, projectedRoot, Boolean(input.copyPlugins));
    projectedRoots.push(projectedRoot);
    marketplacePlugins.push({
      name: safeName,
      source: {
        source: 'local',
        path: `./plugins/${safeName}`,
      },
      policy: {
        installation: 'INSTALLED_BY_DEFAULT',
        authentication: 'NONE',
      },
      category: 'Coding',
    });

    const skillsPath = info.manifest?.skills
      ? resolveRelative(projectedRoot, info.manifest.skills)
      : join(projectedRoot, 'skills');
    for (const dir of skillDirs(skillsPath)) {
      const link = join(skillsDir, `${safeName}__${basename(dir)}`);
      removeIfExists(link);
      try {
        symlinkSync(dir, link, 'dir');
      } catch {
        cpSync(dir, link, { recursive: true, dereference: true });
      }
      skillLinks.push(link);
    }

    Object.assign(
      mcpServers,
      readMcpServers(projectedRoot, info.manifest, safeName, input.clientRoot, input.mcpEnv ?? {}),
    );
  }

  return {
    pluginRoots: projectedRoots,
    skillLinks,
    mcpServers,
    marketplacePath: writeMarketplace(input.workingDir, marketplacePlugins),
    configArgs: toConfigArgs(mcpServers),
  };
}
