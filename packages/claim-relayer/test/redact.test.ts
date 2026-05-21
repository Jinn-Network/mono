import { describe, expect, it } from 'vitest';
import { errorToLogMessage, redactSecrets } from '../src/redact.js';

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
