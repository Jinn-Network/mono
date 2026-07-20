export interface CaptureMetaHit {
  manifestCid: string;
  taskSummary: string;
  tags: string[];
  provenance: string;
  verifiabilityTier: string;
}

export async function queryCaptureMeta({
  url,
  query,
  limit,
  fetchImpl = globalThis.fetch,
}: {
  url: string;
  query: string;
  limit: number;
  fetchImpl?: typeof fetch;
}): Promise<CaptureMetaHit[]> {
  if (!url || query === '') return [];
  try {
    const response = await fetchImpl(
      `${url}?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body.filter((hit): hit is CaptureMetaHit =>
      hit !== null
      && typeof hit === 'object'
      && typeof (hit as CaptureMetaHit).manifestCid === 'string');
  } catch {
    return [];
  }
}
