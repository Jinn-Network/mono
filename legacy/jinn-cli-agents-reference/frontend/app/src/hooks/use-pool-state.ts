'use client';

import { useState, useEffect, useCallback } from 'react';

interface PoolState {
  status: number;
  statusLabel: 'uninitialized' | 'bonding' | 'migrating' | 'graduated';
  tokensToSell: string;
  progress: number | null;
  dopplerUrl: string;
  uniswapUrl: string | null;
}

interface UsePoolStateReturn {
  poolState: PoolState | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function usePoolState(tokenAddress: string | null): UsePoolStateReturn {
  const [poolState, setPoolState] = useState<PoolState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPoolState = useCallback(async () => {
    if (!tokenAddress) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/doppler-pool?tokenAddress=${tokenAddress}`);
      if (!res.ok) throw new Error('Failed to fetch pool state');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPoolState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [tokenAddress]);

  useEffect(() => {
    fetchPoolState();

    // Poll every 30 seconds
    const interval = setInterval(fetchPoolState, 30_000);
    return () => clearInterval(interval);
  }, [fetchPoolState]);

  return { poolState, loading, error, refetch: fetchPoolState };
}
