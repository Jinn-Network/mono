import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectNativeProductBoundary,
  runtimeRelativeImports,
} from './_support/native-product-boundary.js';

const roots: string[] = [];
const CLIENT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function fixture(files: Readonly<Record<string, string>>): { readonly root: string; readonly entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'jinn-native-boundary-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    const directory = dirname(target);
    if (directory !== root) mkdirSync(directory, { recursive: true });
    writeFileSync(target, source);
  }
  return { root, entry: join(root, 'entry.ts') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native product recursive mutation gate', () => {
  it('walks runtime static imports, re-exports, and literal dynamic imports but not type-only edges', () => {
    const subject = fixture({
      'entry.ts': [
        "import './static.js';",
        "import equals = require('./equals.js');",
        "export { runtime } from './exported.js';",
        "export { type Ignored } from './types.js';",
        "const dynamic = () => import('./dynamic.js');",
        'void dynamic;',
      ].join('\n'),
      'static.ts': "export const staticValue = 'static';",
      'exported.ts': 'export const runtime = true;',
      'dynamic.ts': 'export const dynamic = true;',
      'equals.ts': 'export const equals = true;',
      'types.ts': "const marker = 'ephemeral-discovery-key'; export type Ignored = string; void marker;",
    });

    expect(runtimeRelativeImports("import type { X } from './types.js'; import('./runtime.js')"))
      .toEqual(['./runtime.js']);
    const result = inspectNativeProductBoundary({ sourceRoot: subject.root, entries: [subject.entry] });
    expect(result.violations).toEqual([]);
    expect(result.files.map((file) => relative(subject.root, file)).sort()).toEqual([
      'dynamic.ts', 'entry.ts', 'equals.ts', 'exported.ts', 'static.ts',
    ]);
  });

  it.each([
    ['legacy cards enabled', 'legacy-card-fallback', 'const config = { acceptLegacyCards: true }; void config;'],
    ['permissive capability', 'permissive-capability-fallback', 'const capabilityMatch = async () => ({ ok: true }); void capabilityMatch;'],
    ['genesis archive rescan', 'genesis-archive-rescan', "async function tick(archive: any) { await archive.since(''); } void tick;"],
    ['ephemeral discovery key', 'ephemeral-discovery-key', "const keyId = 'ephemeral-discovery-key'; void keyId;"],
    ['legacy document synthesis', 'legacy-document-synthesis', 'function x() { return synthesizeLegacyExecutionDocuments(); } void x;'],
    ['bridge Delivery extension', 'bridge-delivery-extension', 'const backend = { deliveryExtensions() {} }; void backend;'],
    ['fabricated zero Submission', 'fabricated-zero-submission', 'const ZERO_SUBMISSION = new Uint8Array(); void ZERO_SUBMISSION;'],
    ['fabricated zero chain task', 'fabricated-zero-chain-task', 'const chain = { taskId: 0n }; void chain;'],
    ['throwing gap port', 'throwing-native-gap-port', "function verifyVerdictObservationGap() { throw new Error('gap'); } void verifyVerdictObservationGap;"],
  ] as const)('kills the %s mutation', (_label, expected, mutation) => {
    const subject = fixture({ 'entry.ts': mutation });
    const result = inspectNativeProductBoundary({ sourceRoot: subject.root, entries: [subject.entry] });
    expect(result.violations.map(({ kind }) => kind)).toContain(expected);
  });

  it('kills duplicate venue ownership and unresolved or compatibility runtime edges', () => {
    const duplicate = fixture({
      'entry.ts': "import './first.js'; import('./second.js');",
      'first.ts': 'createBaseVenue({ statePath });',
      'second.ts': 'const venue = new BaseVenue(statePath); void venue;',
    });
    expect(inspectNativeProductBoundary({ sourceRoot: duplicate.root, entries: [duplicate.entry] }).violations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'multiple-venue-owners' })]));

    const compatibility = fixture({
      'entry.ts': "import './daemon/bridge-legacy-delivery.js'; import('./missing.js');",
      'daemon/bridge-legacy-delivery.ts': 'export const legacy = true;',
    });
    expect(inspectNativeProductBoundary({ sourceRoot: compatibility.root, entries: [compatibility.entry] }).violations)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'compatibility-runtime-edge' }),
        expect.objectContaining({ kind: 'unresolved-relative-import' }),
      ]));
  });

  it('allows legacy compatibility files to remain when the native runtime graph cannot reach them', () => {
    const subject = fixture({
      'entry.ts': "import './native.js';",
      'native.ts': 'export const native = true;',
      'daemon/bridge-legacy-delivery.ts': [
        "const key = 'ephemeral-discovery-key';",
        'const config = { acceptLegacyCards: true };',
        'void key; void config;',
      ].join('\n'),
    });
    const result = inspectNativeProductBoundary({ sourceRoot: subject.root, entries: [subject.entry] });
    expect(result.violations).toEqual([]);
    expect(result.files.map((file) => relative(subject.root, file))).not.toContain('daemon/bridge-legacy-delivery.ts');
  });

  it('keeps the real native product graph clean while the explicit legacy estate remains available', () => {
    const result = inspectNativeProductBoundary({
      sourceRoot: CLIENT_SRC,
      entries: [join(CLIENT_SRC, 'native-main.ts')],
    });
    expect(result.violations).toEqual([]);
    expect(result.files).toContain(join(CLIENT_SRC, 'native-main.ts'));
    expect(result.files).toContain(join(CLIENT_SRC, 'daemon/native-operator-host.ts'));
    expect(result.files).not.toContain(join(CLIENT_SRC, 'daemon/composition-root.ts'));
    expect(result.files).not.toContain(join(CLIENT_SRC, 'daemon/bridge-legacy-delivery.ts'));
  });
});
