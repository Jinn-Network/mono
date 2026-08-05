import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useConnectionState } from '../api/connection-state.js';
import type { OperatorNotification } from './taxonomy.js';

const SEVERITY_ORDER: Record<OperatorNotification['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

/**
 * Notification derivation moved server-side (issue #2408, spec §6.5) — this hook is now a
 * thin fetcher over `GET /v1/notifications` plus exactly one client-local overlay: the
 * disconnected signal, which by construction a server can never report about its own
 * unreachability (spec §6 composition item 5). Everything else this hook used to compute
 * itself (`deriveNotifications`, `mapStatusToDeriveInput`, the `claim_failed` SSE-ring
 * aggregation, the `restartPending` context read) is gone — the daemon computes it from the
 * same receipts + live-health class and serves the already-derived, already-sorted list.
 *
 * Shares the react-query cache with no other poller (there wasn't one for this key before
 * either); `refetchInterval` matches the existing `['status']` cadence (5s) so the
 * notification surface stays as fresh as Overview's own status poll.
 */
export function useNotifications(): OperatorNotification[] {
  const connection = useConnectionState();
  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.getNotifications(),
    refetchInterval: 5000,
  });

  // When the SPA can't reach the daemon, surface a blocking notification immediately
  // without waiting for (stale) query data. This is the one notice a server can never
  // produce about itself — it stays client-local by construction.
  if (connection.status === 'disconnected') {
    return [
      {
        kind: 'rpc_unreachable',
        severity: 'blocking',
        title: 'Daemon unreachable',
        message: 'Daemon offline. What you see may be stale. Reconnecting automatically…',
      },
    ];
  }

  const notifications = query.data?.notifications ?? [];
  return [...notifications].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}
