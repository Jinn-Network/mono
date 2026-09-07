import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEPENDENCY_SECTIONS } from './stack-package-graph.mjs';

export const COLOPHON_PUBLISH_WORKFLOW = 'colophon-npm-publish.yml';
export const FIRST_CUT_PLATFORM_PIN_PATH = 'packages/benchmark-product/first-cut-platform-pin.json';
export const PRODUCT_RELEASE_PLATFORM_PINS_PATH = 'packages/benchmark-product/product-release-platform-pins.json';

/**
 * Every source file that seals a `@colophon-claims/verify` version into a claim or a bundle asset.
 * A pin here is sealed immutably into every bundle built from this tree and cannot be corrected
 * after the bundle ships, so the publish workflow refuses whenever the set of pins and the version
 * it is about to publish disagree (issue #3244).
 *
 * Reader instructions that live in repository markdown are *not* in this set: they ship no bytes
 * into a bundle and stay correctable after the fact, so they carry their own list
 * (`READER_INSTRUCTION_DOCS`) and their own check, which runs in the test suite rather than
 * gating a publish (issue #3647).
 */
export const CLAIM_PIN_SOURCES = [
  'packages/benchmark-product/core/scripts/demo1-export-public-bundle.mjs',
  'packages/benchmark-product/core/src/legacy-closures.ts',
  'packages/benchmark-product/verify/src/legacy-closures.ts',
  'packages/benchmark-product/cli/src/main.ts',
];

/**
 * Every markdown file in the product tree that tells a reader which `@colophon-claims/verify`
 * version to run. These are corrigible after publication, so they never gate a publish -- but a
 * version npm has never served is still an instruction to fail, and CI refuses one (issue #3647).
 * Dated plans and decision records elsewhere in the repository are historical and out of scope.
 */
export const READER_INSTRUCTION_DOCS = [
  'packages/benchmark-product/EXTERNAL-VERIFICATION.md',
  'packages/benchmark-product/PUBLIC-BUNDLE.md',
  'packages/benchmark-product/README.md',
  'packages/benchmark-product/cli/README.md',
  'packages/benchmark-product/core/README.md',
  'packages/benchmark-product/verify/README.md',
];

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const EXACT_CANARY_PIN = /^0\.1\.0-canary\.sha\.[0-9a-f]{40}$/u;
const VERIFY_RELEASES = {
  '0.2.0': {
    decision: 'DR-2026-08-22-a',
    platformSourceSha: 'e00b2fc47fc5635b007eb349fb1e41aa81bb3c50',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/32544891098/attempts/2',
    receiptSha256: '8c6749c2e6c303b17ceccbc12712e1210e275dcdbcb37fd495a14a15cbb4474e',
  },
  '0.2.1': {
    decision: 'operator-authorization-2026-08-26',
    platformSourceSha: '0533a224cf99f06d7facf0c23455f2781a5b9e62',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/33517790412/attempts/2',
    receiptSha256: '2f2aa7e82f75c2775bd8de8673d3286caf8c6b9a92133a5a93f1766f942b1797',
  },
};
const VERIFY_RELEASE_VERSIONS = Object.keys(VERIFY_RELEASES);
const PRODUCT_RELEASE_PINS_KEYS = ['schemaVersion', 'receipts'];
const VERIFY_020_RECEIPT_KEYS = [
  'decision',
  'product',
  'platformSourceSha',
  'platformVersion',
  'platformDistTag',
  'platformLatestVersion',
  'stackPublishRunUrl',
  'platformPackages',
];
const VERIFY_020_PRODUCT_KEYS = ['packageName', 'version'];
const VERIFY_020_PACKAGE_KEYS = ['name', 'version', 'gitHead', 'integrity', 'provenanceUrl'];
const VERIFY_020_PLATFORM_CLOSURE = [
  '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-evidence',
  '@jinn-network/benchmarking-interop',
  '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-protocol',
  '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run',
  '@jinn-network/environment-record',
  '@jinn-network/evidence-protocol',
  '@jinn-network/task-admission',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/trust-core',
  '@jinn-network/trust-resolve',
  '@jinn-network/trust-testing',
];

function isFloatingCanarySpecifier(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === 'canary' || trimmed === '@canary' || trimmed.endsWith('@canary');
}

function refuseFloatingCanary(value, label) {
  if (isFloatingCanarySpecifier(value)) {
    throw new Error(`floating canary dist-tag in ${label}: ${value}`);
  }
}

function hasExactKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256CanonicalJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function loadFirstCutPlatformPin(repoRoot) {
  const pinPath = resolve(repoRoot, ...FIRST_CUT_PLATFORM_PIN_PATH.split('/'));
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (pin.schemaVersion !== 2) {
    throw new Error(`first-cut pin schemaVersion must be 2, got ${pin.schemaVersion ?? '<missing>'}`);
  }
  if (pin.decision !== 'DR-2026-08-17-c') {
    throw new Error(`first-cut pin must name DR-2026-08-17-c, got ${pin.decision ?? '<missing>'}`);
  }
  refuseFloatingCanary(pin.platformVersion, 'first-cut pin platformVersion');
  if (!COMMIT_SHA.test(String(pin.platformSourceSha))) {
    throw new Error(`first-cut pin platformSourceSha must be a 40-character commit sha, got ${pin.platformSourceSha ?? '<missing>'}`);
  }
  const expectedVersion = `0.1.0-canary.sha.${pin.platformSourceSha}`;
  if (pin.platformVersion !== expectedVersion || !EXACT_CANARY_PIN.test(pin.platformVersion)) {
    throw new Error(`first-cut pin platformVersion must be ${expectedVersion}, got ${pin.platformVersion ?? '<missing>'}`);
  }
  if (pin.platformDistTag !== 'canary') {
    throw new Error(`first-cut pin platformDistTag must remain canary, got ${pin.platformDistTag ?? '<missing>'}`);
  }
  if (pin.platformLatestVersion !== '0.0.0') {
    throw new Error(`first-cut pin platformLatestVersion must be 0.0.0, got ${pin.platformLatestVersion ?? '<missing>'}`);
  }
  const product = pin.productRelease;
  if (
    product?.packageName !== '@colophon-claims/verify'
    || product.version !== '0.1.0'
    || product.distTag !== 'latest'
    || !COMMIT_SHA.test(String(product.sourceSha))
  ) {
    throw new Error('first-cut pin must record @colophon-claims/verify@0.1.0 on latest with an exact source sha');
  }
  return pin;
}

function loadProductReleasePlatformPins(repoRoot) {
  const pinsPath = resolve(repoRoot, ...PRODUCT_RELEASE_PLATFORM_PINS_PATH.split('/'));
  const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
  if (!hasExactKeys(pins, PRODUCT_RELEASE_PINS_KEYS) || pins.schemaVersion !== 1 || !Array.isArray(pins.receipts)) {
    throw new Error('product-release platform pins must use schemaVersion 1 with a receipts array');
  }
  return pins;
}

export function validateProductReleasePlatformPin(pin, manifest) {
  if (!hasExactKeys(pin, VERIFY_020_RECEIPT_KEYS) || !hasExactKeys(pin.product, VERIFY_020_PRODUCT_KEYS)) {
    throw new Error('product-release pin must retain the immutable verifier 0.2 receipt shape');
  }
  const release = VERIFY_RELEASES[pin.product.version];
  if (
    release === undefined
    || pin?.decision !== release.decision
    || pin?.product?.packageName !== '@colophon-claims/verify'
    || pin.platformSourceSha !== release.platformSourceSha
    || pin.platformVersion !== `0.1.0-canary.sha.${release.platformSourceSha}`
    || manifest.name !== pin.product.packageName
    || manifest.version !== pin.product.version
  ) {
    throw new Error('only a registered @colophon-claims/verify 0.2 patch release may use its exact canary receipt');
  }
  refuseFloatingCanary(pin.platformVersion, 'product-release pin platformVersion');
  if (!COMMIT_SHA.test(String(pin.platformSourceSha))) {
    throw new Error('product-release pin platformSourceSha must be a 40-character commit sha');
  }
  if (!EXACT_CANARY_PIN.test(pin.platformVersion)) {
    throw new Error(`product-release pin platformVersion must be 0.1.0-canary.sha.${release.platformSourceSha}`);
  }
  if (
    pin.platformDistTag !== 'canary'
    || pin.platformLatestVersion !== '0.0.0'
    || pin.stackPublishRunUrl !== release.stackPublishRunUrl
  ) {
    throw new Error('product-release pin must retain its recorded stack-canary receipt');
  }
  const directNames = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith('@jinn-network/'));
  const packages = pin.platformPackages;
  if (!Array.isArray(packages) || packages.length !== VERIFY_020_PLATFORM_CLOSURE.length) {
    throw new Error('product-release pin must record the complete verifier 0.2 Jinn closure');
  }
  const names = packages.map((pkg) => pkg?.name);
  if (JSON.stringify(names) !== JSON.stringify(VERIFY_020_PLATFORM_CLOSURE)) {
    throw new Error('product-release pin Jinn package names must be the sorted verifier 0.2 closure');
  }
  if (directNames.some((name) => !names.includes(name))) {
    throw new Error('product-release pin must include every direct Jinn dependency');
  }
  for (const pkg of packages) {
    if (!hasExactKeys(pkg, VERIFY_020_PACKAGE_KEYS)) {
      throw new Error(`product-release pin package row shape drift for ${pkg?.name ?? '<missing>'}`);
    }
    if (
      pkg.version !== pin.platformVersion
      || pkg.gitHead !== pin.platformSourceSha
      || typeof pkg.integrity !== 'string'
      || !pkg.integrity.startsWith('sha512-')
      || pkg.provenanceUrl !== `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(pkg.name)}@${pin.platformVersion}`
    ) {
      throw new Error(`product-release pin must record registry integrity and provenance for ${pkg.name}`);
    }
  }
  if (sha256CanonicalJson(pin) !== release.receiptSha256) {
    throw new Error(`product-release pin must retain the immutable verifier ${pin.product.version} receipt values`);
  }
  return pin;
}

