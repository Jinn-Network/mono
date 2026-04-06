'use client';

import { useCallback, useEffect, useState } from 'react';
import { Coins, ExternalLink, Clock, Copy, Check, ShoppingCart, TrendingUp, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { formatRelativeTime } from '@jinn/shared-ui';

interface TokenInfo {
    token_address: string | null;
    token_symbol: string | null;
    token_name: string | null;
    token_launch_platform: string | null;
    governance_address: string | null;
    pool_address: string | null;
    token_metadata: Record<string, unknown> | null;
}

interface PoolState {
    status: number;
    statusLabel: 'uninitialized' | 'bonding' | 'migrating' | 'graduated' | 'unknown';
    tokensToSell: string;
    progress: number | null; // null when progress can't be calculated (V4 multicurve)
    dopplerUrl: string;
    uniswapUrl: string | null;
}

interface TokenInfoCardProps {
    tokenInfo: TokenInfo;
}

/** Format large token supply numbers compactly: 1000000000 -> "1B", 100000000 -> "100M" */
function formatSupply(raw: unknown): string | null {
    const n = Number(raw);
    if (!raw || isNaN(n) || n <= 0) return null;
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n % 1_000_000_000 === 0 ? 0 : 1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
    return n.toLocaleString();
}

/** Compute allocation percentages from token_metadata fields */
function computeAllocation(meta: Record<string, unknown>): { curve: number; vested: number; treasury: number } | null {
    const total = Number(meta.totalSupply);
    const curve = Number(meta.priceDiscoveryTokens);
    const vested = Number(meta.insiderTokens);
    const treasury = Number(meta.treasuryTokens);
    if (!total || isNaN(total) || isNaN(curve) || isNaN(vested) || isNaN(treasury)) return null;
    return {
        curve: Math.round((curve / total) * 100),
        vested: Math.round((vested / total) * 100),
        treasury: Math.round((treasury / total) * 100),
    };
}

/** Address with copy button and basescan link */
function AddressRow({ label, address }: { label: string; address: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(address);
        setCopied(true);
        toast.success('Copied to clipboard');
        setTimeout(() => setCopied(false), 2000);
    }, [address]);

    return (
        <div className="flex justify-between items-center">
            <span className="text-muted-foreground">{label}</span>
            <div className="flex items-center gap-1">
                <a
                    href={`https://basescan.org/address/${address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline flex items-center gap-1 font-mono text-xs"
                >
                    {address.slice(0, 6)}...{address.slice(-4)}
                    <ExternalLink className="h-3 w-3" />
                </a>
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-5 w-5"
                                onClick={handleCopy}
                            >
                                {copied ? (
                                    <Check className="h-3 w-3 text-green-500" />
                                ) : (
                                    <Copy className="h-3 w-3 text-muted-foreground" />
                                )}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {copied ? 'Copied!' : 'Copy address'}
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            </div>
        </div>
    );
}

/** Pool status badge with appropriate color */
function PoolStatusBadge({ status }: { status: PoolState['statusLabel'] }) {
    const config: Record<string, { label: string; className: string }> = {
        uninitialized: { label: 'Not Started', className: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
        bonding: { label: 'Bonding Curve', className: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
        migrating: { label: 'Migrating', className: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
        graduated: { label: 'Graduated', className: 'bg-green-500/10 text-green-500 border-green-500/20' },
        unknown: { label: 'Unknown', className: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
    };

    const { label, className } = config[status] || config.unknown;

    return (
        <Badge variant="outline" className={className}>
            {label}
        </Badge>
    );
}

export function TokenInfoCard({ tokenInfo }: TokenInfoCardProps) {
    const [poolState, setPoolState] = useState<PoolState | null>(null);
    const [loading, setLoading] = useState(false);

    const meta = tokenInfo.token_metadata ?? {};
    const supply = formatSupply(meta.totalSupply);
    const allocation = computeAllocation(meta);
    const timelock = typeof meta.timelock === 'string' ? meta.timelock : null;
    const safeAddress = typeof meta.safeAddress === 'string' ? meta.safeAddress : null;
    const launchedAt = typeof meta.launchedAt === 'string' ? meta.launchedAt : null;

    // Fetch pool state if this is a Doppler token
    useEffect(() => {
        if (tokenInfo.token_launch_platform === 'doppler' && tokenInfo.token_address) {
            setLoading(true);
            fetch(`/api/doppler-pool?tokenAddress=${tokenInfo.token_address}`)
                .then(res => res.ok ? res.json() : null)
                .then(data => {
                    if (data && !data.error) {
                        setPoolState(data);
                    }
                })
                .catch(err => console.error('Failed to fetch pool state:', err))
                .finally(() => setLoading(false));
        }
    }, [tokenInfo.token_address, tokenInfo.token_launch_platform]);

    // Determine trade URL
    const tradeUrl = poolState?.statusLabel === 'graduated' && poolState.uniswapUrl
        ? poolState.uniswapUrl
        : poolState?.dopplerUrl || `https://app.doppler.lol/tokens/base/${tokenInfo.token_address}`;

    const tradeLabel = poolState?.statusLabel === 'graduated' ? 'Trade on Uniswap' : 'Buy on Doppler';
    const TradeIcon = poolState?.statusLabel === 'graduated' ? TrendingUp : ShoppingCart;

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                    <Coins className="h-4 w-4" />
                    Token
                    {tokenInfo.token_launch_platform && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal capitalize">
                            {tokenInfo.token_launch_platform}
                        </Badge>
                    )}
                    {poolState && <PoolStatusBadge status={poolState.statusLabel} />}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
                {/* Name */}
                {tokenInfo.token_name && (
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">Name</span>
                        <span className="font-medium text-xs truncate ml-4 text-right">{tokenInfo.token_name}</span>
                    </div>
                )}
                {/* Symbol */}
                <div className="flex justify-between">
                    <span className="text-muted-foreground">Symbol</span>
                    <span className="font-mono font-medium">${tokenInfo.token_symbol}</span>
                </div>

                {/* Bonding Curve Status (if in bonding phase) */}
                {poolState?.statusLabel === 'bonding' && (
                    <div className="py-2 px-3 rounded-md bg-amber-500/5 border border-amber-500/20">
                        <div className="flex items-center justify-between">
                            <span className="text-amber-500 font-medium text-xs">Bonding Curve Active</span>
                            <span className="text-[10px] text-muted-foreground">
                                {formatSupply(poolState.tokensToSell)} for sale
                            </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1">
                            Buy tokens on Doppler to help the pool graduate to Uniswap
                        </p>
                    </div>
                )}

                {/* Trade Button */}
                {tokenInfo.token_launch_platform === 'doppler' && (
                    <Button
                        asChild
                        className="w-full mt-2"
                        variant={poolState?.statusLabel === 'graduated' ? 'default' : 'secondary'}
                    >
                        <a href={tradeUrl} target="_blank" rel="noopener noreferrer">
                            {loading ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            ) : (
                                <TradeIcon className="h-4 w-4 mr-2" />
                            )}
                            {tradeLabel}
                            <ExternalLink className="h-3 w-3 ml-1" />
                        </a>
                    </Button>
                )}

                {/* Supply */}
                {supply && (
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">Supply</span>
                        <span className="font-mono text-xs">{supply}</span>
                    </div>
                )}
                {/* Allocation bar */}
                {allocation && (
                    <div className="space-y-1">
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Allocation</span>
                            <span className="text-[11px] text-muted-foreground">
                                {allocation.curve}% curve · {allocation.vested}% vested · {allocation.treasury}% treasury
                            </span>
                        </div>
                        <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-muted">
                            <div className="bg-emerald-500" style={{ width: `${allocation.curve}%` }} />
                            <div className="bg-blue-500" style={{ width: `${allocation.vested}%` }} />
                            <div className="bg-purple-500" style={{ width: `${allocation.treasury}%` }} />
                        </div>
                    </div>
                )}
                {/* Contract */}
                <AddressRow label="Contract" address={tokenInfo.token_address!} />
                {/* Governor */}
                {tokenInfo.governance_address && (
                    <AddressRow label="Governor" address={tokenInfo.governance_address} />
                )}
                {/* Treasury (timelock) */}
                {timelock && (
                    <AddressRow label="Treasury" address={timelock} />
                )}
                {/* Pool */}
                {tokenInfo.pool_address && (
                    <AddressRow label="Pool" address={tokenInfo.pool_address} />
                )}
                {/* Safe */}
                {safeAddress && (
                    <AddressRow label="Safe" address={safeAddress} />
                )}
                {/* Launched date */}
                {launchedAt && (
                    <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Launched</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatRelativeTime(launchedAt)}
                        </span>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
