import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { ServiceInstance } from '@/lib/ventures/service-types';

interface FeaturedVentureCardProps {
    instance: ServiceInstance;
    name: string;
    description: string;
    tokenSymbol?: string | null;
    poolAddress?: string | null;
}

export function FeaturedVentureCard({ instance, name, description, tokenSymbol, poolAddress }: FeaturedVentureCardProps) {
    return (
        <Card className="relative overflow-hidden border-primary/50 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent">
            {/* Glow effect */}
            <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-transparent to-transparent opacity-50" />

            <CardHeader className="relative">
                <div className="flex items-center gap-3">
                    <CardTitle className="text-2xl">{name}</CardTitle>
                    {tokenSymbol && (
                        poolAddress ? (
                            <a
                                href={`https://basescan.org/address/${poolAddress}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm font-mono text-primary hover:underline"
                            >
                                ${tokenSymbol}
                            </a>
                        ) : (
                            <span className="text-sm font-mono text-primary">${tokenSymbol}</span>
                        )
                    )}
                </div>
                <CardDescription className="mt-2 text-base">
                    {description}
                </CardDescription>
            </CardHeader>

            <CardFooter className="relative">
                <Button asChild variant="default" className="flex-1">
                    <Link href={`/ventures/${instance.workstreamId}`}>
                        View Dashboard
                    </Link>
                </Button>
            </CardFooter>
        </Card>
    );
}

// Loading skeleton
export function FeaturedVentureCardSkeleton() {
    return (
        <Card className="border-primary/50">
            <CardHeader>
                <div className="h-7 w-48 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-5 w-full animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardFooter>
                <div className="h-10 flex-1 animate-pulse rounded bg-muted" />
            </CardFooter>
        </Card>
    );
}
