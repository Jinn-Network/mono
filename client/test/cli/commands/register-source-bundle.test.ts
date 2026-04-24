import { describe, it, expect, vi } from 'vitest';
import {
  runRegisterSourceBundle,
} from '../../../src/cli/commands/register-source-bundle.js';
import type { Registry8004 } from '../../../src/discovery/registry.js';

describe('runRegisterSourceBundle', () => {
  it('calls Registry8004.registerSourceBundle with the parsed args', async () => {
    const registerMock = vi.fn().mockResolvedValue(42n);
    const mockRegistry = { registerSourceBundle: registerMock } as unknown as Pick<Registry8004, 'registerSourceBundle'>;

    const result = await runRegisterSourceBundle(
      {
        cid: 'bafy-src',
        measurement: '0x' + 'dd'.repeat(48),
        buildRecipeKind: 'dockerfile',
        publishedBy: '0x4444444444444444444444444444444444444444',
        humanUrl: 'https://github.com/jinn/client',
      },
      { registry: mockRegistry },
    );

    expect(registerMock).toHaveBeenCalledWith({
      bundleCid: 'bafy-src',
      measurement: '0x' + 'dd'.repeat(48),
      buildRecipeKind: 'dockerfile',
      publishedBy: '0x4444444444444444444444444444444444444444',
      humanUrl: 'https://github.com/jinn/client',
    });
    expect(result.registeredAtBlock).toBe(42n);
    expect(result.bundleCid).toBe('bafy-src');
  });

  it('omits humanUrl when not provided', async () => {
    const registerMock = vi.fn().mockResolvedValue(1n);
    const mockRegistry = { registerSourceBundle: registerMock } as unknown as Pick<Registry8004, 'registerSourceBundle'>;

    await runRegisterSourceBundle(
      {
        cid: 'bafy-src',
        measurement: '0x' + 'dd'.repeat(48),
        buildRecipeKind: 'nix',
        publishedBy: '0x4444444444444444444444444444444444444444',
      },
      { registry: mockRegistry },
    );

    const callArgs = registerMock.mock.calls[0][0];
    expect(callArgs.humanUrl).toBeUndefined();
  });

  it('rejects invalid buildRecipeKind', async () => {
    const mockRegistry = {
      registerSourceBundle: vi.fn(),
    } as unknown as Pick<Registry8004, 'registerSourceBundle'>;

    await expect(
      runRegisterSourceBundle(
        {
          cid: 'bafy-src',
          measurement: '0x' + 'dd'.repeat(48),
          buildRecipeKind: 'makefile',
          publishedBy: '0x4444444444444444444444444444444444444444',
        },
        { registry: mockRegistry },
      ),
    ).rejects.toThrow();
  });

  it('rejects invalid measurement (not 0x-prefixed)', async () => {
    const mockRegistry = {
      registerSourceBundle: vi.fn(),
    } as unknown as Pick<Registry8004, 'registerSourceBundle'>;

    await expect(
      runRegisterSourceBundle(
        {
          cid: 'bafy-src',
          measurement: 'not-hex',
          buildRecipeKind: 'dockerfile',
          publishedBy: '0x4444444444444444444444444444444444444444',
        },
        { registry: mockRegistry },
      ),
    ).rejects.toThrow(/measurement/);
  });

  it('rejects missing cid', async () => {
    const mockRegistry = {
      registerSourceBundle: vi.fn(),
    } as unknown as Pick<Registry8004, 'registerSourceBundle'>;

    await expect(
      runRegisterSourceBundle(
        {
          cid: '',
          measurement: '0xdeadbeef',
          buildRecipeKind: 'dockerfile',
          publishedBy: '0x4444444444444444444444444444444444444444',
        },
        { registry: mockRegistry },
      ),
    ).rejects.toThrow();
  });
});
