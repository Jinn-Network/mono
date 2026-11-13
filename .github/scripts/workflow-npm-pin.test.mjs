// Every workflow job that installs or packs packed packages has to run npm 11.19.0 or newer.
//
// The npm bundled with the runner's Node 22 (10.9.9) dies with "Cannot read properties of null
// (reading 'edgesOut')" when two optional peers conflict, as the peers of vitest@4.1.12 do with
// @vitest/browser-webdriverio@4.1.11 (npm/cli#8261, fixed in npm 11.6.0 and never in npm 10;
// #5079). A job reaches that conflict by installing vitest, or by installing a package published
// before #5087 dropped the optional `vitest` peer. The crash was found and fixed one lane at a
// time, after each lane failed: Benchmark Product CI (#5078), Layer CI and the jinn-agent journey
// (#5086), the layer publish workflow (#5092), the npm and SDK publish workflows (#5097) and
// Policy Optimization CI (#5101). Each of those lanes installs npm 11.19.0 in the job; nothing
// checked that the lanes which had not run lately did the same (#5104). The minimum is 11.19.0,
// the version every pinned lane installs, so that the lanes stay on one npm.
//
// A job that runs `npm install`, `npm i`, `npm ci`, `npm pack`, a `pack:smoke` script or a
// packed-types script must run `npm install --global npm@<version>` first, with `<version>` an
// exact release of 11.19.0 or newer. `yarn pack:smoke` and the packed-types scripts shell out to
// npm, so they count even though the workflow never names npm.
//
// Like `workflow-upload-hidden-files.test.mjs`, this reads the workflow text rather than a YAML
// document: Repository structure runs it before any dependency is installed.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = join(root, '.github/workflows');

const MINIMUM_NPM = [11, 19, 0];

// Jobs that run npm without installing packed packages, so they must not be forced to pin. The key
// is `<workflow file>#<job id>`; the value says why. A stale entry fails the test below, so an
// entry cannot outlive the exemption it records.
const ALLOWED_UNPINNED_JOBS = new Map([
  [
    'broadcast-bot.yml#broadcast',
    'runs `npm install -g @anthropic-ai/claude-code`, a registry CLI, and packs nothing',
  ],
  [
    'environment-suite.yml#environment-suite',
    'runs `npm install -g @anthropic-ai/claude-code`, a registry CLI, and packs nothing',
  ],
]);

const indentOf = (line) => line.match(/^\s*/u)[0].length;
const isBlank = (line) => line.trim() === '';
const isComment = (line) => line.trimStart().startsWith('#');
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/u, '$2');
const BLOCK_SCALAR = /^[|>][+-]?\d*$/u;
const JOB_KEY = /^\s*(?:"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)'|([A-Za-z_][\w-]*)):\s*(?:#.*)?$/u;

// The `run:` and `uses:` of every step of every job. `index` is the 0-based line of the value.
// Indentation width is a style choice, so no indent is assumed: each level is read off the first
// line that opens it (the lesson of #4219 in `workflow-yarn-cache.test.mjs`).
function jobsOf(source) {
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsAt === -1) return [];

  let jobIndent = null;
  const starts = [];
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (isBlank(line) || isComment(line)) continue;
    if (indentOf(line) === 0) break;
    jobIndent ??= indentOf(line);
    const key = indentOf(line) === jobIndent ? line.match(JOB_KEY) : null;
    if (key) starts.push({ index, id: key[1] ?? key[2] ?? key[3] });
  }

  return starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    return { id: start.id, steps: stepsOf(lines, start.index, end) };
  });
}

