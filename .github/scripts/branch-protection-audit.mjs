#!/usr/bin/env node

// Reads the live protection posture of `next` and `main` and fails on drift
// from DR-2026-08-18-b (log/decisions/2026-08-18-merge-queue-on-next.md).
//
// WHY RULESETS, NOT CLASSIC PROTECTION: this repository protects its branches
// with repository rulesets. The classic `/branches/{branch}/protection`
// endpoint this script used to read is not populated by rulesets, so it
// reported "no protection" against a repository that was in fact protected —
// and it could never see the `merge_queue` rule at all, which is repo-ruleset
// only. Three GET endpoints replace it:
//
//   GET /repos/{repo}/rulesets              — which rulesets exist
//   GET /repos/{repo}/rulesets/{id}         — enforcement, conditions, bypass_actors
//   GET /repos/{repo}/rules/branches/{ref}  — the rules in EFFECT on a branch,
//                                             each attributed to its ruleset_id
//
// The effective-rules endpoint is what makes per-branch expectations honest: it
// answers "what actually applies here", however many rulesets contribute. The
// detail endpoint supplies the two facts effective rules omit and D2 makes
// load-bearing — `enforcement` and `bypass_actors`.
//
// PER-BRANCH EXPECTATIONS (DR-2026-08-18-b D2/D5) — the two branches are
// deliberately asymmetric, which is why the old uniform validator is gone:
//
//   `next` is the queue's branch. It carries the pull-request rule with
//   dismiss-stale-on-push, the ten required contexts, the `merge_queue` rule at
//   the D5 constants, deletion and non-fast-forward — and its supplying
//   rulesets carry EMPTY bypass_actors. A queue with a standing bypass hole
//   protects against everything except the untested push that motivated it.
//
//   `main` stays outside the queue. It keeps its pull-request rule, deletion
//   and non-fast-forward, and gains `Main base guard` as a required context
//   (ported here from the retired classic-API enable script). Its supplying
//   ruleset RETAINS the admin bypass actor: `promote-main.yml` pushes the
//   Monday fast-forward through it, so the audit asserts that bypass is
//   PRESENT rather than absent.
//
// A repo-wide expectation rides alongside: some active ruleset must restrict
// creation of `refs/heads/gh-readonly-queue/**`, so nobody but the queue can
// forge a ref that the required checks would then attest — and that ruleset
// must admit the merge-queue bot through its bypass list, because a guard with
// an empty bypass list wedges every enqueue instead of protecting anything.
//
// The required contexts are not restated here — they come from
// `required-check-set.mjs`, the same source `enable-next-merge-queue.sh` reads
// through `--print-contexts`. A context this script demanded that no workflow
// reports would hang every queue entry until the check-response timeout.
//
// The report is deterministic by construction (no timestamps, sorted
// collections): the scheduled audit uploads it as evidence, and evidence you
// cannot diff across runs is not evidence.

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requiredContexts } from './required-check-set.mjs';

export const AUDITED_BRANCHES = ['next', 'main'];
export const AUDITED_USERNAMES = ['oaksprout', 'ritsukai'];
export const AUDITED_REPOSITORY = 'Jinn-Network/mono';

// The `next` required set, read from the single source of truth.
export const REQUIRED_CONTEXTS = Object.freeze(requiredContexts());

// `main`'s required set is its own, much smaller thing: the base guard that
// keeps non-hotfix, non-release-review PRs off `main`.
export const MAIN_REQUIRED_CONTEXTS = Object.freeze(['Main base guard']);

// DR-2026-08-18-b D5. Declared in key order so drift complaints are stable.
export const QUEUE_CONFIGURATION = Object.freeze({
  check_response_timeout_minutes: 180,
  grouping_strategy: 'ALLGREEN',
  max_entries_to_build: 2,
  max_entries_to_merge: 1,
  merge_method: 'MERGE',
  min_entries_to_merge: 1,
});

