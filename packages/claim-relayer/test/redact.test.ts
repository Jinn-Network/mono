import { describe, expect, it } from 'vitest';
import { errorToLogMessage, redactSecrets } from '../src/redact.js';
import { loadConfig, redactConfig } from '../src/config.js';

describe('secret redaction', () => {
  it('redacts viem-style RPC URLs from errors and logs', () => {
    const viemError = [
      'HTTP request failed.',
      'URL: https://key.example/rpc/super-secret-token',
      'Request body: {"method":"eth_getLogs"}',
    ].join('\n');

    const redacted = redactSecrets(viemError);
    expect(redacted).toContain('URL: [redacted-url]');
    expect(redacted).not.toContain('https://key.example');
    expect(redacted).not.toContain('super-secret-token');

    const error = new Error(viemError);
    error.stack = `Error: ${viemError}\n    at transport`;
    const logMessage = errorToLogMessage(error);
    expect(logMessage).toContain('URL: [redacted-url]');
    expect(logMessage).not.toContain('key.example');
  });
});

describe('redactConfig (AC3 fallback-chain summary)', () => {
  const env = {
    JINN_CLAIM_RELAYER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f094538d0e9dae1f177b4dd056dbd8e1a6d69690',
    JINN_CLAIM_RELAYER_L2_RPC_URL: 'https://a.example,https://b.example',
    JINN_CLAIM_RELAYER_L1_RPC_URL: 'https://l1-a.example,https://l1-b.example',
    JINN_CLAIM_RELAYER_START_BLOCK: '10',
    JINN_CLAIM_RELAYER_DISTRIBUTOR_ADDRESS: '0x2222222222222222222222222222222222222222',
    JINN_CLAIM_RELAYER_MOCK_MESSENGER_ADDRESS: '0x3333333333333333333333333333333333333333',
    JINN_CLAIM_RELAYER_TASK_CLAIM_EMITTER_ADDRESS: '0x4444444444444444444444444444444444444444',
  };

  it('reports provider counts + primary host (never just [redacted])', () => {
    const config = loadConfig(env);
    const redacted = redactConfig(config);
    // Each rpc field should be a fallback-chain summary, not a bare
    // [redacted] string. Operators want to see the provider count + the
    // primary host in the boot log so they can verify their chain loaded.
    expect(String(redacted.l1RpcUrl)).toMatch(/fallback chain \(2 providers\): primary host=l1-a\.example/);
    expect(String(redacted.l2RpcUrl)).toMatch(/fallback chain \(2 providers\): primary host=a\.example/);
    // Must never leak the full URL or any path / query component.
    expect(JSON.stringify(redacted)).not.toContain('https://a.example');
    expect(JSON.stringify(redacted)).not.toContain('https://l1-a.example');
  });
});
