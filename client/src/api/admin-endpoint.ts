/**
 * Admin endpoints for operator MCP write tools.
 *
 * Mounted only when ui auth is configured (so they're token-gated). Currently
 * supports: daemon_restart (real, exits the process gracefully), manual reward
 * claims, and loop pause/resume (stubbed — returns not_implemented).
 */
import type { Hono } from 'hono';
import type { CommandContext, CommandModule } from '../cli/command.js';
import claimRewardsCommand from '../cli/commands/claim-rewards.js';

export interface AdminEndpointConfig {
  onRestartRequested: () => void;
}

async function runCommandJson(
  command: CommandModule,
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ body: unknown; exitCode: number | null; raw: string }> {
  const chunks: string[] = [];
  let exitCode: number | null = null;
  const writer = {
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
  };
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer,
    exit: (code) => { exitCode = code; },
    env,
  };
  await command.run(ctx);
  const raw = chunks.join('');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { ok: false, error: 'invalid_command_json', raw };
  }
  return { body, exitCode, raw };
}

export function addAdminRoutes(app: Hono, cfg: AdminEndpointConfig): void {
  app.post('/api/admin/restart', (c) => {
    // Defer the actual exit so the response can flush first.
    setTimeout(() => {
      try {
        cfg.onRestartRequested();
      } catch (err) {
        console.error('[admin] restart hook threw:', err);
      }
    }, 50);
    return c.json({ ok: true, scheduled: true });
  });

  app.post('/api/admin/claim-rewards', async (c) => {
    try {
      const result = await runCommandJson(claimRewardsCommand, ['--yes', '--json'], process.env);
      const ok = result.exitCode === null || result.exitCode === 0;
      return c.json(
        {
          ok,
          result: result.body,
          exitCode: result.exitCode,
        },
        ok ? 200 : 500,
      );
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  app.post('/api/admin/loop/:loop/:action', (c) => {
    const loop = c.req.param('loop');
    const action = c.req.param('action');
    return c.json({
      schemaVersion: 1,
      ok: false,
      reason: 'not_implemented',
      loop,
      action,
    });
  });
}
