import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const MAX_MARKETPLACE_PATCH_BYTES = 2 * 1024 * 1024;

export type MarketplacePatchRejectionReason =
  | 'artifact-too-large'
  | 'invalid-utf8'
  | 'nul-byte'
  | 'binary-patch'
  | 'malformed-patch'
  | 'unsafe-path'
  | 'unsupported-mode';

export class MarketplacePatchValidationError extends Error {
  readonly reason: MarketplacePatchRejectionReason;

  constructor(reason: MarketplacePatchRejectionReason, message: string) {
    super(message);
    this.name = 'MarketplacePatchValidationError';
    this.reason = reason;
  }
}

export class MarketplacePatchCheckError extends Error {
  readonly reason = 'git-check-failed' as const;

  constructor(cause: unknown) {
    super('Marketplace patch failed git apply --check', { cause });
    this.name = 'MarketplacePatchCheckError';
  }
}

export type MarketplacePatchWorktreeRejectionReason =
  | 'git-index-inspection-failed'
  | 'malformed-index-output'
  | 'unsafe-existing-mode';

export class MarketplacePatchWorktreeValidationError extends Error {
  readonly reason: MarketplacePatchWorktreeRejectionReason;

  constructor(
    reason: MarketplacePatchWorktreeRejectionReason,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'MarketplacePatchWorktreeValidationError';
    this.reason = reason;
  }
}

export type MarketplacePatchApplicationFailureReason =
  | 'invalid-worktree-path'
  | 'git-apply-failed';

export class MarketplacePatchApplicationError extends Error {
  readonly reason: MarketplacePatchApplicationFailureReason;

  constructor(
    reason: MarketplacePatchApplicationFailureReason,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'MarketplacePatchApplicationError';
    this.reason = reason;
  }
}

export interface ValidatedMarketplacePatch {
  readonly byteLength: number;
  readonly touchedPaths: readonly string[];
}

export interface MarketplacePatchGitOptions {
  readonly cwd: string;
  readonly stdin: Uint8Array;
}

export type MarketplacePatchGitRunner = (
  command: 'git',
  args: readonly string[],
  options: MarketplacePatchGitOptions,
) => Promise<Uint8Array>;

interface ParsedPath {
  readonly value: string;
  readonly end: number;
}

type PathSurface =
  | 'diff-old'
  | 'diff-new'
  | 'old-marker'
  | 'new-marker'
  | 'metadata';

interface PatchSection {
  oldMarker?: string | null;
  newMarker?: string | null;
  oldMode?: string;
  newMode?: string;
  newFileMode?: string;
  deletedFileMode?: string;
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
  hasOperation: boolean;
  inHunk: boolean;
  hunkOldRemaining: number;
  hunkNewRemaining: number;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const MODE_LINE_PATTERN =
  /^(old mode|new mode|new file mode|deleted file mode) ([0-7]{6})$/;
const INDEX_LINE_PATTERN =
  /^index [0-9a-f]+\.\.[0-9a-f]+(?: ([0-7]{6}))?$/i;
const HUNK_HEADER_PATTERN =
  /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/;
const INDEX_STAGE_RECORD_PATTERN =
  /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t(.+)$/;

function validationError(
  reason: MarketplacePatchRejectionReason,
  message: string,
): never {
  throw new MarketplacePatchValidationError(reason, message);
}

function decodeUtf8(bytes: Uint8Array, subject: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return validationError('invalid-utf8', `${subject} is not valid UTF-8`);
  }
}

function parseQuotedPath(input: string, start = 0): ParsedPath {
  if (input[start] !== '"') {
    return validationError('malformed-patch', 'Expected a Git-quoted path');
  }

  const bytes: number[] = [];
  let segmentStart = start + 1;
  let cursor = segmentStart;
  const flushLiteral = (end: number): void => {
    bytes.push(...textEncoder.encode(input.slice(segmentStart, end)));
  };

  while (cursor < input.length) {
    const character = input[cursor]!;
    if (character === '"') {
      flushLiteral(cursor);
      return {
        value: decodeUtf8(Uint8Array.from(bytes), 'Git-quoted path'),
        end: cursor + 1,
      };
    }
    if (character !== '\\') {
      cursor += 1;
      continue;
    }

    flushLiteral(cursor);
    cursor += 1;
    const escape = input[cursor];
    if (escape === undefined) {
      return validationError('malformed-patch', 'Unterminated Git path escape');
    }
    const simpleEscapes: Readonly<Record<string, number>> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      '\\': 0x5c,
    };
    const simple = simpleEscapes[escape];
    if (simple !== undefined) {
      bytes.push(simple);
      cursor += 1;
      segmentStart = cursor;
      continue;
    }
    if (/[0-7]/.test(escape)) {
      let octal = escape;
      cursor += 1;
      while (octal.length < 3 && cursor < input.length && /[0-7]/.test(input[cursor]!)) {
        octal += input[cursor]!;
        cursor += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      segmentStart = cursor;
      continue;
    }
    return validationError('malformed-patch', 'Unsupported Git path escape');
  }

  return validationError('malformed-patch', 'Unterminated Git-quoted path');
}

