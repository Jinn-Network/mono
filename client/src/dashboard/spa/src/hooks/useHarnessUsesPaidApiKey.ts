import { useQuery } from '@tanstack/react-query';
import { canonicalHarnessName } from '../../../../harnesses/names.js';
import { api } from '../api/client.js';
import type { CostSurfaceStatusWire } from '../api/types.js';

type StatusWithCostSurface = { costSurface?: CostSurfaceStatusWire };

export function useHarnessUsesPaidApiKey(harness: string | undefined): boolean {
  const { data, isPending } = useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<StatusWithCostSurface>,
  });

  if (!harness) return false;
  if (isPending || !data?.costSurface) return true;
  const entry = data.costSurface.harnesses[canonicalHarnessName(harness)];
  return entry?.usesPaidApiKey ?? true;
}
