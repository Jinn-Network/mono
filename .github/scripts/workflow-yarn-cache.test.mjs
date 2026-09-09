import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  lstatSync,
  readdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowsDir = resolve(root, '.github/workflows');

const indentOf = (line) => line.match(/^\s*/u)[0].length;
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/u, '$2');
const scalar = (value) => unquote(value.replace(/\s+#.*$/u, ''));
const jobKeyPattern = /^(?:"([A-Za-z_][A-Za-z0-9_-]*)"|'([A-Za-z_][A-Za-z0-9_-]*)'|([A-Za-z_][A-Za-z0-9_-]*))$/u;

function mappingKey(line) {
  const match = line.match(/^(\s+)(.+?):(?:\s+&[^\s#]+)?\s*(?:#.*)?$/u);
  if (!match) return null;
  const key = match[2].match(jobKeyPattern);
  return key ? { indent: match[1].length, name: key[1] ?? key[2] ?? key[3] } : null;
}

// Indentation width is a style choice, not a schema rule: two spaces is this
// repository's convention, four is equally valid YAML that Actions runs. Pinning
// the walk to `parentIndent + 2` made every other width resolve zero jobs and
// zero steps, and a job that contributes no steps is indistinguishable here from
// a compliant one — the guard reported green because it had parsed nothing
// (#4219). Derive the child indent from the document instead of assuming it.
function childIndent(lines, parentIndent, from = 1) {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = indentOf(line);
    return indent > parentIndent ? indent : null;
  }
  return null;
}

export function jobRanges(source) {
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsAt === -1) return [];

  const jobsIndent = indentOf(lines[jobsAt]);
  let jobIndent = null;
  const starts = [];
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= jobsIndent) break;
    const key = mappingKey(line);
    if (!key || key.indent <= jobsIndent) continue;
    if (jobIndent === null) jobIndent = key.indent;
    if (key.indent === jobIndent) starts.push({ index, name: key.name });
  }

  return starts.map((start, position) => ({
    name: start.name,
    lines: lines.slice(start.index, starts[position + 1]?.index ?? lines.length),
  }));
}

export function stepsForJob(lines) {
  const jobIndent = indentOf(lines[0]);
  const stepsIndent = childIndent(lines, jobIndent);
  if (stepsIndent === null) return [];
  const stepsPattern = new RegExp(`^\\s{${stepsIndent}}steps:\\s*(?:#.*)?$`, 'u');
  const stepsAt = lines.findIndex((line) => stepsPattern.test(line));
  if (stepsAt === -1) return [];
  // A sequence entry may sit indented under its key or aligned with it; both are
  // ordinary YAML. Take the indent the first `- ` opener actually uses.
  let stepIndent = null;
  const starts = [];
  for (let index = stepsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // Blank lines and whole-line comments carry no structure; a comment sitting at
    // the step indent is not the end of the sequence.
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = indentOf(line);
    const opener = /^\s*-\s+/u.test(line);
    if (stepIndent === null) {
      if (!opener) {
        if (indent <= stepsIndent) break;
        continue;
      }
      if (indent < stepsIndent) break;
      stepIndent = indent;
    }
    if (indent < stepIndent) break;
    if (indent === stepIndent && !opener) break;
    if (indent === stepIndent) starts.push(index);
  }
  return starts.map((start, position) => lines.slice(start, starts[position + 1] ?? lines.length));
}

function propertyValue(lines, property) {
  const stepIndent = indentOf(lines[0]);
  const pattern = new RegExp(
    `^(?:\\s{${stepIndent}}-\\s*|\\s{${stepIndent + 2}})${property}:\\s*(.*)$`,
    'u',
  );
  const at = lines.findIndex((line) => pattern.test(line));
  if (at === -1) return null;
  const match = lines[at].match(pattern);
  if (!['|', '|-', '>', '>-'].includes(match[1].trim())) return scalar(match[1]);

  const propertyIndent = indentOf(lines[at]);
  return blockAfter(lines, at, propertyIndent).join('\n');
}

function blockAfter(lines, at, propertyIndent) {
  const block = [];
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= propertyIndent) break;
    block.push(line);
  }
  return block;
}

function withValues(lines) {
  const stepIndent = indentOf(lines[0]);
  const withPattern = new RegExp(
    `^(?:\\s{${stepIndent}}-\\s*|\\s{${stepIndent + 2}})with:\\s*(?:#.*)?$`,
    'u',
  );
  const withAt = lines.findIndex((line) => withPattern.test(line));
  if (withAt === -1) return new Map();
  const withIndent = indentOf(lines[withAt]);
  // Same lesson as `childIndent` (#4219): pinning the sub-keys to `withIndent + 2`
  // read an empty map out of every workflow written at another width, and an empty
  // `with:` map is indistinguishable here from an absent key.
  const keyIndent = childIndent(lines, withIndent, withAt + 1);
  if (keyIndent === null) return new Map();
  const values = new Map();

  for (let index = withAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith('#')) continue;
    if (line.trim() && indentOf(line) <= withIndent) break;
    const match = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!match || match[1].length !== keyIndent) continue;
    const raw = match[3].trim();
    if (!['|', '|-', '>', '>-'].includes(raw)) {
      values.set(match[2], scalar(raw));
      continue;
    }
    values.set(match[2], blockAfter(lines, index, match[1].length)
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.startsWith('#'))
      .join('\n'));
  }
  return values;
}

function setupNodeAction(lines) {
  const uses = propertyValue(lines, 'uses');
  return uses?.startsWith('actions/setup-node@') ?? false;
}

// Repository-structure runs this guard before installing dependencies, so keep the
// workflow reader self-contained. Unknown dynamic directories fail closed below;
// finite matrix axes and the repository's package-loop form expand to exact paths.
function defaultsWorkingDirectory(lines, defaultsIndent) {
  if (defaultsIndent === null) return null;
  const defaultsPattern = new RegExp(`^\\s{${defaultsIndent}}defaults:\\s*(?:#.*)?$`, 'u');
  const defaultsAt = lines.findIndex((line) => defaultsPattern.test(line));
  if (defaultsAt === -1) return null;

  const runIndent = childIndent(lines, defaultsIndent, defaultsAt + 1);
  if (runIndent === null) return null;
  const runPattern = new RegExp(`^\\s{${runIndent}}run:\\s*(?:#.*)?$`, 'u');
  const runAt = lines.findIndex((line, index) => index > defaultsAt && runPattern.test(line));
  if (runAt === -1) return null;

  const workingDirectoryIndent = childIndent(lines, runIndent, runAt + 1);
  if (workingDirectoryIndent === null) return null;
  const workingDirectoryPattern = new RegExp(
    `^\\s{${workingDirectoryIndent}}working-directory:\\s*(.+)$`,
    'u',
  );
  for (let index = runAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= runIndent) break;
    const match = line.match(workingDirectoryPattern);
    if (match) return scalar(match[1]);
  }
  return null;
}

