#!/usr/bin/env node
// Structural + frontmatter validator for the default-learner plugin.
// Fails (exit 1) on any error; prints each finding.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_SKILLS = [
  'coordinator',
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
];

const REQUIRED_AGENTS = [
  'explorer',
  'strategist',
  'planner',
  'step-worker',
  'analyst',
  'promoter',
  'consolidator',
];

const REQUIRED_FRONTMATTER = ['name', 'description', 'allowed-tools'];

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

let errors = 0;

function check(predicate, message) {
  if (!predicate) {
    console.error(message);
    errors++;
  }
}

// Skills
for (const name of REQUIRED_SKILLS) {
  const skillFile = join(PLUGIN_ROOT, 'skills', name, 'SKILL.md');
  let text;
  try {
    text = readFileSync(skillFile, 'utf8');
  } catch {
    console.error(`MISSING: ${skillFile}`);
    errors++;
    continue;
  }
  const fm = parseFrontmatter(text);
  if (!fm) {
    console.error(`NO_FRONTMATTER: ${skillFile}`);
    errors++;
    continue;
  }
  for (const f of REQUIRED_FRONTMATTER) {
    check(fm[f], `MISSING_FIELD ${f}: ${skillFile}`);
  }
  check(fm.name === name, `NAME_MISMATCH: ${skillFile} has name="${fm.name}", expected "${name}"`);
}

// Agents
for (const name of REQUIRED_AGENTS) {
  const agentFile = join(PLUGIN_ROOT, 'agents', `${name}.md`);
  let text;
  try {
    text = readFileSync(agentFile, 'utf8');
  } catch {
    console.error(`MISSING: ${agentFile}`);
    errors++;
    continue;
  }
  const fm = parseFrontmatter(text);
  if (!fm) {
    console.error(`NO_FRONTMATTER: ${agentFile}`);
    errors++;
    continue;
  }
  for (const f of REQUIRED_FRONTMATTER) {
    check(fm[f], `MISSING_FIELD ${f}: ${agentFile}`);
  }
  check(fm.name === name, `NAME_MISMATCH: ${agentFile} has name="${fm.name}", expected "${name}"`);
}

// Hook
const hookFile = join(PLUGIN_ROOT, 'hooks', 'session-start.sh');
try {
  const stat = statSync(hookFile);
  check((stat.mode & 0o100) !== 0, `NOT_EXECUTABLE: ${hookFile}`);
} catch {
  console.error(`MISSING: ${hookFile}`);
  errors++;
}

// Loader files
for (const f of ['CLAUDE.md', 'AGENTS.md', 'README.md']) {
  try {
    statSync(join(PLUGIN_ROOT, f));
  } catch {
    console.error(`MISSING: ${join(PLUGIN_ROOT, f)}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n${errors} error(s)`);
  process.exit(1);
}
console.log(`OK — ${REQUIRED_SKILLS.length} skills, ${REQUIRED_AGENTS.length} agents, hook + loaders validated`);
