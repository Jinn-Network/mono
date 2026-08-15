import { useQuery } from '@tanstack/react-query';
import { canonicalHarnessName } from '../../../../harnesses/names.js';
import { api } from '../api/client.js';

export function useHarnessUsesPaidApiKey(harness: string | undefined): boolean {
  const { data, isPending } = useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
  });

  if (!harness) return false;
  if (isPending || !data?.costSurface) return true;
  const entry = data.costSurface.harnesses[canonicalHarnessName(harness)];
  return entry?.usesPaidApiKey ?? true;
}
