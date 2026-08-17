import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');

const COPIES = [
  {
    copy: 'apps/operator-console/styles/colors_and_type.css',
    source: 'docs/design/jinn-design-system/project/colors_and_type.css',
  },
  {
    copy: 'apps/operator-console/styles/foundations.css',
    source: 'docs/design/jinn-design-system/project/foundations.css',
  },
];

function readBuffer(relPath) {
  return readFileSync(resolve(root, relPath));
}

for (const { copy, source } of COPIES) {
  test(`${copy} is a byte-identical copy of ${source}`, () => {
    const copyBuf = readBuffer(copy);
    const sourceBuf = readBuffer(source);
    assert.ok(
      copyBuf.equals(sourceBuf),
      `${copy} does not byte-match ${source} — re-copy from the design system source.`,
    );
  });
}

test('apps/operator-console/styles/theme.css exists and is not a design-system copy', () => {
  const themePath = 'apps/operator-console/styles/theme.css';
  const stat = statSync(resolve(root, themePath), { throwIfNoEntry: false });
  assert.ok(stat && stat.isFile(), `${themePath} must exist`);
  const themeBuf = readBuffer(themePath);
  for (const { source } of COPIES) {
    assert.ok(!themeBuf.equals(readBuffer(source)));
  }
});
