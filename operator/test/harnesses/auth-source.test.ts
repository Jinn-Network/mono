import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHarnessAuthStatus } from '../../src/harnesses/auth-source.js';
import type { Harness } from '../../src/harnesses/types.js';

function harnessWith(getAuthSource: Harness['getAuthSource']): Harness {
  return {
    name: 'fixture',
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    getAuthSource,
  };
}

describe('resolveHarnessAuthStatus', () => {
  it('file-kind with a present long credential → loaded, last-4 suffix, mtime set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'OPENROUTER_API_KEY=sk-or-v1-abc123XYZa3f9\nOTHER=ignored\n');
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: file,
        envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.state).toBe('loaded');
      expect(entry.keySuffix).toBe('a3f9');
      expect(entry.sourcePath).toBe('~/.hermes/.env');
      expect(entry.envKey).toBe('OPENROUTER_API_KEY');
      expect(entry.docAnchor).toBe('hermes-agent');
      expect(entry.lastModified).toMatch(/\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file-kind with a short (<8 char) credential → loaded but suffix masked to null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'OPENROUTER_API_KEY=short\n');
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: file,
        envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.state).toBe('loaded');
      expect(entry.keySuffix).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file-kind, env key absent in an existing file → missing, null suffix and mtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'SOMETHING_ELSE=value\n');
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: file,
        envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.state).toBe('missing');
      expect(entry.keySuffix).toBeNull();
      expect(entry.lastModified).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file-kind, file does not exist → missing', async () => {
    const h = harnessWith(async () => ({
      sourceKind: 'file', sourcePath: '~/.hermes/.env',
      absolutePath: '/nonexistent/path/.env',
      envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
    }));
    const entry = await resolveHarnessAuthStatus(h);
    expect(entry.state).toBe('missing');
    expect(entry.keySuffix).toBeNull();
    expect(entry.lastModified).toBeNull();
  });

  it('parses only the named env line, ignoring values that merely contain the key name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, '.env');
    // A red-herring line whose VALUE mentions the key name must not be picked up.
    writeFileSync(file, 'NOTE=OPENROUTER_API_KEY is set elsewhere\nOPENROUTER_API_KEY=realkey9999\n');
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: file,
        envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.keySuffix).toBe('9999');
      expect(entry.state).toBe('loaded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file-kind JSON credential (e.g. codex auth.json) → loaded from existence, suffix masked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, 'auth.json');
    writeFileSync(file, JSON.stringify({ tokens: { access_token: 'secret-oauth-value' } }));
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.codex/auth.json', absolutePath: file,
        envKey: 'OPENAI_API_KEY', docAnchor: 'codex', credentialIsJson: true,
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.state).toBe('loaded');
      expect(entry.keySuffix).toBeNull();
      expect(entry.lastModified).toMatch(/\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env-kind reads from a supplied env bag → loaded with suffix', async () => {
    const h = harnessWith(async () => ({
      sourceKind: 'env', envKey: 'OPENAI_API_KEY', docAnchor: 'codex',
    }));
    const entry = await resolveHarnessAuthStatus(h, { env: { OPENAI_API_KEY: 'sk-proj-LongEnough1234' } });
    expect(entry.state).toBe('loaded');
    expect(entry.keySuffix).toBe('1234');
    expect(entry.envKey).toBe('OPENAI_API_KEY');
    expect(entry.lastModified).toBeNull();
  });

  it('env-kind with the var absent → missing', async () => {
    const h = harnessWith(async () => ({
      sourceKind: 'env', envKey: 'OPENAI_API_KEY', docAnchor: 'codex',
    }));
    const entry = await resolveHarnessAuthStatus(h, { env: {} });
    expect(entry.state).toBe('missing');
    expect(entry.keySuffix).toBeNull();
  });

  it('session-kind → unknown, no key, no mtime', async () => {
    const h = harnessWith(async () => ({ sourceKind: 'session', docAnchor: 'claude-code' }));
    const entry = await resolveHarnessAuthStatus(h);
    expect(entry.state).toBe('unknown');
    expect(entry.sourceKind).toBe('session');
    expect(entry.keySuffix).toBeNull();
    expect(entry.lastModified).toBeNull();
    expect(entry.docAnchor).toBe('claude-code');
  });

  it('harness with no getAuthSource → sourceKind none, state unknown, no docAnchor', async () => {
    const h = harnessWith(undefined);
    const entry = await resolveHarnessAuthStatus(h);
    expect(entry.sourceKind).toBe('none');
    expect(entry.state).toBe('unknown');
    expect(entry.keySuffix).toBeNull();
    expect(entry.docAnchor).toBeUndefined();
  });

  it('getAuthSource throwing → unknown (never crashes the iteration)', async () => {
    const h = harnessWith(async () => { throw new Error('boom'); });
    const entry = await resolveHarnessAuthStatus(h);
    expect(entry.state).toBe('unknown');
    expect(entry.sourceKind).toBe('session'); // unknown source collapses to session-shaped
    expect(entry.keySuffix).toBeNull();
  });
});
