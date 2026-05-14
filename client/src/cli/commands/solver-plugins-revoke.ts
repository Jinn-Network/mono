import type { CommandContext } from '../command.js';
import type { SolverPluginsDeps } from './solver-plugins.js';

export interface RevokeOptions {
  pluginCid: string;
  reason: string;
  configPath: string | undefined;
  builderAgentIdOverride: bigint | undefined;
}

export async function revokeHandler(
  ctx: CommandContext,
  _opts: RevokeOptions,
  _deps: SolverPluginsDeps,
): Promise<void> {
  ctx.writer.write(JSON.stringify({ error: { code: 'not_implemented', message: 'revoke handler — implemented in Task 10' } }) + '\n');
  ctx.exit(1);
}