function matrixValues(lines, variable) {
  const jobIndent = indentOf(lines[0]);
  const matrixPattern = new RegExp(`^\\s{${jobIndent + 4}}matrix:\\s*(?:#.*)?$`, 'u');
  const matrixAt = lines.findIndex((line) => matrixPattern.test(line));
  if (matrixAt === -1) return [];

  const variableIndent = jobIndent + 6;
  const variablePattern = new RegExp(
    `^\\s{${variableIndent}}${variable}:\\s*(.*)$`,
    'u',
  );
  const variableAt = lines.findIndex((line, index) => index > matrixAt && variablePattern.test(line));
  if (variableAt === -1) return [];
  const raw = lines[variableAt].match(variablePattern)[1].trim();
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(scalar).filter(Boolean);
  }

  const itemPattern = new RegExp(`^\\s{${variableIndent + 2}}-\\s+(.+)$`, 'u');
  const values = [];
  for (let index = variableAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= variableIndent) break;
    const match = line.match(itemPattern);
    if (match) values.push(scalar(match[1]));
  }
  return values;
}

// Every expansion here can nest, and a workflow is untrusted input on the pull_request
// lane. An expansion that runs away returns nothing, which the callers already read as
// "could not derive" — the fail-closed direction — rather than exhausting the stack or
// the heap and taking the whole guard down with it.
const maxExpansionDepth = 32;
const maxDirectoryCandidates = 64;

function expandWorkingDirectories(value, jobLines, depth = 0) {
  if (depth > maxExpansionDepth) return [];
  const workspaceExpanded = value.replace(/\$\{\{\s*github\.workspace\s*\}\}/gu, '.');
  const expressionPattern = /\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/u;
  const match = workspaceExpanded.match(expressionPattern);
  if (!match) return workspaceExpanded.includes('${{') ? [] : [workspaceExpanded];

  const values = matrixValues(jobLines, match[1]);
  const expanded = values.flatMap((entry) => expandWorkingDirectories(
    workspaceExpanded.replace(expressionPattern, entry),
    jobLines,
    depth + 1,
  ));
  return expanded.length > maxDirectoryCandidates ? [] : expanded;
}

function repositoryPath(repositoryRoot, ...parts) {
  const absolute = resolve(repositoryRoot, ...parts);
  const insideRoot = relative(repositoryRoot, absolute);
  if (insideRoot.startsWith(`..${sep}`) || insideRoot === '..') return null;
  return insideRoot || '.';
}

// Shell text is not a regular language, and every regex this guard read it with had
// the same failure mode: an unanticipated form resolved to the WRONG lockfile instead
// of failing closed (#4255). Tokenize once instead. Quotes, escapes, comments, line
// continuations and redirections are consumed here so that no later step has to
// re-guess them, and the scan is linear — the flag-alternation regex it replaces
// backtracked exponentially on a crafted `run:` line.
function shellTokens(run) {
  const tokens = [];
  const breaks = /[\s;&|()<>]/u;
  const heredocs = [];
  let index = 0;
  while (index < run.length) {
    const character = run[index];
    if (character === '\\' && run[index + 1] === '\n') {
      index += 2;
    } else if (character === '#' && (index === 0 || /\s/u.test(run[index - 1]))) {
      while (index < run.length && run[index] !== '\n') index += 1;
    } else if (character === '\n' || character === ';') {
      tokens.push({ type: 'separator' });
      index += 1;
      while (character === '\n' && heredocs.length > 0) {
        const delimiter = heredocs.shift();
        const body = run.indexOf(`\n${delimiter}\n`, index - 1);
        index = body === -1 ? run.length : body + delimiter.length + 2;
      }
    } else if (/\s/u.test(character)) {
      index += 1;
    } else if (character === '(' || character === ')') {
      tokens.push({ type: character });
      index += 1;
    } else if (character === '&' || character === '|') {
      tokens.push({ type: 'separator' });
      index += run[index + 1] === character ? 2 : 1;
    } else if (character === '<' && run[index + 1] === '<') {
      index += 2;
      if (run[index] === '-') index += 1;
      while (index < run.length && /[^\S\n]/u.test(run[index])) index += 1;
      let delimiter = '';
      while (index < run.length && !breaks.test(run[index])) {
        const inner = run[index];
        if (inner === '"' || inner === "'") {
          const close = run.indexOf(inner, index + 1);
          delimiter += close === -1 ? run.slice(index + 1) : run.slice(index + 1, close);
          index = close === -1 ? run.length : close + 1;
        } else {
          delimiter += inner;
          index += 1;
        }
      }
      heredocs.push(delimiter);
    } else if (character === '<' || character === '>') {
      // A redirection and its target say nothing about the command's arguments, and
      // the file-descriptor number in `2>&1` is not one either.
      if (tokens.at(-1)?.type === 'word' && /^\d+$/u.test(tokens.at(-1).value)) tokens.pop();
      index += run[index + 1] === '>' ? 2 : 1;
      while (index < run.length && /[^\S\n]/u.test(run[index])) index += 1;
      if (run[index] === '&' && run[index + 1] !== '&') index += 1;
      while (index < run.length && !breaks.test(run[index])) index += 1;
    } else {
      let word = '';
      while (index < run.length && !breaks.test(run[index])) {
        const inner = run[index];
        if (inner === '"' || inner === "'") {
          const close = run.indexOf(inner, index + 1);
          word += close === -1 ? run.slice(index + 1) : run.slice(index + 1, close);
          index = close === -1 ? run.length : close + 1;
        } else if (inner === '\\' && index + 1 < run.length) {
          word += run[index + 1];
          index += 2;
        } else {
          word += inner;
          index += 1;
        }
      }
      tokens.push({ type: 'word', value: word });
    }
  }
  return tokens;
}

