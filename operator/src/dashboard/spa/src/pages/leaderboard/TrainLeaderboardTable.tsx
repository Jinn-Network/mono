import { useQuery } from '@tanstack/react-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Skeleton } from '../../components/ui/skeleton.js';

import type { JSX } from 'react';

interface TrainRollup {
  implName: string;
  codeDigest: string;
  meanResolved: number;
  verdictCount: number;
  uniqueOperators: number;
}

interface LeaderboardResponse {
  rollups: TrainRollup[];
}

/**
 * Train-mode leaderboard table. One row per harness/codeDigest with the
 * mean resolved %, run count, and unique-operator count. Rolled up server-
 * side at `/api/solvernets/<solverNet>/leaderboard?mode=train` and refreshed
 * every 15s.
 *
 * Migrated to shadcn `<Table>` with right-aligned numeric columns; loading
 * state is a small `<Skeleton>` stack; empty state is a plain muted line.
 */
export function TrainLeaderboardTable({ solverNet }: { solverNet: string }): JSX.Element {
  const { data, isLoading } = useQuery<LeaderboardResponse>({
    queryKey: ['leaderboard', solverNet, 'train'],
    queryFn: async () => {
      const res = await fetch(`/api/solvernets/${encodeURIComponent(solverNet)}/leaderboard?mode=train`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<LeaderboardResponse>;
    },
    refetchInterval: 15_000,
  });

  const rollups = data?.rollups ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-6">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
      </div>
    );
  }

  if (rollups.length === 0) {
    return (
      <div className="p-6 font-mono text-[13px] text-[var(--fg-dim)]">
        No train-mode verdicts recorded yet.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Harness</TableHead>
          <TableHead>codeDigest</TableHead>
          <TableHead className="text-right">Mean resolved</TableHead>
          <TableHead className="text-right">n</TableHead>
          <TableHead className="text-right">Operators</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rollups.map((r) => (
          <TableRow key={r.codeDigest}>
            <TableCell className="font-mono text-[12px] text-foreground">{r.implName}</TableCell>
            <TableCell className="font-mono text-[12px] text-muted-foreground">
              {r.codeDigest.slice(0, 16)}…
            </TableCell>
            <TableCell className="text-right font-mono text-[12px] text-foreground">
              {(r.meanResolved * 100).toFixed(1)}%
            </TableCell>
            <TableCell className="text-right font-mono text-[12px] text-foreground">
              {r.verdictCount}
            </TableCell>
            <TableCell className="text-right font-mono text-[12px] text-foreground">
              {r.uniqueOperators}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