export function validateProductReleasePlatformPins(pins, manifest) {
  if (
    !hasExactKeys(pins, PRODUCT_RELEASE_PINS_KEYS)
    || pins.schemaVersion !== 1
    || !Array.isArray(pins.receipts)
    || JSON.stringify(pins.receipts.map((pin) => pin?.product?.version)) !== JSON.stringify(VERIFY_RELEASE_VERSIONS)
  ) {
    throw new Error('product-release platform pins must contain the exact ordered immutable verifier 0.2 receipts');
  }
  for (const pin of pins.receipts) {
    validateProductReleasePlatformPin(pin, {
      ...manifest,
      name: '@colophon-claims/verify',
      version: pin.product.version,
    });
  }
  const selected = pins.receipts.find((pin) => pin.product.version === manifest.version);
  if (selected === undefined) {
    throw new Error(`no immutable platform receipt is registered for ${manifest.name}@${manifest.version}`);
  }
  return validateProductReleasePlatformPin(selected, manifest);
}

export function loadProductReleasePlatformPin(repoRoot, manifest) {
  const pins = loadProductReleasePlatformPins(repoRoot);
  return validateProductReleasePlatformPins(pins, manifest);
}

export function transformColophonManifestForPublish(manifest, pin, { gitHead } = {}) {
  refuseFloatingCanary(pin?.platformVersion, 'pin platformVersion');
  if (!EXACT_CANARY_PIN.test(String(pin?.platformVersion ?? ''))) {
    throw new Error(`Colophon publish pin must be an exact canary sha version, got ${pin?.platformVersion ?? '<missing>'}`);
  }
  const patched = structuredClone(manifest);
  delete patched.packageManager;
  if (gitHead && COMMIT_SHA.test(gitHead)) patched.gitHead = gitHead;
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = patched[section];
    if (!entries) continue;
    for (const [dependency, specifier] of Object.entries(entries)) {
      refuseFloatingCanary(specifier, `${section}.${dependency}`);
      if (dependency.startsWith('@jinn-network/')) entries[dependency] = pin.platformVersion;
    }
  }
  if (patched.resolutions) {
    for (const [key, value] of Object.entries(patched.resolutions)) {
      if (typeof value !== 'string') continue;
      if (value.startsWith('portal:') || value.startsWith('workspace:')) delete patched.resolutions[key];
    }
    if (Object.keys(patched.resolutions).length === 0) delete patched.resolutions;
  }
  patched.scripts ??= {};
  patched.scripts.prepack = 'npm run build';
  return patched;
}

export function applyColophonPublishManifest(manifestPath, pin, options = {}) {
  const originalBytes = readFileSync(manifestPath, 'utf8');
  const patched = transformColophonManifestForPublish(JSON.parse(originalBytes), pin, options);
  writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
  return {
    restore() {
      writeFileSync(manifestPath, originalBytes, 'utf8');
    },
  };
}