// `yarn` with no verb is `yarn install` in Yarn 4, so a verb-less invocation counts —
// except when its flags say it only reports something.
const informationalYarnFlags = new Set(['--version', '-v', '--help', '-h']);

// Tokens that sit in front of the real command without being it. `do` and `{` matter
// because the repository's own package-loop form writes the whole loop on one line.
const commandPrefixes = new Set(['do', '{', '!', 'time', 'env', 'sudo', 'command', 'exec', 'nice', 'npx']);
// Constructs whose branch this walk does not model. A `cd` under one of them may or may
// not have run, so the directory becomes underivable rather than a guess.
const unmodelledKeywords = new Set([
  'if', 'elif', 'else', 'then', 'while', 'until', 'case',
  // `done` closes a loop whose last iteration decides where the shell ends up.
  'done',
]);

// Walk the tokens the way the shell walks them, tracking the working directory across
// `cd`/`pushd`/`popd` and scoping it to `( … )`. Each Yarn install contributes the
// directory candidates in force where it appears, or `null` when the walk lost track —
// `null` becomes "could not derive", which is the only safe direction here.
function shellInstallDirectories(run, loopValues) {
  const installs = [];
  const scopes = [];
  let directories = ['.'];
  let previous = ['.'];
  let pushdStack = [];
  let command = [];

  const join = (base, entry) => {
    if (entry === '.') return base;
    return base === '.' ? entry : `${base}/${entry}`;
  };
  const move = (target) => {
    if (directories === null) return;
    const expanded = expandShellWorkingDirectories(target, loopValues);
    if (expanded.length === 0) {
      directories = null;
      return;
    }
    const next = [...new Set(directories.flatMap(
      (base) => expanded.map((entry) => join(base, entry)),
    ))];
    previous = directories;
    // Each `cd` through a loop variable multiplies the candidate set. Left unbounded a
    // twenty-line `run:` block exhausts the heap, and this guard runs on every pull
    // request — including from a fork — in a job that carries no timeout.
    directories = next.length > maxDirectoryCandidates ? null : next;
  };

  const finish = () => {
    const words = command;
    command = [];
    let at = 0;
    while (at < words.length
      && (commandPrefixes.has(words[at]) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[at]))) {
      at += 1;
    }
    const [name, ...rest] = words.slice(at);
    if (name === undefined) return;
    if (unmodelledKeywords.has(name)) {
      directories = null;
      return;
    }
    if (name === 'cd' || name === 'pushd') {
      if (name === 'pushd') pushdStack.push(directories);
      const separated = rest[0] === '--';
      const target = separated ? rest[1] : rest[0];
      if (target === undefined) directories = null;
      else if (target === '-' && !separated) [directories, previous] = [previous, directories];
      else if (target.startsWith('~')) directories = null;
      else move(target);
      return;
    }
    if (name === 'popd') {
      directories = pushdStack.length > 0 ? pushdStack.pop() : null;
      return;
    }
    if (name.split('/').pop() !== 'yarn') return;

    const flags = [];
    const args = [];
    let cwd = null;
    let endOfFlags = false;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (endOfFlags || !token.startsWith('-')) {
        args.push(token);
      } else if (token === '--') {
        endOfFlags = true;
      } else if (token === '--cwd') {
        cwd = rest[index + 1] ?? '';
        index += 1;
      } else if (token.startsWith('--cwd=')) {
        cwd = token.slice('--cwd='.length);
      } else {
        flags.push(token);
      }
    }
    const isInstall = args.length === 0
      ? !flags.some((flag) => informationalYarnFlags.has(flag))
      : args[0] === 'install';
    if (!isInstall) return;
    const targets = cwd === null ? ['.'] : expandShellWorkingDirectories(cwd, loopValues);
    if (directories === null || targets.length === 0 || cwd === '') {
      installs.push(null);
      return;
    }
    const resolved = [...new Set(directories.flatMap(
      (base) => targets.map((entry) => join(base, entry)),
    ))];
    installs.push(resolved.length > maxDirectoryCandidates ? null : resolved);
  };

  for (const token of shellTokens(run)) {
    if (token.type === 'word') {
      command.push(token.value);
    } else if (token.type === '(') {
      finish();
      scopes.push({ directories, previous, pushdStack });
      pushdStack = [];
    } else if (token.type === ')') {
      finish();
      const scope = scopes.pop();
      if (scope !== undefined) ({ directories, previous, pushdStack } = scope);
    } else {
      finish();
    }
  }
  finish();
  return installs;
}

function shellLoopValues(run) {
  const commands = run.split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\s*\n\s*/gu, ' ');
  const values = new Map();
  const loopPattern = /(?:^|\n)\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+);\s*do/gu;
  for (const match of commands.matchAll(loopPattern)) {
    const entries = match[2].trim().split(/\s+/u).map(unquote).filter(Boolean);
    // Leaving the variable unset makes expansion yield nothing, which the caller
    // reports as "could not derive". A glob (`for d in packages/*`) is a directory
    // set only the runner can enumerate, so emitting `packages/*/yarn.lock` as a
    // required path would name something no workflow can ever satisfy.
    if (entries.some((entry) => /[$*?[\]{}]/u.test(entry))) continue;
    values.set(match[1], entries);
  }
  return values;
}

function expandShellWorkingDirectories(value, loopValues, depth = 0) {
  if (depth > maxExpansionDepth) return [];
  const workspaceExpanded = value
    .replace(/^\$\{?GITHUB_WORKSPACE\}?$/u, '.')
    .replace(/^\$\{\{\s*github\.workspace\s*\}\}$/u, '.');
  const variablePattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/u;
  const match = workspaceExpanded.match(variablePattern);
  if (!match) return [workspaceExpanded];

  const values = loopValues.get(match[1] ?? match[2]) ?? [];
  const expanded = values.flatMap((entry) => expandShellWorkingDirectories(
    workspaceExpanded.replace(variablePattern, entry),
    loopValues,
    depth + 1,
  ));
  return expanded.length > maxDirectoryCandidates ? [] : expanded;
}

