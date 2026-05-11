// client/src/harnesses/impls/hermes-agent/config-builder.ts
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface McpStdioServer {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export type McpServer = McpStdioServer | McpHttpServer;

export interface HermesConfigSnippet {
  mcp_servers?: Record<string, McpServer>;
  skills?: { external_dirs?: string[] };
}

export interface ConfigBuilderEnv {
  storePath?: string;
  daemonApiUrl: string;
  daemonApiToken: string;
  corpusEnv: {
    subgraphUrl?: string;
    ipfsGatewayUrl?: string;
    rpcUrl?: string;
    chainId?: number;
    identityRegistryAddress?: string;
    fromBlock?: number;
  };
}

function buildJinnRuntimeEnv(env: ConfigBuilderEnv): Record<string, string> {
  const out: Record<string, string> = {
    DAEMON_API_URL: env.daemonApiUrl,
    DAEMON_API_TOKEN: env.daemonApiToken,
  };
  if (env.storePath) out.STORE_PATH = env.storePath;
  if (env.corpusEnv.subgraphUrl) out.JINN_CORPUS_SUBGRAPH_URL = env.corpusEnv.subgraphUrl;
  if (env.corpusEnv.ipfsGatewayUrl) out.JINN_CORPUS_IPFS_GATEWAY_URL = env.corpusEnv.ipfsGatewayUrl;
  if (env.corpusEnv.rpcUrl) out.JINN_CORPUS_RPC_URL = env.corpusEnv.rpcUrl;
  if (env.corpusEnv.chainId != null) out.JINN_CORPUS_CHAIN_ID = String(env.corpusEnv.chainId);
  if (env.corpusEnv.identityRegistryAddress) {
    out.JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS = env.corpusEnv.identityRegistryAddress;
  }
  if (env.corpusEnv.fromBlock != null) out.JINN_CORPUS_FROM_BLOCK = String(env.corpusEnv.fromBlock);
  return out;
}

function resolvePathTemplate(value: string, pluginRoot: string): string {
  // Resolve ${CLAUDE_PLUGIN_ROOT} / ${CODEX_PLUGIN_ROOT} → pluginRoot,
  // then resolve relative paths against pluginRoot.
  const substituted = value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('${CODEX_PLUGIN_ROOT}', pluginRoot);
  if (isAbsolute(substituted)) return substituted;
  return resolve(pluginRoot, substituted);
}

function translateMcpFromFile(pluginRoot: string, jinnEnv: Record<string, string>): Record<string, McpServer> {
  const mcpFile = join(pluginRoot, '.mcp.json');
  if (!existsSync(mcpFile)) return {};

  const raw = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
    mcpServers?: Record<string, McpStdioServer | McpHttpServer>;
  };
  const servers = raw.mcpServers ?? {};
  const out: Record<string, McpServer> = {};

  for (const [name, server] of Object.entries(servers)) {
    if ('url' in server) {
      // HTTP MCP — pass through unchanged (no path resolution needed)
      out[name] = { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
      continue;
    }
    // Stdio MCP — resolve paths and merge env
    const resolvedArgs = server.args.map((a) => resolvePathTemplate(a, pluginRoot));
    const resolvedCwd = server.cwd ? resolvePathTemplate(server.cwd, pluginRoot) : pluginRoot;
    out[name] = {
      command: server.command,
      args: resolvedArgs,
      cwd: resolvedCwd,
      env: { ...jinnEnv, ...(server.env ?? {}) },
    };
  }
  return out;
}

function translateSkillsDir(pluginRoot: string): string | null {
  const skillsDir = join(pluginRoot, 'skills');
  return existsSync(skillsDir) ? skillsDir : null;
}

export function hermesConfigFromSolverPlugins(
  roots: readonly string[],
  env: ConfigBuilderEnv,
): HermesConfigSnippet {
  const jinnEnv = buildJinnRuntimeEnv(env);
  const mcpServers: Record<string, McpServer> = {};
  const externalDirs: string[] = [];

  for (const root of roots) {
    Object.assign(mcpServers, translateMcpFromFile(root, jinnEnv));
    const skills = translateSkillsDir(root);
    if (skills) externalDirs.push(skills);
  }

  const snippet: HermesConfigSnippet = {};
  if (Object.keys(mcpServers).length > 0) snippet.mcp_servers = mcpServers;
  if (externalDirs.length > 0) snippet.skills = { external_dirs: externalDirs };
  return snippet;
}
