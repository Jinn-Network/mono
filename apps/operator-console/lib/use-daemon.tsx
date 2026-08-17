'use client';

import { useCallback, useEffect, useState } from 'react';

import { daemonJson } from '@/lib/daemon';
import { surfaceMessage, type SurfaceName, type SurfaceState } from '@/lib/surface-state';

export { classifySurface } from '@/lib/surface-state';

export function useDaemonJson<T>(path: string, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await daemonJson<T>(path);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (!intervalMs) return undefined;
    const id = window.setInterval(() => {
      void reload();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [reload, intervalMs]);

  return { data, loading, error, reload, setData };
}

export function SurfaceStatus({
  name,
  state,
}: {
  name: SurfaceName;
  state: SurfaceState;
}) {
  const message = surfaceMessage(name, state);
  if (!message) return null;
  return (
    <p
      data-testid={`${name}-state`}
      data-state={state}
      className="m-0 font-mono text-[13px] text-muted-foreground"
    >
      {message}
    </p>
  );
}
