/**
 * Port result envelope (architecture spec §4). Adapters may throw; ports
 * never do — every port method resolves a PortResult so a failure surfaces
 * as a typed outcome, never a crash into the host session.
 */
export type PortResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'degraded'; reason: string; value?: T }
  | { status: 'unavailable'; reason: string };

export function ok<T>(value: T): PortResult<T> {
  return { status: 'ok', value };
}

export function degraded<T>(reason: string, value?: T): PortResult<T> {
  return { status: 'degraded', reason, value };
}

export function unavailable<T = never>(reason: string): PortResult<T> {
  return { status: 'unavailable', reason };
}

/** Fail-open value access: ok → value; degraded → value ?? fallback; unavailable → fallback. */
export function valueOr<T>(res: PortResult<T>, fallback: T): T {
  if (res.status === 'ok') return res.value;
  if (res.status === 'degraded') return res.value ?? fallback;
  return fallback;
}

/** Like valueOr, but also surfaces the failure reason so callers can collect it. */
export function unwrap<T>(res: PortResult<T>, fallback: T): { value: T; reason?: string } {
  if (res.status === 'ok') return { value: res.value };
  return { value: res.status === 'degraded' ? res.value ?? fallback : fallback, reason: res.reason };
}
