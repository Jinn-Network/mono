/**
 * One solver attempt = one `claude -p` subprocess with WebSearch.
 *
 * This is the same execution shape Jinn's Claude harnesses already use
 * (`operator/src/runner/claude.ts`, `harnesses/impls/learner` adapters):
 * spawn the Claude CLI headless, hand it a task, read a structured payload
 * back. Here it is stripped to the minimum an experiment needs — no MCP
 * server, no daemon, no chain — so the only thing under test is the solver
 * layer.
 */

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_SYSTEM_PROMPT, STRATEGIES } from './strategies.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
const SCHEMA = readFileSync(join(ROOT, 'schema/solver-output.schema.json'), 'utf8');
const GUARD = join(ROOT, 'hooks/websearch-guard.mjs');

/** Settings JSON handed to the subprocess: WebSearch only, guarded. */
function settingsJson() {
  return JSON.stringify({
    permissions: { allow: ['WebSearch'], deny: ['WebFetch', 'Bash', 'Read', 'Write', 'Edit'] },
    hooks: {
      PreToolUse: [
        // Guard path is double-quoted for the shell: worktree paths can carry
        // spaces and apostrophes (e.g. .../life's-work/...).
        { matcher: 'WebSearch', hooks: [{ type: 'command', command: `node "${GUARD}"` }] },
      ],
    },
  });
}

/**
 * Solver-visible prompt. Contains exactly the question, its criteria and the
 * cut-off. Never the ground truth, the source of the ground truth, the dispute
 * history, or anything else from the truth file.
 *
 * Two dataset shapes are accepted:
 *   - the original synthetic benchmark  { claim, criteria, deadline }
 *   - the real-dispute benchmark        { question, resolution_criteria,
 *                                         cutoff_time, source_protocol,
 *                                         public_metadata }
 * `source_protocol` is deliberately NOT shown to the solver: naming the venue
 * would point straight at the settlement record we are trying to keep out.
 */
export function buildPrompt(claim) {
  const question = claim.question ?? claim.claim;
  const criteria = claim.resolution_criteria ?? claim.criteria ?? '';
  const cutoff = claim.cutoff_time ?? claim.deadline;
  const meta = claim.public_metadata ?? {};

  const lines = [`QUESTION: ${question}`, ''];
  if (String(criteria).trim()) {
    lines.push(`RESOLUTION CRITERIA: ${criteria}`, '');
  } else {
    lines.push(
      'RESOLUTION CRITERIA: none were published beyond the question itself. Resolve',
      'the question exactly as worded.',
      '',
    );
  }
  if (meta.outcomes) lines.push(`PERMITTED OUTCOMES: ${meta.outcomes}`, '');
  if (meta.template_type && meta.template_type !== 'bool') {
    lines.push(`ANSWER TYPE: ${meta.template_type}`, '');
  }

  if (claim.cutoff_time) {
    lines.push(
      `CUT-OFF: ${cutoff}`,
      '',
      'Answer as of the cut-off, on the evidence that existed at that time.',
      'Anything published after the cut-off is inadmissible, including any later',
      'account of how this question was eventually settled. Check the publication',
      'date of what you find and disregard what postdates the cut-off.',
    );
  } else {
    lines.push(`RESOLUTION DEADLINE: ${cutoff}`, '', 'The deadline has passed. Determine how this claim resolved.');
  }
  return lines.join('\n');
}

/**
 * Runs one attempt, retrying transient CLI/API failures. Retries are only for
 * infrastructure faults (proxy TLS hiccups, API overload) — a solver that
 * returns a valid answer is never re-rolled, so retries cannot bias the result.
 */
export async function runSolver(opts) {
  const retries = opts.retries ?? 2;
  let last;
  for (let i = 0; i <= retries; i += 1) {
    last = await runSolverOnce(opts);
    if (last.ok) return i === 0 ? last : { ...last, retried: i };
    if (i < retries) await new Promise((r) => setTimeout(r, 10_000 * (i + 1)));
  }
  return { ...last, retried: retries };
}

function runSolverOnce({
  claim,
  model,
  strategy = 'default',
  attemptId,
  auditLog,
  timeoutMs = 600_000,
}) {
  const strat = STRATEGIES[strategy];
  if (!strat) throw new Error(`unknown strategy: ${strategy}`);
  const systemPrompt = BASE_SYSTEM_PROMPT + '\n' + strat.suffix;

  mkdirSync(dirname(auditLog), { recursive: true });

  const args = [
    '-p',
    '--model', model,
    '--system-prompt', systemPrompt,
    '--tools', 'WebSearch',
    '--allowed-tools', 'WebSearch',
    '--setting-sources', '',
    '--no-session-persistence',
    '--settings', settingsJson(),
    '--json-schema', SCHEMA,
    '--output-format', 'json',
    buildPrompt(claim),
  ];

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: '/tmp',
      env: childEnv(auditLog, claim),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const wallMs = Date.now() - startedAt;
      const base = {
        attempt_id: attemptId,
        claim_id: claim.id,
        model,
        strategy,
        wall_ms: wallMs,
        exit_code: code,
      };
      let meta;
      try {
        meta = JSON.parse(out);
      } catch {
        return resolve({ ...base, ok: false, error: `unparseable CLI output: ${err.slice(0, 500) || out.slice(0, 500)}` });
      }
      const modelUsage = meta.modelUsage ?? {};
      const usage = {
        cost_usd: meta.total_cost_usd ?? null,
        input_tokens: sumUsage(modelUsage, 'inputTokens'),
        output_tokens: sumUsage(modelUsage, 'outputTokens'),
        cache_read_tokens: sumUsage(modelUsage, 'cacheReadInputTokens'),
        cache_creation_tokens: sumUsage(modelUsage, 'cacheCreationInputTokens'),
        web_search_requests: sumUsage(modelUsage, 'webSearchRequests'),
        num_turns: meta.num_turns ?? null,
        api_ms: meta.duration_api_ms ?? null,
      };
      const denials = (meta.permission_denials ?? []).map((d) => ({
        tool: d.tool_name,
        input: d.tool_input,
      }));

      if (meta.is_error) {
        return resolve({ ...base, ok: false, usage, denials, error: String(meta.result ?? 'CLI reported error') });
      }
      let payload;
      try {
        payload = JSON.parse(meta.result);
      } catch {
        return resolve({ ...base, ok: false, usage, denials, error: `unparseable solver payload: ${String(meta.result).slice(0, 400)}` });
      }
      resolve({ ...base, ok: true, usage, denials, output: payload });
    });
  });
}

/**
 * Parent-session identifiers are stripped so the solver starts clean, and the
 * leakage guard is handed the question title (to refuse near-verbatim searches)
 * and the cut-off (recorded in the audit log).
 */
function childEnv(auditLog, claim) {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_SESSION_ID']) delete env[k];
  env.JINN_CR_AUDIT_LOG = auditLog;
  env.JINN_CR_QUESTION_TITLE = claim?.question ?? claim?.claim ?? '';
  env.JINN_CR_CUTOFF = claim?.cutoff_time ?? claim?.deadline ?? '';
  env.CLAUDE_CODE_ENTRYPOINT = 'jinn-claim-resolution-experiment';
  return env;
}

function sumUsage(modelUsage, key) {
  return Object.values(modelUsage).reduce((acc, v) => acc + (v?.[key] ?? 0), 0);
}
