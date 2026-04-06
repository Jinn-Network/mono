import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { substituteEnvVariables, type GeminiSettings } from 'jinn-node/agent/agent.js';

describe('substituteEnvVariables', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('args array substitution', () => {
    it('substitutes ${VAR} placeholders in args arrays', () => {
      process.env.API_KEY = 'test-key-123';

      const settings: GeminiSettings = {
        mcpServers: {
          testServer: {
            command: 'npx',
            args: ['--header', 'Authorization: Bearer ${API_KEY}'],
            trust: true,
          },
        },
      };

      const result = substituteEnvVariables(settings);

      expect(result.mcpServers!['testServer'].args).toEqual([
        '--header', 'Authorization: Bearer test-key-123',
      ]);
    });

    it('throws when referenced env var is not set', () => {
      delete process.env.UNSET_API_KEY;

      const settings: GeminiSettings = {
        mcpServers: {
          testServer: {
            command: 'npx',
            args: ['--header', 'Authorization: Bearer ${UNSET_API_KEY}'],
            trust: true,
          },
        },
      };

      expect(() => substituteEnvVariables(settings)).toThrow(/UNSET_API_KEY.*not set/);
    });

    it('throws when args reference bridge-managed secret placeholders', () => {
      process.env.FIREFLIES_API_KEY = 'should-not-be-used';

      const settings: GeminiSettings = {
        mcpServers: {
          fireflies: {
            command: 'npx',
            args: ['--header', 'Authorization: Bearer ${FIREFLIES_API_KEY}'],
            trust: true,
          },
        },
      };

      expect(() => substituteEnvVariables(settings)).toThrow(/Forbidden bridge-managed secret placeholder/);
    });

    it('handles multiple placeholders in a single arg', () => {
      process.env.HOST = 'example.com';
      process.env.PORT = '8080';

      const settings: GeminiSettings = {
        mcpServers: {
          test: {
            command: 'node',
            args: ['--url', 'https://${HOST}:${PORT}/api'],
            trust: true,
          },
        },
      };

      const result = substituteEnvVariables(settings);

      expect(result.mcpServers!['test'].args).toEqual([
        '--url', 'https://example.com:8080/api',
      ]);
    });

    it('leaves args without placeholders unchanged', () => {
      const settings: GeminiSettings = {
        mcpServers: {
          test: {
            command: 'node',
            args: ['-y', 'some-package', '--flag'],
            trust: true,
          },
        },
      };

      const result = substituteEnvVariables(settings);

      expect(result.mcpServers!['test'].args).toEqual(['-y', 'some-package', '--flag']);
    });

    it('handles servers with no args array', () => {
      const settings: GeminiSettings = {
        mcpServers: {
          test: {
            command: 'node',
            trust: true,
          },
        },
      };

      // Should not throw
      const result = substituteEnvVariables(settings);
      expect(result.mcpServers!['test'].args).toBeUndefined();
    });
  });

  describe('env block substitution (existing behavior)', () => {
    it('substitutes ${VAR} in env blocks', () => {
      process.env.API_TOKEN = 'api-token-xyz';

      const settings: GeminiSettings = {
        mcpServers: {
          testServer: {
            command: 'npx',
            args: ['-y', 'railway-mcp'],
            trust: true,
            env: { API_TOKEN: '${API_TOKEN}' },
          },
        },
      };

      const result = substituteEnvVariables(settings);

      expect(result.mcpServers!['testServer'].env!['API_TOKEN']).toBe('api-token-xyz');
    });

    it('throws when env var in env block is not set', () => {
      delete process.env.MISSING_TOKEN;

      const settings: GeminiSettings = {
        mcpServers: {
          testServer: {
            command: 'npx',
            trust: true,
            env: { API_TOKEN: '${MISSING_TOKEN}' },
          },
        },
      };

      expect(() => substituteEnvVariables(settings)).toThrow(/MISSING_TOKEN.*not set/);
    });

    it('throws when env block references bridge-managed secret placeholders', () => {
      process.env.RAILWAY_API_TOKEN = 'should-not-be-used';

      const settings: GeminiSettings = {
        mcpServers: {
          railway: {
            command: 'npx',
            trust: true,
            env: { RAILWAY_API_TOKEN: '${RAILWAY_API_TOKEN}' },
          },
        },
      };

      expect(() => substituteEnvVariables(settings)).toThrow(/Forbidden bridge-managed secret placeholder/);
    });
  });

  describe('combined env + args substitution', () => {
    it('substitutes both env and args in the same server config', () => {
      process.env.API_KEY = 'key-abc';
      process.env.API_TOKEN = 'token-xyz';

      const settings: GeminiSettings = {
        mcpServers: {
          combined: {
            command: 'npx',
            args: ['--header', 'X-Key: ${API_KEY}'],
            trust: true,
            env: { TOKEN: '${API_TOKEN}' },
          },
        },
      };

      const result = substituteEnvVariables(settings);

      expect(result.mcpServers!['combined'].args).toEqual(['--header', 'X-Key: key-abc']);
      expect(result.mcpServers!['combined'].env!['TOKEN']).toBe('token-xyz');
    });
  });
});