/**
 * Every published `@colophon-claims/verify` release this repository holds a receipt for. This is the
 * offline floor, not the authority: a receipt is added in the same change that bumps the version, so
 * the ledger names a release before the registry does. `fetchPublishedVerifyVersions` is what the
 * workflow actually asks.
 */
export function registeredVerifyReleases() {
  return ['0.1.0', ...VERIFY_RELEASE_VERSIONS];
}

/**
 * The versions npm actually serves. Fails closed: a registry that cannot be read leaves the guard
 * unable to tell a pin that resolves from one that 404s, and guessing in that state is the exact
 * failure the guard exists to prevent.
 */
export async function fetchPublishedVerifyVersions(
  packageName = '@colophon-claims/verify',
  fetchImpl = fetch,
) {
  const response = await fetchImpl(`https://registry.npmjs.org/${packageName.replace('/', '%2f')}`);
  if (!response.ok) {
    throw new Error(`cannot read published ${packageName} versions from npm: HTTP ${response.status}`);
  }
  const versions = Object.keys((await response.json()).versions ?? {});
  if (versions.length === 0) throw new Error(`npm reports no published versions of ${packageName}`);
  return versions;
}

/**
 * Every specifier shape npx resolves: the exact `X.Y.Z`, and the compatible `X.Y` and `X` lines.
 * The bare major is in the pattern because that is the shape that 404s against a 0.x package, and
 * a scan that cannot see it cannot refuse it (issue #3647).
 */
const VERIFY_PIN_PATTERN = /@colophon-claims\/verify@([0-9]+(?:\.[0-9]+){0,2})/gu;

const REGEX_PRECEDING_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw',
  'typeof', 'void', 'yield',
]);

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/**
 * Whether a `/` opens a regex literal, by the standard previous-significant-token rule. The rule is
 * biased toward regex: only a value -- an identifier that is not a regex-admitting keyword, a
 * number, a closing `)` or `]`, or a completed literal -- reads the `/` as division. Reading a
 * regex as division is the direction that loses a pin, because `/^https:\/\//` then opens a line
 * comment and `/a\/*b/` opens a block comment. Reading division as a regex only widens a span, and
 * a pin inside a span that is neither string nor comment refuses rather than vanishing.
 */
function slashOpensRegex(previous) {
  if (previous === null) return true;
  if (previous.value) return false;
  if (previous.word !== undefined) return REGEX_PRECEDING_KEYWORDS.has(previous.word);
  return true;
}

/**
 * The index of the closing `/` of the regex literal opening at `index`, or -1 when the text is not
 * one. A regex literal cannot carry an unescaped newline, so a `/` whose line ends before a closing
 * `/` was division after all.
 */
function regexLiteralEnd(text, index) {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\') cursor += 2;
    else if (char === '\n') return -1;
    else if (inClass) {
      if (char === ']') inClass = false;
      cursor += 1;
    } else if (char === '[') {
      inClass = true;
      cursor += 1;
    } else if (char === '/') return cursor;
    else cursor += 1;
  }
  return -1;
}

/**
 * The source ranges a JavaScript or TypeScript file spends inside a string literal, inside a
 * comment, or inside a regex literal. Everything else is code.
 *
 * A pin is sealed into a bundle by a string constant; a version named in a comment is prose about
 * a pin, not a pin. Scanning the raw text cannot tell the two apart, so a sentence explaining a
 * pending bump would refuse a publish that nothing in the tree actually blocks (issue #3686).
 *
 * Regex literals are tracked for the opposite reason. A scanner with no state for them reads the
 * escaped slashes in `/^https:\/\//` as a line comment and the escaped slash-star in `/a\/*b/` as
 * a block comment, and a
 * pin caught inside either bogus span is classified as prose and dropped -- silently, because a
 * dropped pin never reaches `unclassified` (issue #3900). They are yielded as their own span kind
 * rather than folded into `string`, so a pin inside one refuses instead of sealing.
 */
