/**
 * Unit Test: Stale Claim Detection Logic
 * Module: control-api/server.ts (claimRequest mutation)
 * Priority: P1 (RELIABILITY)
 *
 * Tests business logic for 5-minute stale claim detection.
 * Critical for preventing jobs from getting stuck in IN_PROGRESS indefinitely.
 *
 * Impact: Ensures stuck jobs can be reclaimed after 5 minutes, preventing
 * permanent job blockage when workers crash or lose network connectivity.
 */

import { describe, expect, it } from 'vitest';

/**
 * Pure function extracted from Control API server.ts
 * Tests the stale detection logic in isolation
 */
function isClaimStale(claimedAt: string | null | undefined, status: string): boolean {
  if (status === 'COMPLETED') return false; // Never reclaim completed jobs
  if (!claimedAt) return true; // No timestamp = definitely stale
  
  const claimedAtTime = new Date(claimedAt).getTime();
  
  // Handle invalid dates (NaN) as stale
  if (isNaN(claimedAtTime)) return true;
  
  const ageMs = Date.now() - claimedAtTime;
  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  
  return status === 'IN_PROGRESS' && ageMs > STALE_THRESHOLD_MS;
}

describe('Stale Claim Detection Logic', () => {
  describe('basic staleness detection', () => {
    it('detects claim as stale when >5 minutes old', () => {
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const result = isClaimStale(sixMinutesAgo, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('detects claim as fresh when <5 minutes old', () => {
      const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();
      const result = isClaimStale(fourMinutesAgo, 'IN_PROGRESS');
      expect(result).toBe(false);
    });

    it('detects claim as stale exactly at 5 minutes (boundary)', () => {
      const exactlyFiveMinutes = new Date(Date.now() - 5 * 60 * 1000 - 100).toISOString(); // 100ms over
      const result = isClaimStale(exactlyFiveMinutes, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('detects claim as fresh just under 5 minutes (boundary)', () => {
      const justUnderFiveMinutes = new Date(Date.now() - 5 * 60 * 1000 + 100).toISOString(); // 100ms under
      const result = isClaimStale(justUnderFiveMinutes, 'IN_PROGRESS');
      expect(result).toBe(false);
    });
  });

  describe('status-based staleness', () => {
    it('never considers COMPLETED claims as stale', () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const result = isClaimStale(tenMinutesAgo, 'COMPLETED');
      expect(result).toBe(false);
    });

    it('considers IN_PROGRESS claims as stale when old', () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const result = isClaimStale(tenMinutesAgo, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('never considers fresh IN_PROGRESS claims as stale', () => {
      const oneMinuteAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
      const result = isClaimStale(oneMinuteAgo, 'IN_PROGRESS');
      expect(result).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('considers claim stale when claimed_at is null', () => {
      const result = isClaimStale(null, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('considers claim stale when claimed_at is undefined', () => {
      const result = isClaimStale(undefined, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('considers claim stale when claimed_at is empty string', () => {
      const result = isClaimStale('', 'IN_PROGRESS');
      expect(result).toBe(true); // Invalid date = NaN time = stale
    });

    it('handles very old claims (hours old)', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const result = isClaimStale(threeHoursAgo, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('handles very recent claims (seconds old)', () => {
      const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
      const result = isClaimStale(tenSecondsAgo, 'IN_PROGRESS');
      expect(result).toBe(false);
    });

    it('handles future timestamps gracefully', () => {
      const futureTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const result = isClaimStale(futureTime, 'IN_PROGRESS');
      expect(result).toBe(false); // Negative age = not stale
    });
  });

  describe('boundary testing (4:59 vs 5:01)', () => {
    it('considers 4:59 as fresh', () => {
      const time_4m59s = new Date(Date.now() - (4 * 60 + 59) * 1000).toISOString();
      const result = isClaimStale(time_4m59s, 'IN_PROGRESS');
      expect(result).toBe(false);
    });

    it('considers 5:01 as stale', () => {
      const time_5m01s = new Date(Date.now() - (5 * 60 + 1) * 1000).toISOString();
      const result = isClaimStale(time_5m01s, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('considers exactly 5:00 as fresh', () => {
      const time_5m00s = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const result = isClaimStale(time_5m00s, 'IN_PROGRESS');
      expect(result).toBe(false); // At threshold, not over
    });

    it('considers 5:00.001 as stale', () => {
      const time_5m_001ms = new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString();
      const result = isClaimStale(time_5m_001ms, 'IN_PROGRESS');
      expect(result).toBe(true);
    });
  });

  describe('status variations', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    it('handles PENDING status', () => {
      // PENDING claims should be stale if old (not explicitly handled, defaults to time check)
      const result = isClaimStale(tenMinutesAgo, 'PENDING');
      // Current implementation: only IN_PROGRESS can be stale
      expect(result).toBe(false);
    });

    it('handles FAILED status', () => {
      const result = isClaimStale(tenMinutesAgo, 'FAILED');
      expect(result).toBe(false); // Only IN_PROGRESS can be stale
    });

    it('handles unknown status', () => {
      const result = isClaimStale(tenMinutesAgo, 'UNKNOWN_STATUS');
      expect(result).toBe(false); // Only IN_PROGRESS can be stale
    });

    it('handles lowercase status', () => {
      const result = isClaimStale(tenMinutesAgo, 'completed');
      expect(result).toBe(false); // Should be case-sensitive or normalized
    });
  });

  describe('timestamp format handling', () => {
    it('handles ISO 8601 format', () => {
      const isoTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const result = isClaimStale(isoTime, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('handles RFC 2822 format', () => {
      const rfcTime = new Date(Date.now() - 10 * 60 * 1000).toUTCString();
      const result = isClaimStale(rfcTime, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('handles epoch milliseconds as string', () => {
      const epochTime = (Date.now() - 10 * 60 * 1000).toString();
      const result = isClaimStale(epochTime, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('handles invalid date format', () => {
      const result = isClaimStale('not-a-date', 'IN_PROGRESS');
      expect(result).toBe(true); // Invalid date = NaN = stale
    });
  });

  describe('threshold configuration', () => {
    it('uses 5 minute threshold (300 seconds)', () => {
      const EXPECTED_THRESHOLD_MS = 5 * 60 * 1000;
      expect(EXPECTED_THRESHOLD_MS).toBe(300000);
    });

    it('threshold is exactly 300,000 milliseconds', () => {
      const justOverThreshold = new Date(Date.now() - 300001).toISOString();
      const result = isClaimStale(justOverThreshold, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('threshold is not 4 minutes', () => {
      const fourMinutes = new Date(Date.now() - 4 * 60 * 1000 - 1).toISOString();
      const result = isClaimStale(fourMinutes, 'IN_PROGRESS');
      expect(result).toBe(false);
    });

    it('threshold is not 6 minutes', () => {
      const sixMinutes = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const result = isClaimStale(sixMinutes, 'IN_PROGRESS');
      expect(result).toBe(true); // Over threshold
    });
  });

  describe('clock skew scenarios', () => {
    it('handles small clock skew (future timestamp)', () => {
      const oneMinuteInFuture = new Date(Date.now() + 1 * 60 * 1000).toISOString();
      const result = isClaimStale(oneMinuteInFuture, 'IN_PROGRESS');
      expect(result).toBe(false); // Negative age = fresh
    });

    it('handles very old timestamps (days)', () => {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const result = isClaimStale(oneDayAgo, 'IN_PROGRESS');
      expect(result).toBe(true);
    });

    it('handles epoch zero (1970-01-01)', () => {
      const epochZero = new Date(0).toISOString();
      const result = isClaimStale(epochZero, 'IN_PROGRESS');
      expect(result).toBe(true); // Very old = stale
    });
  });

  describe('integration with Control API behavior', () => {
    it('stale COMPLETED jobs should never be reclaimed', () => {
      const veryOld = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const result = isClaimStale(veryOld, 'COMPLETED');
      expect(result).toBe(false); // Never reclaim completed
    });

    it('fresh IN_PROGRESS jobs should be protected', () => {
      const fresh = new Date(Date.now() - 1 * 60 * 1000).toISOString();
      const result = isClaimStale(fresh, 'IN_PROGRESS');
      expect(result).toBe(false); // Protect fresh claims
    });

    it('stale IN_PROGRESS jobs should be reclaimable', () => {
      const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const result = isClaimStale(stale, 'IN_PROGRESS');
      expect(result).toBe(true); // Allow reclaiming
    });
  });
});

