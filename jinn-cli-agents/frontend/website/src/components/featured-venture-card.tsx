import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, Sparkles } from 'lucide-react';
import { LAUNCHPAD_URL, getExplorerUrl } from '@/lib/featured-services';
import type { Venture } from '@/lib/ventures-queries';

interface FeaturedVentureCardProps {
    venture: Venture;
}

export function FeaturedVentureCard({ venture }: FeaturedVentureCardProps) {
    const launchpadHref = venture.slug
        ? `${LAUNCHPAD_URL}/ventures/${venture.slug}`
        : null;
    const explorerHref = getExplorerUrl('venture', venture.id);

    return (
        <Card className="relative overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-muted/30">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(20,184,166,0.12),transparent_45%)]" />

            <CardHeader className="relative">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-teal-500" />
                        <Badge variant="outline" className="border-teal-500/40 text-teal-700 dark:text-teal-300">
                            Active Venture
                        </Badge>
                    </div>
                    {venture.token_symbol && (
                        <Badge variant="outline" className="text-xs font-mono bg-teal-500/10 border-teal-500/30 text-teal-700 dark:text-teal-300">
                            ${venture.token_symbol}
                        </Badge>
                    )}
                </div>
                <CardTitle className="mt-4 text-2xl">{venture.name}</CardTitle>
                <CardDescription className="mt-2 text-base">
                    {venture.description || 'An autonomous venture on the Jinn network.'}
                </CardDescription>
            </CardHeader>

            <CardFooter className="relative gap-2">
                {launchpadHref && (
                    <Button asChild variant="default" className="flex-1">
                        <a
                            href={launchpadHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2"
                        >
                            Open Venture
                            <ExternalLink className="h-4 w-4" />
                        </a>
                    </Button>
                )}
                <Button asChild variant="outline" className={launchpadHref ? 'flex-1' : 'w-full'}>
                    <a
                        href={explorerHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2"
                    >
                        View in Explorer
                        <ExternalLink className="h-4 w-4" />
                    </a>
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
                <div className="h-5 w-32 animate-pulse rounded bg-muted" />
                <div className="mt-4 h-7 w-48 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-5 w-full animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent>
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            </CardContent>
            <CardFooter>
                <div className="h-10 flex-1 animate-pulse rounded bg-muted" />
            </CardFooter>
        </Card>
    );
}
