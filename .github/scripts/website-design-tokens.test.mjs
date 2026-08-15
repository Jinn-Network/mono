import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// apps/website/styles/{colors_and_type,foundations}.css are raw copies of
// the design system source. They are never hand-edited: any change belongs
// in docs/design/jinn-design-system/project/ and gets re-copied here. This
// guard compares raw bytes (not strings) so encoding/whitespace drift is
// caught even when it wouldn't show up in a text diff.
const COPIES = [
  {
    copy: 'apps/website/styles/colors_and_type.css',
    source: 'docs/design/jinn-design-system/project/colors_and_type.css',
  },
  {
    copy: 'apps/website/styles/foundations.css',
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
      `${copy} does not byte-match ${source} — this file is never edited directly: ` +
        're-copy it from the design system source instead.',
    );
  });
}

test('apps/website/styles/theme.css exists and is not a copy of either design-system source', () => {
  const themePath = 'apps/website/styles/theme.css';
  const stat = statSync(resolve(root, themePath), { throwIfNoEntry: false });
  assert.ok(stat && stat.isFile(), `${themePath} must exist — it is the editable bridge stylesheet`);

  const themeBuf = readBuffer(themePath);
  for (const { source } of COPIES) {
    const sourceBuf = readBuffer(source);
    assert.ok(
      !themeBuf.equals(sourceBuf),
      `${themePath} is byte-identical to ${source} — theme.css is the editable bridge and ` +
        'should not be a raw copy of a design-system source file',
    );
  }
});