function yarnInstallLockfiles(step, jobLines, inheritedWorkingDirectory, repositoryRoot) {
  const run = propertyValue(step, 'run');
  if (run === null) return { found: false, lockfiles: [], unresolved: false };

  const installs = shellInstallDirectories(run, shellLoopValues(run));
  if (installs.length === 0) return { found: false, lockfiles: [], unresolved: false };

  const stepWorkingDirectory = propertyValue(step, 'working-directory');
  const workingDirectory = stepWorkingDirectory ?? inheritedWorkingDirectory ?? '.';
  const workingDirectories = expandWorkingDirectories(workingDirectory, jobLines);
  const lockfiles = [];
  let unresolved = workingDirectories.length === 0;

  for (const commandWorkingDirectories of installs) {
    if (commandWorkingDirectories === null) {
      unresolved = true;
      continue;
    }
    for (const base of workingDirectories) {
      for (const commandDirectory of commandWorkingDirectories) {
        const project = repositoryPath(repositoryRoot, base, commandDirectory);
        if (project === null) {
          unresolved = true;
          continue;
        }
        lockfiles.push(project === '.' ? 'yarn.lock' : `${project}/yarn.lock`);
      }
    }
  }

  return { found: true, lockfiles: [...new Set(lockfiles)], unresolved };
}

