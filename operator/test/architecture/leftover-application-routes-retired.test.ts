/**
 * Stage 6 Task 17: leftover application HTTP dissolves; it does not move to
 * the operator console. Stop-hook and artifact insert/acquire stay.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_support/source-text.js';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function source(relative: string): string {
  return codeOnly(readFileSync(join(srcRoot, relative), 'utf8'));
}

describe('leftover application routes are retired (Stage 6 Task 17)', () => {
  it('server.ts no longer mounts launcher, solvernets, or captures HTTP', () => {
    const server = source('api/server.ts');
    expect(server).not.toMatch(/\baddLauncherRoutes\b/u);
    expect(server).not.toMatch(/\baddSolverNetsRoutes\b/u);
    expect(server).not.toMatch(/\bregisterSolverNetsEndpoints\b/u);
    expect(server).not.toMatch(/\baddCapturesRoutes\b/u);
  });

  it('deletes the leftover application route modules', () => {
    expect(existsSync(join(srcRoot, 'api/launcher-endpoints.ts'))).toBe(false);
    expect(existsSync(join(srcRoot, 'api/solvernets-endpoint.ts'))).toBe(false);
    expect(existsSync(join(srcRoot, 'api/solvernets-endpoints.ts'))).toBe(false);
    expect(existsSync(join(srcRoot, 'api/captures.ts'))).toBe(false);
    expect(existsSync(join(srcRoot, 'api/leaderboard-api.ts'))).toBe(false);
    expect(existsSync(join(srcRoot, 'agent/agent-ws.ts'))).toBe(false);
  });

  it('does not mount the embedded-agent WebSocket or loop pause/resume stub', () => {
    const server = source('api/server.ts');
    const main = source('main.ts');
    const admin = source('api/admin-endpoint.ts');
    expect(server).not.toMatch(/\/api\/agent\/ws/u);
    expect(main).not.toMatch(/attachAgentWs/u);
    expect(main).not.toMatch(/\/api\/agent\/ws/u);
    expect(admin).not.toMatch(/\/api\/admin\/loop/u);
    expect(admin).not.toMatch(/not_implemented/u);
  });

  it('does not mint live-closure-validated until a verifier exists', () => {
    const vertical = source('daemon/native-vertical-mode.ts');
    expect(vertical).not.toMatch(/live-closure-validated/u);
  });

  it('keeps stop-hook and artifact insert/acquire', () => {
    const server = source('api/server.ts');
    expect(server).toMatch(/\baddStopHookRoutes\b/u);
    expect(server).toMatch(/\/v1\/artifacts\/acquire/u);
    expect(server).toMatch(/['"]\/artifacts['"]/u);
  });
});
