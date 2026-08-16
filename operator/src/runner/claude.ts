import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Task, TaskResult } from '../types/index.js';
import type { Runner, RunnerContext } from './runner.js';
import { Store } from '../store/store.js';
import { tracedSpawn } from '../trajectory/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** MCP subprocess: compiled `server.js` when present, else `node --import tsx server.ts` (dev / yarn e2e). */
function resolveJinnMcpLauncher(explicitPath?: string): { command: string; args: string[] } {
  if (explicitPath) {
    return { command: process.execPath, args: [explicitPath] };
  }
  const mcpDir = join(__dirname, '..', 'mcp');
  const js = join(mcpDir, 'server.js');
  const ts = join(mcpDir, 'server.ts');
  if (existsSync(js)) {
    return { command: process.execPath, args: [js] };
  }
  if (existsSync(ts)) {
    return { command: process.execPath, args: ['--import', 'tsx', ts] };
  }
  return { command: process.execPath, args: [js] };
}

export interface ClaudeRunnerConfig {
  claudePath?: string;
  model?: string;
  mcpServerPath?: string;
}

export class ClaudeRunner implements Runner {
  private claudePath: string;
  private model?: string;
  private readonly mcpLauncher: { command: string; args: string[] };

  constructor(config: ClaudeRunnerConfig = {}) {
    this.claudePath = config.claudePath ?? 'claude';
    this.model = config.model;
    this.mcpLauncher = resolveJinnMcpLauncher(config.mcpServerPath);
  }

