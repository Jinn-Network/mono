import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { launchBridgeBackedMcp } from 'jinn-node/agent/mcp/launchers/shared/bridge-launcher.js';

function createFakeChildProcess(): EventEmitter {
  return new EventEmitter();
}

describe('launchBridgeBackedMcp', () => {
  it('injects bridge token into args builder and launches with stdio inherit', async () => {
    const child = createFakeChildProcess();
    const getCredentialFn = vi.fn().mockResolvedValue('token-123');
    const spawnFn = vi.fn().mockReturnValue(child);

    const launchPromise = launchBridgeBackedMcp(
      {
        provider: 'fireflies',
        command: 'npx',
        args: (token) => ['-y', 'mcp-remote', '--header', `Authorization: Bearer ${token}`],
      },
      { getCredentialFn, spawnFn }
    );
    await Promise.resolve();

    expect(getCredentialFn).toHaveBeenCalledWith('fireflies');
    expect(spawnFn).toHaveBeenCalledWith(
      'npx',
      ['-y', 'mcp-remote', '--header', 'Authorization: Bearer token-123'],
      expect.objectContaining({ stdio: 'inherit' })
    );

    child.emit('exit', 0, null);
    await expect(launchPromise).resolves.toBe(0);
  });

  it('injects token via env var when tokenEnvVar is configured', async () => {
    const child = createFakeChildProcess();
    const getCredentialFn = vi.fn().mockResolvedValue('railway-token-xyz');
    const spawnFn = vi.fn().mockReturnValue(child);

    const launchPromise = launchBridgeBackedMcp(
      {
        provider: 'railway',
        command: 'npx',
        args: ['-y', 'railway-mcp@2.2.0'],
        tokenEnvVar: 'RAILWAY_API_TOKEN',
      },
      { getCredentialFn, spawnFn }
    );
    await Promise.resolve();

    expect(spawnFn).toHaveBeenCalledWith(
      'npx',
      ['-y', 'railway-mcp@2.2.0'],
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({ RAILWAY_API_TOKEN: 'railway-token-xyz' }),
      })
    );

    child.emit('exit', 0, null);
    await expect(launchPromise).resolves.toBe(0);
  });

  it('rejects when credential fetch fails and does not spawn process', async () => {
    const getCredentialFn = vi.fn().mockRejectedValue(new Error('credential bridge unavailable'));
    const spawnFn = vi.fn();

    await expect(
      launchBridgeBackedMcp(
        {
          provider: 'fireflies',
          command: 'npx',
          args: ['-y', 'mcp-remote'],
        },
        { getCredentialFn, spawnFn }
      )
    ).rejects.toThrow('credential bridge unavailable');

    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('rejects when spawned process emits error', async () => {
    const child = createFakeChildProcess();
    const getCredentialFn = vi.fn().mockResolvedValue('token-123');
    const spawnFn = vi.fn().mockReturnValue(child);

    const launchPromise = launchBridgeBackedMcp(
      {
        provider: 'fireflies',
        command: 'npx',
        args: ['-y', 'mcp-remote'],
      },
      { getCredentialFn, spawnFn }
    );
    await Promise.resolve();

    child.emit('error', new Error('spawn failed'));
    await expect(launchPromise).rejects.toThrow('spawn failed');
  });

  it('returns non-zero exit code when process exits from a signal', async () => {
    const child = createFakeChildProcess();
    const getCredentialFn = vi.fn().mockResolvedValue('token-123');
    const spawnFn = vi.fn().mockReturnValue(child);

    const launchPromise = launchBridgeBackedMcp(
      {
        provider: 'fireflies',
        command: 'npx',
        args: ['-y', 'mcp-remote'],
      },
      { getCredentialFn, spawnFn }
    );
    await Promise.resolve();

    child.emit('exit', null, 'SIGTERM');
    await expect(launchPromise).resolves.toBe(1);
  });
});