function parseDiffPathPair(input: string): readonly [string, string] {
  if (input.startsWith('"')) {
    const oldPath = parseQuotedPath(input);
    let cursor = oldPath.end;
    if (input[cursor] !== ' ') {
      return validationError('malformed-patch', 'Missing diff path separator');
    }
    while (input[cursor] === ' ') cursor += 1;
    const newPath = input[cursor] === '"'
      ? parseQuotedPath(input, cursor)
      : { value: input.slice(cursor), end: input.length };
    if (newPath.end !== input.length || newPath.value.length === 0) {
      return validationError('malformed-patch', 'Malformed diff target path');
    }
    return [oldPath.value, newPath.value];
  }

  const candidateSeparators: number[] = [];
  let cursor = input.indexOf(' b/');
  while (cursor !== -1) {
    candidateSeparators.push(cursor);
    cursor = input.indexOf(' b/', cursor + 1);
  }
  if (candidateSeparators.length > 1) {
    return validationError('malformed-patch', 'Ambiguous diff path separator');
  }
  const separator = candidateSeparators[0] ?? input.indexOf(' ');
  if (separator <= 0 || separator >= input.length - 1) {
    return validationError('malformed-patch', 'Diff header must contain two paths');
  }
  return [input.slice(0, separator), input.slice(separator + 1)];
}

function parseSinglePath(input: string, allowTabSuffix: boolean): string {
  if (input.startsWith('"')) {
    const parsed = parseQuotedPath(input);
    const suffix = input.slice(parsed.end);
    if (suffix.length !== 0 && !(allowTabSuffix && suffix.startsWith('\t'))) {
      return validationError('malformed-patch', 'Unexpected text after quoted path');
    }
    return parsed.value;
  }
  const tab = allowTabSuffix ? input.indexOf('\t') : -1;
  const path = tab === -1 ? input : input.slice(0, tab);
  if (path.length === 0) {
    return validationError('malformed-patch', 'Patch path is empty');
  }
  return path;
}

function isPlatformAbsolute(path: string): boolean {
  return isAbsolute(path)
    || /^[a-z]:[\\/]/i.test(path)
    || /^[\\/]{2}/.test(path);
}

function normalizePath(rawPath: string, surface: PathSurface): string | null {
  const mayBeNull = surface === 'old-marker' || surface === 'new-marker';
  if (rawPath === '/dev/null') {
    if (!mayBeNull) {
      return validationError('unsafe-path', '/dev/null is only valid in file markers');
    }
    return null;
  }
  if (isPlatformAbsolute(rawPath)) {
    return validationError('unsafe-path', 'Absolute patch paths are forbidden');
  }
  if (rawPath.includes('\\')) {
    return validationError('unsafe-path', 'Backslashes in patch paths are forbidden');
  }
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    return validationError('malformed-patch', 'Control characters in patch paths are forbidden');
  }
  if (rawPath.split('/').some((component) => component === '..')) {
    return validationError('unsafe-path', 'Patch path traversal is forbidden');
  }

  let path = rawPath;
  if (surface === 'diff-old' || surface === 'old-marker') {
    if (!path.startsWith('a/')) {
      return validationError('malformed-patch', 'Old patch path must use the a/ prefix');
    }
    path = path.slice(2);
  } else if (surface === 'diff-new' || surface === 'new-marker') {
    if (!path.startsWith('b/')) {
      return validationError('malformed-patch', 'New patch path must use the b/ prefix');
    }
    path = path.slice(2);
  }
  if (isPlatformAbsolute(path) || /^[a-z]:/i.test(path)) {
    return validationError('unsafe-path', 'Absolute patch paths are forbidden');
  }

  const components = path.split('/');
  if (
    path.length === 0
    || components.some((component) => component.length === 0 || component === '.')
    || path.normalize('NFC') !== path
  ) {
    return validationError('malformed-patch', 'Patch path is malformed or ambiguous');
  }
  if (components.some((component) => component.toLowerCase() === '.git')) {
    return validationError('unsafe-path', 'Patch paths may not address Git metadata');
  }
  return path;
}