function stepsOf(lines, jobAt, end) {
  let keyIndent = null;
  let stepsAt = -1;
  for (let index = jobAt + 1; index < end; index += 1) {
    const line = lines[index];
    if (isBlank(line) || isComment(line)) continue;
    keyIndent ??= indentOf(line);
    if (indentOf(line) === keyIndent && /^\s*steps:\s*(?:#.*)?$/u.test(line)) {
      stepsAt = index;
      break;
    }
  }
  if (stepsAt === -1) return [];

  // A sequence entry may sit indented under `steps:` or aligned with it; take the indent the
  // first `- ` opener really uses.
  const stepsIndent = indentOf(lines[stepsAt]);
  let openerIndent = null;
  const openers = [];
  for (let index = stepsAt + 1; index < end; index += 1) {
    const line = lines[index];
    if (isBlank(line) || isComment(line)) continue;
    const indent = indentOf(line);
    const opens = /^\s*-(?:\s|$)/u.test(line);
    if (openerIndent === null) {
      if (!opens || indent < stepsIndent) break;
      openerIndent = indent;
    }
    if (indent < openerIndent || (indent === openerIndent && !opens)) break;
    if (indent === openerIndent) openers.push(index);
  }

  return openers.map((opener, position) => stepAt(lines, opener, openers[position + 1] ?? end));
}

function stepAt(lines, opener, end) {
  // `- run: x` puts the key at the column after the dash and its spaces; a following key sits there.
  const keyIndent = lines[opener].match(/^\s*-\s*/u)[0].length;
  const step = { line: opener + 1, uses: null, run: null };
  for (let index = opener; index < end; index += 1) {
    const text = index === opener ? lines[index].slice(keyIndent) : lines[index];
    const key = text.match(/^(\s*)(uses|run):\s*(.*)$/u);
    if (!key || (index !== opener && key[1].length !== keyIndent)) continue;
    if (key[2] === 'uses') {
      step.uses = unquote(key[3].replace(/(?:^|\s)#.*$/u, ''));
      continue;
    }
    const scalar = [];
    if (!BLOCK_SCALAR.test(key[3].trim())) scalar.push({ index, text: unquote(key[3]) });
    for (let next = index + 1; next < end; next += 1) {
      if (!isBlank(lines[next]) && indentOf(lines[next]) <= keyIndent) break;
      scalar.push({ index: next, text: lines[next] });
    }
    step.run = scalar;
  }
  return step;
}

// Cuts a shell comment: a `#` that starts a word outside quotes.
function withoutShellComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

// The simple commands of a `run:` value, each with the line it starts on. Continuation lines are
// joined, comments are dropped, and `;`, `&&`, `||`, `|` and subshell brackets separate commands.
// The shell keywords that can lead a command (`if`, `then`, `do`...) and `NAME=value` prefixes are
// stripped so the first word is the program.
function commandsOf(scalar) {
  const commands = [];
  let pending = null;
  for (const { index, text } of scalar) {
    const line = withoutShellComment(text).trimEnd();
    const joined = pending ? { index: pending.index, text: `${pending.text} ${line}` } : { index, text: line };
    if (line.endsWith('\\')) {
      pending = { index: joined.index, text: joined.text.slice(0, -1) };
      continue;
    }
    pending = null;
    for (const piece of joined.text.split(/&&|\|\||[;|(){}`\n]|\$\(/u)) {
      const words = piece.trim().split(/\s+/u).filter(Boolean);
      while (words.length > 0 && /^(?:if|then|else|elif|do|while|until|!|time|sudo|env|command|[A-Za-z_]\w*=\S*)$/u.test(words[0])) {
        words.shift();
      }
      if (words.length > 0) commands.push({ line: joined.index + 1, words });
    }
  }
  return commands;
}

// npm options that take their value as the next word, so the value is not mistaken for the command.
const VALUE_FLAGS = new Set(['--prefix', '--userconfig', '--globalconfig', '--registry', '--loglevel', '--workspace', '-w', '--cache', '--location']);
const INSTALL_COMMANDS = new Set(['install', 'i', 'add']);
const PACKED_COMMANDS = new Set([...INSTALL_COMMANDS, 'ci', 'pack']);

// `npm [flags] <command> [flags and operands]`, or null when the command is not npm.
function parseNpm(words) {
  if (words[0] !== 'npm') return null;
  let at = 1;
  while (at < words.length && words[at].startsWith('-')) {
    at += VALUE_FLAGS.has(words[at]) ? 2 : 1;
  }
  const rest = words.slice(at + 1);
  return {
    command: words[at] ?? null,
    global: words.some((word) => word === '-g' || word === '--global' || word === '--location=global'),
    operands: rest.filter((word) => !word.startsWith('-')).map(unquote),
  };
}

function isNpmSelfInstall(npm) {
  return INSTALL_COMMANDS.has(npm.command) && npm.operands.length > 0 && npm.operands.every((operand) => operand === 'npm' || operand.startsWith('npm@'));
}

// An exact release at or above the minimum. A range, a tag or a prerelease names no fixed npm.
function isSufficientNpmPin(npm) {
  if (!isNpmSelfInstall(npm) || !npm.global) return false;
  return npm.operands.every((operand) => {
    const version = operand.slice('npm@'.length).match(/^(\d+)\.(\d+)\.(\d+)$/u);
    if (!version) return false;
    const parts = version.slice(1).map(Number);
    for (let position = 0; position < MINIMUM_NPM.length; position += 1) {
      if (parts[position] !== MINIMUM_NPM[position]) return parts[position] > MINIMUM_NPM[position];
    }
    return true;
  });
}

// The scripts behind `pack:smoke`, the registry and pre-publication acceptance runs, and the jinn-agent
// cold-stock journey (`cold-stock-e2e.sh`). Each installs packed tarballs with whatever npm is on the
// PATH.
const PACKED_CONSUMER_SCRIPT = /(?:^|\/)(?:(?:smoke-test-pack|external-consumer-acceptance|prepublication-external-consumer)\.mjs|cold-stock-e2e\.sh)$/u;

// Programs that can run a package script or a Node script. A `pack:smoke` or packed-types word
// after any other program (`echo`, `grep`) is text, not a run.
const RUNNERS = new Set(['yarn', 'npm', 'npx', 'node', 'corepack', 'bash', 'sh']);

// What the command does that needs the pin: a packed-package npm command, a `pack:smoke` script, or
// a packed-types script. Null when it needs none.
function packedUse(words) {
  const npm = parseNpm(words);
  if (npm && !isNpmSelfInstall(npm) && PACKED_COMMANDS.has(npm.command)) return `npm ${npm.command}`;
  if (!RUNNERS.has(words[0])) return null;
  if (words.some((word) => /^pack:smoke(?::|$)/u.test(unquote(word)))) return 'a pack:smoke script';
  if (words.some((word) => /packed-types[\w.-]*\.mjs$/u.test(unquote(word)))) return 'a packed-types script';
  if (words.some((word) => PACKED_CONSUMER_SCRIPT.test(unquote(word)))) return 'a packed-consumer script';
  return null;
}

// The first packed-package command of the job that runs before a sufficient npm is installed, or
// null. A `setup-node` step installs a fresh Node and its bundled npm, so a pin made before it is
// gone.
function firstUnpinned(job) {
  let pinned = false;
  for (const step of job.steps) {
    if (step.uses?.startsWith('actions/setup-node@')) pinned = false;
    for (const command of commandsOf(step.run ?? [])) {
      const npm = parseNpm(command.words);
      if (npm && isSufficientNpmPin(npm)) {
        pinned = true;
        continue;
      }
      const use = packedUse(command.words);
      if (use && !pinned) return { job: job.id, line: command.line, use, command: command.words.join(' ') };
    }
  }
  return null;
}

function unpinnedJobs(source) {
  return jobsOf(source).map(firstUnpinned).filter(Boolean);
}

function workflowFiles() {
  return readdirSync(workflowsDir).filter((name) => /\.ya?ml$/u.test(name)).sort();
}

function scanWorkflows() {
  return workflowFiles().map((name) => {
    const source = readFileSync(join(workflowsDir, name), 'utf8');
    return { name, source, findings: unpinnedJobs(source) };
  });
}

test('every job that installs or packs packed packages first installs npm 11.19.0 or newer', () => {
  const offenders = [];
  for (const { name, findings } of scanWorkflows()) {
    for (const { job, line, use, command } of findings) {
      if (ALLOWED_UNPINNED_JOBS.has(`${name}#${job}`)) continue;
      offenders.push(`${name}#${job}:${line} runs ${use} (\`${command}\`) before any \`npm install --global npm@<11.19.0 or newer>\``);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every allow-list entry names a job that still runs npm unpinned', () => {
  const unpinned = new Set();
  const jobs = new Set();
  for (const { name, source, findings } of scanWorkflows()) {
    for (const job of jobsOf(source)) jobs.add(`${name}#${job.id}`);
    for (const { job } of findings) unpinned.add(`${name}#${job}`);
  }
  for (const [key, reason] of ALLOWED_UNPINNED_JOBS) {
    assert.ok(jobs.has(key), `${key} is allow-listed but names no job`);
    assert.ok(unpinned.has(key), `${key} is allow-listed but no longer runs npm unpinned; remove the entry`);
    assert.ok(reason.trim().length > 0, `${key} needs a reason`);
  }
});

// The `run:` keys of steps, read without the job and step walk above. An `outputs:` entry or a
// `with:` input may be named `run` too; those are values handed on, not commands.
function runKeyLines(source) {
  const lines = source.split('\n');
  return lines.filter((line, index) => {
    if (!/^\s*(?:-\s+)?run:\s*\S/u.test(line) || isComment(line)) return false;
    const column = line.match(/^\s*(?:-\s+)?/u)[0].length;
    for (let up = index - 1; up >= 0; up -= 1) {
      if (isBlank(lines[up]) || isComment(lines[up]) || indentOf(lines[up]) >= column) continue;
      return !/^\s*(?:outputs|with|env|inputs):/u.test(lines[up]);
    }
    return true;
  });
}

test('the scan reads every run step the workflows hold', () => {
  // A scan that parsed nothing would report no offenders, so count the `run:` values it saw against
  // the ones in the text.
  for (const { name, source } of scanWorkflows()) {
    const seen = jobsOf(source).flatMap((job) => job.steps).filter((step) => step.run !== null).length;
    assert.equal(seen, runKeyLines(source).length, `${name}: the scan read ${seen} run steps`);
  }
});

test('the scan finds the lanes that pin and the commands that need it', () => {
  const sources = new Map(scanWorkflows().map(({ name, source }) => [name, source]));
  const usesAndPins = (name) => jobsOf(sources.get(name)).map((job) => {
    const commands = job.steps.flatMap((step) => commandsOf(step.run ?? []));
    return {
      job: job.id,
      pins: commands.some((command) => parseNpm(command.words) && isSufficientNpmPin(parseNpm(command.words))),
      uses: commands.map((command) => packedUse(command.words)).filter(Boolean),
    };
  });

  // The shapes the repository really uses: a one-line pin step, a pin inside a multi-line `run:`,
  // a `- run:` pin, and `npm pack` / `yarn pack:smoke` / a packed-types script that follow one.
  assert.deepEqual(usesAndPins('policy-optimization-ci.yml').filter((job) => job.pins).map((job) => job.job).sort(), ['product', 'verify']);
  assert.ok(usesAndPins('evidence-ci.yml').some((job) => job.pins && job.uses.includes('a pack:smoke script')));
  assert.ok(usesAndPins('layer-npm-publish.yml').some((job) => job.pins && job.uses.includes('npm pack')));
  assert.ok(usesAndPins('benchmark-product-ci.yml').some((job) => job.pins && job.uses.includes('a packed-types script')));
  assert.ok(usesAndPins('jinn-agent-ci.yml').some((job) => job.job === 'cold-stock-e2e' && job.pins && job.uses.includes('a packed-consumer script')));

  const total = [...sources.keys()].flatMap((name) => usesAndPins(name)).filter((job) => job.pins).length;
  assert.ok(total >= 20, `expected the scan to find at least 20 pinning jobs, found ${total}`);
});

const wrap = (steps) => `jobs:\n  lane:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
const flagged = (source) => unpinnedJobs(source).map(({ job, use }) => `${job}: ${use}`);

test('a pack smoke, a packed-types script, or an npm install, ci or pack without a pin is flagged', () => {
  assert.deepEqual(flagged(wrap('      - run: yarn pack:smoke')), ['lane: a pack:smoke script']);
  assert.deepEqual(flagged(wrap('      - run: yarn pack:smoke:private-runtime')), ['lane: a pack:smoke script']);
  assert.deepEqual(flagged(wrap('      - run: node .github/scripts/policy-packed-types.test.mjs')), ['lane: a packed-types script']);
  assert.deepEqual(flagged(wrap('      - run: node scripts/smoke-test-pack.mjs --output x.tgz')), ['lane: a packed-consumer script']);
  assert.deepEqual(flagged(wrap('      - run: node scripts/external-consumer-acceptance.mjs --registry')), ['lane: a packed-consumer script']);
  assert.deepEqual(flagged(wrap('      - run: bash plugin/scripts/cold-stock-e2e.sh')), ['lane: a packed-consumer script']);
  // The unit tests of those scripts do not install packed packages.
  assert.deepEqual(flagged(wrap('      - run: node --test .github/scripts/prepublication-external-consumer.test.mjs')), []);
  assert.deepEqual(flagged(wrap('      - run: npm install')), ['lane: npm install']);
  assert.deepEqual(flagged(wrap('      - run: npm i --no-audit')), ['lane: npm i']);
  assert.deepEqual(flagged(wrap('      - run: npm ci --ignore-scripts')), ['lane: npm ci']);
  assert.deepEqual(flagged(wrap('      - run: npm pack --silent')), ['lane: npm pack']);
  assert.deepEqual(flagged(wrap('      - run: npm --prefix pkg install')), ['lane: npm install']);
  assert.deepEqual(flagged(wrap('      - run: if npm pack --silent; then echo ok; fi')), ['lane: npm pack']);
  assert.deepEqual(
    flagged(wrap('      - name: Verify\n        working-directory: packages/x\n        run: |\n          yarn install --immutable\n          yarn build\n          yarn pack:smoke')),
    ['lane: a pack:smoke script'],
  );
});

test('a job reports once, at its first unpinned command', () => {
  assert.deepEqual(flagged(wrap('      - run: yarn pack:smoke\n      - run: npm pack')), ['lane: a pack:smoke script']);
});

test('a global install of an exact npm release of 11.19.0 or newer earlier in the job passes', () => {
  assert.deepEqual(flagged(wrap('      - run: npm install -g npm@11.19.0\n      - run: yarn pack:smoke')), []);
  assert.deepEqual(flagged(wrap('      - run: npm install --global npm@11.19.0 --no-audit --no-fund\n      - run: yarn pack:smoke')), []);
  assert.deepEqual(flagged(wrap('      - run: npm i -g npm@11.20.1\n      - run: npm pack')), []);
  assert.deepEqual(flagged(wrap('      - run: npm install -g npm@12.0.0\n      - run: npm ci')), []);
  assert.deepEqual(flagged(wrap('      - run: npm install -g "npm@11.19.0"\n      - run: npm ci')), []);
  assert.deepEqual(
    flagged(wrap('      - name: Pin\n        run: |\n          npm install -g npm@11.19.0\n          echo "$(npm prefix -g)/bin" >> "$GITHUB_PATH"\n          test "$(npm --version)" = "11.19.0"\n          yarn pack:smoke')),
    [],
  );
});

test('a pin that names no fixed npm of 11.19.0 or newer does not count', () => {
  for (const spec of ['npm@10.9.9', 'npm@11.18.9', 'npm@11.19.0-pre.1', 'npm@latest', 'npm@11', 'npm@^11.19.0', 'npm@>=11.19.0', 'npm']) {
    assert.deepEqual(flagged(wrap(`      - run: npm install -g ${spec}\n      - run: yarn pack:smoke`)), ['lane: a pack:smoke script'], spec);
  }
  // Without `--global` the install lands in the working directory, not on the PATH.
  assert.deepEqual(flagged(wrap('      - run: npm install npm@11.19.0\n      - run: yarn pack:smoke')), ['lane: a pack:smoke script']);
  // A pin next to another package is an install of that package, not a pin.
  assert.deepEqual(flagged(wrap('      - run: npm install -g npm@11.19.0 typescript\n      - run: yarn pack:smoke')), ['lane: npm install']);
});

test('a pin counts only for the job it is in, and only before the command that needs it', () => {
  assert.deepEqual(
    flagged('jobs:\n  a:\n    steps:\n      - run: npm install -g npm@11.19.0\n  b:\n    steps:\n      - run: yarn pack:smoke\n'),
    ['b: a pack:smoke script'],
  );
  assert.deepEqual(flagged(wrap('      - run: yarn pack:smoke\n      - run: npm install -g npm@11.19.0')), ['lane: a pack:smoke script']);
  assert.deepEqual(flagged(wrap('      - run: yarn pack:smoke && npm install -g npm@11.19.0')), ['lane: a pack:smoke script']);
  assert.deepEqual(flagged(wrap('      - run: npm install -g npm@11.19.0 && yarn pack:smoke')), []);
});

test('a later setup-node discards the pin it follows', () => {
  const setup = '      - uses: actions/setup-node@v7\n        with:\n          node-version: 22';
  assert.deepEqual(flagged(wrap(`${setup}\n      - run: npm install -g npm@11.19.0\n      - run: yarn pack:smoke`)), []);
  assert.deepEqual(
    flagged(wrap(`      - run: npm install -g npm@11.19.0\n${setup}\n      - run: yarn pack:smoke`)),
    ['lane: a pack:smoke script'],
  );
});

test('text that only mentions npm is not a command', () => {
  const source = wrap([
    '      - run: yarn install --immutable',
    '      - run: npm view "@jinn-network/sdk@1.0.0" version',
    '      - run: npm publish --access public',
    '      - run: npm run build',
    '      - run: npm exec -- jinn --help',
    '      - run: echo "npm install is not run here"',
    '      - run: |',
    '          # npm pack would go here',
    '          yarn build # then npm ci',
    '      - uses: actions/github-script@v8',
    '        with:',
    '          script: |',
    '            const note = "npm install and yarn pack:smoke are named here";',
  ].join('\n'));
  assert.deepEqual(flagged(source), []);
});

test('workflows written at another indent width, with an aligned step list, are read', () => {
  const fourSpaces = 'jobs:\n    lane:\n        steps:\n            - uses: actions/setup-node@v7\n            - run: yarn pack:smoke\n';
  assert.deepEqual(flagged(fourSpaces), ['lane: a pack:smoke script']);
  const aligned = 'jobs:\n  lane:\n    steps:\n    - run: npm install -g npm@11.19.0\n    - run: yarn pack:smoke\n  other:\n    steps:\n    - run: npm pack\n';
  assert.deepEqual(flagged(aligned), ['other: npm pack']);
  const quoted = 'jobs:\n  "lane":\n    steps:\n      - run: "yarn pack:smoke"\n';
  assert.deepEqual(flagged(quoted), ['lane: a pack:smoke script']);
  const continued = wrap('      - run: >-\n          npm pack\n          --silent');
  assert.deepEqual(flagged(continued), ['lane: npm pack']);
  const backslash = wrap('      - run: |\n          npm install \\\n            --no-audit');
  assert.deepEqual(flagged(backslash), ['lane: npm install']);
});

test('the allow-list is short and every entry says why', () => {
  assert.ok(ALLOWED_UNPINNED_JOBS.size <= 5, 'an allow-list that grows is a pin that was skipped; pin the job instead');
  for (const [key, reason] of ALLOWED_UNPINNED_JOBS) {
    assert.match(key, /^[\w.-]+\.ya?ml#[\w-]+$/u);
    assert.ok(reason.length >= 20, `${key} needs a reason`);
  }
});
