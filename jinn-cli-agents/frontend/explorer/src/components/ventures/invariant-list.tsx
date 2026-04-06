import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  InvariantCard,
  type Invariant,
  type LegacyInvariant,
  type InvariantMeasurement,
  type HealthStatus,
} from '@jinn/shared-ui';

/**
 * Combined invariant with its latest measurement
 */
export interface InvariantWithMeasurement {
  id: string;
  invariant: Invariant | LegacyInvariant;
  text: string;
  measurement?: InvariantMeasurement;
  latestScore?: number | boolean;
  latestContext?: string;
  lastMeasuredAt?: string;
  status: HealthStatus;
}

interface InvariantListProps {
  invariants: InvariantWithMeasurement[];
}

export function InvariantList({ invariants }: InvariantListProps) {
  if (invariants.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No invariants found in blueprint
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invariants</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {invariants.map((inv) => (
            <InvariantCard
              key={inv.id}
              invariant={inv.invariant}
              measurement={inv.measurement}
              status={inv.status}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