function addPath(
  paths: Set<string>,
  rawPath: string,
  surface: PathSurface,
): string | null {
  const normalized = normalizePath(rawPath, surface);
  if (normalized !== null) paths.add(normalized);
  return normalized;
}

function validateMode(mode: string): void {
  if (!REGULAR_FILE_MODES.has(mode)) {
    validationError('unsupported-mode', `Unsupported patch file mode ${mode}`);
  }
}

function finishSection(section: PatchSection | null): void {
  if (section === null) return;
  if (section.inHunk) {
    validationError('malformed-patch', 'Patch hunk ended before its declared line counts');
  }
  if (!section.hasOperation) {
    validationError('malformed-patch', 'Patch section has no operation');
  }
  if ((section.oldMarker === undefined) !== (section.newMarker === undefined)) {
    validationError('malformed-patch', 'Patch section has an incomplete file marker pair');
  }
  if (section.oldMarker === null && section.newMarker === null) {
    validationError('malformed-patch', '/dev/null cannot be both patch endpoints');
  }
  if ((section.oldMode === undefined) !== (section.newMode === undefined)) {
    validationError('unsupported-mode', 'Mode transitions require old and new modes');
  }
  if ((section.renameFrom === undefined) !== (section.renameTo === undefined)) {
    validationError('malformed-patch', 'Rename metadata requires both paths');
  }
  if ((section.copyFrom === undefined) !== (section.copyTo === undefined)) {
    validationError('malformed-patch', 'Copy metadata requires both paths');
  }
  if (section.newFileMode !== undefined && section.deletedFileMode !== undefined) {
    validationError('unsupported-mode', 'A patch cannot create and delete the same file');
  }
}

function newSection(): PatchSection {
  return {
    hasOperation: false,
    inHunk: false,
    hunkOldRemaining: 0,
    hunkNewRemaining: 0,
  };
}

function uniqueField(
  section: PatchSection,
  field: keyof PatchSection,
  value: string | null,
): void {
  if (section[field] !== undefined) {
    validationError('malformed-patch', `Duplicate patch metadata: ${String(field)}`);
  }
  (section as Record<keyof PatchSection, unknown>)[field] = value;
}

/**
 * Validates untrusted marketplace patch bytes without accessing the filesystem.
 *
 * Paths are returned in deterministic repository-relative order for a caller's
 * Human/CODEOWNER policy gate. Passing validation does not imply that the patch
 * applies to any particular checkout; that is the worktree operation's job.
 */
