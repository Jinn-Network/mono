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

function walkOut(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkOut(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * The rendered markup of one exported page. Next's static export also
 * serializes every string into the RSC flight payload inside <script> tags,
 * which is hydration data, not a second copy of the page.
 */
function markup(rel) {
  return readFileSync(join(outDir, rel), 'utf8').replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

/** Every `<a>` in a page's markup, as { href, text }. */
function anchors(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: m[1].replace(/&amp;/g, '&'),
    text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
}

const PAGES = [
  'index.html',
  'docs/index.html',
  'docs/check-a-claim/index.html',
  'docs/protocol/index.html',
  'docs/task-marketplace/index.html',
  'docs/machine/index.html',
  'docs/community/index.html',
];

test('static export output', async (t) => {
  if (!outExists()) {
    t.skip('apps/website/out/ does not exist: run `yarn build` first');
    return;
  }

  await t.test('every page and both machine surfaces exist and are non-empty', () => {
    for (const rel of [...PAGES, 'llms.txt', 'llms-full.txt']) {
      const full = join(outDir, rel);
      const stat = statSync(full, { throwIfNoEntry: false });
      assert.ok(stat && stat.isFile(), `out/${rel} does not exist`);
      assert.ok(stat.size > 0, `out/${rel} is empty`);
    }
  });

  await t.test('the docs tree is exactly the pages that exist today', () => {
    const exported = walkOut(join(outDir, 'docs'))
      .filter((f) => f.endsWith('index.html'))
      .map((f) => f.slice(outDir.length + 1))
      .sort();
    assert.deepEqual(exported, PAGES.filter((p) => p.startsWith('docs/')).sort());
  });

  await t.test('llms.txt indexes the current pages and none of the retired ones', () => {
    const text = readFileSync(join(outDir, 'llms.txt'), 'utf8');
    for (const route of ['/docs/check-a-claim', '/docs/protocol', '/docs/task-marketplace']) {
      assert.ok(text.includes(route), `out/llms.txt does not mention ${route}`);
    }
    for (const route of ['/docs/build', '/docs/operate', '/docs/reference']) {
      assert.ok(!text.includes(route), `out/llms.txt still mentions the retired route ${route}`);
    }
  });

  await t.test('no output file references the old jinn.network/profiles document root', () => {
    const violations = walkOut(outDir)
      .filter((f) => /\.(html|txt|js|css)$/.test(f))
      .filter((f) => readFileSync(f, 'utf8').includes('jinn.network/profiles'))
      .map((f) => f.slice(root.length + 1));
    assert.deepEqual(violations, []);
  });

  // GROWTH.md §3: "Bring a claim" is the single call to action on every
  // outward surface.
  await t.test('the rendered landing markup carries the "Bring a claim" CTA exactly once', () => {
    const cta = anchors(markup('index.html')).filter(
      (a) => a.href === 'https://colophon.claims/#publish',
    );
    assert.equal(
      cta.length,
      1,
      `GROWTH.md §3 names a single call to action. Expected exactly one link to ` +
        `https://colophon.claims/#publish in the rendered markup, found ${cta.length}.`,
    );
    assert.equal(cta[0].text, 'Bring a claim');
  });

  await t.test('the landing page tells the current story in its title, description and body', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const noun = 'open protocol and network for work and the data it produces';

    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    assert.ok(title.includes(noun), `landing <title> is "${title}"`);
    const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
    assert.ok(description.includes(noun), `landing description is "${description}"`);
    const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? '';
    assert.ok(ogTitle.includes(noun), `landing og:title is "${ogTitle}"`);

    const links = anchors(markup('index.html'));
    assert.ok(
      links.some((a) => a.href === 'https://colophon.claims/'),
      'the landing page must name and link Colophon',
    );
    assert.ok(
      links.some((a) => a.href === 'https://github.com/Jinn-Network/spec'),
      'the landing page must link the specification at its repository',
    );
    // Selling is the direction. Where the landing page mentions buying or
    // selling at all, it carries the sentence that says so.
    const body = markup('index.html');
    assert.match(body, /is the direction, not a working market/);
  });

  await t.test('every explorer link is labelled as a record of the parked network', () => {
    const unlabelled = [];
    for (const rel of PAGES) {
      for (const a of anchors(markup(rel))) {
        if (a.href.includes('explorer.jinn.network') && !/record/i.test(a.text)) {
          unlabelled.push(`${rel}: "${a.text}"`);
        }
      }
    }
    assert.deepEqual(unlabelled, []);
  });

  await t.test('no rendered page and no machine surface carries an em dash', () => {
    const violations = [];
    for (const rel of PAGES) {
      if (markup(rel).includes('—')) violations.push(rel);
    }
    for (const rel of ['llms.txt', 'llms-full.txt']) {
      if (readFileSync(join(outDir, rel), 'utf8').includes('—')) violations.push(rel);
    }
    assert.deepEqual(violations, []);
  });
});
