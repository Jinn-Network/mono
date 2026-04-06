/**
 * Unit Test: Mech Configuration
 * Module: worker/config/MechConfig.ts
 * Priority: P1 (HIGH)
 *
 * Tests mech configuration utilities including marketplace enablement,
 * deployment output parsing, and persistence info management.
 *
 * Impact: Prevents deployment failures, mech misconfiguration
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  enableMechMarketplaceInConfig,
  parseMechDeployOutput,
  createMechPersistenceInfo,
  getMechInfoPath,
  type MechDeploymentResult,
  type MechPersistenceInfo,
} from 'jinn-node/worker/config/MechConfig.js';

describe('MechConfig', () => {
  describe('enableMechMarketplaceInConfig', () => {
    let validConfig: any;

    beforeEach(() => {
      validConfig = {
        home_chain: 'gnosis',
        configurations: {
          gnosis: {
            use_mech_marketplace: false,
          },
        },
        env_variables: {},
      };
    });

    describe('valid configurations', () => {
      it('enables mech marketplace with required fields', () => {
        const mechMarketplace = '0x1234567890123456789012345678901234567890';

        enableMechMarketplaceInConfig(validConfig, mechMarketplace);

        expect(validConfig.configurations.gnosis.use_mech_marketplace).toBe(true);
        expect(validConfig.env_variables.MECH_MARKETPLACE_ADDRESS).toEqual({
          value: mechMarketplace,
          provision_type: 'fixed',
        });
      });

      it('sets default mech request price when not provided', () => {
        const mechMarketplace = '0x1234567890123456789012345678901234567890';

        enableMechMarketplaceInConfig(validConfig, mechMarketplace);

        expect(validConfig.env_variables.MECH_REQUEST_PRICE).toEqual({
          value: '10000000000000000', // 0.01 ETH in wei
          provision_type: 'fixed',
        });
      });

      it('uses custom mech request price when provided', () => {
        const mechMarketplace = '0x1234567890123456789012345678901234567890';
        const customPrice = '20000000000000000'; // 0.02 ETH

        enableMechMarketplaceInConfig(validConfig, mechMarketplace, customPrice);

        expect(validConfig.env_variables.MECH_REQUEST_PRICE).toEqual({
          value: customPrice,
          provision_type: 'fixed',
        });
      });

      it('sets all required computed env variables', () => {
        const mechMarketplace = '0x1234567890123456789012345678901234567890';

        enableMechMarketplaceInConfig(validConfig, mechMarketplace);

        expect(validConfig.env_variables.AGENT_ID).toEqual({
          value: '',
          provision_type: 'computed',
        });
        expect(validConfig.env_variables.MECH_TO_CONFIG).toEqual({
          value: '',
          provision_type: 'computed',
        });
        expect(validConfig.env_variables.ON_CHAIN_SERVICE_ID).toEqual({
          value: '',
          provision_type: 'computed',
        });
      });

      it('sets all required RPC env variables', () => {
        const mechMarketplace = '0x1234567890123456789012345678901234567890';

        enableMechMarketplaceInConfig(validConfig, mechMarketplace);

        expect(validConfig.env_variables.GNOSIS_LEDGER_RPC).toEqual({
          value: '',
          provision_type: 'computed',
        });
        expect(validConfig.env_variables.ETHEREUM_LEDGER_RPC_0).toEqual({
          value: '',
          provision_type: 'computed',
        });
        expect(validConfig.env_variables.GNOSIS_LEDGER_RPC_0).toEqual({
          value: '',
          provision_type: 'computed',
        });
      });

      it('creates env_variables object if missing', () => {
        const configWithoutEnv = {
          home_chain: 'gnosis',
          configurations: {
            gnosis: { use_mech_marketplace: false },
          },
        };
        const mechMarketplace = '0x1234567890123456789012345678901234567890';

        enableMechMarketplaceInConfig(configWithoutEnv, mechMarketplace);

        expect(configWithoutEnv).toHaveProperty('env_variables');
        expect(configWithoutEnv.env_variables).toHaveProperty('MECH_MARKETPLACE_ADDRESS');
      });
    });

    describe('invalid configurations', () => {
      it('throws when configurations is missing', () => {
        const invalidConfig = { home_chain: 'gnosis' };

        expect(() =>
          enableMechMarketplaceInConfig(invalidConfig, '0x1234567890123456789012345678901234567890')
        ).toThrow('Invalid service configuration: missing configurations or home_chain');
      });

      it('throws when home_chain is missing', () => {
        const invalidConfig = { configurations: {} };

        expect(() =>
          enableMechMarketplaceInConfig(invalidConfig, '0x1234567890123456789012345678901234567890')
        ).toThrow('Invalid service configuration: missing configurations or home_chain');
      });

      it('throws when home_chain configuration is missing', () => {
        const invalidConfig = {
          home_chain: 'gnosis',
          configurations: {
            base: {}, // Missing gnosis
          },
        };

        expect(() =>
          enableMechMarketplaceInConfig(invalidConfig, '0x1234567890123456789012345678901234567890')
        ).toThrow('Missing configuration for home chain: gnosis');
      });
    });
  });

  describe('parseMechDeployOutput', () => {
    describe('JSON format parsing', () => {
      it('parses valid JSON output', () => {
        const output = `
Deploying mech...
{"mech_address": "0xabcdef1234567890abcdef1234567890abcdef12", "agent_id": 42}
Deploy complete
        `;

        const result = parseMechDeployOutput(output);

        expect(result).toEqual({
          mechAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
          agentId: '42',
        });
      });

      it('converts numeric agent_id to string', () => {
        const output = '{"mech_address": "0x123", "agent_id": 99}';

        const result = parseMechDeployOutput(output);

        expect(result.agentId).toBe('99');
        expect(typeof result.agentId).toBe('string');
      });

      it('parses JSON from middle of multiline output', () => {
        const output = `
Starting deployment...
Processing...
{"mech_address": "0x456", "agent_id": 10}
Done!
        `;

        const result = parseMechDeployOutput(output);

        expect(result.mechAddress).toBe('0x456');
        expect(result.agentId).toBe('10');
      });

      it('skips invalid JSON lines and finds valid one', () => {
        const output = `
{invalid json}
{"mech_address": "0x789", "agent_id": 5}
        `;

        const result = parseMechDeployOutput(output);

        expect(result.mechAddress).toBe('0x789');
      });
    });

    describe('regex fallback parsing', () => {
      it('parses regex format with colons', () => {
        const output = `
mech_address: 0xabc123
agent_id: 7
        `;

        const result = parseMechDeployOutput(output);

        expect(result).toEqual({
          mechAddress: '0xabc123',
          agentId: '7',
        });
      });

      it('parses regex format with spaces', () => {
        const output = `
mech_address   0xdef456
agent_id   99
        `;

        const result = parseMechDeployOutput(output);

        expect(result).toEqual({
          mechAddress: '0xdef456',
          agentId: '99',
        });
      });

      it('handles case-insensitive field names', () => {
        const output = `
MECH_ADDRESS: 0x111
AGENT_ID: 3
        `;

        const result = parseMechDeployOutput(output);

        expect(result.mechAddress).toBe('0x111');
        expect(result.agentId).toBe('3');
      });

      it('handles hex addresses with 0x prefix', () => {
        const output = `
mech_address: 0x1234567890abcdef1234567890abcdef12345678
agent_id: 100
        `;

        const result = parseMechDeployOutput(output);

        expect(result.mechAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
      });
    });

    describe('error handling', () => {
      it('throws when mech_address is missing', () => {
        const output = 'agent_id: 5';

        expect(() => parseMechDeployOutput(output)).toThrow(
          'Could not find mech_address and agent_id in output'
        );
      });

      it('throws when agent_id is missing', () => {
        const output = 'mech_address: 0x123';

        expect(() => parseMechDeployOutput(output)).toThrow(
          'Could not find mech_address and agent_id in output'
        );
      });

      it('throws when output is empty', () => {
        expect(() => parseMechDeployOutput('')).toThrow(
          'Could not find mech_address and agent_id in output'
        );
      });

      it('throws when output is invalid', () => {
        const output = 'Random deployment text without required fields';

        expect(() => parseMechDeployOutput(output)).toThrow(
          'Could not find mech_address and agent_id in output'
        );
      });

      it('wraps parsing errors with context', () => {
        const output = 'Invalid output';

        expect(() => parseMechDeployOutput(output)).toThrow(/Failed to parse mech deploy output/);
      });
    });
  });

  describe('createMechPersistenceInfo', () => {
    it('creates persistence info with all required fields', () => {
      const info = createMechPersistenceInfo(
        '0xmechaddress',
        '42',
        'my-service',
        '/path/to/config.json'
      );

      expect(info).toMatchObject({
        mechAddress: '0xmechaddress',
        agentId: '42',
        serviceName: 'my-service',
        configPath: '/path/to/config.json',
      });
    });

    it('sets deployedAt timestamp', () => {
      const before = new Date().toISOString();
      const info = createMechPersistenceInfo('0xabc', '1', 'service', '/path');
      const after = new Date().toISOString();

      expect(info.deployedAt).toBeDefined();
      expect(info.deployedAt >= before).toBe(true);
      expect(info.deployedAt <= after).toBe(true);
    });

    it('sets lastUpdated timestamp', () => {
      const before = new Date().toISOString();
      const info = createMechPersistenceInfo('0xabc', '1', 'service', '/path');
      const after = new Date().toISOString();

      expect(info.lastUpdated).toBeDefined();
      expect(info.lastUpdated >= before).toBe(true);
      expect(info.lastUpdated <= after).toBe(true);
    });

    it('sets deployedAt and lastUpdated to same value', () => {
      const info = createMechPersistenceInfo('0xabc', '1', 'service', '/path');

      expect(info.deployedAt).toBe(info.lastUpdated);
    });

    it('creates valid ISO timestamp format', () => {
      const info = createMechPersistenceInfo('0xabc', '1', 'service', '/path');

      expect(() => new Date(info.deployedAt)).not.toThrow();
      expect(() => new Date(info.lastUpdated)).not.toThrow();
    });
  });

  describe('getMechInfoPath', () => {
    it('constructs path with mech info directory', () => {
      const configPath = '/services/my-service/config.json';
      const serviceName = 'my-service';

      const infoPath = getMechInfoPath(configPath, serviceName);

      expect(infoPath).toContain('.mech-info');
      expect(infoPath).toContain('my-service-mech.json');
    });

    it('uses parent directory of config file', () => {
      const configPath = '/services/my-service/config.json';
      const serviceName = 'test';

      const infoPath = getMechInfoPath(configPath, serviceName);

      expect(infoPath).toContain('/services/my-service/');
    });

    it('appends -mech.json to service name', () => {
      const configPath = '/path/to/config.json';
      const serviceName = 'trader-agent';

      const infoPath = getMechInfoPath(configPath, serviceName);

      expect(infoPath).toMatch(/trader-agent-mech\.json$/);
    });

    it('handles deep nested config paths', () => {
      const configPath = '/var/lib/services/production/trader/v1/config.json';
      const serviceName = 'trader';

      const infoPath = getMechInfoPath(configPath, serviceName);

      expect(infoPath).toContain('/var/lib/services/production/trader/v1/');
      expect(infoPath).toContain('.mech-info');
    });
  });
});
