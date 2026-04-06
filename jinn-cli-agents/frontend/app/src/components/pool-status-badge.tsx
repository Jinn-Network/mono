import { Badge } from '@/components/ui/badge';

type StatusLabel = 'uninitialized' | 'bonding' | 'migrating' | 'graduated' | 'proposed' | 'unknown';

const config: Record<string, { label: string; className: string }> = {
  proposed: { label: 'Proposed', className: 'bg-violet-500/10 text-violet-500 border-violet-500/20' },
  uninitialized: { label: 'Not Started', className: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
  bonding: { label: 'Bonding Curve', className: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
  migrating: { label: 'Migrating', className: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
  graduated: { label: 'Graduated', className: 'bg-green-500/10 text-green-500 border-green-500/20' },
  unknown: { label: 'Unknown', className: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
};

export function PoolStatusBadge({ status }: { status: StatusLabel }) {
  const { label, className } = config[status] || config.unknown;

  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  );
}
