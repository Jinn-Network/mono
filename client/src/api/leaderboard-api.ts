import { Hono } from 'hono';

export interface LeaderboardDeps {
  querySubgraph(mode: 'train' | 'frozen'): Promise<{
    harnessRollups: Array<{
      implName: string;
      codeDigest: string;
      mode: 'train' | 'frozen';
      verdictCount: number;
      scoreSum: number;
      uniqueOperators: number;
      lastSeenAt: number;
      meanResolved?: number;
    }>;
  }>;
  isCheckpointVerified(args: { implName: string; codeDigest: string }): Promise<boolean>;
}

export function leaderboardRoutes(deps: LeaderboardDeps): Hono {
  const app = new Hono();
  app.get('/api/solvernets/:name/leaderboard', async (c) => {
    const mode = (c.req.query('mode') ?? 'train') as 'train' | 'frozen';
    const result = await deps.querySubgraph(mode);
    const rollups = await Promise.all(
      result.harnessRollups.map(async (r) => ({
        ...r,
        meanResolved: r.verdictCount > 0 ? r.scoreSum / r.verdictCount : 0,
        verified:
          mode === 'frozen'
            ? await deps.isCheckpointVerified({ implName: r.implName, codeDigest: r.codeDigest })
            : null,
      })),
    );
    return c.json({ rollups });
  });
  return app;
}
