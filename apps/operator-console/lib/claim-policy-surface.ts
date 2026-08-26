import { classifySurface, type SurfaceState } from '@/lib/surface-state';

export function claimPolicySurface(input: {
  loading: boolean;
  data: unknown;
  error: string | null;
}): SurfaceState {
  return classifySurface({
    loading: input.loading && !input.data,
    error: input.error,
    empty: false,
  });
}
