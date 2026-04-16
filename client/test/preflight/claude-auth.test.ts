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
  it('returns "bare" when no Docker indicators exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: false,
      composeServiceExists: false,
    });
    expect(result).toBe('bare');
  });

  it('returns "container" when dockerenvExists is true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: true,
      composeServiceExists: false,
    });
    expect(result).toBe('container');
  });

  it('returns "docker-compose" when composeServiceExists is true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: false,
      composeServiceExists: true,
    });
    expect(result).toBe('docker-compose');
  });

  it('returns "bare" when composeServiceExists is false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-'));
    const result = detectAuthContext({
      cwd: dir,
      dockerenvExists: false,
      composeServiceExists: false,
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
