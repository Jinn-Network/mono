import { createHash } from 'node:crypto';
import { canonicalJson } from '../harnesses/engine/canonical-json.js';

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
    disjointness: raw['disjointness'] as CapabilitySlateArtifact['disjointness'],
  };
}

function normalize(a: CapabilitySlateArtifact): CapabilitySlateArtifact {
  return { ...a, instances: [...a.instances].sort((x, y) => x.instance_id.localeCompare(y.instance_id)) };
}

export function hashCapabilitySlate(a: CapabilitySlateArtifact): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(normalize(a))).digest('hex')}`;
}
