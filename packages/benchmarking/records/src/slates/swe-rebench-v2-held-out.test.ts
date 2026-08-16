/**
 * Cross-source parity: the records embed must stay byte-identical to the
 * canonical client artifact (the membership hub until operator/ retires) —
 * same discipline as packages/sdk/test/solvernets/
 * swe-rebench-v2-held-out-slate-cross-source.test.ts, which covers the
 * sdk ↔ client pair. Transitively, all three copies agree.
 *
 * This test also carries the drift protection the records module itself
 * deliberately does not: swe-rebench-v2-held-out.ts is a data module with no
 * canonicalizer, comparator, or `node:crypto` import (see its header — that
 * tree bans locale-sensitive APIs in production source). The hash
 * verification below reproduces the *historical* derivation (locale-default
 * `localeCompare` sort, as originally computed in the legacy client module)
 * purely to confirm the frozen `HELD_OUT_SLATE_V1.hash` is still the value
 * that derivation produces — this is CI-time drift protection standing in
 * for the runtime fail-loud check the old sdk-embedded loader used to do.
 * A future slate version (v2+) must derive its hash with UTF-16 code-unit
 * ordering (`compareCodeUnitStrings` in ../order.js) instead, per the
 * stack's sealing rule — this legacy canonicalizer is not a template to
 * reuse for a new version.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  loadHeldOutSlate,
  HELD_OUT_SLATE_V1,
  HELD_OUT_SLATE_SCHEMA_VERSION,
  type HeldOutSlateArtifact,
} from './swe-rebench-v2-held-out.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientArtifactPath = resolve(
  here,
  '../../../../../operator/src/solver-types/slates/held-out-slate.swe-rebench-v2.v1.json',
);

/**
 * Historical canonicalizer, reproduced here (not in production source) only
 * to verify the frozen hash — see the file header. Minimal RFC 8785 (JCS)
 * serialization for the flat slate artifact shape: object keys sorted by
 * UTF-16 code-unit order, string values JSON-escaped, arrays in order.
 */
function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Historical hashed projection: schema/solver/version/generatedAt + the
 * instanceIds sorted with locale-default `localeCompare` — the derivation the
 * legacy client module used when this hash was originally computed. Excludes
 * the `hash` field itself (a hash never hashes itself).
 */
function normalizeHeldOutSlateArtifactHistorical(artifact: HeldOutSlateArtifact): {
  schemaVersion: string;
  solverType: string;
  version: string;
  generatedAt: string;
  instanceIds: string[];
} {
  return {
    schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
    solverType: artifact.solverType,
    version: artifact.version,
    generatedAt: artifact.generatedAt,
    instanceIds: [...artifact.instanceIds].sort((a, b) => a.localeCompare(b)),
  };
}

function hashHeldOutSlateArtifactHistorical(artifact: HeldOutSlateArtifact): `sha256:${string}` {
  const canonical = canonicalJson(normalizeHeldOutSlateArtifactHistorical(artifact));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

describe('held-out slate cross-source parity (records ↔ client)', () => {
  const clientArtifact = JSON.parse(readFileSync(clientArtifactPath, 'utf8')) as {
    instanceIds: string[];
    hash: string;
    version: string;
    solverType: string;
  };

  it('records embedded instanceId set === client artifact instanceIds', () => {
    const slate = loadHeldOutSlate('v1');
    expect([...slate.instanceIds].sort()).toEqual([...clientArtifact.instanceIds].sort());
  });

  it('records declared hash === client artifact hash, and reproduces the historical derivation', () => {
    expect(HELD_OUT_SLATE_V1.hash).toBe(clientArtifact.hash);
    expect(hashHeldOutSlateArtifactHistorical(HELD_OUT_SLATE_V1)).toBe(HELD_OUT_SLATE_V1.hash);
    expect(() => loadHeldOutSlate('v1')).not.toThrow();
  });

  it('records version + solverType === client artifact', () => {
    expect(HELD_OUT_SLATE_V1.version).toBe(clientArtifact.version);
    expect(HELD_OUT_SLATE_V1.solverType).toBe(clientArtifact.solverType);
  });
});
