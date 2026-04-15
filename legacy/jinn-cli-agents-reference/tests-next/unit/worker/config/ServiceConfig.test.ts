/**
 * Unit Test: Service Configuration
 * Module: worker/config/ServiceConfig.ts
 * Priority: P1 (HIGH)
 *
 * Tests service configuration utilities including validation, chain support,
 * default config generation, and config file loading.
 *
 * Impact: Prevents deployment failures from invalid configs ($2K+/year risk)
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  SUPPORTED_CHAINS,
  SERVICE_CONSTANTS,
  createDefaultServiceConfig,
  validateChainSupport,
  validateServiceConfig,
  validateServiceConfigOrThrow,
  validateServiceConfigFile,
  extractServiceName,
  type ServiceConfigTemplate,
} from 'jinn-node/worker/config/ServiceConfig.js';

describe('ServiceConfig', () => {
  describe('SUPPORTED_CHAINS', () => {
    it('includes all expected chains', () => {
      expect(SUPPORTED_CHAINS).toContain('gnosis');
      expect(SUPPORTED_CHAINS).toContain('base');
      expect(SUPPORTED_CHAINS).toContain('mode');
      expect(SUPPORTED_CHAINS).toContain('optimism');
      expect(SUPPORTED_CHAINS).toContain('ethereum');
      expect(SUPPORTED_CHAINS).toContain('polygon');
      expect(SUPPORTED_CHAINS).toContain('arbitrum');
    });

    it('has at least 7 supported chains', () => {
      expect(SUPPORTED_CHAINS.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe('SERVICE_CONSTANTS', () => {
    it('defines valid default service bond', () => {
      expect(SERVICE_CONSTANTS.DEFAULT_SERVICE_BOND_WEI).toBe('50000000000000000000');
      expect(typeof SERVICE_CONSTANTS.DEFAULT_SERVICE_BOND_WEI).toBe('string');
    });

    it('defines integer funding requirements', () => {
      expect(typeof SERVICE_CONSTANTS.DEFAULT_AGENT_FUNDING_WEI).toBe('number');
      expect(typeof SERVICE_CONSTANTS.DEFAULT_SAFE_FUNDING_WEI).toBe('number');
    });

    it('defines valid IPFS hash', () => {
      expect(SERVICE_CONSTANTS.DEFAULT_SERVICE_HASH).toMatch(/^bafybei/);
    });

    it('defines base as default home chain', () => {
      expect(SERVICE_CONSTANTS.DEFAULT_HOME_CHAIN).toBe('base');
    });

    it('defines RPC URLs for all supported chains', () => {
      for (const chain of SUPPORTED_CHAINS) {
        expect(SERVICE_CONSTANTS.DEFAULT_RPC_URLS[chain]).toBeDefined();
        expect(SERVICE_CONSTANTS.DEFAULT_RPC_URLS[chain]).toMatch(/^https:\/\//);
      }
    });
  });

  describe('createDefaultServiceConfig', () => {
    it('creates valid config with no overrides', () => {
      const config = createDefaultServiceConfig();

      expect(config.name).toMatch(/^jinn-service-/);
      expect(config.hash).toBe(SERVICE_CONSTANTS.DEFAULT_SERVICE_HASH);
      expect(config.home_chain).toBe('base');
      expect(config.configurations).toHaveProperty('base');
    });

    it('generates timestamp-based service names', () => {
      const config = createDefaultServiceConfig();

      expect(config.name).toMatch(/^jinn-service-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    it('uses custom service name when provided', () => {
      const config = createDefaultServiceConfig({ name: 'my-custom-service' });

      expect(config.name).toBe('my-custom-service');
    });

    it('uses custom home chain when provided', () => {
      const config = createDefaultServiceConfig({ home_chain: 'gnosis' });

      expect(config.home_chain).toBe('gnosis');
      expect(config.configurations).toHaveProperty('gnosis');
      expect(config.configurations).not.toHaveProperty('base');
    });

    it('creates config with integer fund requirements', () => {
      const config = createDefaultServiceConfig();
      const ethFunding = config.configurations.base.fund_requirements['0x0000000000000000000000000000000000000000'];

      expect(typeof ethFunding.agent).toBe('number');
      expect(typeof ethFunding.safe).toBe('number');
    });

    it('does not include OLAS token in default fund requirements', () => {
      const config = createDefaultServiceConfig();
      const olasFunding = config.configurations.base.fund_requirements['0x54330d28ca3357F294334BDC454a032e7f353416'];

      // OLAS token is not included in default config — middleware handles staking bond separately
      expect(olasFunding).toBeUndefined();
    });

    it('sets mech marketplace disabled by default', () => {
      const config = createDefaultServiceConfig();

      expect(config.configurations.base.use_mech_marketplace).toBe(false);
    });

    it('sets staking enabled by default', () => {
      const config = createDefaultServiceConfig();

      expect(config.configurations.base.use_staking).toBe(true);
    });

    it('includes valid RPC URL for home chain', () => {
      const config = createDefaultServiceConfig();

      expect(config.configurations.base.rpc).toMatch(/^https:\/\//);
    });
  });

  describe('validateChainSupport', () => {
    it('validates supported chains', () => {
      const result = validateChainSupport('gnosis');

      expect(result.isSupported).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects unsupported chains', () => {
      const result = validateChainSupport('unsupported-chain');

      expect(result.isSupported).toBe(false);
      expect(result.error).toContain('not supported');
      expect(result.error).toContain('unsupported-chain');
    });

    it('lists all supported chains in error', () => {
      const result = validateChainSupport('invalid');

      expect(result.error).toContain('gnosis');
      expect(result.error).toContain('base');
    });

    it('validates all supported chains', () => {
      for (const chain of SUPPORTED_CHAINS) {
        const result = validateChainSupport(chain);
        expect(result.isSupported).toBe(true);
      }
    });
  });

  describe('validateServiceConfig', () => {
    let validConfig: any;

    beforeEach(() => {
      validConfig = createDefaultServiceConfig();
    });

    describe('valid configurations', () => {
      it('validates complete valid config', () => {
        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it('validates config with custom name', () => {
        validConfig.name = 'custom-service-name';

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(true);
      });

      it('validates all supported chains', () => {
        for (const chain of SUPPORTED_CHAINS) {
          const config = createDefaultServiceConfig({ home_chain: chain });
          const result = validateServiceConfig(config);

          expect(result.isValid).toBe(true);
        }
      });
    });

    describe('missing required fields', () => {
      it('rejects config without name', () => {
        delete validConfig.name;

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Missing service name');
      });

      it('rejects config without home_chain', () => {
        delete validConfig.home_chain;

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Missing home_chain');
      });

      it('rejects config without hash', () => {
        delete validConfig.hash;

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Missing service hash');
      });
    });

    describe('chain validation', () => {
      it('rejects unsupported home_chain', () => {
        validConfig.home_chain = 'unsupported-chain';

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('not supported'))).toBe(true);
      });

      it('rejects config missing home_chain configuration', () => {
        validConfig.home_chain = 'gnosis';
        // Still has 'base' config, but missing 'gnosis'

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Missing configuration for home_chain'))).toBe(true);
      });
    });

    describe('IPFS hash validation', () => {
      it('rejects invalid IPFS hash format', () => {
        validConfig.hash = 'invalid-hash';

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid IPFS hash format'))).toBe(true);
      });

      it('accepts valid bafybei prefix', () => {
        validConfig.hash = 'bafybeiardecju3sygh7hwuywka2bgjinbr7vrzob4mpdrookyfsbdmoq2m';

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(true);
      });
    });

    describe('agent_id validation', () => {
      it('rejects string agent_id', () => {
        validConfig.configurations.base.agent_id = '43';

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('agent_id must be a number'))).toBe(true);
      });

      it('accepts numeric agent_id', () => {
        validConfig.configurations.base.agent_id = 43;

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(true);
      });
    });

    describe('fund requirements validation', () => {
      it('rejects string fund requirements', () => {
        validConfig.configurations.base.fund_requirements['0x0000000000000000000000000000000000000000'].agent = '500000000000000';

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be integers, not strings'))).toBe(true);
      });

      it('accepts integer fund requirements', () => {
        validConfig.configurations.base.fund_requirements['0x0000000000000000000000000000000000000000'].agent = 500000000000000;

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(true);
      });

      it('validates all token fund requirements', () => {
        validConfig.configurations.base.fund_requirements = {
          '0x0000000000000000000000000000000000000000': {
            agent: '1000',
            safe: 2000,
          },
          '0x54330d28ca3357F294334BDC454a032e7f353416': {
            agent: 3000,
            safe: '4000',
          },
        };

        const result = validateServiceConfig(validConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      });
    });

    describe('multiple errors', () => {
      it('collects all validation errors', () => {
        const invalidConfig = {
          // Missing name
          home_chain: 'invalid-chain',
          hash: 'invalid-hash',
          configurations: {
            'invalid-chain': {
              agent_id: '123',
            },
          },
        };

        const result = validateServiceConfig(invalidConfig);

        expect(result.isValid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(3);
      });
    });
  });

  describe('validateServiceConfigOrThrow', () => {
    it('does not throw for valid config', () => {
      const validConfig = createDefaultServiceConfig();

      expect(() => validateServiceConfigOrThrow(validConfig)).not.toThrow();
    });

    it('throws for invalid config', () => {
      const invalidConfig = { name: 'test' }; // Missing required fields

      expect(() => validateServiceConfigOrThrow(invalidConfig)).toThrow(
        'Service configuration validation failed'
      );
    });

    it('includes all errors in throw message', () => {
      const invalidConfig = {}; // Missing everything

      expect(() => validateServiceConfigOrThrow(invalidConfig)).toThrow(/Missing service name/);
      expect(() => validateServiceConfigOrThrow(invalidConfig)).toThrow(/Missing home_chain/);
    });

    it('formats errors with numbering', () => {
      const invalidConfig = {};

      try {
        validateServiceConfigOrThrow(invalidConfig);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toMatch(/\d+\./); // Contains numbered list
      }
    });
  });

  describe('validateServiceConfigFile', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('validates and loads valid config file', async () => {
      const validConfig = createDefaultServiceConfig();
      const mockReadFile = vi.fn().mockResolvedValue(JSON.stringify(validConfig));

      vi.doMock('fs/promises', () => ({
        readFile: mockReadFile,
      }));

      const result = await validateServiceConfigFile('/path/to/config.json');

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.config).toEqual(validConfig);
    });

    it('returns validation errors for invalid config', async () => {
      const invalidConfig = { name: 'test' };
      const mockReadFile = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));

      vi.doMock('fs/promises', () => ({
        readFile: mockReadFile,
      }));

      const result = await validateServiceConfigFile('/path/to/config.json');

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.config).toBeUndefined();
    });

    it('handles file read errors', async () => {
      const mockReadFile = vi.fn().mockRejectedValue(new Error('File not found'));

      vi.doMock('fs/promises', () => ({
        readFile: mockReadFile,
      }));

      const result = await validateServiceConfigFile('/nonexistent/config.json');

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Failed to load config file'))).toBe(true);
    });

    it('handles JSON parse errors', async () => {
      const mockReadFile = vi.fn().mockResolvedValue('invalid json {');

      vi.doMock('fs/promises', () => ({
        readFile: mockReadFile,
      }));

      const result = await validateServiceConfigFile('/path/to/config.json');

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Failed to load config file'))).toBe(true);
    });
  });

  describe('extractServiceName', () => {
    describe('from config path', () => {
      it('extracts name from quickstart config path', () => {
        const name = extractServiceName('/path/to/my-service-quickstart-config.json');

        expect(name).toBe('my-service');
      });

      it('extracts name from regular config path', () => {
        const name = extractServiceName('/path/to/trader-agent.json');

        expect(name).toBe('trader-agent');
      });

      it('handles deep nested paths', () => {
        const name = extractServiceName('/var/lib/services/production/my-service-quickstart-config.json');

        expect(name).toBe('my-service');
      });

      it('returns empty string for empty path', () => {
        const name = extractServiceName('');

        expect(name).toBe('');
      });
    });

    describe('from config object', () => {
      it('extracts name from config object', () => {
        const config = { name: 'my-service-name' };

        const name = extractServiceName(config);

        expect(name).toBe('my-service-name');
      });

      it('returns unknown-service when name is missing', () => {
        const config = {};

        const name = extractServiceName(config);

        expect(name).toBe('unknown-service');
      });

      it('prefers name from config object', () => {
        const config = { name: 'config-name' };

        const name = extractServiceName(config);

        expect(name).toBe('config-name');
      });
    });
  });
});