// `actions/setup-node` resolves the Yarn cache folder by shelling out to whatever `yarn`
// is on PATH inside the setup-node step itself. On the runner image that is the bundled
// global Yarn 1, which refuses any project declaring `packageManager: yarn@4.13.0`. The
// cache therefore only works when Corepack is enabled by an earlier step in the same job.
//
// Accepted limits, both in the safe direction: this is a text check over the `run:`
// scalar, so `corepack enable` inside a heredoc counts even though it only writes a
// file; and a step whose `if:` is a runtime expression counts even though it may not
// run. Over-counting yields a red job on the runner, never a silent cache miss. A
// literal `if: false` is excluded below because that one is decidable here.
function enablesCorepack(step) {
  const run = propertyValue(step, 'run');
  if (run === null) return false;
  const condition = propertyValue(step, 'if');
  if (condition !== null && /^(?:false|\$\{\{\s*false\s*\}\})$/u.test(condition.trim())) {
    return false;
  }
  return run
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .some((line) => /(?:^|[;&|(]|\s)corepack\s+enable(?:\s|$)/u.test(line));
}

// CRLF is valid in a YAML file Actions runs. Left in place, every walk here splits
// on `\n` and carries a trailing `\r` into each line, so no anchored pattern matches
// and the workflow silently resolves zero steps (#4219).
function readWorkflow(directory, workflowName) {
  return readFileSync(join(directory, workflowName), 'utf8').replace(/\r\n/gu, '\n');
}

export function yarnCacheViolations(directory = workflowsDir, repositoryRoot = root) {
  const violations = [];
  const workflowNames = readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  for (const workflowName of workflowNames) {
    const source = readWorkflow(directory, workflowName);
    const sourceLines = source.split('\n');
    const jobsAt = sourceLines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
    const workflowWorkingDirectory = defaultsWorkingDirectory(sourceLines.slice(0, jobsAt), 0);
    for (const job of jobRanges(source)) {
      const steps = stepsForJob(job.lines);
      for (let index = 0; index < steps.length; index += 1) {
        if (!setupNodeAction(steps[index])) continue;
        if (withValues(steps[index]).get('cache') !== 'yarn') continue;
        if (steps.slice(0, index).some(enablesCorepack)) continue;
        violations.push(
          `${workflowName} job ${job.name}: corepack enable must run before the setup-node step that caches Yarn`,
        );
      }
      const jobWorkingDirectory = defaultsWorkingDirectory(
        job.lines,
        childIndent(job.lines, indentOf(job.lines[0])),
      ) ?? workflowWorkingDirectory;
      for (let index = 0; index < steps.length; index += 1) {
        if (!setupNodeAction(steps[index])) continue;
        const installs = steps.slice(index + 1)
          .map((step) => yarnInstallLockfiles(step, job.lines, jobWorkingDirectory, repositoryRoot))
          .filter((install) => install.found);
        if (installs.length === 0) continue;

        const location = `${workflowName} job ${job.name}`;
        const values = withValues(steps[index]);
        const remoteCheckoutLockfiles = steps.slice(0, index)
          .filter((step) => propertyValue(step, 'uses')?.startsWith('actions/checkout@'))
          .map((step) => withValues(step))
          .filter((checkout) => checkout.get('repository') && checkout.get('path'))
          .map((checkout) => relative(
            repositoryRoot,
            resolve(repositoryRoot, checkout.get('path'), 'yarn.lock'),
          ))
          .filter((dependencyPath) => !dependencyPath.startsWith(`..${sep}`) && dependencyPath !== '..');
        if (values.get('cache') !== 'yarn') {
          violations.push(`${location}: setup-node must declare cache: yarn`);
        }

        const paths = (values.get('cache-dependency-path') ?? '')
          .split('\n')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (paths.length === 0) {
          violations.push(`${location}: setup-node must declare cache-dependency-path`);
          continue;
        }
        if (new Set(paths).size !== paths.length) {
          violations.push(`${location}: cache-dependency-path entries must be deduplicated`);
        }
        if (installs.some((install) => install.unresolved)) {
          violations.push(`${location}: could not derive every Yarn install project lockfile`);
        }
        const requiredPaths = [...new Set(installs.flatMap((install) => install.lockfiles))];
        for (const requiredPath of requiredPaths) {
          if (!paths.includes(requiredPath)) {
            violations.push(`${location}: setup-node must cache ${requiredPath}`);
          }
        }
        for (const dependencyPath of paths) {
          const absolute = resolve(repositoryRoot, dependencyPath);
          const insideRoot = relative(repositoryRoot, absolute);
          if (insideRoot.startsWith(`..${sep}`) || insideRoot === '..' || dependencyPath.startsWith('/')) {
            violations.push(`${location}: cache dependency path must stay inside the repository: ${dependencyPath}`);
          } else if (basename(dependencyPath) !== 'yarn.lock') {
            violations.push(`${location}: cache dependency path is not an existing lockfile: ${dependencyPath}`);
            // The containment check above is string math over the declared path, so it
            // is blind to links. `lstatSync` refuses a lockfile that is itself a
            // symlink; re-deriving containment from the real path refuses one reached
            // through a symlinked parent directory.
          } else if ((!existsSync(absolute)
            || !lstatSync(absolute).isFile()
            || repositoryPath(realpathSync(repositoryRoot), realpathSync(absolute)) === null)
            && !remoteCheckoutLockfiles.includes(dependencyPath)) {
            violations.push(`${location}: cache dependency path is not an existing lockfile: ${dependencyPath}`);
          }
        }
      }
    }
  }
  return violations;
}

// The walks above can only report on steps they resolve, and a job they resolve
// nothing from looks exactly like a compliant one. This counts `actions/setup-node`
// two ways — the raw text of the file, and the steps the walk actually returned —
// so any future workflow shape the walk cannot see fails loudly by name instead of
// passing silently (#4219).
export function setupNodeStepCoverage(directory = workflowsDir) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((workflowName) => {
      const source = readWorkflow(directory, workflowName);
      // A flow-style sequence entry (`- { uses: actions/setup-node@v7 }`) is legal
      // YAML that Actions runs and that the block walk cannot see. Counting it here
      // is what stops the two sides agreeing with each other about a shape neither
      // one parses.
      const declared = source
        .split('\n')
        .filter((line) => /^\s*(?:-\s+)?uses:\s*["']?actions\/setup-node@/u.test(line)
          || /^\s*-\s*\{.*\buses:\s*["']?actions\/setup-node@/u.test(line))
        .length;
      const resolved = jobRanges(source)
        .flatMap((job) => stepsForJob(job.lines))
        .filter(setupNodeAction)
        .length;
      return { workflow: workflowName, declared, resolved };
    });
}

test('setup-node caches every later Yarn install with existing lockfiles', () => {
  assert.deepEqual(yarnCacheViolations(), []);
});

test('the workflow walk resolves every setup-node step present in the source', () => {
  const blind = setupNodeStepCoverage()
    .filter(({ declared, resolved }) => declared !== resolved)
    .map(({ workflow, declared, resolved }) => `${workflow}: ${declared} in source, ${resolved} walked`);
  assert.deepEqual(blind, []);
});

test('coverage counting catches a workflow shape the walk cannot see', () => {
  const fixtureWorkflows = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-coverage-'));
  try {
    // `steps:` with its sequence entries aligned to the key rather than indented
    // under it: ordinary YAML, and the shape the pre-#4219 walk resolved as empty.
    writeFileSync(join(fixtureWorkflows, 'aligned.yml'), `name: aligned fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
    - run: corepack enable
    - uses: actions/setup-node@v7
      with:
        node-version: 22
    - run: yarn install --immutable
`);
    assert.deepEqual(setupNodeStepCoverage(fixtureWorkflows), [
      { workflow: 'aligned.yml', declared: 1, resolved: 1 },
    ]);
    assert.match(
      yarnCacheViolations(fixtureWorkflows, fixtureWorkflows).join('\n'),
      /must declare cache: yarn/u,
    );
  } finally {
    rmSync(fixtureWorkflows, { recursive: true, force: true });
  }
});

test('the walk reads four-space and CRLF workflows', () => {
  const fixtureWorkflows = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-shape-'));
  const body = `name: shape fixture
jobs:
    verify:
        runs-on: ubuntu-latest
        steps:
            - run: corepack enable
            - uses: actions/setup-node@v7
              with:
                  node-version: 22
                  cache: yarn
            - run: yarn install --immutable
`;
  try {
    writeFileSync(join(fixtureWorkflows, 'four-space.yml'), body);
    writeFileSync(join(fixtureWorkflows, 'crlf.yml'), body.replace(/\n/gu, '\r\n'));
    assert.deepEqual(setupNodeStepCoverage(fixtureWorkflows), [
      { workflow: 'crlf.yml', declared: 1, resolved: 1 },
      { workflow: 'four-space.yml', declared: 1, resolved: 1 },
    ]);
    // `cache: yarn` sits in a four-space `with:` block. Its absence from the
    // violations proves the map was read; before #4253 the block resolved empty and
    // this fixture passed for the narrower reason that it saw no keys at all.
    const violations = yarnCacheViolations(fixtureWorkflows, fixtureWorkflows);
    assert.deepEqual(violations, [
      'crlf.yml job verify: setup-node must declare cache-dependency-path',
      'four-space.yml job verify: setup-node must declare cache-dependency-path',
    ]);
  } finally {
    rmSync(fixtureWorkflows, { recursive: true, force: true });
  }
});

function fixtureWorkflow(setupWith) {
  return `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
${setupWith}
      - run: yarn install --immutable
        working-directory: app
`;
}

function withFixture(run) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-'));
  const fixtureWorkflows = join(fixtureRoot, '.github/workflows');
  mkdirSync(join(fixtureRoot, 'app'), { recursive: true });
  mkdirSync(fixtureWorkflows, { recursive: true });
  writeFileSync(join(fixtureRoot, 'app/yarn.lock'), 'fixture lockfile\n');
  try {
    run({ fixtureRoot, fixtureWorkflows });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function withWorkflowMutation(workflowName, mutate, run) {
  const fixtureWorkflows = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-mutation-'));
  const source = readFileSync(join(workflowsDir, workflowName), 'utf8');
  const mutant = mutate(source);
  assert.notEqual(mutant, source, `mutation did not change ${workflowName}`);
  writeFileSync(join(fixtureWorkflows, workflowName), mutant);
  try {
    run(fixtureWorkflows);
  } finally {
    rmSync(fixtureWorkflows, { recursive: true, force: true });
  }
}

test('guard rejects a setup-node step missing Yarn cache configuration', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22\n          cache-dependency-path: app/yarn.lock',
    ));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});

test('guard rejects cache dependency paths that do not exist', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22\n          cache: yarn\n          cache-dependency-path: missing/yarn.lock',
    ));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /not an existing lockfile/u);
  });
});

test('guard does not treat a nested checkout path as proof that a lockfile exists', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          path: dependency
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: dependency/yarn.lock
      - run: yarn install --immutable
`);
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /not an existing lockfile/u);
  });
});

test('guard accepts a lockfile supplied by an external repository checkout', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          repository: Jinn-Network/autopilot
          path: .autopilot-pin
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: .autopilot-pin/yarn.lock
      - run: yarn install --immutable
        working-directory: .autopilot-pin
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), []);
  });
});

test('guard reads step properties at their YAML depth', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Set up Node
        env:
          uses: not-an-action
        uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: yarn install --immutable
        working-directory: app
`);
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});

