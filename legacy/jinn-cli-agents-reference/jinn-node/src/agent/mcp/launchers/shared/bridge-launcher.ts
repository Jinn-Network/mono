import { spawn, type ChildProcess } from 'child_process';
import { getCredential } from '../../../shared/credential-client.js';

type SpawnLike = typeof spawn;
type GetCredentialLike = typeof getCredential;

export interface BridgeMcpLauncherOptions {
  provider: string;
  command: string;
  args: string[] | ((token: string) => string[]);
  tokenEnvVar?: string;
  env?: Record<string, string>;
}

export interface BridgeMcpLauncherDeps {
  getCredentialFn?: GetCredentialLike;
  spawnFn?: SpawnLike;
}

function waitForChildExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * Launch an external MCP process using a bridge-fetched credential.
 * Token is injected only into the spawned MCP process (never global process.env).
 */
export async function launchBridgeBackedMcp(
  options: BridgeMcpLauncherOptions,
  deps: BridgeMcpLauncherDeps = {}
): Promise<number> {
  const getCredentialImpl = deps.getCredentialFn ?? getCredential;
  const spawnImpl = deps.spawnFn ?? spawn;

  const token = await getCredentialImpl(options.provider);
  const args = typeof options.args === 'function' ? options.args(token) : options.args;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
  };

  if (options.tokenEnvVar) {
    env[options.tokenEnvVar] = token;
  }

  const child = spawnImpl(options.command, args, {
    env,
    stdio: 'inherit',
  });

  return waitForChildExit(child);
}