function* literalAndCommentSpans(text) {
  const stack = [{ kind: 'code', depth: 0, previous: null }];
  let index = 0;
  while (index < text.length) {
    const frame = stack[stack.length - 1];
    const char = text[index];
    // Computed once per slash the heuristic admits; the comment branches below still win the tie,
    // because `//` is never an empty regex and `/*` is never a valid one.
    const regexEnd =
      frame.kind === 'code' && char === '/' && slashOpensRegex(frame.previous)
        ? regexLiteralEnd(text, index)
        : -1;
    if (frame.kind === 'template') {
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        yield { kind: 'string', start: frame.chunkStart, end: index };
        stack.pop();
        stack[stack.length - 1].previous = { value: true };
        index += 1;
      } else if (char === '$' && text[index + 1] === '{') {
        yield { kind: 'string', start: frame.chunkStart, end: index };
        stack.push({ kind: 'code', depth: 0, previous: null });
        index += 2;
      } else {
        index += 1;
      }
    } else if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index);
      yield { kind: 'comment', start: index, end: end < 0 ? text.length : end };
      if (end < 0) return;
      index = end + 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      // An unterminated block comment is a syntax error, and calling the rest of the file prose
      // would drop every pin in it without a word. Refuse the tail instead.
      yield {
        kind: end < 0 ? 'unterminated' : 'comment',
        start: index,
        end: end < 0 ? text.length : end + 2,
      };
      index = end < 0 ? text.length : end + 2;
    } else if (regexEnd >= 0) {
      yield { kind: 'regex', start: index, end: regexEnd + 1 };
      frame.previous = { value: true };
      index = regexEnd + 1;
    } else if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') cursor += 2;
        else if (text[cursor] === char || text[cursor] === '\n') break;
        else cursor += 1;
      }
      yield { kind: 'string', start: index, end: Math.min(cursor + 1, text.length) };
      frame.previous = { value: true };
      index = cursor + 1;
    } else if (char === '`') {
      stack.push({ kind: 'template', chunkStart: index + 1 });
      index += 1;
    } else if (IDENTIFIER_CHAR.test(char)) {
      let cursor = index;
      while (cursor < text.length && IDENTIFIER_CHAR.test(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      frame.previous = /^[0-9]/u.test(word) ? { value: true } : { word };
      index = cursor;
    } else if (char === '{') {
      frame.depth += 1;
      frame.previous = { punct: char };
      index += 1;
    } else if (char === '}') {
      if (frame.depth > 0) {
        frame.depth -= 1;
        frame.previous = { punct: char };
      } else if (stack.length > 1) {
        stack.pop();
        stack[stack.length - 1].chunkStart = index + 1;
      } else {
        frame.previous = { punct: char };
      }
      index += 1;
    } else {
      if (!/\s/u.test(char)) {
        frame.previous = char === ')' || char === ']' ? { value: true } : { punct: char };
      }
      index += 1;
    }
  }
}

/**
 * The `@colophon-claims/verify` specifiers one source file seals, in every shape npx resolves.
 *
 * The scanner above is deliberately small -- it tracks nested template interpolations and regex
 * literals, and nothing else -- so it refuses rather than guesses: any specifier it cannot place in
 * a string or a comment throws, including one it can place in a regex literal and one it can place
 * nowhere at all. Silently dropping one would hide it from the publish guard, which is the failure
 * this scan exists to prevent.
 */
export function collectPinsFromSource(text, label = 'source') {
  const spans = [...literalAndCommentSpans(text)];
  const pins = new Set();
  const unclassified = [];
  for (const match of text.matchAll(VERIFY_PIN_PATTERN)) {
    const span = spans.find(({ start, end }) => match.index >= start && match.index < end);
    if (span?.kind === 'string') pins.add(match[1]);
    else if (span?.kind !== 'comment') unclassified.push(match[1]);
  }
  if (unclassified.length > 0) {
    throw new Error(
      `cannot tell whether @colophon-claims/verify@${unclassified.join(', @')} in ${label} is sealed or explained; put the specifier in a plain string constant`,
    );
  }
  return [...pins].sort();
}

/**
 * Every `@colophon-claims/verify` specifier pinned by `CLAIM_PIN_SOURCES`, deduplicated and
 * sorted.
 */
export function collectClaimVerifyPins(repoRoot, sources = CLAIM_PIN_SOURCES) {
  const pins = new Set();
  for (const source of sources) {
    const text = readFileSync(resolve(repoRoot, ...source.split('/')), 'utf8');
    for (const pin of collectPinsFromSource(text, source)) pins.add(pin);
  }
  return [...pins].sort();
}

/**
 * Every `@colophon-claims/verify` specifier a reader-instruction document tells a reader to run.
 * Markdown has no string literals to scan and no comments to exclude, so the whole text counts.
 */
export function collectReaderInstructionPins(repoRoot, docs = READER_INSTRUCTION_DOCS) {
  const pins = new Set();
  for (const doc of docs) {
    const text = readFileSync(resolve(repoRoot, ...doc.split('/')), 'utf8');
    for (const match of text.matchAll(VERIFY_PIN_PATTERN)) pins.add(match[1]);
  }
  return [...pins].sort();
}