test('guard does not mistake nested step data or shell comments for executable workflow structure', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Document an action
        env:
          uses: actions/setup-node@v7
        run: |
          # yarn install --immutable
          echo no dependency installation
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), []);
  });
});

test('guard rejects a directory named like a lockfile', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    rmSync(join(fixtureRoot, 'app/yarn.lock'));
    mkdirSync(join(fixtureRoot, 'app/yarn.lock'));
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22\n          cache: yarn\n          cache-dependency-path: app/yarn.lock',
    ));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /not an existing lockfile/u);
  });
});

test('guard rejects a cache mapping missing one installed project lockfile', () => {
  withWorkflowMutation('ci.yml', (source) => source.replace(
    '            packages/lifecycle-notifications/yarn.lock\n',
    '',
  ), (fixtureWorkflows) => {
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows), [
      'ci.yml job dashboard-e2e: setup-node must cache packages/lifecycle-notifications/yarn.lock',
    ]);
  });
});

test('guard rejects an unrelated existing lockfile in place of the installed project', () => {
  withWorkflowMutation('ci.yml', (source) => source.replace(
    '            packages/lifecycle-notifications/yarn.lock\n',
    '            operator/yarn.lock\n',
  ), (fixtureWorkflows) => {
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows), [
      'ci.yml job dashboard-e2e: setup-node must cache packages/lifecycle-notifications/yarn.lock',
    ]);
  });
});

test('guard derives installs from workflow defaults and yarn --cwd', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    mkdirSync(join(fixtureRoot, 'dependency'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'dependency/yarn.lock'), 'dependency lockfile\n');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
defaults:
  run:
    working-directory: app
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: app/yarn.lock
      - run: yarn --cwd ../dependency install --immutable
`);
    assert.match(
      yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
      /must cache dependency\/yarn\.lock/u,
    );
  });
});

test('guard expands matrix working directories', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    for (const directory of ['packages/one', 'packages/two']) {
      mkdirSync(join(fixtureRoot, directory), { recursive: true });
      writeFileSync(join(fixtureRoot, directory, 'yarn.lock'), `${directory} lockfile\n`);
    }
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        component: [one, two]
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: packages/one/yarn.lock
      - run: yarn install --immutable
        working-directory: packages/\${{ matrix.component }}
`);
    assert.match(
      yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
      /must cache packages\/two\/yarn\.lock/u,
    );
  });
});

test('guard expands shell install loops', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    for (const directory of ['packages/one', 'packages/two']) {
      mkdirSync(join(fixtureRoot, directory), { recursive: true });
      writeFileSync(join(fixtureRoot, directory, 'yarn.lock'), `${directory} lockfile\n`);
    }
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: packages/one/yarn.lock
      - run: |
          for component in one two; do
            (cd "packages/$component" && yarn install --immutable)
          done
`);
    assert.match(
      yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
      /must cache packages\/two\/yarn\.lock/u,
    );
  });
});

test('guard checks Yarn installs under double-quoted job IDs', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22',
    ).replace('  verify:', '  "verify":'));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});

test('guard checks Yarn installs under single-quoted job IDs with valid punctuation', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22',
    ).replace('  verify:', "  'verify-job_1':"));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});

test('guard checks Yarn installs under anchored job IDs', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22',
    ).replace('  verify:', '  verify: &verify_job'));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});

for (const anchor of ['verify.job', 'verify/job']) {
  test(`guard checks Yarn installs under job anchor ${anchor}`, () => {
    withFixture(({ fixtureRoot, fixtureWorkflows }) => {
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
        '          node-version: 22',
      ).replace('  verify:', `  verify: &${anchor}`));
      assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
    });
  });
}

test('guard rejects a cached setup-node step that Corepack has not yet been enabled for', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: app/yarn.lock
      - run: corepack enable
      - run: yarn install --immutable
        working-directory: app
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: corepack enable must run before the setup-node step that caches Yarn',
    ]);
  });
});

test('guard ignores a Corepack command that only appears in a shell comment', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: |
          # corepack enable
          echo not enabled
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: app/yarn.lock
      - run: yarn install --immutable
        working-directory: app
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: corepack enable must run before the setup-node step that caches Yarn',
    ]);
  });
});

test('guard rejects a workflow whose Corepack step is moved after the cached setup-node step', () => {
  withWorkflowMutation('net-liveness.yml', (source) => source.replace(
    `      - name: Enable Corepack before the Yarn cache lookup
        # setup-node resolves the Yarn cache folder by shelling out to \`yarn\`.
        # Without Corepack that is the runner image's global Yarn 1, which
        # refuses every project pinned to \`packageManager: yarn@4.13.0\`.
        run: corepack enable
`,
    '',
  ), (fixtureWorkflows) => {
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows), [
      'net-liveness.yml job net-liveness: corepack enable must run before the setup-node step that caches Yarn',
    ]);
  });
});

test('coverage counting sees a flow-style step entry the walk cannot', () => {
  const fixtureWorkflows = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-flow-'));
  try {
    // `- { uses: ... }` is legal YAML that Actions runs and that the block walk
    // resolves as nothing. Counted only by the block regex, both sides would read
    // zero and the coverage assertion would agree with itself about a blind spot.
    writeFileSync(join(fixtureWorkflows, 'flow.yml'), `name: flow fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - { uses: actions/setup-node@v7, with: { cache: yarn } }
      - run: yarn install --immutable
`);
    assert.deepEqual(setupNodeStepCoverage(fixtureWorkflows), [
      { workflow: 'flow.yml', declared: 1, resolved: 0 },
    ]);
  } finally {
    rmSync(fixtureWorkflows, { recursive: true, force: true });
  }
});

test('guard rejects a cache dependency path that is a symlink rather than a lockfile', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    // `statSync` follows the link and reports the target file, which would satisfy
    // the very containment check the path assertion above it exists to enforce.
    const outside = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-outside-'));
    try {
      writeFileSync(join(outside, 'yarn.lock'), 'outside lockfile\n');
      rmSync(join(fixtureRoot, 'app/yarn.lock'));
      symlinkSync(join(outside, 'yarn.lock'), join(fixtureRoot, 'app/yarn.lock'));
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
        '          node-version: 22\n          cache: yarn\n          cache-dependency-path: app/yarn.lock',
      ));
      assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
        'fixture.yml job verify: cache dependency path is not an existing lockfile: app/yarn.lock',
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// Each of these once resolved to the repository root while the shell was somewhere
// else, which is the silent wrong-lockfile direction #4255(2) says must never happen.
for (const [label, run] of [
  ['a cd on a preceding line', 'cd app\n          yarn install --immutable'],
  ['a cd whose command chain does not install', 'cd app && yarn build\n          yarn install --immutable'],
  ['cd -- with an explicit end of options', 'cd -- app\n          yarn install --immutable'],
  ['pushd on a preceding line', 'pushd app\n          yarn install --immutable'],
]) {
  test(`guard follows the working directory across ${label}`, () => {
    withFixture(({ fixtureRoot, fixtureWorkflows }) => {
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          ${run}
`);
      assert.match(
        yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
        /must cache app\/yarn\.lock/u,
      );
    });
  });
}

