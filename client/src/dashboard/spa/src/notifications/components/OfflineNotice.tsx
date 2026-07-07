import type { JSX } from 'react';
import { useNotifications } from '../useNotifications.js';
import { NotificationsList } from './NotificationsList.js';

/**
 * The blocking offline signal (issue #443).
 *
 * `useNotifications` returns the `rpc_unreachable` notice the instant the
 * connection-state probe flips to `disconnected`. AppShell already renders the
 * full notice list, but the pre-running gate (App.tsx) mounts AppShell only on
 * the `running` branch. A daemon that dies after a successful first poll leaves
 * react-query serving cached data, so the gate lands in the Onboarding
 * (pre-running / bootstrap takeover) branch, which previously surfaced nothing
 * for the offline signal. Mounting this filtered notice there keeps a dying
 * daemon from going silent.
 */
export function OfflineNotice(): JSX.Element | null {
  const notices = useNotifications().filter((n) => n.kind === 'rpc_unreachable');
  return <NotificationsList notices={notices} />;
}
