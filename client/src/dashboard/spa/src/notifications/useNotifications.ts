import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useConnectionState } from '../api/connection-state.js';
import { useRestartPending } from '../shell/RestartPendingContext.js';
import { deriveNotifications, type DeriveInput } from './derive.js';
import type { OperatorNotification } from './taxonomy.js';

const SEVERITY_ORDER: Record<OperatorNotification['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

export function useNotifications(): OperatorNotification[] {
  const connection = useConnectionState();
  const { restartPending } = useRestartPending();
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
    refetchInterval: 5000,
  });
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 5000,
  });

  return useMemo(() => {
    // When the SPA can't reach the daemon, surface a blocking notification
    // immediately without waiting for (stale) status/bootstrap data.
    if (connection.status === 'disconnected') {
      return [
        {
          kind: 'rpc_unreachable' as const,
          severity: 'blocking' as const,
          message: 'Daemon offline. What you see may be stale. Reconnecting automatically…',
        },
      ];
    }

    if (!status.data || !bootstrap.data) return [];

    // Merge the locally-tracked restart-pending flag into the status shape so
    // the deriver can emit `restart_required` without the server having to
    // expose this transient UI state.
    const statusWithRestart = {
      ...(status.data as DeriveInput['status']),
      restartPending,
    };

    const derived = deriveNotifications({
      bootstrap: bootstrap.data as DeriveInput['bootstrap'],
      status: statusWithRestart,
    });
    return [...derived].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  }, [connection.status, restartPending, status.data, bootstrap.data]);
}