test('guard restores the working directory a subshell changed', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureRoot, 'yarn.lock'), 'root lockfile\n');
    // Only `app/yarn.lock` is declared, so the violation names whatever directory the
    // second install lands in — the proof that `)` restored it.
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: app/yarn.lock
      - run: |
          (cd app && yarn install --immutable)
          yarn install --immutable
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: setup-node must cache yarn.lock',
    ]);
  });
});

test('guard fails closed when it loses track of the working directory', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          cd "$PROJECT_DIR"
          yarn install --immutable
`);
    assert.match(
      yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
      /could not derive every Yarn install project lockfile/u,
    );
  });
});

for (const [label, run] of [
  ['a semicolon-separated cd', 'cd app; yarn install --immutable'],
  ['pushd', 'pushd app && yarn install --immutable'],
]) {
  test(`guard resolves an install behind ${label}`, () => {
    withFixture(({ fixtureRoot, fixtureWorkflows }) => {
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: ${run}
`);
      const violations = yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n');
      assert.match(violations, /must cache app\/yarn\.lock/u);
      assert.doesNotMatch(violations, /could not derive/u);
    });
  });
}

for (const [label, run] of [
  ['a bare yarn', 'yarn'],
  ['flags before the install verb', 'yarn --immutable install'],
]) {
  test(`guard recognises ${label} as an install`, () => {
    withFixture(({ fixtureRoot, fixtureWorkflows }) => {
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: ${run}
        working-directory: app
`);
      assert.match(
        yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
        /must cache app\/yarn\.lock/u,
      );
    });
  });
}

for (const run of ['yarn build', 'yarn vitest run src', 'yarn --version', 'yarn -v']) {
  test(`guard does not mistake \`${run}\` for an install`, () => {
    withFixture(({ fixtureRoot, fixtureWorkflows }) => {
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: ${run}
        working-directory: app
`);
      assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), []);
    });
  });
}

// A redirected or argument-carrying install is still an install; missing one imposes
// no cache requirement at all, which is the direction that costs a silent cache miss.
for (const run of [
  'yarn install --immutable > install.log',
  'yarn install --immutable 2>&1 | tee install.log',
  'yarn install >/dev/null',
  'yarn install --immutable # remember to cd back afterwards',
  // The verb-less forms are where a mis-lexed redirection is invisible: the target
  // or the file descriptor becomes the verb and the install stops looking like one.
  'yarn > install.log',
  'yarn 2>&1',
]) {
  test(`guard sees the install in \`${run}\``, () => {
    withFixture(({ fixtureRoot, fixtureWorkflows }) => {
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: ${run}
        working-directory: app
`);
      assert.match(
        yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
        /must declare cache: yarn/u,
      );
    });
  });
}

test('guard ignores a Corepack step whose condition is literally false', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - if: \${{ false }}
        run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: app/yarn.lock
      - run: yarn install --immutable
        working-directory: app
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: corepack enable must run before the setup-node step that caches Yarn',
    ]);
  });
});

test('guard reports a glob install loop as underivable rather than naming a glob lockfile', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    mkdirSync(join(fixtureRoot, 'packages/one'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'packages/one/yarn.lock'), 'one lockfile\n');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: packages/one/yarn.lock
      - run: |
          for d in packages/*; do
            (cd "$d" && yarn install --immutable)
          done
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: could not derive every Yarn install project lockfile',
    ]);
  });
});

test('the walk reads a job whose keys are separated by whole-line comments', () => {
  const fixtureWorkflows = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-comment-'));
  try {
    // A comment carries no structure, so deriving a child indent from one blinds the
    // walk to the whole job — and a job the walk resolves nothing from is exactly what
    // the coverage assertion cannot distinguish from a compliant one (#4219).
    writeFileSync(join(fixtureWorkflows, 'commented.yml'), `name: comment fixture
jobs:
  verify:
  # what this job is for
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
        # why this version
          cache: yarn
          node-version: 22
      - run: yarn install --immutable
`);
    assert.deepEqual(setupNodeStepCoverage(fixtureWorkflows), [
      { workflow: 'commented.yml', declared: 1, resolved: 1 },
    ]);
    // `cache: yarn` sits behind the comment inside `with:`; reading it proves the
    // comment did not truncate the map either.
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureWorkflows), [
      'commented.yml job verify: setup-node must declare cache-dependency-path',
    ]);
  } finally {
    rmSync(fixtureWorkflows, { recursive: true, force: true });
  }
});

test('coverage counting sees a flow-style entry whose uses key follows a nested map', () => {
  const fixtureWorkflows = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-nested-flow-'));
  try {
    writeFileSync(join(fixtureWorkflows, 'nested-flow.yml'), `name: nested flow fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - { with: { cache: yarn }, uses: actions/setup-node@v7 }
      - run: yarn install --immutable
`);
    assert.deepEqual(setupNodeStepCoverage(fixtureWorkflows), [
      { workflow: 'nested-flow.yml', declared: 1, resolved: 0 },
    ]);
  } finally {
    rmSync(fixtureWorkflows, { recursive: true, force: true });
  }
});

test('guard rejects a cache dependency path reached through a symlinked parent', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    // `lstatSync` only refuses a link in the final position; containment above it is
    // string math over the declared path, so a symlinked parent escapes both.
    const outside = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-outside-parent-'));
    try {
      writeFileSync(join(outside, 'yarn.lock'), 'outside lockfile\n');
      rmSync(join(fixtureRoot, 'app'), { recursive: true, force: true });
      symlinkSync(outside, join(fixtureRoot, 'app'));
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
        '          node-version: 22\n          cache: yarn\n          cache-dependency-path: app/yarn.lock',
      ));
      assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
        'fixture.yml job verify: cache dependency path is not an existing lockfile: app/yarn.lock',
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('the shell walk stays linear on an adversarial run block', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    // The flag-alternation regex this walk replaced backtracked exponentially here:
    // ~47s at 26 repetitions, and the structure lane that runs this guard on every
    // pull request carries no job timeout.
    const hostile = `yarn${' --cwd=a'.repeat(64)} X`;
    const nested = `${'('.repeat(2048)}yarn install --immutable${')'.repeat(2048)}`;
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: app/yarn.lock
      - run: |
          ${hostile}
          ${nested}
        working-directory: app
`);
    const startedAt = process.hrtime.bigint();
    yarnCacheViolations(fixtureWorkflows, fixtureRoot);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.ok(elapsedMs < 5000, `walk took ${elapsedMs.toFixed(0)}ms`);
  });
});

test('guard does not read a shell comment as a second command', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    // Without comment stripping the `;` inside the comment ends a command and
    // `yarn install` after it reads as a real install that nothing performs.
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: |
          yarn build # later: cd app; yarn install
        working-directory: app
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), []);
  });
});

// Every entry below once resolved to the repository root while the shell was elsewhere,
// or hid the install entirely. Both are the silent directions this guard must not take.
for (const [label, run] of [
  ['a one-line for loop', 'for d in app; do cd $d; yarn install --immutable; done'],
  ['a brace group', '{ cd app; yarn install --immutable; }'],
  ['an environment assignment prefix', 'cd app\n          NODE_ENV=production yarn install --immutable'],
  ['a command prefix', 'cd app\n          env yarn install --immutable'],
  ['a yarn invoked by path', 'cd app\n          ./node_modules/.bin/yarn install --immutable'],
]) {
  test(`guard resolves an install behind ${label}`, () => {
    withFixture(({ fixtureRoot, fixtureWorkflows }) => {
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          ${run}
`);
      assert.match(
        yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
        /must cache app\/yarn\.lock/u,
      );
    });
  });
}

for (const [label, run] of [
  ['a conditional directory change', 'cd app\n          if [ -d other ]; then cd ../other; fi\n          yarn install --immutable'],
  ['a while loop', 'ls | while read d; do cd $d; yarn install --immutable; done'],
]) {
  test(`guard fails closed on ${label}`, () => {
    withFixture(({ fixtureRoot, fixtureWorkflows }) => {
      writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          ${run}
`);
      assert.match(
        yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
        /could not derive every Yarn install project lockfile/u,
      );
    });
  });
}

