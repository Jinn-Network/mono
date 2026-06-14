import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addHarnessAuthStatusRoutes } from '../../src/api/harness-auth-status-endpoint.js';
import { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';
import type { Harness } from '../../src/harnesses/types.js';
import type { HarnessAuthSource } from '../../src/harnesses/auth-source.js';

function harness(name: string, getAuthSource?: () => Promise<HarnessAuthSource>): Harness {
  return {
    name, version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    ...(getAuthSource ? { getAuthSource } : {}),
  };
}

describe('harness-auth-status-endpoint (#564)', () => {
  it('GET /v1/harnesses/auth-status iterates every registered harness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authep-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'OPENROUTER_API_KEY=sk-or-v1-longenough-a3f9\n');
    try {
      const reg = new HarnessReadinessRegistry({
        harnessesByName: {
          'hermes-agent': harness('hermes-agent', async () => ({
            sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: envFile,
            envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
          })),
          'claude-code': harness('claude-code', async () => ({
            sourceKind: 'session', docAnchor: 'claude-code',
          })),
          'prediction-v1-baseline': harness('prediction-v1-baseline'), // no getAuthSource
        },
        joinedHarnessesByCid: {},
      });
      const app = new Hono();
      addHarnessAuthStatusRoutes(app, { registry: reg });

      const res = await app.request('/v1/harnesses/auth-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.harnesses).toHaveLength(3);

      const hermes = body.harnesses.find((h: { harnessName: string }) => h.harnessName === 'hermes-agent');
      expect(hermes.state).toBe('loaded');
      expect(hermes.keySuffix).toBe('a3f9');
      expect(hermes.sourcePath).toBe('~/.hermes/.env');

      const claude = body.harnesses.find((h: { harnessName: string }) => h.harnessName === 'claude-code');
      expect(claude.state).toBe('unknown');
      expect(claude.sourceKind).toBe('session');

      const pred = body.harnesses.find((h: { harnessName: string }) => h.harnessName === 'prediction-v1-baseline');
      expect(pred.sourceKind).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEVER returns full key bytes — only the last-4 suffix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authep-'));
    const envFile = join(dir, '.env');
    const fullKey = 'sk-or-v1-SUPERSECRETFULLKEYVALUE-tail';
    writeFileSync(envFile, `OPENROUTER_API_KEY=${fullKey}\n`);
    try {
      const reg = new HarnessReadinessRegistry({
        harnessesByName: {
          'hermes-agent': harness('hermes-agent', async () => ({
            sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: envFile,
            envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
          })),
        },
        joinedHarnessesByCid: {},
      });
      const app = new Hono();
      addHarnessAuthStatusRoutes(app, { registry: reg });
      const res = await app.request('/v1/harnesses/auth-status');
      const raw = await res.text();
      expect(raw).not.toContain(fullKey);
      expect(raw).not.toContain('SUPERSECRETFULLKEYVALUE');
      expect(raw).toContain('tail'); // the last-4 suffix is allowed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 503 when the registry holder is not yet populated', async () => {
    const app = new Hono();
    addHarnessAuthStatusRoutes(app, { getRegistry: () => null });
    const res = await app.request('/v1/harnesses/auth-status');
    expect(res.status).toBe(503);
  });
});
