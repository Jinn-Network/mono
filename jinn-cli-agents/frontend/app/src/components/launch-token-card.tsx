'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import { useAccount, useConnect } from 'wagmi';
import { Rocket, Loader2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useDeployToken } from '@/hooks/use-deploy-token';
import { updateVentureToken } from '@/app/actions';

interface LaunchTokenCardProps {
  ventureId: string;
  ventureName: string;
  kpiCount?: number;
}

export function LaunchTokenCard({ ventureId, ventureName, kpiCount = 0 }: LaunchTokenCardProps) {
  const router = useRouter();
  const { ready, authenticated, login, connectWallet } = usePrivy();
  const { isConnected, address } = useAccount();
  const { connect, connectors } = useConnect();
  const { deploy } = useDeployToken();

  // Attempt to sync Privy auth with Wagmi connection
  useEffect(() => {
    if (ready && authenticated && !isConnected) {
      const privyConnector = connectors.find((c) => c.id === 'privy');
      if (privyConnector) {
        connect({ connector: privyConnector });
      }
    }
  }, [ready, authenticated, isConnected, connectors, connect]);

  const [symbol, setSymbol] = useState('');
  const [step, setStep] = useState<'form' | 'deploying' | 'updating'>('form');
  const [walletTimedOut, setWalletTimedOut] = useState(false);

  // Timeout for wallet auto-connect — show manual connect after 5s
  useEffect(() => {
    if (ready && authenticated && !isConnected) {
      setWalletTimedOut(false);
      const timer = setTimeout(() => setWalletTimedOut(true), 5000);
      return () => clearTimeout(timer);
    }
    if (isConnected) {
      setWalletTimedOut(false);
    }
  }, [ready, authenticated, isConnected]);

  const isValid = symbol.trim().length >= 2 && symbol.trim().length <= 10;

  async function handleLaunch() {
    if (!address || !isValid) return;

    try {
      setStep('deploying');
      toast.info('Confirm the transaction in your wallet...');

      const deployResult = await deploy(ventureName, symbol.trim().toUpperCase());

      setStep('updating');
      const updateResult = await updateVentureToken(ventureId, {
        token_address: deployResult.tokenAddress,
        token_symbol: symbol.trim().toUpperCase(),
        token_name: ventureName,
        governance_address: deployResult.governor,
        pool_address: deployResult.poolInitializer,
        token_metadata: {
          poolId: deployResult.poolId,
          totalSupply: '1000000000',
          priceDiscoveryTokens: '100000000',
          insiderTokens: '100000000',
          treasuryTokens: '800000000',
          numeraire: deployResult.numeraire,
          transactionHash: deployResult.transactionHash,
          launchedAt: new Date().toISOString(),
          governor: deployResult.governor,
          timelock: deployResult.timelock,
          liquidityMigrator: deployResult.liquidityMigrator,
          poolInitializer: deployResult.poolInitializer,
          migrationPool: deployResult.migrationPool,
          integrator: deployResult.integrator,
        },
      });

      if (updateResult.error) {
        toast.error('Token deployed but failed to update venture record');
      } else {
        toast.success('Token launched!');
      }

      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Launch failed';
      toast.error(message);
      setStep('form');
    }
  }

  if (!ready) {
    return (
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Launch Token
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 animate-pulse">
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-9 w-full rounded bg-muted" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // KPI gating
  if (kpiCount < 2) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Launch Token
          </CardTitle>
          <CardDescription>
            Define at least 2 success criteria before launching a token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {kpiCount === 0
              ? 'No KPIs defined yet. Scroll up to add success criteria.'
              : `${kpiCount}/2 KPIs defined. Add ${2 - kpiCount} more to unlock launch.`}
          </p>
        </CardContent>
      </Card>
    );
  }

  // Not signed in
  if (!authenticated) {
    return (
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Launch Token
          </CardTitle>
          <CardDescription>
            Sign in to launch a token for this idea.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={login} className="w-full">Sign In</Button>
        </CardContent>
      </Card>
    );
  }

  // Signed in but no wallet connected (email-only user)
  if (!isConnected) {
    return (
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Launch Token
          </CardTitle>
          <CardDescription>
            A wallet is needed to deploy a token on Base. Your embedded wallet will activate automatically, or connect an external wallet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {walletTimedOut ? (
            <Button onClick={() => connectWallet()} className="w-full">
              <Wallet className="h-4 w-4 mr-2" />
              Connect Wallet
            </Button>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Connecting wallet...</span>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Rocket className="h-4 w-4" />
          Launch Token
        </CardTitle>
        <CardDescription>
          Deploy a Doppler bonding curve to rally support. 10% for price discovery, 10% vested, 80% governance treasury.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="symbol">Token Symbol</Label>
          <Input
            id="symbol"
            placeholder="TICKER"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            maxLength={10}
            disabled={step !== 'form'}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">2-10 characters</p>
        </div>

        <Button
          onClick={handleLaunch}
          disabled={!isValid || step !== 'form'}
          className="w-full"
        >
          {step !== 'form' && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          {step === 'deploying'
            ? 'Deploying...'
            : step === 'updating'
              ? 'Saving...'
              : 'Launch Token'}
        </Button>
      </CardContent>
    </Card>
  );
}