  async run(task: Task, context: RunnerContext): Promise<TaskResult> {
    const prompt = buildPrompt(task);

    // Write MCP config to temp dir
    const tmpDir = mkdtempSync(join(tmpdir(), 'jinn-runner-'));
    const mcpConfigPath = join(tmpDir, 'mcp-config.json');

    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        'jinn-client': {
          command: this.mcpLauncher.command,
          args: this.mcpLauncher.args,
          env: {
            DESIRED_STATE_ID: task.id,
            DESIRED_STATE_DESCRIPTION: task.description,
            DESIRED_STATE_CONTEXT: task.context ? JSON.stringify(task.context) : '',
            DESIRED_STATE_ROLE: task.role ?? '',
            RESTORATION_REQUEST_ID: task.restorationRequestId ?? '',
            REQUEST_ID: context.requestId,
            RESTORATION_DELIVERY_DATA: task.role === 'evaluation' && task.context?.restorationResult
              ? JSON.stringify(task.context.restorationResult)
              : '',
            STORE_PATH: context.storePath ?? '',
            DAEMON_API_URL: context.daemonApiUrl ?? '',
            // Bearer token for the daemon's cost-mutating routes. MCP
            // subprocess attaches this as `Authorization: Bearer <token>`
            // on fetches to `POST /v1/artifacts/acquire` and
            // `POST /artifacts`. Empty string when unset → daemon returns 401.
            DAEMON_API_TOKEN: context.daemonApiToken ?? '',
            // Discovery indexer + IPFS gateway — both keyless. The agent EOA
            // private key NEVER leaves the daemon process; acquire_artifact
            // proxies through DAEMON_API_URL instead.
            JINN_DISCOVERY_URL: context.corpusEnv?.discoveryUrl ?? '',
            JINN_DISCOVERY_MODE: context.corpusEnv?.discoveryUrl ? 'http' : 'onchain',
            JINN_CORPUS_IPFS_GATEWAY_URL: context.corpusEnv?.ipfsGatewayUrl ?? '',
            JINN_CORPUS_RPC_URL: context.corpusEnv?.rpcUrl ?? '',
            JINN_CORPUS_CHAIN_ID: context.corpusEnv?.chainId != null ? String(context.corpusEnv.chainId) : '',
            JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS: context.corpusEnv?.identityRegistryAddress ?? '',
            JINN_CORPUS_FROM_BLOCK: context.corpusEnv?.fromBlock != null ? String(context.corpusEnv.fromBlock) : '',
          },
        },
      },
    }));

    try {
      if (context.trajectory) {
        // Traced path — wrap spawn with tracedSpawn so the subprocess lifetime
        // surfaces as a jinn.state_transition span in the run's trajectory.
        const agentEnv = buildAgentEnv();
        const args = buildAgentArgs(prompt, mcpConfigPath, this.model);
        console.log(`[runner] Spawning agent (traced): ${this.claudePath} ${args.slice(0, 3).join(' ')} ... (timeout: ${context.timeoutMs}ms)`);
        const result = await tracedSpawn({
          collector: context.trajectory,
          cmd: this.claudePath,
          args,
          env: agentEnv,
          stateFrom: 'PREPARED',
          stateTo: 'RAN_CLAUDE',
        });
        console.log(`[runner] Agent process exited (exitCode: ${result.exitCode})`);
        if (result.exitCode !== 0) {
          throw new Error(`Agent exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
        }
      } else {
        await spawnAgent(this.claudePath, prompt, mcpConfigPath, this.model, context.timeoutMs);
      }

      // Read result from store — the MCP tool published it as an artifact
      if (context.storePath) {
        const store = new Store(context.storePath);
        try {
          const isEvaluation = task.role === 'evaluation';
          const tag = isEvaluation ? 'evaluation-verdict' : 'restoration-result';
          const artifact = store.getArtifactByRequestId(context.requestId, tag);
          if (artifact) {
            return { data: artifact.content };
          }
        } finally {
          store.close();
        }
      }

      return { data: '' };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export function buildPrompt(task: Task): string {
  let contextSection = '';
  if (task.context && Object.keys(task.context).length > 0) {
    contextSection = `\n## Context\n${JSON.stringify(task.context, null, 2)}\n`;
  }

  const isEvaluation = task.role === 'evaluation';

  const instructions = isEvaluation
    ? `## Instructions
1. Use get_task to understand what was requested
2. Use get_restoration_delivery to fetch the restoration result
3. Evaluate whether the solution satisfied the Task
4. Use submit_restoration_result to report your verdict
5. Use report_progress to log progress along the way
6. Optionally use publish_artifact to record any insights`
    : `## Instructions
1. Use get_task to understand what needs to be restored
2. Take the necessary actions to restore it
3. Use submit_restoration_result to report what you did
4. Use report_progress to log progress along the way
5. Optionally use publish_artifact to record any insights`;

  return `You are ${isEvaluation ? 'evaluating a solution' : 'solving a Task'}.

## Task
ID: ${task.id}
Description: ${task.description}
${contextSection}
${instructions}

Work autonomously. Do not ask questions.`;
}

// Environment allowlist for agent subprocess — only pass what's needed.
// The agent must never see private keys, operator passwords, or secrets.
//
// CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are explicit auth paths for
// Claude Code itself (equivalent to `claude auth login` / `claude
// setup-token`). Headless Docker deployments need them forwarded — without
// them the spawned agent always fails with "Not logged in". They are Claude
// credentials, not Jinn operator secrets, so forwarding is scoped and
// intentional.
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'NODE_PATH',
  'NODE_OPTIONS',
  'NPM_CONFIG_PREFIX',
  // Claude Code auth — needed in Docker where keychain is unavailable.
  // CLAUDE_CODE_OAUTH_TOKEN is the output of `claude setup-token` (subscription
  // path, year-long validity); ANTHROPIC_API_KEY is the pay-per-request fallback.
  // Both are Claude credentials, not Jinn operator secrets, so forwarding is
  // scoped and intentional. Without these the spawned `claude -p …` fails with
  // "Not logged in · Please run /login".
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];

const ENV_BLOCKLIST = [
  'PRIVATE_KEY',
  'SECRET',
  'PASSWORD',
  'OPERATOR',
  'MNEMONIC',
  'KEYSTORE',
  'API_KEY',
  'AUTH_TOKEN',
  'SERVICE_ROLE',
];

function buildAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function buildAgentArgs(prompt: string, mcpConfigPath: string, model?: string): string[] {
  const args = ['-p', prompt, '--mcp-config', mcpConfigPath, '--strict-mcp-config'];
  if (model) args.push('--model', model);
  args.push('--allowedTools', 'mcp__jinn-client__*');
  return args;
}

function spawnAgent(claudePath: string, prompt: string, mcpConfigPath: string, model?: string, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildAgentArgs(prompt, mcpConfigPath, model);

    console.log(`[runner] Spawning agent: ${claudePath} ${args.slice(0, 3).join(' ')} ... (timeout: ${timeoutMs}ms)`);

    const agentEnv = buildAgentEnv();
    const child = spawn(claudePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: agentEnv,
      timeout: timeoutMs,
    });

    console.log(`[runner] Agent process spawned (pid: ${child.pid})`);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      // Stream output as it arrives
      const lines = d.toString().trim();
      if (lines) console.log(`[runner:stdout] ${lines.slice(0, 200)}`);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      const lines = d.toString().trim();
      if (lines) console.error(`[runner:stderr] ${lines.slice(0, 200)}`);
    });

    child.on('exit', (code, signal) => {
      console.log(`[runner] Agent process exited (code: ${code}, signal: ${signal})`);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Agent exited with code ${code}, signal ${signal}: ${stderr.slice(0, 500)}`));
      }
    });

    child.on('error', (err) => {
      console.error(`[runner] Agent spawn error:`, err.message);
      reject(err);
    });
  });
}
