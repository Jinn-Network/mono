/**
 * Thin context that lifts the `restartPending` flag from App-level local state
 * into a shared surface so `useNotifications` can synthesise the
 * `restart_required` notification without prop-drilling.
 *
 * The context default is `false / noop` so any consumer that renders outside
 * the provider (e.g. isolated unit tests) silently sees "no restart pending"
 * rather than crashing.
 */
import { createContext, useContext } from 'react';

interface RestartPendingContextValue {
  restartPending: boolean;
  setRestartPending: (pending: boolean) => void;
}

export const RestartPendingContext = createContext<RestartPendingContextValue>({
  restartPending: false,
  setRestartPending: () => {},
});

export function useRestartPending(): RestartPendingContextValue {
  return useContext(RestartPendingContext);
}