/**
 * Refuses a reader instruction naming a verifier version npm does not serve. An exact `X.Y.Z` must
 * be published; a shorter `X` or `X.Y` line must have a published version under it.
 *
 * The default authority is the offline receipt ledger, so this runs in CI without a network call.
 * The ledger names a release before the registry does, which leaves one window it cannot see: a
 * doc bumped in the same change as the receipt reads as resolvable until the manual publish
 * dispatch runs. That is the narrow, self-healing half; the shape it does catch -- a line npm has
 * never served at all -- is the one that strands a reader indefinitely.
 */
export function assertReaderInstructionPinsResolve(pins, published = registeredVerifyReleases()) {
  const unresolvable = pins.filter((pin) =>
    pin.split('.').length === 3
      ? !published.includes(pin)
      : !published.some((version) => version.startsWith(`${pin}.`)),
  );
  if (unresolvable.length > 0) {
    throw new Error(
      `reader instructions name unpublished verifier @${unresolvable.join(', @')}; a reader following them gets a 404`,
    );
  }
  return pins;
}

/**
 * Refuses a publish whose version and whose in-tree claim pins disagree, in either direction.
 *
 * The workflow is a manual dispatch against whatever the default branch's HEAD is at the moment it
 * runs, so nothing but this check couples the reader being published to the bundles this tree
 * builds. Publishing a version no pin names ships a reader no bundle asks for; leaving a pin on a
 * version that is neither published nor about to be published ships bundles whose sealed command
 * 404s, or whose compatible line resolves to a reader that refuses their format.
 *
 * A bundle asks for a reader two ways, and both count. An exact `X.Y.Z` pin names one release; a
 * compatible `X.Y` line names every patch under it, which is what that line is for -- the closures
 * carrying it are frozen and cannot be repointed, so requiring an exact pin would leave a
 * verifier-only patch release unpublishable by the very design meant to deliver it (issue #3687).
 */
export function assertClaimPinsMatchPublish(pins, publishVersion, published = registeredVerifyReleases()) {
  const resolvable = new Set([...published, publishVersion]);
  const exact = pins.filter((pin) => pin.split('.').length === 3);
  const unresolvable = exact.filter((pin) => !resolvable.has(pin));
  if (unresolvable.length > 0) {
    throw new Error(
      `claim pins name unpublished verifier ${unresolvable.join(', ')}; publish those before ${publishVersion}`,
    );
  }
  const unsatisfied = pins
    .filter((pin) => pin.split('.').length < 3)
    .filter((line) => ![...resolvable].some((version) => version.startsWith(`${line}.`)));
  if (unsatisfied.length > 0) {
    throw new Error(`claim compatible lines @${unsatisfied.join(', @')} resolve to no published verifier`);
  }
  const admittingLine = pins
    .filter((pin) => pin.split('.').length < 3)
    .find((line) => publishVersion.startsWith(`${line}.`));
  if (!exact.includes(publishVersion) && !admittingLine) {
    throw new Error(
      `no claim pin names ${publishVersion} and no compatible line admits it; publishing it would ship a reader no bundle in this tree asks for`,
    );
  }
  return pins;
}

export async function checkClaimPins(repoRoot, manifest, published) {
  return assertClaimPinsMatchPublish(
    collectClaimVerifyPins(repoRoot),
    manifest.version,
    published ?? await fetchPublishedVerifyVersions(manifest.name),
  );
}

const MODES = ['--apply', '--check-claim-pins'];

function parseArgs(argv) {
  if (!MODES.includes(argv[0]) || !argv[1]) {
    throw new Error(`usage: node .github/scripts/colophon-publish-manifest.mjs ${MODES.join('|')} <package.json>`);
  }
  return { mode: argv[0], manifestPath: argv[1] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const { mode, manifestPath } = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), 'utf8'));
    if (mode === '--check-claim-pins') {
      await checkClaimPins(repoRoot, manifest);
      process.stdout.write(`claim pins agree with ${manifest.name}@${manifest.version}\n`);
    } else {
      const pin = loadProductReleasePlatformPin(repoRoot, manifest);
      const gitHead = COMMIT_SHA.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : undefined;
      applyColophonPublishManifest(resolve(repoRoot, manifestPath), pin, { gitHead });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
