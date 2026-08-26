export type MergeableEvent = {
  id?: string;
  time?: string;
};

const DEFAULT_CAP = 200;

export function mergeEventsById<T extends MergeableEvent>(
  existing: readonly T[],
  incoming: readonly T[],
  cap: number = DEFAULT_CAP,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const push = (event: T): void => {
    if (event.id) {
      if (seen.has(event.id)) return;
      seen.add(event.id);
    }
    out.push(event);
  };
  for (const event of incoming) push(event);
  for (const event of existing) push(event);
  return out.slice(0, cap);
}
