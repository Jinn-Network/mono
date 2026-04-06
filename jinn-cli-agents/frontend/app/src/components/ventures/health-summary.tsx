import { Card, CardContent } from '@/components/ui/card';
import type { HealthStatus } from '@jinn/shared-ui';

interface HealthSummaryProps {
  counts: Record<HealthStatus, number>;
}

export function HealthSummary({ counts }: HealthSummaryProps) {
  const total = counts.healthy + counts.warning + counts.critical + counts.unknown;
  const measured = total - counts.unknown;
  const passing = counts.healthy;

  return (
    <Card>
      <CardContent className="py-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Health Status</h3>
            <p className="text-sm text-muted-foreground">
              {measured > 0
                ? `${passing}/${measured} invariants passing`
                : 'No measurements yet'}
            </p>
          </div>
          <div className="flex gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-green-500">{counts.healthy}</div>
              <div className="text-xs text-muted-foreground">Healthy</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-yellow-500">{counts.warning}</div>
              <div className="text-xs text-muted-foreground">Warning</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-red-500">{counts.critical}</div>
              <div className="text-xs text-muted-foreground">Critical</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-muted-foreground">{counts.unknown}</div>
              <div className="text-xs text-muted-foreground">Unknown</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
