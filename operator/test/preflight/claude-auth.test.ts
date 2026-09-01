import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectAuthContext,
  probeClaudeAuth,
  buildLoginCommand,
} from '../../src/preflight/claude-auth.js';

// ---------------------------------------------------------------------------
// detectAuthContext
// ---------------------------------------------------------------------------

describe('detectAuthContext', () => {
  it('returns "bare" by default when no signal is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: false,
      env: {},
    });
    expect(result).toBe('bare');
  });

  it('returns "container" when dockerenvExists is true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: true,
      env: {},
    });
    expect(result).toBe('container');
  });

  it('returns the env-supplied mode when JINN_RUNTIME_MODE is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: false,
      env: { JINN_RUNTIME_MODE: 'docker-compose' },
    });
    expect(result).toBe('docker-compose');
  });

  it('returns the configuredMode when supplied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: false,
      configuredMode: 'docker-compose',
      env: {},
    });
    expect(result).toBe('docker-compose');
  });

  it('does NOT auto-detect docker-compose from cwd contents (deliberately)', () => {
    // Prior behavior misfired for anyone running from the operator/ checkout dir.
    // Now: a docker-compose.yml in cwd alone is not enough — operator must
    // opt in via env var or configured mode.
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  jinn-daemon:\n    image: x\n');
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: false,
      env: {},
    });
    expect(result).toBe('bare');
  });
});

// ---------------------------------------------------------------------------
// probeClaudeAuth
// ---------------------------------------------------------------------------

describe('probeClaudeAuth', () => {
  it('returns authenticated=true when spawnResult has loggedIn:true', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      spawnResult: {
        status: 0,
        stdout: JSON.stringify({ loggedIn: true, email: 'test@example.com' }),
        stderr: '',
      },
    });
    expect(result.authenticated).toBe(true);
    expect(result.email).toBe('test@example.com');
  });

  it('returns authenticated=false when spawnResult has loggedIn:false', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      spawnResult: {
        status: 0,
        stdout: JSON.stringify({ loggedIn: false }),
        stderr: '',
      },
    });
    expect(result.authenticated).toBe(false);
  });

  it('returns authenticated=false when spawn fails (status: 1)', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      spawnResult: {
        status: 1,
        stdout: '',
        stderr: 'error',
      },
    });
    expect(result.authenticated).toBe(false);
  });

  it('returns authenticated=false when stdout is not JSON', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      spawnResult: {
        status: 0,
        stdout: 'not json at all',
        stderr: '',
      },
    });
    expect(result.authenticated).toBe(false);
    expect(result.validity).toBe('malformed');
  });

  it('classifies a non-zero spawn as an error, not a valid login', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      spawnResult: {
        status: 1,
        stdout: '',
        stderr: 'error',
      },
    });
    expect(result.authenticated).toBe(false);
    expect(result.validity).toBe('error');
  });

  it('classifies a timed-out spawn as an error', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      spawnResult: {
        status: null,
        stdout: '',
        stderr: 'claude auth status timed out',
      },
    });
    expect(result.authenticated).toBe(false);
    expect(result.validity).toBe('error');
  });

  it('classifies loggedIn:false as invalid', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      spawnResult: {
        status: 0,
        stdout: JSON.stringify({ loggedIn: false }),
        stderr: '',
      },
    });
    expect(result.authenticated).toBe(false);
    expect(result.validity).toBe('invalid');
  });

  it('classifies loggedIn:true as valid', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      spawnResult: {
        status: 0,
        stdout: JSON.stringify({ loggedIn: true }),
        stderr: '',
      },
    });
    expect(result.authenticated).toBe(true);
    expect(result.validity).toBe('valid');
  });

  it('accepts a configured claudePath while preserving injected probe results', () => {
    const result = probeClaudeAuth({
      context: 'bare',
      cwd: '/tmp',
      claudePath: '/custom/claude',
      spawnResult: {
        status: 0,
        stdout: JSON.stringify({ loggedIn: true }),
        stderr: '',
      },
    });
    expect(result.authenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildLoginCommand
// ---------------------------------------------------------------------------

describe('buildLoginCommand', () => {
  it('returns direct claude command for bare context', () => {
    const result = buildLoginCommand('bare', '/some/path');
    expect(result.command).toBe('claude');
    expect(result.args).toEqual(['auth', 'login']);
  });

  it('returns direct claude command for container context', () => {
    const result = buildLoginCommand('container', '/some/path');
    expect(result.command).toBe('claude');
    expect(result.args).toEqual(['auth', 'login']);
  });

  it('uses configured claude path for bare login commands', () => {
    const result = buildLoginCommand('bare', '/some/path', '/custom/claude');
    expect(result.command).toBe('/custom/claude');
    expect(result.args).toEqual(['auth', 'login']);
  });

  it('returns docker compose command with jinn-daemon for docker-compose context', () => {
    const result = buildLoginCommand('docker-compose', '/my/project');
    expect(result.command).toBe('docker');
    expect(result.args).toEqual([
      'compose',
      '-f',
      '/my/project/docker-compose.yml',
      'run',
      '--rm',
      '-it',
      '--no-deps',
      '--entrypoint',
      'claude',
      'jinn-daemon',
      'auth',
      'login',
    ]);
  });
});
