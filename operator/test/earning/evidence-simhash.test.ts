import { describe, it, expect } from 'vitest';
import {
  computeEvidenceSimHash,
  extractFeatures,
  hammingDistance,
  simhashFromFeatures,
  type EvidenceCheckpointV1,
} from '../../src/earning/evidence-simhash.js';

const makeCheckpoint = (overrides?: Partial<EvidenceCheckpointV1>): EvidenceCheckpointV1 => ({
  version: 1,
  desiredStateHash: '0xabc123',
  toolCalls: [
    { name: 'readFile', argsHash: '0xdef456' },
    { name: 'writeFile', argsHash: '0x789012' },
  ],
  externalInteractions: [
    { endpoint: 'https://api.example.com/status', method: 'GET' },
  ],
  outcome: 'success',
  ...overrides,
});

describe('evidence-simhash', () => {
  describe('extractFeatures', () => {
    it('extracts expected features from a checkpoint', () => {
      const checkpoint = makeCheckpoint();
      const features = extractFeatures(checkpoint);

      expect(features).toContain('desired:0xabc123');
      expect(features).toContain('tool:readfile:0xdef456');
      expect(features).toContain('tool:writefile:0x789012');
      expect(features).toContain('ext:https://api.example.com/status:get');
      expect(features).toContain('outcome:success');
      expect(features).toHaveLength(5);
    });

    it('normalizes tool names and endpoints to lowercase', () => {
      const checkpoint = makeCheckpoint({
        toolCalls: [{ name: 'ReadFile', argsHash: '0x1' }],
        externalInteractions: [{ endpoint: 'HTTPS://API.COM', method: 'POST' }],
      });
      const features = extractFeatures(checkpoint);

      expect(features).toContain('tool:readfile:0x1');
      expect(features).toContain('ext:https://api.com:post');
    });

    it('handles empty tool calls and interactions', () => {
      const checkpoint = makeCheckpoint({
        toolCalls: [],
        externalInteractions: [],
      });
      const features = extractFeatures(checkpoint);

      // desired + outcome only
      expect(features).toHaveLength(2);
    });
  });

  describe('simhashFromFeatures', () => {
    it('returns zero hash for empty features', () => {
      const hash = simhashFromFeatures([]);
      expect(hash).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('is deterministic — same features produce same hash', () => {
      const features = ['feat:a', 'feat:b', 'feat:c'];
      const hash1 = simhashFromFeatures(features);
      const hash2 = simhashFromFeatures(features);
      expect(hash1).toBe(hash2);
    });

    it('produces a valid 66-char hex string', () => {
      const hash = simhashFromFeatures(['test']);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe('computeEvidenceSimHash', () => {
    it('produces deterministic output', () => {
      const checkpoint = makeCheckpoint();
      const hash1 = computeEvidenceSimHash(checkpoint);
      const hash2 = computeEvidenceSimHash(checkpoint);
      expect(hash1).toBe(hash2);
    });

    it('similar checkpoints produce similar hashes (low Hamming distance)', () => {
      const cp1 = makeCheckpoint();
      // Change only the outcome
      const cp2 = makeCheckpoint({ outcome: 'failure' });

      const hash1 = computeEvidenceSimHash(cp1);
      const hash2 = computeEvidenceSimHash(cp2);

      const distance = hammingDistance(hash1, hash2);
      // Changing 1 of 5 features should give small Hamming distance
      // (not exact, but should be well below 128)
      expect(distance).toBeLessThan(128);
    });

    it('very different checkpoints produce dissimilar hashes (high Hamming distance)', () => {
      const cp1 = makeCheckpoint();
      const cp2 = makeCheckpoint({
        desiredStateHash: '0xcompletely_different',
        toolCalls: [
          { name: 'deleteDatabase', argsHash: '0xdanger' },
          { name: 'formatDisk', argsHash: '0xbad' },
          { name: 'dropTables', argsHash: '0xworse' },
        ],
        externalInteractions: [
          { endpoint: 'https://evil.com/hack', method: 'DELETE' },
          { endpoint: 'https://other.com/pwn', method: 'PUT' },
        ],
        outcome: 'failure',
      });

      const hash1 = computeEvidenceSimHash(cp1);
      const hash2 = computeEvidenceSimHash(cp2);

      const distance = hammingDistance(hash1, hash2);
      // Completely different features should give distance near 128 (random)
      // Allow some variance, but should be well above the typical threshold of 64
      expect(distance).toBeGreaterThan(50);
    });

    it('identical checkpoints produce identical hashes (distance 0)', () => {
      const cp = makeCheckpoint();
      const hash1 = computeEvidenceSimHash(cp);
      const hash2 = computeEvidenceSimHash(cp);
      expect(hammingDistance(hash1, hash2)).toBe(0);
    });
  });

  describe('hammingDistance', () => {
    it('returns 0 for identical hashes', () => {
      const hash = '0x' + 'ff'.repeat(32);
      expect(hammingDistance(hash as `0x${string}`, hash as `0x${string}`)).toBe(0);
    });

    it('returns 256 for fully inverted hashes', () => {
      const a = '0x' + '00'.repeat(32);
      const b = '0x' + 'ff'.repeat(32);
      expect(hammingDistance(a as `0x${string}`, b as `0x${string}`)).toBe(256);
    });

    it('returns 1 for hashes differing by one bit', () => {
      const a = '0x' + '00'.repeat(32);
      const b = '0x' + '00'.repeat(31) + '01';
      expect(hammingDistance(a as `0x${string}`, b as `0x${string}`)).toBe(1);
    });

    it('returns 8 for hashes differing by one byte', () => {
      const a = '0x' + '00'.repeat(32);
      const b = '0x' + '00'.repeat(31) + 'ff';
      expect(hammingDistance(a as `0x${string}`, b as `0x${string}`)).toBe(8);
    });
  });
});
