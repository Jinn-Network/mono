import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000001';

async function loadVerifyJobClaim() {
  vi.resetModules();
  const mod = await import('../../../services/x402-gateway/credentials/job-verify.ts');
  return mod.verifyJobClaim;
}

describe('verifyJobClaim', () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.CHAIN_ID = '8453';
    process.env.CONTROL_API_URL = 'http://localhost:4001/graphql';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it('returns unavailable when signer key is not configured', async () => {
    delete process.env.CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;
    const verifyJobClaim = await loadVerifyJobClaim();

    const result = await verifyJobClaim('0xabc', TEST_ADDRESS);

    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('private key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns invalid when no claim exists', async () => {
    const verifyJobClaim = await loadVerifyJobClaim();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { getRequestClaim: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await verifyJobClaim('0xabc', TEST_ADDRESS);

    expect(result.state).toBe('invalid');
    expect(result.error).toContain('not claimed');
  });

  it('returns invalid when claim owner differs from requester', async () => {
    const verifyJobClaim = await loadVerifyJobClaim();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          getRequestClaim: {
            request_id: '0xabc',
            worker_address: OTHER_ADDRESS,
            status: 'IN_PROGRESS',
            claimed_at: new Date().toISOString(),
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await verifyJobClaim('0xabc', TEST_ADDRESS);

    expect(result.state).toBe('invalid');
    expect(result.error).toContain('different address');
  });

  it('returns unavailable on control API fetch failure', async () => {
    const verifyJobClaim = await loadVerifyJobClaim();
    fetchMock.mockRejectedValue(new Error('connection refused'));

    const result = await verifyJobClaim('0xabc', TEST_ADDRESS);

    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('verification failed');
  });

  it('returns unavailable when control API responds non-200', async () => {
    const verifyJobClaim = await loadVerifyJobClaim();
    fetchMock.mockResolvedValue(new Response('oops', { status: 503 }));

    const result = await verifyJobClaim('0xabc', TEST_ADDRESS);

    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('HTTP 503');
  });

  it('returns valid when claim owner matches requester and status is IN_PROGRESS', async () => {
    const verifyJobClaim = await loadVerifyJobClaim();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          getRequestClaim: {
            request_id: '0xabc',
            worker_address: TEST_ADDRESS,
            status: 'IN_PROGRESS',
            claimed_at: new Date().toISOString(),
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await verifyJobClaim('0xabc', TEST_ADDRESS);

    expect(result).toEqual({ state: 'valid' });
  });
});
