'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classifySurface, SurfaceStatus, useDaemonJson } from '@/lib/use-daemon';

type TaskPostCounts = {
  chain?: { h1: number; h6: number; h24: number };
};

export default function PostingPage() {
  const { data, loading, error } = useDaemonJson<TaskPostCounts>(
    '/v1/discovery/task-post-counts',
    30_000,
  );
  const chain = data?.chain;
  const state = classifySurface({
    loading: loading && !data,
    error,
    empty: !chain || chain.h24 === 0,
  });

  return (
    <Card data-testid="network-task-posts">
      <CardHeader>
        <CardTitle>Posting</CardTitle>
      </CardHeader>
      <CardContent>
        {state !== 'ready' || !chain ? (
          <SurfaceStatus name="posting" state={state} />
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {(
              [
                ['Last 1h', chain.h1],
                ['Last 6h', chain.h6],
                ['Last 24h', chain.h24],
              ] as const
            ).map(([label, count]) => (
              <div key={label} className="flex flex-col gap-1">
                <span className="font-mono text-[11px] tracking-[0.12em] text-dim uppercase">
                  {label}
                </span>
                <span className="font-mono text-[20px]">{count}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
