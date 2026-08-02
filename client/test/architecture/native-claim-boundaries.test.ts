import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workLoop = readFileSync(
  fileURLToPath(new URL('../../src/daemon/work-loop.ts', import.meta.url)),
  'utf8',
);
const composition = readFileSync(
  fileURLToPath(new URL('../../src/daemon/composition-root.ts', import.meta.url)),
  'utf8',
);

function nativeMethod(source: string): string {
  const start = source.indexOf('private async processNativeCard');
  const end = source.indexOf('private async readNativeCards', start);
  if (start < 0 || end < 0) throw new Error('native work-loop method boundary changed');
  return source.slice(start, end);
}

describe('Phase B native claim architecture boundaries', () => {
  it('keeps native ingestion on B5 claim coordination and outside legacy pipeline/bridges', () => {
    const source = nativeMethod(workLoop);
    expect(source).toContain('nativeClaimCoordinator!.process');
    expect(source).not.toMatch(/runPipeline|synthesizeLegacy|capabilityMatch|acceptLegacyCards/u);
  });

  it('forbids the permissive capability and hardcoded launcher-ready fallbacks', () => {
    expect(workLoop).not.toContain('capabilityMatch: async () => ({ ok: true })');
    expect(composition).not.toMatch(/probe:\s*async\s*\(\)\s*=>\s*\(\{\s*ready:\s*true/u);
    expect(composition).toContain('await access(executable.path, constants.X_OK)');
    expect(composition).toContain("createHash('sha256').update(await readFile(executable.path))");
  });

  it('requires native exact-document, canonical-reader, state, lease, and bound agent inputs', () => {
    expect(composition).toContain('readonly nativeClaimRuntime?: NativeClaimRuntimeInput');
    expect(composition).toContain('native operator boot requires durable claim state');
    expect(composition).toContain('identities!.agent !== input.nativeClaimRuntime!.operatorAgent');
    expect(composition).toContain('exactDocuments');
    expect(composition).toContain('canonical: NativeClaimCanonicalReader');
  });
});
