import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ROOT = ['schemaVersion', 'phase', 'defaultPolicy', 'transitions'];
const REQUIRED_TRANSITION = [
  'id', 'owner', 'entryPoints', 'replacement', 'consumers', 'defaultMode', 'noNewUseGuard',
  'usageSignal', 'migration', 'sunsetCondition', 'deletionTest', 'targetPullRequest', 'status',
];
const DEFAULT_MODES = new Set(['legacy', 'native', 'explicit-only', 'not-applicable']);
const STATUSES = new Set(['planned', 'migrating', 'ready-for-deletion', 'deleted', 'blocked']);
// Only meaningful when status is 'deleted' (spec §7 human-gate rule): the PR that flips a
// transition to deleted must cite Class A evidence, never just the Class O counters that may
// have informed the decision. Kept out of REQUIRED_TRANSITION (unconditionally required) because
// it is conditionally required — see the status === 'deleted' check below.
const OPTIONAL_TRANSITION_FIELDS = ['evidenceCitation'];

function object(value, label, errors) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  return value;
}

function closed(record, required, label, errors, optional = []) {
  if (record === undefined) return;
  for (const field of required) {
    if (!Object.hasOwn(record, field)) errors.push(`${label} missing required field ${field}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) errors.push(`${label} has unknown field ${field}`);
  }
}

function nonEmptyString(value, label, errors) {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${label} must be a non-empty string`);
}

function nonEmptyUniqueStrings(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${label} must contain unique values`);
  value.forEach((item, index) => nonEmptyString(item, `${label}[${index}]`, errors));
}

function uniqueStrings(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${label} must contain unique values`);
  value.forEach((item, index) => nonEmptyString(item, `${label}[${index}]`, errors));
}

function repoPath(value, label, repoRoot, errors) {
  nonEmptyString(value, label, errors);
  if (typeof value !== 'string' || value.length === 0) return;
  if (isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) {
    errors.push(`${label} must be a normalized repository-relative path`);
    return;
  }
  if (!existsSync(resolve(repoRoot, ...value.split('/')))) errors.push(`${label} does not exist: ${value}`);
}

function nested(record, fields, label, errors) {
  const value = object(record, label, errors);
  closed(value, fields, label, errors);
  if (value !== undefined) for (const field of fields) nonEmptyString(value[field], `${label}.${field}`, errors);
  return value;
}

// usageSignal.sourceFile is a discrete, path-validated field (never embedded in prose) so a
// stale or renamed file cannot silently pass review the way `usageSignal.source` prose did.
function usageSignal(record, label, repoRoot, errors) {
  const fields = ['name', 'sourceFile', 'sourceDescription', 'zeroDefinition'];
  const value = object(record, label, errors);
  closed(value, fields, label, errors);
  if (value === undefined) return;
  nonEmptyString(value.name, `${label}.name`, errors);
  if (value.sourceFile === null) {
    // Static architecture inventory (no durable runtime counter) — nothing to path-check.
  } else if (typeof value.sourceFile !== 'string') {
    errors.push(`${label}.sourceFile must be a repository path or null`);
  } else {
    repoPath(value.sourceFile, `${label}.sourceFile`, repoRoot, errors);
  }
  nonEmptyString(value.sourceDescription, `${label}.sourceDescription`, errors);
  nonEmptyString(value.zeroDefinition, `${label}.zeroDefinition`, errors);
}

