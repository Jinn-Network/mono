import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'out');

function outExists() {
  const stat = statSync(outDir, { throwIfNoEntry: false });
  return !!(stat && stat.isDirectory());
}

test('static export output', async (t) => {
  if (!outExists()) {
    t.skip('apps/website/out/ does not exist — run `yarn build` first');
    return;
  }

  await t.test('index.html, docs/index.html, llms.txt, llms-full.txt all exist and are non-empty', () => {
    for (const rel of ['index.html', 'docs/index.html', 'llms.txt', 'llms-full.txt']) {
      const full = join(outDir, rel);
      const stat = statSync(full, { throwIfNoEntry: false });
      assert.ok(stat && stat.isFile(), `out/${rel} does not exist`);
      assert.ok(stat.size > 0, `out/${rel} is empty`);
    }
  });

  await t.test('llms.txt mentions /docs/build/quickstart', () => {
    const text = readFileSync(join(outDir, 'llms.txt'), 'utf8');
    assert.ok(text.includes('/docs/build/quickstart'), 'out/llms.txt does not mention /docs/build/quickstart');
  });

  await t.test('no output file references the old jinn.network/profiles document root', () => {
    const violations = [];
    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (/\.(html|txt|js|css)$/.test(entry)) {
          const text = readFileSync(full, 'utf8');
          if (text.includes('jinn.network/profiles')) {
            violations.push(full.slice(root.length + 1));
          }
        }
      }
    }
    walk(outDir);
    assert.deepEqual(violations, []);
  });

  // GROWTH.md §3: one call to action on every outward surface until the v0
  // gate produces a result. Counted over the rendered markup only — Next's
  // static export also serializes every href into the RSC flight payload
  // inside <script> tags, which is hydration data, not a second ask.
  await t.test('the rendered landing markup carries the Telegram CTA exactly once', () => {
    const text = readFileSync(join(outDir, 'index.html'), 'utf8');
    const markup = text.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    const matches = markup.match(/t\.me\/jinnNetwork/g) ?? [];
    assert.equal(
      matches.length,
      1,
      `GROWTH.md §3 binds every outward surface to a single call to action. ` +
        `Expected exactly one t.me/jinnNetwork in the rendered markup, found ${matches.length}.`,
    );
  });
});
