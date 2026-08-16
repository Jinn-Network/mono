import { createHash } from 'node:crypto';
import { canonicalJson } from '../util/canonical-json.js';

export interface CorpusRecord {
  id: string;
  repos: string[];
  instanceIdsReferenced: string[];
  text: string;
}

export interface CorpusIndexRecord { id: string; repos: string[]; instanceIds: string[]; sketch: number[]; }
export interface CorpusDerivedIndex {
  repos: string[];
  instanceIds: string[];
  records: CorpusIndexRecord[];
}

export function tokenize(text: string): string[] {
  const m = text.toLowerCase().match(/[a-z0-9_]+/g);
  return m ?? [];
}

/** 32-bit FNV-1a — stable, dependency-free, good enough for MinHash bucketing. */
function fnv1a(s: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function minhashSketch(tokens: string[], numHashes = 64): number[] {
  const uniq = [...new Set(tokens)];
  const out: number[] = [];
  for (let k = 0; k < numHashes; k++) {
    let min = 0xffffffff;
    for (const t of uniq) {
      const h = fnv1a(t, k * 0x9e3779b1);
      if (h < min) min = h;
    }
    out.push(uniq.length === 0 ? 0 : min);
  }
  return out;
}

export function buildCorpusIndex(records: CorpusRecord[]): CorpusDerivedIndex {
  const repos = new Set<string>();
  const instanceIds = new Set<string>();
  const indexed: CorpusIndexRecord[] = [];
  for (const r of records) {
    r.repos.forEach((x) => repos.add(x));
    r.instanceIdsReferenced.forEach((x) => instanceIds.add(x));
    indexed.push({
      id: r.id,
      repos: [...r.repos].sort(),
      instanceIds: [...r.instanceIdsReferenced].sort(),
      sketch: minhashSketch(tokenize(r.text)),
    });
  }
  // Deterministic total order: primary by id, tiebreak by canonical content so
  // duplicate ids never make the cid input-order-dependent (spec §4.3).
  indexed.sort((a, b) => a.id.localeCompare(b.id) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { repos: [...repos].sort(), instanceIds: [...instanceIds].sort(), records: indexed };
}

export function corpusSnapshotCid(index: CorpusDerivedIndex): `sha256:${string}` {
  // RFC 8785 canonical JSON (key-sorted, cross-language reproducible) so a third
  // party can recompute this Merkle root to re-check the disjointness proof (spec §4.3).
  // Arrays are already fully sorted by buildCorpusIndex; canonicalJson sorts object keys.
  return `sha256:${createHash('sha256').update(canonicalJson(index)).digest('hex')}`;
}