export function validateMarketplacePatch(
  artifact: Uint8Array,
): ValidatedMarketplacePatch {
  if (artifact.byteLength > MAX_MARKETPLACE_PATCH_BYTES) {
    validationError('artifact-too-large', 'Marketplace patch exceeds 2 MiB');
  }
  if (artifact.includes(0)) {
    validationError('nul-byte', 'Marketplace patch contains a NUL byte');
  }

  const patch = decodeUtf8(artifact, 'Marketplace patch');
  const lines = patch.split('\n').map((line) => (
    line.endsWith('\r') ? line.slice(0, -1) : line
  ));
  const paths = new Set<string>();
  let section: PatchSection | null = null;
  let sectionCount = 0;

  for (const line of lines) {
    if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) {
      validationError('binary-patch', 'Binary patches are forbidden');
    }
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ') || line.startsWith('@@@')) {
      validationError('malformed-patch', 'Combined diffs are unsupported');
    }
    if (line.startsWith('diff --git ')) {
      finishSection(section);
      const [oldPath, newPath] = parseDiffPathPair(line.slice('diff --git '.length));
      addPath(paths, oldPath, 'diff-old');
      addPath(paths, newPath, 'diff-new');
      section = newSection();
      sectionCount += 1;
      continue;
    }
    if (line.startsWith('--- ') && (section === null || section.oldMarker !== undefined)) {
      finishSection(section);
      section = newSection();
      sectionCount += 1;
    }
    if (section === null) continue;
    if (line.startsWith('@@')) {
      const match = HUNK_HEADER_PATTERN.exec(line);
      if (match === null || section.inHunk) {
        validationError('malformed-patch', 'Malformed unified diff hunk header');
      }
      section.hunkOldRemaining = Number.parseInt(match[1] ?? '1', 10);
      section.hunkNewRemaining = Number.parseInt(match[2] ?? '1', 10);
      section.inHunk =
        section.hunkOldRemaining > 0 || section.hunkNewRemaining > 0;
      section.hasOperation = true;
      continue;
    }
    if (section.inHunk) {
      if (line === '\\ No newline at end of file') continue;
      const prefix = line[0];
      if (prefix === ' ') {
        if (section.hunkOldRemaining === 0 || section.hunkNewRemaining === 0) {
          validationError('malformed-patch', 'Hunk context exceeds declared line counts');
        }
        section.hunkOldRemaining -= 1;
        section.hunkNewRemaining -= 1;
      } else if (prefix === '-') {
        if (section.hunkOldRemaining === 0) {
          validationError('malformed-patch', 'Hunk deletion exceeds declared line count');
        }
        section.hunkOldRemaining -= 1;
      } else if (prefix === '+') {
        if (section.hunkNewRemaining === 0) {
          validationError('malformed-patch', 'Hunk addition exceeds declared line count');
        }
        section.hunkNewRemaining -= 1;
      } else {
        validationError('malformed-patch', 'Malformed unified diff hunk body');
      }
      section.inHunk =
        section.hunkOldRemaining > 0 || section.hunkNewRemaining > 0;
      continue;
    }

    if (line.startsWith('--- ')) {
      const normalized = addPath(
        paths,
        parseSinglePath(line.slice(4), true),
        'old-marker',
      );
      uniqueField(section, 'oldMarker', normalized);
      section.hasOperation = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const normalized = addPath(
        paths,
        parseSinglePath(line.slice(4), true),
        'new-marker',
      );
      uniqueField(section, 'newMarker', normalized);
      section.hasOperation = true;
      continue;
    }
    if (
      line.startsWith('old mode ')
      || line.startsWith('new mode ')
      || line.startsWith('new file mode ')
      || line.startsWith('deleted file mode ')
    ) {
      const match = MODE_LINE_PATTERN.exec(line);
      if (match === null) {
        validationError('malformed-patch', 'Malformed patch mode line');
      }
      const label = match[1]!;
      const mode = match[2]!;
      validateMode(mode);
      const field = label === 'old mode'
        ? 'oldMode'
        : label === 'new mode'
          ? 'newMode'
          : label === 'new file mode'
            ? 'newFileMode'
            : 'deletedFileMode';
      uniqueField(section, field, mode);
      section.hasOperation = true;
      continue;
    }
    if (line.startsWith('index ')) {
      const match = INDEX_LINE_PATTERN.exec(line);
      if (match === null) {
        validationError('malformed-patch', 'Malformed patch index line');
      }
      if (match[1] !== undefined) validateMode(match[1]);
      section.hasOperation = true;
      continue;
    }
    const pathMetadata = [
      ['rename from ', 'renameFrom'],
      ['rename to ', 'renameTo'],
      ['copy from ', 'copyFrom'],
      ['copy to ', 'copyTo'],
    ] as const;
    const matched = pathMetadata.find(([prefix]) => line.startsWith(prefix));
    if (matched !== undefined) {
      const [prefix, field] = matched;
      const path = addPath(
        paths,
        parseSinglePath(line.slice(prefix.length), false),
        'metadata',
      );
      if (path === null) {
        validationError('unsafe-path', '/dev/null is forbidden in path metadata');
      }
      uniqueField(section, field, path);
      section.hasOperation = true;
    }
  }

  finishSection(section);
  if (sectionCount === 0 || paths.size === 0) {
    validationError('malformed-patch', 'Artifact is not a Git unified diff');
  }
  return {
    byteLength: artifact.byteLength,
    touchedPaths: [...paths].sort((left, right) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  };
}

function worktreeValidationError(
  reason: MarketplacePatchWorktreeRejectionReason,
  message: string,
  cause?: unknown,
): never {
  throw new MarketplacePatchWorktreeValidationError(reason, message, cause);
}

