export function parseLastEventId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export type SseResumePlan =
  | { action: "backfill"; afterId?: number }
  | { action: "id-not-in-buffer" };

export function sseResumePlan(
  lastEventId: number | undefined,
  hasId: (id: number) => boolean,
): SseResumePlan {
  if (lastEventId === undefined) return { action: "backfill" };
  if (!hasId(lastEventId)) return { action: "id-not-in-buffer" };
  return { action: "backfill", afterId: lastEventId };
}