// GitHub's built-in repository-admin role. `promote-main.yml` depends on it.
export const MAIN_ADMIN_BYPASS = Object.freeze({
  actorId: 5,
  actorType: 'RepositoryRole',
  bypassMode: 'always',
});

export const QUEUE_REF_PATTERN = 'refs/heads/gh-readonly-queue/**';

const NEXT_RULE_TYPES = Object.freeze([
  'pull_request',
  'required_status_checks',
  'merge_queue',
  'deletion',
  'non_fast_forward',
]);

const MAIN_RULE_TYPES = Object.freeze([
  'pull_request',
  'required_status_checks',
  'deletion',
  'non_fast_forward',
]);

export function createReadOnlyRequest({ token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!token) throw new Error('a GitHub read token is required');
  return async (method, path) => {
    if (method !== 'GET') throw new Error(`read-only GitHub client permits GET only, received ${method}`);
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data };
  };
}

function requireSuccess(response, label) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label}: GitHub GET returned ${response.status}`);
  }
  return response.data;
}

function sortedStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string'))].sort();
}

function actorKey(actor) {
  return `${actor.actorType ?? ''}:${String(actor.actorId ?? '')}:${actor.bypassMode ?? ''}`;
}

function describeRuleset(id, detail) {
  return {
    id,
    name: typeof detail?.name === 'string' ? detail.name : '(unnamed)',
    enforcement: typeof detail?.enforcement === 'string' ? detail.enforcement : 'unknown',
    readable: true,
    refPatterns: sortedStrings(detail?.conditions?.ref_name?.include),
    ruleTypes: sortedStrings((detail?.rules ?? []).map((rule) => rule?.type)),
    bypassActors: (detail?.bypass_actors ?? [])
      .map((actor) => ({
        actorId: actor?.actor_id ?? null,
        actorType: actor?.actor_type ?? null,
        bypassMode: actor?.bypass_mode ?? null,
      }))
      .sort((left, right) => actorKey(left).localeCompare(actorKey(right))),
  };
}

function unreadableRuleset(id) {
  return {
    id,
    name: '(unreadable)',
    enforcement: 'unknown',
    readable: false,
    refPatterns: [],
    ruleTypes: [],
    bypassActors: [],
  };
}

async function readRulesets(repository, request) {
  const listing = requireSuccess(await request('GET', `/repos/${repository}/rulesets`), 'ruleset listing');
  if (!Array.isArray(listing)) throw new Error('ruleset listing: GitHub did not return a list of rulesets');
  const ids = [...new Set(listing.map((entry) => Number(entry?.id)).filter((id) => Number.isInteger(id)))]
    .sort((left, right) => left - right);
  const rulesets = new Map();
  for (const id of ids) {
    const detail = requireSuccess(await request('GET', `/repos/${repository}/rulesets/${id}`), `ruleset ${id}`);
    rulesets.set(id, describeRuleset(id, detail));
  }
  return rulesets;
}

// Pure read of the effective-rules payload. Every expectation below consumes
// these facts, so "what the branch has" and "what the branch owes" stay
// separable — and a drifted branch still reports its real posture.
//
// EVERY supplier of a type is collected, not the first one. Reading only the
// first made a SECOND ruleset contributing rules to the same branch invisible —
// including one carrying a standing admin bypass, which is the precise hole D2
// exists to close. So: required contexts are UNIONED across suppliers (that is
// what the branch actually owes), and the supplying-ruleset set that the bypass
// and enforcement loops walk is the union of every contributing ruleset id.
function readBranchFacts(branch, effectiveRules) {
  const byType = new Map();
  for (const rule of effectiveRules) {
    if (typeof rule?.type !== 'string') continue;
    if (!byType.has(rule.type)) byType.set(rule.type, []);
    byType.get(rule.type).push(rule);
  }
  const rulesetIdsOf = (type) => [...new Set((byType.get(type) ?? [])
    .map((rule) => Number(rule?.ruleset_id))
    .filter((id) => Number.isInteger(id)))]
    .sort((left, right) => left - right);
  // Scalar parameters cannot be unioned, so they are read from the first
  // supplier in API order — and `expectSingleSupplier` below reports the
  // multiplicity itself as drift, so the ambiguity is never silent.
  const firstOf = (type) => byType.get(type)?.[0]?.parameters;
  const pull = firstOf('pull_request');
  const queue = firstOf('merge_queue');
  return {
    branch,
    ruleTypes: sortedStrings([...byType.keys()]),
    rules: {
      pull_request: byType.has('pull_request')
        ? {
          rulesetIds: rulesetIdsOf('pull_request'),
          approvals: Number.isInteger(pull?.required_approving_review_count)
            ? pull.required_approving_review_count
            : null,
          codeOwnerReview: pull?.require_code_owner_review === true,
          dismissStaleOnPush: pull?.dismiss_stale_reviews_on_push === true,
        }
        : null,
      required_status_checks: byType.has('required_status_checks')
        ? {
          rulesetIds: rulesetIdsOf('required_status_checks'),
          contexts: sortedStrings((byType.get('required_status_checks') ?? [])
            .flatMap((rule) => (rule?.parameters?.required_status_checks ?? []).map((check) => check?.context))),
        }
        : null,
      merge_queue: byType.has('merge_queue')
        ? {
          rulesetIds: rulesetIdsOf('merge_queue'),
          check_response_timeout_minutes: queue?.check_response_timeout_minutes ?? null,
          grouping_strategy: queue?.grouping_strategy ?? null,
          max_entries_to_build: queue?.max_entries_to_build ?? null,
          max_entries_to_merge: queue?.max_entries_to_merge ?? null,
          merge_method: queue?.merge_method ?? null,
          min_entries_to_merge: queue?.min_entries_to_merge ?? null,
        }
        : null,
      deletion: byType.has('deletion') ? { rulesetIds: rulesetIdsOf('deletion') } : null,
      non_fast_forward: byType.has('non_fast_forward') ? { rulesetIds: rulesetIdsOf('non_fast_forward') } : null,
    },
  };
}

function supplyingRulesets(facts, rulesets, types) {
  const ids = [...new Set(types.flatMap((type) => facts.rules[type]?.rulesetIds ?? []))]
    .sort((left, right) => left - right);
  return ids.map((id) => rulesets.get(id) ?? unreadableRuleset(id));
}

// `pull_request` and `merge_queue` carry scalar parameters that two rulesets can
// disagree about. Which one GitHub resolves to is not something an audit should
// guess, so more than one supplier is reported as drift in its own right.
function expectSingleSupplier(branch, facts, types, complaints) {
  for (const type of types) {
    const ids = facts.rules[type]?.rulesetIds ?? [];
    if (ids.length > 1) {
      complaints.push(`${branch}: ${ids.length} rulesets supply a ${type} rule (${ids.join(', ')}); exactly one must, or which parameters are in force is ambiguous`);
    }
  }
}

function expectPullRequestReviews(branch, pull, complaints, { dismissStale, genericApprovals }) {
  if (!pull) {
    complaints.push(`${branch}: no ruleset in effect supplies a pull_request rule`);
    return;
  }
  if (genericApprovals === 0) {
    if (pull.approvals !== 0) {
      complaints.push(`${branch}: pull_request requires ${String(pull.approvals)} approving reviews; exactly 0 is required`);
    }
  } else if (!Number.isInteger(pull.approvals) || pull.approvals < 1) {
    complaints.push(`${branch}: pull_request requires ${String(pull.approvals)} approving reviews; at least 1 is required`);
  }
  if (pull.codeOwnerReview !== true) complaints.push(`${branch}: pull_request does not require code-owner review`);
  if (dismissStale && pull.dismissStaleOnPush !== true) {
    complaints.push(`${branch}: pull_request does not dismiss stale reviews on push`);
  }
}

// Set EQUALITY, not containment. An extra context added in the UI is as bad as
// a missing one: nothing reports it, so every queue entry sits on an unreported
// check until the check-response timeout ejects it.
function expectRequiredContexts(branch, checks, expected, complaints) {
  if (!checks) {
    complaints.push(`${branch}: no ruleset in effect supplies a required_status_checks rule`);
    return;
  }
  const missing = expected.filter((context) => !checks.contexts.includes(context));
  if (missing.length > 0) complaints.push(`${branch}: required status contexts missing: ${missing.join(', ')}`);
  const unexpected = checks.contexts.filter((context) => !expected.includes(context));
  if (unexpected.length > 0) {
    complaints.push(`${branch}: unexpected required status contexts: ${unexpected.join(', ')}; a required context no workflow reports leaves every queue entry on an unreported check until the check-response timeout ejects it`);
  }
}

function expectRuleTypes(branch, facts, types, complaints) {
  for (const type of types) {
    if (!facts.rules[type]) complaints.push(`${branch}: no ruleset in effect supplies a ${type} rule`);
  }
}

function expectActiveRulesets(branch, supplying, complaints) {
  for (const ruleset of supplying) {
    if (!ruleset.readable) {
      complaints.push(`${branch}: ruleset ${String(ruleset.id)} supplies rules but could not be read`);
      continue;
    }
    if (ruleset.enforcement !== 'active') {
      complaints.push(`${branch}: ruleset ${String(ruleset.id)} (${ruleset.name}) enforcement is ${ruleset.enforcement}, not active`);
    }
  }
}

function evaluateNext(facts, rulesets) {
  const complaints = [];
  expectPullRequestReviews('next', facts.rules.pull_request, complaints, { dismissStale: true, genericApprovals: 0 });
  expectRequiredContexts('next', facts.rules.required_status_checks, REQUIRED_CONTEXTS, complaints);
  const queue = facts.rules.merge_queue;
  if (!queue) complaints.push('next: no ruleset in effect supplies a merge_queue rule');
  else {
    for (const [key, expected] of Object.entries(QUEUE_CONFIGURATION)) {
      if (queue[key] !== expected) {
        complaints.push(`next: merge_queue ${key} is ${String(queue[key])}; DR-2026-08-18-b D5 fixes it at ${String(expected)}`);
      }
    }
  }
  expectRuleTypes('next', facts, ['deletion', 'non_fast_forward'], complaints);
  expectSingleSupplier('next', facts, ['pull_request', 'merge_queue'], complaints);
  const supplying = supplyingRulesets(facts, rulesets, NEXT_RULE_TYPES);
  expectActiveRulesets('next', supplying, complaints);
  // D2: no actor retains direct push to `next`. A bypass actor on any ruleset
  // that supplies these rules is exactly the hole the queue exists to close.
  for (const ruleset of supplying) {
    if (ruleset.readable && ruleset.bypassActors.length > 0) {
      complaints.push(`next: ruleset ${String(ruleset.id)} (${ruleset.name}) carries ${String(ruleset.bypassActors.length)} bypass actor(s); the queue branch must have none`);
    }
  }
  return { supplying, complaints };
}

function evaluateMain(facts, rulesets) {
  const complaints = [];
  // Dismiss-stale is deliberately not asserted on `main`: D2 scopes it to the
  // queue branch, and the standing release-review PR would churn under it.
  expectPullRequestReviews('main', facts.rules.pull_request, complaints, { dismissStale: false });
  expectRequiredContexts('main', facts.rules.required_status_checks, MAIN_REQUIRED_CONTEXTS, complaints);
  expectRuleTypes('main', facts, ['deletion', 'non_fast_forward'], complaints);
  expectSingleSupplier('main', facts, ['pull_request', 'merge_queue'], complaints);
  const supplying = supplyingRulesets(facts, rulesets, MAIN_RULE_TYPES);
  expectActiveRulesets('main', supplying, complaints);
  // The admin bypass is asserted PRESENT, and asserted on EVERY ruleset
  // supplying the pull_request rule — that is the rule which would otherwise
  // refuse `promote-main.yml`'s Monday fast-forward push, and a second supplier
  // without the bypass refuses the push no matter what the first one allows.
  const gatingIds = facts.rules.pull_request?.rulesetIds ?? [];
  for (const gating of supplying.filter((ruleset) => gatingIds.includes(ruleset.id))) {
    if (!gating.readable) continue;
    const present = gating.bypassActors.some((actor) => (
      actor.actorId === MAIN_ADMIN_BYPASS.actorId
      && actor.actorType === MAIN_ADMIN_BYPASS.actorType
      && actor.bypassMode === MAIN_ADMIN_BYPASS.bypassMode
    ));
    if (!present) {
      complaints.push(`main: ruleset ${String(gating.id)} (${gating.name}) has lost the admin bypass actor (${MAIN_ADMIN_BYPASS.actorType} ${String(MAIN_ADMIN_BYPASS.actorId)}, ${MAIN_ADMIN_BYPASS.bypassMode}); promote-main.yml pushes through it`);
    }
  }
  return { supplying, complaints };
}

async function auditBranch({ repository, branch, request, rulesets }) {
  const response = await request('GET', `/repos/${repository}/rules/branches/${encodeURIComponent(branch)}`);
  const effective = requireSuccess(response, `${branch} effective rules`);
  if (!Array.isArray(effective)) throw new Error(`${branch}: effective branch rules did not return a list`);
  const facts = readBranchFacts(branch, effective);
  const { supplying, complaints } = branch === 'next'
    ? evaluateNext(facts, rulesets)
    : evaluateMain(facts, rulesets);
  return {
    ...facts,
    supplyingRulesets: supplying.map((ruleset) => ({
      id: ruleset.id,
      name: ruleset.name,
      enforcement: ruleset.enforcement,
      bypassActors: ruleset.bypassActors,
    })),
    compliant: complaints.length === 0,
    complaints,
  };
}

// GitHub patched the forgeable `gh-readonly-queue/**` ref hazard in 2025-08 by
// letting a ruleset restrict creation of those refs while still admitting the
// queue's own bot. Without it, anyone with push access can create a ref that
// the required contexts then attest.
//
// The bypass list is not optional decoration on this one: a guard WITHOUT the
// merge-queue bot in bypass stops the queue creating its own refs and wedges
// every enqueue. Presence alone is therefore not a green — the resolved actor
// is asserted and reported, so the misconfiguration is visible before it is
// operational.
function auditQueueRefGuard(rulesets) {
  const guards = [...rulesets.values()].filter((ruleset) => (
    ruleset.readable
    && ruleset.enforcement === 'active'
    && ruleset.refPatterns.includes(QUEUE_REF_PATTERN)
    && ruleset.ruleTypes.includes('creation')
  ));
  const complaints = [];
  for (const guard of guards) {
    if (guard.bypassActors.length === 0) {
      complaints.push(`ruleset ${String(guard.id)} (${guard.name}) restricts creation of ${QUEUE_REF_PATTERN} but carries no bypass actor; the merge queue cannot create its own refs and every enqueue wedges`);
    } else if (guard.bypassActors.length > 1) {
      complaints.push(`ruleset ${String(guard.id)} (${guard.name}) admits ${String(guard.bypassActors.length)} bypass actors on ${QUEUE_REF_PATTERN}; only the merge-queue bot may create those refs`);
    }
  }
  return {
    pattern: QUEUE_REF_PATTERN,
    present: guards.length > 0,
    rulesets: guards.map((ruleset) => ({
      id: ruleset.id,
      name: ruleset.name,
      bypassActors: ruleset.bypassActors,
    })),
    complaints,
  };
}

function describeActor(actor) {
  return `${String(actor.actorType)} ${String(actor.actorId)} ${String(actor.bypassMode)}`;
}

async function auditOwner(repository, username, request) {
  const user = await request('GET', `/users/${encodeURIComponent(username)}`);
  const profile = requireSuccess(user, `username ${username}`);
  if (typeof profile?.login !== 'string' || profile.login.toLowerCase() !== username) {
    throw new Error(`${username}: resolved GitHub login does not match the required current handle`);
  }
  const permission = await request(
    'GET',
    `/repos/${repository}/collaborators/${encodeURIComponent(username)}/permission`,
  );
  if (permission.status === 403) {
    return {
      username,
      resolved: true,
      collaborator: 'visibility-unavailable',
      eligible: false,
    };
  }
  if (permission.status === 404) throw new Error(`${username}: resolved username is not a visible repository collaborator`);
  requireSuccess(permission, `collaborator ${username}`);
  const level = permission.data?.permission;
  if (!['write', 'maintain', 'admin'].includes(level)) {
    throw new Error(`${username}: repository membership is visible but is not write-capable collaborator access`);
  }
  return {
    username,
    resolved: true,
    collaborator: true,
    permission: level,
  };
}

export async function auditRepositoryArchitecture({ repository, request }) {
  if (repository !== AUDITED_REPOSITORY) throw new Error(`repository must be exactly ${AUDITED_REPOSITORY}`);
  if (typeof request !== 'function') throw new Error('an injectable read request function is required');
  const owners = [];
  const branches = [];
  const errors = [];
  for (const username of AUDITED_USERNAMES) {
    try {
      const owner = await auditOwner(repository, username, request);
      owners.push(owner);
      if (owner.collaborator === 'visibility-unavailable') {
        errors.push(`${username}: collaborator visibility unavailable; write eligibility was not proven`);
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      owners.push({ username, resolved: false, collaborator: false, error: message });
      errors.push(message);
    }
  }
  // A ruleset-read failure is recorded, not thrown: every branch still gets
  // audited and reported, which is what makes the evidence artifact useful when
  // the API is only partly available.
  let rulesets = new Map();
  try {
    rulesets = await readRulesets(repository, request);
  } catch (error) {
    errors.push(error?.message ?? String(error));
  }
  for (const branch of AUDITED_BRANCHES) {
    try {
      const evaluation = await auditBranch({ repository, branch, request, rulesets });
      branches.push(evaluation);
      errors.push(...evaluation.complaints);
    } catch (error) {
      const message = error?.message ?? String(error);
      branches.push({ branch, compliant: false, error: message });
      errors.push(message);
    }
  }
  const queueRefGuard = auditQueueRefGuard(rulesets);
  if (!queueRefGuard.present) {
    errors.push(`no active ruleset restricts creation of ${QUEUE_REF_PATTERN}; queue refs are forgeable`);
  }
  errors.push(...queueRefGuard.complaints);
  const report = {
    version: 2,
    repository,
    requiredContexts: REQUIRED_CONTEXTS,
    mainRequiredContexts: MAIN_REQUIRED_CONTEXTS,
    queueConfiguration: QUEUE_CONFIGURATION,
    owners,
    rulesets: [...rulesets.values()],
    queueRefGuard,
    branches,
    errors,
  };
  if (errors.length > 0) {
    const error = new Error(`architecture policy drift:\n- ${errors.join('\n- ')}`);
    error.report = report;
    throw error;
  }
  return report;
}

function summarizeQueue(queue) {
  if (!queue) return 'absent';
  return [
    String(queue.merge_method),
    String(queue.grouping_strategy),
    `merge ${String(queue.max_entries_to_merge)}/${String(queue.min_entries_to_merge)}`,
    `build ${String(queue.max_entries_to_build)}`,
    `${String(queue.check_response_timeout_minutes)}m`,
  ].join(' ');
}

function branchRow(branch) {
  if (!branch.rules) return [branch.branch, 'unread', 'unread', 'unread', 'unread', 'unread', 'unread', 'unread'];
  const pull = branch.rules.pull_request;
  const checks = branch.rules.required_status_checks;
  const supplying = branch.supplyingRulesets ?? [];
  return [
    branch.branch,
    supplying.map((ruleset) => `${String(ruleset.id)} ${ruleset.name}`).join('; ') || 'none',
    pull ? String(pull.approvals) : 'absent',
    pull ? (pull.codeOwnerReview ? 'required' : 'not required') : 'absent',
    pull ? (pull.dismissStaleOnPush ? 'yes' : 'no') : 'absent',
    checks ? String(checks.contexts.length) : 'absent',
    summarizeQueue(branch.rules.merge_queue),
    String(supplying.reduce((total, ruleset) => total + ruleset.bypassActors.length, 0)),
  ];
}

export function formatAuditSummary(report) {
  const lines = [
    '# Platform architecture policy audit',
    '',
    `Repository: ${report.repository}`,
    '',
    '| Branch | Rulesets | Approvals | Code owners | Stale dismissed | Contexts | Merge queue | Bypass actors |',
    '| --- | --- | ---: | --- | --- | ---: | --- | ---: |',
  ];
  for (const branch of report.branches) lines.push(`| ${branchRow(branch).join(' | ')} |`);
  const guard = report.queueRefGuard;
  const guardCell = guard?.present
    ? guard.rulesets.map((ruleset) => {
      const bypass = (ruleset.bypassActors ?? []).map(describeActor).join(', ') || 'NO BYPASS ACTOR';
      return `${String(ruleset.id)} ${ruleset.name} (bypass: ${bypass})`;
    }).join('; ')
    : 'absent';
  lines.push('', `Queue-ref creation guard \`${guard?.pattern ?? QUEUE_REF_PATTERN}\`: ${guardCell}`);
  lines.push('', '| Owner | Resolved | Collaborator |', '| --- | --- | --- |');
  for (const owner of report.owners) lines.push(`| @${owner.username} | ${owner.resolved ? 'yes' : 'no'} | ${owner.collaborator} |`);
  if (report.errors.length > 0) lines.push('', '## Drift', '', ...report.errors.map((error) => `- ${error}`));
  return `${lines.join('\n')}\n`;
}

export async function runArchitectureAudit({ repository, request, out, summary }) {
  try {
    const report = await auditRepositoryArchitecture({ repository, request });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(summary, formatAuditSummary(report), 'utf8');
    return report;
  } catch (error) {
    if (error?.report) {
      writeFileSync(out, `${JSON.stringify(error.report, null, 2)}\n`, 'utf8');
      writeFileSync(summary, formatAuditSummary(error.report), 'utf8');
    }
    throw error;
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--repository' && value) { options.repository = value; index += 1; }
    else if (argv[index] === '--out' && value) { options.out = value; index += 1; }
    else if (argv[index] === '--summary' && value) { options.summary = value; index += 1; }
    else throw new Error(`unknown or incomplete argument ${argv[index]}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.out || !options.summary) throw new Error('--out and --summary are required');
  for (const path of [options.out, options.summary]) {
    if (!existsSync(dirname(resolve(path)))) throw new Error(`output directory does not exist: ${dirname(path)}`);
  }
  const request = createReadOnlyRequest({
    token: process.env.ARCHITECTURE_AUDIT_TOKEN ?? process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
  });
  await runArchitectureAudit({
    repository: options.repository ?? process.env.GITHUB_REPOSITORY,
    request,
    out: options.out,
    summary: options.summary,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`architecture policy audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
