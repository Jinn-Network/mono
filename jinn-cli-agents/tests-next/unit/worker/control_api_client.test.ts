/**
 * Unit Test: Control API Client
 * Module: worker/control_api_client.ts
 * Priority: P1 (RELIABILITY)
 *
 * Tests worker's Control API client for claim operations, error handling,
 * and retry logic. Critical for worker-API communication reliability.
 *
 * Impact: Ensures worker correctly handles claim responses, including
 * "already claimed" scenarios and network failures.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { claimRequest } from 'jinn-node/worker/control_api_client.js';

// Mock dependencies
vi.mock('jinn-node/env/operate-profile.js', () => ({
  getMechAddress: vi.fn().mockReturnValue('0xWORKER123'),
  getServicePrivateKey: vi.fn(),
  getMechChainConfig: vi.fn()
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getOptionalControlApiUrl: vi.fn().mockReturnValue('http://localhost:4001/graphql')
}));

vi.mock('jinn-node/http/client.js', () => ({
  postJson: vi.fn()
}));

import { postJson } from 'jinn-node/http/client.js';

describe('Control API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('claimRequest', () => {
    it('successfully claims a request', async () => {
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xREQ123',
            status: 'IN_PROGRESS',
            claimed_at: '2025-01-01T00:00:00.000Z'
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      const result = await claimRequest('0xREQ123');

      expect(result).toEqual({
        request_id: '0xREQ123',
        status: 'IN_PROGRESS',
        claimed_at: '2025-01-01T00:00:00.000Z',
      });
    });

    it('sets correct headers', async () => {
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xREQ123',
            status: 'IN_PROGRESS',
            claimed_at: '2025-01-01T00:00:00.000Z'
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      await claimRequest('0xREQ123');

      expect(postJson).toHaveBeenCalledWith(
        'http://localhost:4001/graphql',
        expect.objectContaining({
          query: expect.stringContaining('claimRequest'),
          variables: { requestId: '0xREQ123' }
        }),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            'X-Worker-Address': '0xWORKER123',
            'Idempotency-Key': '0xREQ123:claim'
          },
          timeoutMs: 10_000,
          maxRetries: 0
        })
      );
    });

    it('builds idempotency key from requestId and phase', async () => {
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xDIFFERENT',
            status: 'IN_PROGRESS',
            claimed_at: '2025-01-01T00:00:00.000Z'
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      await claimRequest('0xDIFFERENT');

      expect(postJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Idempotency-Key': '0xDIFFERENT:claim'
          })
        })
      );
    });

    it('handles "already claimed" error gracefully', async () => {
      const mockError = new Error('Request already claimed by another worker');

      (postJson as any).mockRejectedValue(mockError);

      const result = await claimRequest('0xREQ123');

      expect(result).toEqual({
        request_id: '0xREQ123',
        status: 'IN_PROGRESS',
        alreadyClaimed: true
      });
    });

    it('detects "already claimed" case-insensitively', async () => {
      const mockError = new Error('REQUEST ALREADY CLAIMED');

      (postJson as any).mockRejectedValue(mockError);

      const result = await claimRequest('0xREQ123');

      expect(result.alreadyClaimed).toBe(true);
    });

    it('retries on network failure', async () => {
      (postJson as any)
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({
          data: {
            claimRequest: {
              request_id: '0xREQ123',
              status: 'IN_PROGRESS',
              claimed_at: '2025-01-01T00:00:00.000Z'
            }
          }
        });

      const result = await claimRequest('0xREQ123');

      expect(postJson).toHaveBeenCalledTimes(3); // 2 failures + 1 success
      expect(result.request_id).toBe('0xREQ123');
      expect(result.alreadyClaimed).toBeFalsy();
    });

    it('retries up to 3 attempts', async () => {
      (postJson as any).mockRejectedValue(new Error('Persistent failure'));

      await expect(claimRequest('0xREQ123')).rejects.toThrow('Persistent failure');

      expect(postJson).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });

    it('uses exponential backoff for retries', async () => {
      vi.useFakeTimers();

      (postJson as any)
        .mockRejectedValueOnce(new Error('Failure 1'))
        .mockRejectedValueOnce(new Error('Failure 2'))
        .mockResolvedValueOnce({
          data: {
            claimRequest: {
              request_id: '0xREQ123',
              status: 'IN_PROGRESS',
              claimed_at: '2025-01-01T00:00:00.000Z'
            }
          }
        });

      const promise = claimRequest('0xREQ123');

      // First attempt fails immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(postJson).toHaveBeenCalledTimes(1);

      // Retry 1 after 500ms (2^0 * 500)
      await vi.advanceTimersByTimeAsync(500);
      expect(postJson).toHaveBeenCalledTimes(2);

      // Retry 2 after 1000ms (2^1 * 500)
      await vi.advanceTimersByTimeAsync(1000);
      expect(postJson).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result.request_id).toBe('0xREQ123');

      vi.useRealTimers();
    });

    it('throws on GraphQL errors', async () => {
      const mockResponse = {
        errors: [
          { message: 'Request not found in Ponder' }
        ]
      };

      (postJson as any).mockResolvedValue(mockResponse);

      await expect(claimRequest('0xREQ123')).rejects.toThrow('Request not found in Ponder');
    });

    it('handles multiple GraphQL errors', async () => {
      const mockResponse = {
        errors: [
          { message: 'Error 1' },
          { message: 'Error 2' }
        ]
      };

      (postJson as any).mockResolvedValue(mockResponse);

      await expect(claimRequest('0xREQ123')).rejects.toThrow('Error 1; Error 2');
    });

    it('throws on null response', async () => {
      (postJson as any).mockResolvedValue(null);

      await expect(claimRequest('0xREQ123')).rejects.toThrow('GraphQL error');
    });

    it('throws on response with no data', async () => {
      (postJson as any).mockResolvedValue({});

      // Will throw trying to access json.data.claimRequest
      await expect(claimRequest('0xREQ123')).rejects.toThrow();
    });

    it('handles error without message property', async () => {
      const mockError = { code: 500, details: 'Server error' };

      (postJson as any).mockRejectedValue(mockError);

      // Should convert to string, won't match "already claimed", so will throw
      await expect(claimRequest('0xREQ123')).rejects.toThrow();
    });

    it('preserves claimed_at timestamp from response', async () => {
      const expectedTime = '2025-12-03T10:30:00.000Z';
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xREQ123',
            status: 'IN_PROGRESS',
            claimed_at: expectedTime
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      const result = await claimRequest('0xREQ123');

      expect(result.claimed_at).toBe(expectedTime);
    });

    it('returns alreadyClaimed falsy for successful fresh claims', async () => {
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xREQ123',
            status: 'IN_PROGRESS',
            claimed_at: '2025-01-01T00:00:00.000Z'
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      const result = await claimRequest('0xREQ123');

      expect(result.alreadyClaimed).toBeFalsy();
    });

    it('includes alreadyClaimed=true when claim error detected', async () => {
      const mockError = new Error('Already claimed by worker 0xOTHER');

      (postJson as any).mockRejectedValue(mockError);

      const result = await claimRequest('0xREQ123');

      expect(result.alreadyClaimed).toBe(true);
      expect(result.status).toBe('IN_PROGRESS');
    });
  });

  describe('error message parsing', () => {
    it('detects "already claimed" in various formats', async () => {
      const variations = [
        'Request already claimed',
        'already claimed by another worker',
        'ALREADY CLAIMED',
        'The request was already claimed',
        'Error: already claimed'
      ];

      for (const msg of variations) {
        vi.clearAllMocks();
        (postJson as any).mockRejectedValue(new Error(msg));

        const result = await claimRequest('0xREQ123');
        expect(result.alreadyClaimed).toBe(true);
      }
    });

    it('does not false-positive on unrelated errors', async () => {
      const unrelatedErrors = [
        'Network timeout',
        'GraphQL parse error',
        'Ponder validation failed',
        'Internal server error'
      ];

      for (const msg of unrelatedErrors) {
        vi.clearAllMocks();
        (postJson as any).mockRejectedValue(new Error(msg));

        await expect(claimRequest('0xREQ123')).rejects.toThrow(msg);
      }
    });
  });

  describe('request construction', () => {
    it('sends correct GraphQL mutation', async () => {
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xREQ123',
            status: 'IN_PROGRESS',
            claimed_at: '2025-01-01T00:00:00.000Z'
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      await claimRequest('0xREQ123');

      expect(postJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          query: expect.stringMatching(/mutation Claim\(\$requestId: String!\)/),
          variables: { requestId: '0xREQ123' }
        }),
        expect.any(Object)
      );
    });

    it('requests correct fields in response', async () => {
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xREQ123',
            status: 'IN_PROGRESS',
            claimed_at: '2025-01-01T00:00:00.000Z'
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      await claimRequest('0xREQ123');

      const call = (postJson as any).mock.calls[0];
      const query = call[1].query;

      expect(query).toContain('request_id');
      expect(query).toContain('status');
      expect(query).toContain('claimed_at');
    });
  });

  describe('timeout configuration', () => {
    it('uses 10 second timeout', async () => {
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xREQ123',
            status: 'IN_PROGRESS',
            claimed_at: '2025-01-01T00:00:00.000Z'
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      await claimRequest('0xREQ123');

      expect(postJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          timeoutMs: 10_000
        })
      );
    });

    it('disables postJson internal retries', async () => {
      const mockResponse = {
        data: {
          claimRequest: {
            request_id: '0xREQ123',
            status: 'IN_PROGRESS',
            claimed_at: '2025-01-01T00:00:00.000Z'
          }
        }
      };

      (postJson as any).mockResolvedValue(mockResponse);

      await claimRequest('0xREQ123');

      // Client implements its own retry logic, so disable postJson retries
      expect(postJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          maxRetries: 0
        })
      );
    });
  });
});

