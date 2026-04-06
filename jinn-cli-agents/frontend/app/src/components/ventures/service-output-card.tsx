import { ExternalLink } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { ServiceOutput } from '@/lib/ventures/service-types';

interface ServiceOutputCardProps {
    output: ServiceOutput;
}

export function ServiceOutputCard({ output }: ServiceOutputCardProps) {
    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                    Service Output
                </CardTitle>
            </CardHeader>
            <CardContent>
                <Button variant="outline" asChild>
                    <a
                        href={output.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center"
                    >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        {output.label || 'Visit Output'}
                    </a>
                </Button>
            </CardContent>
        </Card>
    );
}
