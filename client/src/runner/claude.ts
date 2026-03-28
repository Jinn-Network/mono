import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { DesiredState, RestorationResult } from '../types/index.js';
import type { Runner, RunnerContext } from './runner.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

export interface ClaudeRunnerConfig {
  claudePath?: string;
  model?: string;
  mcpServerPath?: string;
}

export class ClaudeRunner implements Runner {
  private claudePath: string;
  private model?: string;
  private mcpServerPath: string;

  constructor(config: ClaudeRunnerConfig = {}) {
    this.claudePath = config.claudePath ?? 'claude';
    this.model = config.model;
    this.mcpServerPath = config.mcpServerPath ?? join(__dirname, '..', 'mcp', 'server.ts');
  }

  async run(desiredState: DesiredState, context: RunnerContext): Promise<RestorationResult> {
    const prompt = buildPrompt(desiredState);

    // Write MCP config to temp dir
    const tmpDir = mkdtempSync(join(tmpdir(), 'jinn-runner-'));
    const mcpConfigPath = join(tmpDir, 'mcp-config.json');

    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        'jinn-client': {
          command: 'npx',
          args: ['tsx', this.mcpServerPath],
          env: {
            DESIRED_STATE_ID: desiredState.id,
            DESIRED_STATE_DESCRIPTION: desiredState.description,
            DESIRED_STATE_CONTEXT: desiredState.context ? JSON.stringify(desiredState.context) : '',
            DESIRED_STATE_TYPE: desiredState.type ?? '',
            RESTORATION_REQUEST_ID: desiredState.restorationRequestId ?? '',
            REQUEST_ID: context.requestId,
          },
        },
      },
    }));

    try {
      const output = await spawnAgent(this.claudePath, prompt, mcpConfigPath, this.model, context.timeoutMs);
      return { data: output };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export function buildPrompt(desiredState: DesiredState): string {
  let contextSection = '';
  if (desiredState.context && Object.keys(desiredState.context).length > 0) {
    contextSection = `\n## Context\n${JSON.stringify(desiredState.context, null, 2)}\n`;
  }

  return `You are restoring a desired state.

## Desired State
ID: ${desiredState.id}
Description: ${desiredState.description}
${contextSection}
## Instructions
1. Use get_desired_state to understand what needs to be restored
2. Take the necessary actions to restore it
3. Use submit_restoration_result to report what you did
4. Use report_progress to log progress along the way

Work autonomously. Do not ask questions.`;
}

// Environment allowlist for agent subprocess — only pass what's needed.
// The agent must never see private keys, operator passwords, or secrets.
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

function spawnAgent(claudePath: string, prompt: string, mcpConfigPath: string, model?: string, timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--mcp-config', mcpConfigPath];
    if (model) args.push('--model', model);
    args.push('--allowedTools', 'mcp__jinn-client__*');

    const child = spawn(claudePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildAgentEnv(),
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Agent exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    child.on('error', reject);
  });
}
