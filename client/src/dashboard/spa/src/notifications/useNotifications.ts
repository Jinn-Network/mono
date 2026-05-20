import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { deriveNotifications, type DeriveInput } from './derive.js';
import type { OperatorNotification } from './taxonomy.js';

const SEVERITY_ORDER: Record<OperatorNotification['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

export function useNotifications(): OperatorNotification[] {
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
    if (!status.data || !bootstrap.data) return [];
    const derived = deriveNotifications({
      bootstrap: bootstrap.data as DeriveInput['bootstrap'],
      status: status.data as DeriveInput['status'],
    });
    return [...derived].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  }, [status.data, bootstrap.data]);
}
