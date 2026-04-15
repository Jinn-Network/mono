// Dynamic discovery and caching of Civitai base model tokens

const DEFAULT_BASE_MODELS: string[] = [
  'SD 1.5',
  'SD 2.1',
  'SD 2.0',
  'SDXL 1.0',
  'SDXL 0.9',
  'Pony',
  'Illustrious',
  'Other',
  // Common variants occasionally seen in the wild
  'SD 1.5 LCM',
  'SD 1.5 Hyper',
  'SD 2.1 768',
  'SDXL 1.0 LCM',
  'SDXL Hyper',
  'SDXL Lightning',
  'SDXL Turbo',
  'Flux.1 D',
  'NoobAI',
];

type CacheState = {
  values: string[];
  updatedAt: number;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const cache: CacheState = { values: DEFAULT_BASE_MODELS.slice(), updatedAt: 0 };
let refreshing = false;

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    if (v && typeof v === 'string') {
      seen.add(v);
    }
  }
  return Array.from(seen).sort();
}

async function safeFetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'metacog-mcp/1.0 (+civitai-discovery)' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function getCachedBaseModels(): string[] {
  return cache.values.slice();
}

export async function refreshBaseModelsInBackground(pages = 8, limit = 100): Promise<void> {
  const tooSoon = Date.now() - cache.updatedAt < ONE_HOUR_MS;
  if (refreshing || tooSoon) return;
  refreshing = true;
  try {
    const collected: string[] = [];
    for (let page = 1; page <= pages; page++) {
      const url = `https://civitai.com/api/v1/models?limit=${limit}&page=${page}`;
      const json = await safeFetchJson(url);
      const items: any[] = Array.isArray(json?.items) ? json.items : [];
      for (const item of items) {
        const versions: any[] = Array.isArray(item?.modelVersions) ? item.modelVersions : [];
        for (const mv of versions) {
          const bm = mv?.baseModel;
          if (typeof bm === 'string' && bm.trim().length > 0) {
            collected.push(bm.trim());
          }
        }
      }
      // small delay to be polite and avoid potential 4xx from heuristics
      await new Promise((r) => setTimeout(r, 150));
    }
    const merged = uniqueStrings([...DEFAULT_BASE_MODELS, ...collected]);
    if (merged.length > 0) {
      cache.values = merged;
      cache.updatedAt = Date.now();
    }
  } finally {
    refreshing = false;
  }
}

export function getBaseModelEnumValues(): [string, ...string[]] {
  const current = getCachedBaseModels();
  const values = (current.length > 0 ? current : DEFAULT_BASE_MODELS).slice();
  // Ensure z.enum receives a non-empty tuple
  const first = values[0] ?? 'SD 1.5';
  const rest = values.slice(1);
  return [first, ...rest];
}

// Kick off a background refresh on import
// Fire-and-forget; schema can be built from cached defaults and will improve over time
void refreshBaseModelsInBackground();


