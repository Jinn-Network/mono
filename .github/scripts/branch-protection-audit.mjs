#!/usr/bin/env node

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDITED_BRANCHES = ['integration/evidence-v1', 'next', 'main'];
export const AUDITED_USERNAMES = ['oaksprout', 'ritsukai'];
export const REQUIRED_CONTEXTS = ['platform-architecture-control', 'platform-verification'];
export const AUDITED_REPOSITORY = 'Jinn-Network/mono';

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

function validateProtection(branch, protection) {
  const review = protection?.required_pull_request_reviews;
  if (!review || !Number.isInteger(review.required_approving_review_count) || review.required_approving_review_count < 1) {
    throw new Error(`${branch}: at least one approving review is required`);
  }
  if (review.require_code_owner_reviews !== true) throw new Error(`${branch}: code-owner reviews are not required`);
  if (review.dismiss_stale_reviews !== true) throw new Error(`${branch}: stale approvals are not dismissed`);
  const bypass = review.bypass_pull_request_allowances;
  if (bypass === null || typeof bypass !== 'object' || Array.isArray(bypass)) {
    throw new Error(`${branch}: review bypass allowances must be an object`);
  }
  for (const kind of ['users', 'teams', 'apps']) {
    const allowances = bypass[kind];
    if (!Object.hasOwn(bypass, kind) || !Array.isArray(allowances) || allowances.length !== 0) {
      throw new Error(`${branch}: ${kind} review bypass allowances must be empty arrays`);
    }
  }
  const statusChecks = protection?.required_status_checks;
  const contexts = new Set([
    ...(statusChecks?.contexts ?? []),
    ...(statusChecks?.checks ?? []).map((check) => check.context),
  ]);
  for (const context of REQUIRED_CONTEXTS) {
    if (!contexts.has(context)) throw new Error(`${branch}: required status context ${context} is missing`);
  }
  if (protection?.allow_force_pushes?.enabled !== false) throw new Error(`${branch}: force pushes must be disabled`);
  if (protection?.enforce_admins?.enabled !== true) throw new Error(`${branch}: administrator enforcement must be enabled`);
  return {
    branch,
    approvingReviews: review.required_approving_review_count,
    codeOwnerReviews: true,
    dismissStaleReviews: true,
    requiredContexts: [...contexts].sort(),
    forcePushes: false,
    enforceAdmins: true,
    bypassAllowances: { apps: 0, teams: 0, users: 0 },
  };
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
  for (const branch of AUDITED_BRANCHES) {
    try {
      const response = await request(
        'GET',
        `/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`,
      );
      branches.push({
        ...validateProtection(branch, requireSuccess(response, `${branch} protection`)),
        compliant: true,
      });
    } catch (error) {
      const message = error?.message ?? String(error);
      branches.push({ branch, compliant: false, error: message });
      errors.push(message);
    }
  }
  const report = {
    version: 1,
    repository,
    requiredContexts: REQUIRED_CONTEXTS,
    owners,
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

export function formatAuditSummary(report) {
  const lines = [
    '# Platform architecture policy audit',
    '',
    `Repository: ${report.repository}`,
    '',
    '| Branch | Approvals | Code owners | Stale dismissed | Force pushes | Admins |',
    '| --- | ---: | --- | --- | --- | --- |',
  ];
  for (const branch of report.branches) {
    lines.push(branch.compliant
      ? `| ${branch.branch} | ${branch.approvingReviews} | required | yes | disabled | enforced |`
      : `| ${branch.branch} | drift | drift | drift | drift | drift |`);
  }
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
