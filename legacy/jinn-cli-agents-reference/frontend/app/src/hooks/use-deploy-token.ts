'use client';

import { useState, useCallback } from 'react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { deployVentureToken, type DeployTokenResult } from '@/lib/doppler-deploy';

interface UseDeployTokenReturn {
  deploy: (name: string, symbol: string) => Promise<DeployTokenResult>;
  isReady: boolean;
  isPending: boolean;
  error: string | null;
}

export function useDeployToken(): UseDeployTokenReturn {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isReady = !!publicClient && !!walletClient;

  const deploy = useCallback(
    async (name: string, symbol: string): Promise<DeployTokenResult> => {
      if (!publicClient || !walletClient) {
        throw new Error('Wallet not connected');
      }

      setIsPending(true);
      setError(null);

      try {
        const result = await deployVentureToken({
          name,
          symbol,
          publicClient,
          walletClient,
        });
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Deployment failed';
        setError(message);
        throw err;
      } finally {
        setIsPending(false);
      }
    },
    [publicClient, walletClient]
  );

  return { deploy, isReady, isPending, error };
}
