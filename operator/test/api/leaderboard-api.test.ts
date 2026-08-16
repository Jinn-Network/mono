import { describe, it, expect } from 'vitest';
import { leaderboardRoutes } from '../../src/api/leaderboard-api.js';

describe('GET /api/solvernets/:name/leaderboard', () => {
  it('returns train-mode HarnessRollup query results', async () => {
    const app = leaderboardRoutes({
      querySubgraph: async () => ({
        harnessRollups: [
          {
            implName: 'claude-code-learner',
            codeDigest: 'sha256:abc',
            mode: 'train',
            verdictCount: 12,
            scoreSum: 7,
            uniqueOperators: 1,
            lastSeenAt: 1746547200,
          },
        ],
      }),
      isCheckpointVerified: async () => false,
    });
    const res = await app.request('/api/solvernets/swe-rebench-v2/leaderboard?mode=train');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rollups: Array<{ mode: string }>;
    };
    expect(body.rollups).toHaveLength(1);
    expect(body.rollups[0].mode).toBe('train');
  });

  it('filters by mode = "frozen"', async () => {
    const app = leaderboardRoutes({
      querySubgraph: async (mode) => ({
        harnessRollups: [
          {
            implName: 'claude-code-learner',
            codeDigest: 'sha256:abc',
            mode,
            verdictCount: 12,
            scoreSum: 7,
            uniqueOperators: 1,
            lastSeenAt: 1746547200,
          },
        ],
      }),
      isCheckpointVerified: async () => false,
    });
    const res = await app.request('/api/solvernets/swe-rebench-v2/leaderboard?mode=frozen');
    const body = (await res.json()) as {
      rollups: Array<{ mode: string }>;
    };
    expect(body.rollups[0].mode).toBe('frozen');
  });
});
