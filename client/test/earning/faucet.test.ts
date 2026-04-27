import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestFaucetMock = vi.fn();
const cdpClientOptions: Array<Record<string, string>> = [];

// MOCK_JUSTIFICATION: Third-party SDK; faucet is the leaf network adapter (HTTP to coinbase). Mocking the SDK is mocking the boundary.
vi.mock('@coinbase/cdp-sdk', () => ({
  CdpClient: class {
    evm = {
      requestFaucet: requestFaucetMock,
    };

    constructor(options: Record<string, string>) {
      cdpClientOptions.push(options);
    }
  },
}));

describe('requestTestnetFunding', () => {
  beforeEach(() => {
    delete process.env['CDP_API_KEY_ID'];
    delete process.env['CDP_API_KEY_SECRET'];
    cdpClientOptions.length = 0;
    requestFaucetMock.mockResolvedValue({ transactionHash: '0xtesthash' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses a complete shipped credential pair when env overrides are absent', async () => {
    const { requestTestnetFunding } = await import('../../src/earning/faucet.js');

    const result = await requestTestnetFunding(
      '0x0000000000000000000000000000000000000001',
      'base-sepolia',
    );

    expect(result).toEqual({ ok: true, txHash: '0xtesthash' });
    expect(cdpClientOptions).toHaveLength(1);
    expect(cdpClientOptions[0]).toEqual(expect.objectContaining({
      apiKeyId: expect.any(String),
      apiKeySecret: expect.any(String),
    }));
    expect(cdpClientOptions[0]?.apiKeyId.length).toBeGreaterThan(0);
    expect(cdpClientOptions[0]?.apiKeySecret.length).toBeGreaterThan(0);
    expect(requestFaucetMock).toHaveBeenCalledWith({
      address: '0x0000000000000000000000000000000000000001',
      network: 'base-sepolia',
      token: 'eth',
    });
  });
});
