import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../util/canonical-json.js';

export const CAPABILITY_SLATE_SCHEMA_VERSION = 'capability-slate.v1' as const;

export type AxisVerdict = 'pass' | 'fail' | 'n/a-v0';

export interface AxisResult {
  verdict: AxisVerdict;
  /** [slateInstanceId, corpusRecordId] pairs that overlapped on this axis. */
  flaggedPairs: Array<[string, string]>;
}
export interface LexicalAxisResult extends AxisResult { attestation: 'self-attested'; }
export interface SemanticAxisResult extends AxisResult { model: string | null; threshold: number | null; }

export interface CapabilitySlateInstance {
  instance_id: string;
  repo: string;
  rowHash: `sha256:${string}` | string;
  imageDigest: `sha256:${string}` | string;
  stockPassRate: number;
  screening: { agentSha: string; emptyLoadout: boolean; noCorpusTools: boolean; hostSkillDirHash: string };
}

export interface CapabilitySlateArtifact {
  schemaVersion: typeof CAPABILITY_SLATE_SCHEMA_VERSION;
  solverType: string;
  version: string;
  generatedAt: string;
  evalSemanticsVersion: string;
  instances: CapabilitySlateInstance[];
  construction: string;
  corpusSnapshotCid: string;
  corpusDerivedIndexCid: string;
  loadoutFrozenBeforeSlate: boolean;
  disjointness: {
    instance: AxisResult;
    repo: AxisResult;
    lexical: LexicalAxisResult;
    semantic: SemanticAxisResult;
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function reqString(o: Record<string, unknown>, k: string): string {
  if (typeof o[k] !== 'string' || (o[k] as string).length === 0) throw new Error(`capability slate: ${k} must be a non-empty string`);
  return o[k] as string;
}

function parseAxis(o: unknown, name: string): AxisResult {
  if (!isObject(o)) throw new Error(`capability slate: disjointness.${name} must be an object`);
  const verdict = o['verdict'];
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'n/a-v0') {
    throw new Error(`capability slate: disjointness.${name}.verdict must be pass|fail|n/a-v0`);
  }
  if (!Array.isArray(o['flaggedPairs'])) {
    throw new Error(`capability slate: disjointness.${name}.flaggedPairs must be an array`);
  }
  return { verdict, flaggedPairs: o['flaggedPairs'] as Array<[string, string]> };
}

function parseDisjointness(raw: unknown): CapabilitySlateArtifact['disjointness'] {
  if (!isObject(raw)) throw new Error('capability slate: disjointness must be an object');
  const instance = parseAxis(raw['instance'], 'instance');
  const repo = parseAxis(raw['repo'], 'repo');
  const lexical = parseAxis(raw['lexical'], 'lexical');
  const lexRaw = raw['lexical'] as Record<string, unknown>;
  if (lexRaw['attestation'] !== 'self-attested') {
    throw new Error('capability slate: disjointness.lexical.attestation must be "self-attested"');
  }
  const semantic = parseAxis(raw['semantic'], 'semantic');
  const semRaw = raw['semantic'] as Record<string, unknown>;
  const model = semRaw['model'];
  const threshold = semRaw['threshold'];
  if (model !== null && typeof model !== 'string') {
    throw new Error('capability slate: disjointness.semantic.model must be string|null');
  }
  if (threshold !== null && typeof threshold !== 'number') {
    throw new Error('capability slate: disjointness.semantic.threshold must be number|null');
  }
  return {
    instance,
    repo,
    lexical: { ...lexical, attestation: 'self-attested' },
    semantic: { ...semantic, model: model as string | null, threshold: threshold as number | null },
  };
}

export function parseCapabilitySlate(raw: unknown): CapabilitySlateArtifact {
  if (!isObject(raw)) throw new Error('capability slate must be an object');
  if (raw['schemaVersion'] !== CAPABILITY_SLATE_SCHEMA_VERSION) {
    throw new Error(`capability slate schemaVersion must be ${CAPABILITY_SLATE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw['instances'])) throw new Error('capability slate instances must be an array');
  const instances = (raw['instances'] as unknown[]).map((it): CapabilitySlateInstance => {
    if (!isObject(it)) throw new Error('capability slate instance must be an object');
    const s = it['screening'];
    if (!isObject(s)) throw new Error('capability slate instance missing screening object');
    if (typeof it['stockPassRate'] !== 'number') throw new Error('capability slate instance missing stockPassRate');
    return {
      instance_id: reqString(it, 'instance_id'),
      repo: reqString(it, 'repo'),
      rowHash: reqString(it, 'rowHash'),
      imageDigest: reqString(it, 'imageDigest'),
      stockPassRate: it['stockPassRate'] as number,
      screening: {
        agentSha: reqString(s, 'agentSha'),
        emptyLoadout: s['emptyLoadout'] === true,
        noCorpusTools: s['noCorpusTools'] === true,
        hostSkillDirHash: reqString(s, 'hostSkillDirHash'),
      },
    };
  });
  return {
    schemaVersion: CAPABILITY_SLATE_SCHEMA_VERSION,
    solverType: reqString(raw, 'solverType'),
    version: reqString(raw, 'version'),
    generatedAt: reqString(raw, 'generatedAt'),
    evalSemanticsVersion: reqString(raw, 'evalSemanticsVersion'),
    instances,
    construction: reqString(raw, 'construction'),
    corpusSnapshotCid: reqString(raw, 'corpusSnapshotCid'),
    corpusDerivedIndexCid: reqString(raw, 'corpusDerivedIndexCid'),
    loadoutFrozenBeforeSlate: raw['loadoutFrozenBeforeSlate'] === true,
    disjointness: parseDisjointness(raw['disjointness']),
  };
}

function normalize(a: CapabilitySlateArtifact): CapabilitySlateArtifact {
  return { ...a, instances: [...a.instances].sort((x, y) => x.instance_id.localeCompare(y.instance_id)) };
}

export function hashCapabilitySlate(a: CapabilitySlateArtifact): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(normalize(a))).digest('hex')}`;
}

/**
 * Repos on the frozen cap-v0 capability slate (spec §11 — unioned into the
 * task-creator mint denylist alongside the held-out slates). Unlike the
 * held-out loader, a missing artifact is NOT an error here: the cap-v0 slate
 * may legitimately not be frozen yet (§4.4), so this returns the empty set
 * until it is. `slatesDirOverride` lets tests point at a fixture directory;
 * production callers omit it and resolve the module-relative `slates/` dir
 * (mirrors `_swe-rebench-v2-held-out-slate.ts`'s `slatesDir()`).
 */
export function loadCapabilitySlateRepos(slatesDirOverride?: string): Set<string> {
  const dir = slatesDirOverride ?? join(dirname(fileURLToPath(import.meta.url)), 'slates');
  const file = join(dir, 'capability-slate.cap-v0.json');
  if (!existsSync(file)) return new Set();
  const artifact = parseCapabilitySlate(JSON.parse(readFileSync(file, 'utf8')));
  return new Set(artifact.instances.map((i) => i.repo));
}

/** Fail-loud disjointness invariant. A slate whose instance/repo/lexical/semantic
 *  axis self-declares `verdict:'fail'` is contaminated and MUST NOT be loaded for a
 *  run — `parseCapabilitySlate` validates *shape* (and `'fail'` is a structurally
 *  valid AxisVerdict), so this separate guard enforces the *invariant* and closes
 *  the load-only path a bare parse would leave open (§4.3). `n/a-v0` (semantic axis,
 *  optional at v0) is not a failure. */
export function assertSlateDisjoint(slate: CapabilitySlateArtifact): void {
  const failed = (Object.entries(slate.disjointness) as Array<[string, AxisResult]>)
    .filter(([, axis]) => axis.verdict === 'fail')
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(
      `capability slate: disjointness axis/axes [${failed.join(', ')}] declared verdict:'fail' — ` +
      `contaminated slate, refusing to load (§4.3)`,
    );
  }
}
