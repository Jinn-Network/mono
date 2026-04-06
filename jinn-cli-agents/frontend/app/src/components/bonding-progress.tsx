'use client';

import { ExternalLink, ShoppingCart, TrendingUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PoolStatusBadge } from '@/components/pool-status-badge';
import { usePoolState } from '@/hooks/use-pool-state';

interface BondingProgressProps {
  tokenAddress: string;
}

export function BondingProgress({ tokenAddress }: BondingProgressProps) {
  const { poolState, loading } = usePoolState(tokenAddress);

  if (loading && !poolState) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading pool state...
      </div>
    );
  }

  if (!poolState) return null;

  const isGraduated = poolState.statusLabel === 'graduated';
  const tradeUrl = isGraduated && poolState.uniswapUrl
    ? poolState.uniswapUrl
    : poolState.dopplerUrl;
  const tradeLabel = isGraduated ? 'Trade on Uniswap' : 'Buy on Doppler';
  const TradeIcon = isGraduated ? TrendingUp : ShoppingCart;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <PoolStatusBadge status={poolState.statusLabel} />
        {poolState.tokensToSell && (
          <span className="text-xs text-muted-foreground">
            {poolState.tokensToSell} tokens for sale
          </span>
        )}
      </div>

      {poolState.statusLabel === 'bonding' && (
        <div className="py-2 px-3 rounded-md bg-amber-500/5 border border-amber-500/20">
          <p className="text-xs text-muted-foreground">
            Buy tokens on Doppler to help the pool graduate to Uniswap
          </p>
        </div>
      )}

      <Button asChild className="w-full" variant={isGraduated ? 'default' : 'secondary'}>
        <a href={tradeUrl} target="_blank" rel="noopener noreferrer">
          <TradeIcon className="h-4 w-4 mr-2" />
          {tradeLabel}
          <ExternalLink className="h-3 w-3 ml-1" />
        </a>
      </Button>
    </div>
  );
}
