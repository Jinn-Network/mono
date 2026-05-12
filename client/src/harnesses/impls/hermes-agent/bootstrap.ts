// client/src/harnesses/impls/hermes-agent/bootstrap.ts
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hermesConfigFromSolverPlugins,
  type ConfigBuilderEnv,
  type HermesConfigSnippet,
} from './config-builder.js';

const TOOLSET_ALLOWLIST = [
  'terminal',
  'file',
  'web',
  'skills',
  'memory',
  'session_search',
  'todo',
  'code_execution',
];

// State the per-Task $HERMES_HOME must inherit from the operator's real Hermes
// home so a Jinn-run Hermes task can actually authenticate. Hermes resolves
// OAuth creds from `$HERMES_HOME/auth/google_oauth.json` and pooled creds from
// `$HERMES_HOME/auth.json` — there is NO real-home fallback for the OAuth file
// — so a fresh per-Task $HERMES_HOME (which the freeze contract requires) would
// otherwise have no credentials and Hermes would fail with "No … credentials
// found." We copy these on first use.
//
// Caveat for frozen mode: Hermes may refresh the OAuth access token mid-task,
// which mutates `auth/google_oauth.json` and would trip the daemon hash-fence.
// The freeze-mode workstream (SWE-rebench v2 design §6) should exclude `auth/`
// from the Hermes freeze hash, or pre-refresh the token before a frozen run.
const OPERATOR_STATE_TO_SEED = ['auth', 'auth.json'] as const;

export interface WritePerTaskConfigInputs {
  hermesHome: string;
  workingDir: string;
  model?: string;
  provider?: string;
  solverPluginRoots: readonly string[];
  env: ConfigBuilderEnv;
  /**
   * The operator's real Hermes home (typically `process.env.HERMES_HOME` or
   * `~/.hermes`). Auth credentials are copied from here into the per-Task
   * `hermesHome` on first use. Omit (or pass a path equal to `hermesHome`) to
   * skip seeding — e.g. in tests.
   */
  seedFrom?: string;
}

function seedOperatorState(hermesHome: string, seedFrom: string): void {
  if (seedFrom === hermesHome || !existsSync(seedFrom)) return;
  for (const name of OPERATOR_STATE_TO_SEED) {
    const src = join(seedFrom, name);
    const dst = join(hermesHome, name);
    if (existsSync(src) && !existsSync(dst)) {
      cpSync(src, dst, { recursive: true });
    }
  }
}

function snippetToYaml(snippet: HermesConfigSnippet, opts: { model?: string; provider?: string; workingDir: string }): string {
  const lines: string[] = [];

  // Model block
  if (opts.model || opts.provider) {
    lines.push('model:');
    if (opts.model) lines.push(`  default: "${opts.model}"`);
    if (opts.provider) lines.push(`  provider: "${opts.provider}"`);
    lines.push('');
  }

  // Terminal block
  lines.push('terminal:');
  lines.push('  backend: local');
  lines.push(`  cwd: "${opts.workingDir.replaceAll('"', '\\"')}"`);
  lines.push('  timeout: 180');
  lines.push('');

  // Toolset allowlist
  lines.push('platform_toolsets:');
  lines.push('  hermes-cli:');
  for (const ts of TOOLSET_ALLOWLIST) {
    lines.push(`    - ${ts}`);
  }
  lines.push('');

  // MCP servers (translated from SolverPlugin .mcp.json)
  if (snippet.mcp_servers && Object.keys(snippet.mcp_servers).length > 0) {
    lines.push('mcp_servers:');
    for (const [name, server] of Object.entries(snippet.mcp_servers)) {
      lines.push(`  ${name}:`);
      if ('url' in server) {
        lines.push(`    url: "${server.url}"`);
        if (server.headers) {
          lines.push('    headers:');
          for (const [h, v] of Object.entries(server.headers)) {
            lines.push(`      ${h}: "${v}"`);
          }
        }
      } else {
        lines.push(`    command: "${server.command}"`);
        lines.push('    args:');
        for (const a of server.args) lines.push(`      - "${a}"`);
        if (server.cwd) lines.push(`    cwd: "${server.cwd}"`);
        if (server.env && Object.keys(server.env).length > 0) {
          lines.push('    env:');
          for (const [k, v] of Object.entries(server.env)) {
            lines.push(`      ${k}: "${v.replaceAll('"', '\\"')}"`);
          }
        }
      }
    }
    lines.push('');
  }

  // Skills
  if (snippet.skills?.external_dirs && snippet.skills.external_dirs.length > 0) {
    lines.push('skills:');
    lines.push('  external_dirs:');
    for (const d of snippet.skills.external_dirs) {
      lines.push(`    - "${d}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function snippetToEnvFile(env: ConfigBuilderEnv): string {
  const lines: string[] = [];
  lines.push(`DAEMON_API_URL=${env.daemonApiUrl}`);
  lines.push(`DAEMON_API_TOKEN=${env.daemonApiToken}`);
  if (env.storePath) lines.push(`STORE_PATH=${env.storePath}`);
  if (env.corpusEnv.subgraphUrl) lines.push(`JINN_CORPUS_SUBGRAPH_URL=${env.corpusEnv.subgraphUrl}`);
  if (env.corpusEnv.ipfsGatewayUrl) lines.push(`JINN_CORPUS_IPFS_GATEWAY_URL=${env.corpusEnv.ipfsGatewayUrl}`);
  if (env.corpusEnv.rpcUrl) lines.push(`JINN_CORPUS_RPC_URL=${env.corpusEnv.rpcUrl}`);
  if (env.corpusEnv.chainId != null) lines.push(`JINN_CORPUS_CHAIN_ID=${env.corpusEnv.chainId}`);
  if (env.corpusEnv.identityRegistryAddress) lines.push(`JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS=${env.corpusEnv.identityRegistryAddress}`);
  if (env.corpusEnv.fromBlock != null) lines.push(`JINN_CORPUS_FROM_BLOCK=${env.corpusEnv.fromBlock}`);
  return lines.join('\n') + '\n';
}

export function writePerTaskHermesConfig(inputs: WritePerTaskConfigInputs): void {
  mkdirSync(inputs.hermesHome, { recursive: true });

  if (inputs.seedFrom) {
    seedOperatorState(inputs.hermesHome, inputs.seedFrom);
  }

  const snippet = hermesConfigFromSolverPlugins(inputs.solverPluginRoots, inputs.env);
  const yaml = snippetToYaml(snippet, {
    model: inputs.model,
    provider: inputs.provider,
    workingDir: inputs.workingDir,
  });
  writeFileSync(join(inputs.hermesHome, 'config.yaml'), yaml, 'utf8');

  const envFile = snippetToEnvFile(inputs.env);
  writeFileSync(join(inputs.hermesHome, '.env'), envFile, 'utf8');
}