export function validateTransitionManifest(manifest, { repoRoot = process.cwd() } = {}) {
  const errors = [];
  const root = object(manifest, 'manifest', errors);
  closed(root, REQUIRED_ROOT, 'manifest', errors);
  if (root === undefined) return errors;
  if (root.schemaVersion !== 1) errors.push('manifest.schemaVersion must be 1');
  nonEmptyString(root.phase, 'manifest.phase', errors);
  nonEmptyString(root.defaultPolicy, 'manifest.defaultPolicy', errors);
  if (!Array.isArray(root.transitions) || root.transitions.length === 0) {
    errors.push('manifest.transitions must be a non-empty array');
    return errors;
  }

  const ids = new Set();
  root.transitions.forEach((candidate, index) => {
    const label = `manifest.transitions[${index}]`;
    const transition = object(candidate, label, errors);
    closed(transition, REQUIRED_TRANSITION, label, errors, OPTIONAL_TRANSITION_FIELDS);
    if (transition === undefined) return;
    nonEmptyString(transition.id, `${label}.id`, errors);
    if (typeof transition.id === 'string' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(transition.id)) {
      errors.push(`${label}.id must be lower-kebab-case`);
    }
    if (ids.has(transition.id)) errors.push(`${label}.id duplicates ${transition.id}`);
    ids.add(transition.id);
    nonEmptyString(transition.owner, `${label}.owner`, errors);
    nonEmptyUniqueStrings(transition.entryPoints, `${label}.entryPoints`, errors);
    if (Array.isArray(transition.entryPoints)) {
      transition.entryPoints.forEach((path, pathIndex) => {
        if (transition.status === 'deleted') {
          nonEmptyString(path, `${label}.entryPoints[${pathIndex}]`, errors);
          if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) {
            errors.push(`${label}.entryPoints[${pathIndex}] must be a normalized repository-relative path`);
          }
        } else {
          repoPath(path, `${label}.entryPoints[${pathIndex}]`, repoRoot, errors);
        }
      });
    }
    nonEmptyString(transition.replacement, `${label}.replacement`, errors);
    uniqueStrings(transition.consumers, `${label}.consumers`, errors);
    if (transition.status !== 'deleted' && Array.isArray(transition.consumers)
      && transition.consumers.length === 0) {
      errors.push(`${label}.consumers must be non-empty until the transition is deleted`);
    }
    if (!DEFAULT_MODES.has(transition.defaultMode)) errors.push(`${label}.defaultMode is invalid`);
    if (!STATUSES.has(transition.status)) errors.push(`${label}.status is invalid`);
    nonEmptyString(transition.targetPullRequest, `${label}.targetPullRequest`, errors);
    // Spec §7 human-gate rule: a PR that flips a row to `deleted` must cite Class A evidence in
    // its body, and that citation must resolve — Class O counters may inform the decision but may
    // never be the cited basis. `evidenceCitation` only means something at that moment, so it is
    // forbidden outside status 'deleted' rather than left as free-floating optional metadata.
    if (transition.status === 'deleted') {
      repoPath(transition.evidenceCitation, `${label}.evidenceCitation`, repoRoot, errors);
    } else if (Object.hasOwn(transition, 'evidenceCitation')) {
      errors.push(`${label}.evidenceCitation is only allowed when status is 'deleted'`);
    }

    const guard = nested(transition.noNewUseGuard, ['path', 'assertion'], `${label}.noNewUseGuard`, errors);
    if (guard !== undefined) repoPath(guard.path, `${label}.noNewUseGuard.path`, repoRoot, errors);
    usageSignal(transition.usageSignal, `${label}.usageSignal`, repoRoot, errors);
    nested(transition.migration, ['description', 'compatibility'], `${label}.migration`, errors);
    const sunset = object(transition.sunsetCondition, `${label}.sunsetCondition`, errors);
    closed(sunset, ['description', 'evidence'], `${label}.sunsetCondition`, errors);
    if (sunset !== undefined) {
      nonEmptyString(sunset.description, `${label}.sunsetCondition.description`, errors);
      nonEmptyUniqueStrings(sunset.evidence, `${label}.sunsetCondition.evidence`, errors);
    }
    const deletion = nested(transition.deletionTest, ['path', 'command'], `${label}.deletionTest`, errors);
    if (deletion !== undefined) repoPath(deletion.path, `${label}.deletionTest.path`, repoRoot, errors);
  });
  return errors;
}

export function loadAndValidateTransitionManifest(path, options) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateTransitionManifest(manifest, options);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return manifest;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error('usage: node transition-manifest.mjs <manifest.json> [...]');
  for (const path of paths) loadAndValidateTransitionManifest(resolve(path), { repoRoot });
}