function validateTouchedPathIndexModes(
  output: Uint8Array,
  touchedPaths: readonly string[],
): void {
  if (output.byteLength === 0) return;
  if (output[output.byteLength - 1] !== 0) {
    worktreeValidationError(
      'malformed-index-output',
      'Git index inspection output is not NUL-terminated',
    );
  }

  let decoded: string;
  try {
    decoded = textDecoder.decode(output);
  } catch {
    return worktreeValidationError(
      'malformed-index-output',
      'Git index inspection output is not valid UTF-8',
    );
  }
  const expected = new Set(touchedPaths);
  const observed = new Set<string>();
  const records = decoded.slice(0, -1).split('\0');
  for (const record of records) {
    const match = INDEX_STAGE_RECORD_PATTERN.exec(record);
    if (match === null) {
      worktreeValidationError(
        'malformed-index-output',
        'Git index inspection returned a malformed stage record',
      );
    }
    const mode = match[1]!;
    const stage = match[3]!;
    const path = match[4]!;
    if (!REGULAR_FILE_MODES.has(mode)) {
      worktreeValidationError(
        'unsafe-existing-mode',
        `Touched path has unsupported existing index mode ${mode}: ${path}`,
      );
    }
    if (stage !== '0' || !expected.has(path) || observed.has(path)) {
      worktreeValidationError(
        'malformed-index-output',
        'Git index inspection returned an unexpected or duplicate path',
      );
    }
    observed.add(path);
  }
}

export const defaultMarketplacePatchGitRunner: MarketplacePatchGitRunner = (
  command,
  args,
  options,
) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let settled = false;
  const rejectOnce = (error: unknown): void => {
    if (settled) return;
    settled = true;
    reject(error);
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > 8 * 1024 * 1024) {
      child.kill();
      rejectOnce(new Error('Git command output exceeded safety limit'));
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = 64 * 1024 - stderrBytes;
    if (remaining <= 0) return;
    const retained = chunk.subarray(0, remaining);
    stderrChunks.push(retained);
    stderrBytes += retained.byteLength;
  });
  child.on('error', rejectOnce);
  child.stdin.on('error', rejectOnce);
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    if (code === 0) {
      resolve(Buffer.concat(stdoutChunks));
      return;
    }
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    reject(new Error(`git exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`));
  });
  child.stdin.end(Buffer.from(options.stdin));
});

export interface ApplyMarketplacePatchInput {
  readonly artifact: Uint8Array;
  /**
   * Absolute path to a trusted, existing worktree. The caller owns exclusive
   * mutation of both its index and filesystem state until this promise settles.
   * The function uses one immutable artifact snapshot and adjacent index-mode
   * inspection/check/apply calls, but Git offers no cross-process lock that can
   * eliminate unrelated index or worktree races.
   */
  readonly worktreePath: string;
  readonly runGit?: MarketplacePatchGitRunner;
}

/**
 * Validates, checks, and applies one marketplace patch to a trusted worktree.
 *
 * Index modes for every touched path are inspected without following filesystem
 * symlinks. That inspection and `git apply --check` always complete before
 * plain `git apply` is invoked. Neither apply invocation uses a patch filename
 * or `--3way`; byte-identical copies of the validated snapshot are sent over
 * stdin.
 */
export async function applyMarketplacePatchToWorktree(
  input: ApplyMarketplacePatchInput,
): Promise<ValidatedMarketplacePatch> {
  const snapshot = Uint8Array.from(input.artifact);
  const validated = validateMarketplacePatch(snapshot);
  if (
    input.worktreePath.length === 0
    || !isAbsolute(input.worktreePath)
    || /[\u0000\r\n]/.test(input.worktreePath)
  ) {
    throw new MarketplacePatchApplicationError(
      'invalid-worktree-path',
      'Marketplace patch worktree path must be an absolute trusted path',
    );
  }

  const runGit = input.runGit ?? defaultMarketplacePatchGitRunner;
  let indexOutput: Uint8Array;
  try {
    indexOutput = await runGit(
      'git',
      [
        '--literal-pathspecs',
        'ls-files',
        '--stage',
        '-z',
        '--',
        ...validated.touchedPaths,
      ],
      {
        cwd: input.worktreePath,
        stdin: new Uint8Array(),
      },
    );
  } catch (error) {
    throw new MarketplacePatchWorktreeValidationError(
      'git-index-inspection-failed',
      'Marketplace patch could not inspect touched index modes',
      error,
    );
  }
  validateTouchedPathIndexModes(indexOutput, validated.touchedPaths);

  try {
    await runGit('git', ['apply', '--check'], {
      cwd: input.worktreePath,
      stdin: Uint8Array.from(snapshot),
    });
  } catch (error) {
    throw new MarketplacePatchCheckError(error);
  }
  try {
    await runGit('git', ['apply'], {
      cwd: input.worktreePath,
      stdin: Uint8Array.from(snapshot),
    });
  } catch (error) {
    throw new MarketplacePatchApplicationError(
      'git-apply-failed',
      'Marketplace patch failed git apply',
      error,
    );
  }
  return validated;
}