test('guard does not honour a directory change that only appears in a heredoc', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureRoot, 'yarn.lock'), 'root lockfile\n');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          cat <<'EOF' > setup.sh
          cd app
          EOF
          yarn install --immutable
`);
    // The `cd` is written to a file, not executed; the install runs at the root.
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), []);
  });
});

test('the directory walk stays bounded when every command multiplies the candidates', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    // Each `cd $d` multiplied the candidate set by the loop width. Sixteen of them
    // exhausted the heap, in a lane that runs on fork pull requests with no timeout.
    writeFileSync(join(fixtureRoot, 'yarn.lock'), 'root lockfile\n');
    const explosive = Array.from({ length: 24 }, () => 'cd $d').join('\n          ');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          for d in a b c; do
          ${explosive}
          yarn install --immutable
          done
`);
    const startedAt = process.hrtime.bigint();
    const violations = yarnCacheViolations(fixtureWorkflows, fixtureRoot);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.ok(elapsedMs < 5000, `walk took ${elapsedMs.toFixed(0)}ms`);
    assert.deepEqual(violations, [
      'fixture.yml job verify: could not derive every Yarn install project lockfile',
    ]);
  });
});

test('a runaway shell expansion reports rather than exhausting the stack', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureRoot, 'yarn.lock'), 'root lockfile\n');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          for d in a; do
          cd ${'$d'.repeat(20000)}
          yarn install --immutable
          done
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: could not derive every Yarn install project lockfile',
    ]);
  });
});

test('guard fails closed on a directory the walk cannot expand itself', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureRoot, 'yarn.lock'), 'root lockfile\n');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          cd ~/app
          yarn install --immutable
`);
    // Tilde expansion belongs to the shell; naming `~/yarn.lock` would be nonsense.
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: could not derive every Yarn install project lockfile',
    ]);
  });
});

test('guard does not carry a loop body directory past the loop', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureRoot, 'yarn.lock'), 'root lockfile\n');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          for d in a b; do cd $d; done
          yarn install --immutable
`);
    // The shell ends in whichever directory the last iteration reached; claiming both
    // would be a confident wrong answer.
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: could not derive every Yarn install project lockfile',
    ]);
  });
});

test('guard fails closed when one install names more projects than it will enumerate', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureRoot, 'yarn.lock'), 'root lockfile\n');
    // Two sets that are each individually within the bound, crossed into one that is not.
    const outer = Array.from({ length: 10 }, (unused, index) => `o${index}`).join(' ');
    const inner = Array.from({ length: 10 }, (unused, index) => `i${index}`).join(' ');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          for d in ${outer}; do
          for e in ${inner}; do
          cd $d
          yarn --cwd $e install --immutable
          done
          done
`);
    // Naming 128 required lockfiles is not a verdict anyone can act on, and the set is
    // attacker-controlled; the bound turns it into one actionable line.
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: could not derive every Yarn install project lockfile',
    ]);
  });
});

test('guard fails closed on a --cwd with no value', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureRoot, 'yarn.lock'), 'root lockfile\n');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: yarn.lock
      - run: |
          yarn install --immutable --cwd
`);
    // The target is missing, not absent: resolving it to the root would be a guess.
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), [
      'fixture.yml job verify: could not derive every Yarn install project lockfile',
    ]);
  });
});
