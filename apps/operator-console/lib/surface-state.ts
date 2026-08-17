export type SurfaceState = 'loading' | 'empty' | 'error' | 'ready';

export function classifySurface(input: {
  loading: boolean;
  error: string | null;
  empty: boolean;
}): SurfaceState {
  if (input.loading) return 'loading';
  if (input.error) return 'error';
  if (input.empty) return 'empty';
  return 'ready';
}

export const SURFACE_COPY = {
  overview: {
    loading: 'Loading',
    empty: 'No status',
    error: 'Status unavailable',
  },
  events: {
    loading: 'Loading',
    empty: 'No events',
    error: 'Events unavailable',
  },
  notifications: {
    loading: 'Loading',
    empty: 'No notifications',
    error: 'Notifications unavailable',
  },
  claimPolicy: {
    loading: 'Loading',
    empty: 'Claim policy not set',
    error: 'Claim policy unavailable',
  },
  network: {
    loading: 'Loading',
    empty: 'No RPC slots',
    error: 'Network unavailable',
  },
  security: {
    loading: 'Loading',
    empty: 'Token not set',
    error: 'Security unavailable',
  },
  posting: {
    loading: 'Loading',
    empty: 'No task posts in the last 24h.',
    error: 'Task-post rate is unavailable while the indexer catches up.',
  },
} as const;

export type SurfaceName = keyof typeof SURFACE_COPY;

export function surfaceMessage(
  name: SurfaceName,
  state: SurfaceState,
): string | undefined {
  if (state === 'ready') return undefined;
  return SURFACE_COPY[name][state];
}
