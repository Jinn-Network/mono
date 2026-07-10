/**
 * The distill LLM port — runs `jinn-skill-distill-prompt-v1` over one evidence
 * cluster via the `claude` CLI and returns a {@link DistillLLMOutput}
 * (spec/2026-07-06-distillation-v1.md §7). This is the model call that
 * `distillClusters` injects as `DistillDeps.distill`; the distiller itself owns
 * the downstream scrub / contamination / publish steps.
 *
 * The port is deliberately thin: it builds the model input (the versioned
 * distill prompt + a serialized view of the cluster), spawns `claude` in
 * non-interactive mode reading that input on stdin, and parses a strict
 * `{ name, description, body }` JSON object back out of stdout (tolerating a
 * leading/trailing prose wrapper the model may emit around it).
 *
 * Auth is ambient: the `claude` CLI resolves its own credentials (a logged-in
 * session, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` from the env). This
 * port never reads, sets, or manages a key — matching the daemon's other
 * `claude -p` call sites (`src/runner/claude.ts`, the claude-code adapter).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DistillCluster, DistillLLMOutput, MetaDistillLLMOutput } from './distill.js';
import type { MetaCluster } from './cluster.js';

/** Default `claude` executable (resolved from PATH), mirrors the daemon default. */
const DEFAULT_CLAUDE_PATH = 'claude';
/** Default `codex` executable (resolved from PATH), using the logged-in Codex CLI session. */
const DEFAULT_CODEX_PATH = 'codex';
/**
 * Default distiller model — the strongest available (opus-class), NOT the
 * daemon-wide cheap default (spec §5, v0.5). Distillation is offline, one-shot,
 * and cheap relative to the measurement run, and its quality is model-sensitive
 * — so it pins the best model. Overridable via `JINN_DISTILL_MODEL` at the CLI.
 */
export const DEFAULT_MODEL = 'claude-opus-4-8';
/** Default Codex distiller model for quality runs; override with `JINN_DISTILL_MODEL`. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';

/**
 * Default per-cluster subprocess deadline (#1534). A hung `claude`/`codex`
 * child would otherwise block a run forever — silently, since nothing prints
 * until the run completes. On expiry the child is killed and the cluster lands
 * in `errors[]`; the run continues. Override with `--cluster-timeout` /
 * `JINN_DISTILL_CLUSTER_TIMEOUT_S`.
 */
export const DEFAULT_CLUSTER_TIMEOUT_MS = 600_000;

/** A distiller subprocess exceeded its per-cluster deadline and was killed. */
export class DistillTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label}: distiller subprocess timed out after ${timeoutMs}ms and was killed`);
    this.name = 'DistillTimeoutError';
  }
}

const DISTILL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'body'],
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 1 },
  },
} as const;

const META_DISTILL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'body', 'supports'],
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 1 },
    supports: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
  },
} as const;

/**
 * The subset of `node:child_process` a spawned child exposes that this port
 * uses. Injected so tests capture the args + feed canned stdout without ever
 * spawning a real `claude`.
 */
export interface ChildLike {
  stdin: { write(chunk: string): void; end(): void } | null;
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** Optional so pre-#1534 test fakes stay valid; real children always have it. */
  kill?(signal?: NodeJS.Signals): void;
}

/** Minimal spawn signature: `(command, args) => child`. Satisfied by `child_process.spawn`. */
export type SpawnLike = (command: string, args: readonly string[]) => ChildLike;

/** The prompt MODE each cluster tier keys on (§7). */
const MODE_BY_TIER = {
  pattern: 'strategic-pattern',
  lesson: 'failure-lesson',
  contrastive: 'contrastive',
} as const;

/**
 * Serialize a cluster into the concrete model input appended after the prompt:
 * the MODE the prompt keys on (§7 tier → strategic-pattern / failure-lesson /
 * contrastive) plus the cluster's evidence payload. Only tier + `input` are
 * sent — refs and instance ids are audit metadata the model must not echo.
 */
function serializeCluster(cluster: DistillCluster): string {
  const mode = MODE_BY_TIER[cluster.tier];
  const evidence = JSON.stringify(cluster.input, null, 2);
  return `MODE = ${mode}\n\nEVIDENCE (the cluster's verified traces):\n${evidence}`;
}

/**
 * Build the full model input: the versioned distill prompt, the serialized
 * cluster, and a strict-JSON output contract. The contract is explicit so the
 * downstream parser has an object to extract even if the model wraps it in prose.
 */
export function buildDistillInput(prompt: string, cluster: DistillCluster): string {
  return [
    prompt,
    '',
    serializeCluster(cluster),
    '',
    'Return ONLY a single JSON object with exactly these string fields, and nothing else:',
    '{ "name": "...", "description": "...", "body": "..." }',
    '- name: lowercase-hyphen skill name.',
    '- description: the retrieval surface ("Use when …").',
    '- body: the markdown SKILL.md body.',
  ].join('\n');
}

/**
 * Extract the first balanced `{...}` JSON object from `stdout` and parse it,
 * tolerating a leading/trailing prose wrapper (e.g. "Here is the skill: {…}").
 * Scans for the first `{` and matches braces (skipping string literals) to the
 * balancing `}` so a `}` inside a string does not truncate the object.
 */
function extractJsonObject(stdout: string): unknown {
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`distill LLM: no JSON object in model output: ${stdout.slice(0, 200)}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i += 1) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = stdout.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (err) {
          throw new Error(
            `distill LLM: model output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
  throw new Error(`distill LLM: unterminated JSON object in model output: ${stdout.slice(start, start + 200)}`);
}

/**
 * Validate `parsed` is a JSON object whose `name`/`description`/`body` are all
 * non-empty strings, and return it narrowed. Shared by both distill asserts;
 * `label` prefixes the error so the stage (distill vs meta-distill) stays legible.
 */
function assertSkillOutputFields(parsed: unknown, label: string): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${label}: model output is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of ['name', 'description', 'body'] as const) {
    if (typeof obj[field] !== 'string' || obj[field] === '') {
      throw new Error(`${label}: model output missing/invalid field "${field}"`);
    }
  }
  return obj;
}

/** Validate the parsed object is a `{ name, description, body }` of non-empty strings. */
function assertDistillOutput(parsed: unknown): DistillLLMOutput {
  const obj = assertSkillOutputFields(parsed, 'distill LLM');
  return { name: obj.name as string, description: obj.description as string, body: obj.body as string };
}

/**
 * Shared `claude -p` runner for the distill ports: spawn `claude -p --model`,
 * pipe `input` on stdin, collect stdout, and on a clean exit hand stdout to
 * `parse` (which extracts + validates the JSON, and may throw). A non-zero exit
 * or a spawn error rejects; `label` prefixes the process-level errors so the
 * calling stage stays identifiable.
 *
 * `-p` (non-interactive print mode) with the prompt on stdin mirrors the daemon's
 * other claude call sites (src/runner/claude.ts, the claude-code adapter) minus
 * the MCP wiring these ports have no use for.
 */
function runClaudeJson<T>(
  claudePath: string,
  model: string,
  spawnImpl: SpawnLike,
  input: string,
  parse: (stdout: string) => T,
  label: string,
  timeoutMs: number = DEFAULT_CLUSTER_TIMEOUT_MS,
): Promise<T> {
  const args = ['-p', '--model', model];
  return new Promise<T>((resolve, reject) => {
    const child = spawnImpl(claudePath, args);
    let stdout = '';
    let stderr = '';
    let settled = false;

    // #1534: a hung child blocks the whole run — kill it at the deadline and
    // surface a per-cluster error so the run continues.
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.('SIGKILL');
      reject(new DistillTimeoutError(label, timeoutMs));
    }, timeoutMs);
    deadline.unref?.();

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(err);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (code !== 0) {
        reject(new Error(`${label}: claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(parse(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Feed the prompt on stdin, then close it so `claude -p` runs and exits.
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

async function withTempJsonSchema<T>(schema: unknown, fn: (schemaPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jinn-codex-schema-'));
  const schemaPath = join(dir, 'output.schema.json');
  try {
    await writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf-8');
    return await fn(schemaPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Shared Codex runner for the distill ports. `codex exec` reads the full prompt
 * on stdin, uses its logged-in CLI auth, and constrains the final message with
 * a temporary JSON schema file so the same strict parser can validate output.
 */
async function runCodexJson<T>(
  codexPath: string,
  model: string,
  spawnImpl: SpawnLike,
  input: string,
  schema: unknown,
  parse: (stdout: string) => T,
  label: string,
  timeoutMs: number = DEFAULT_CLUSTER_TIMEOUT_MS,
): Promise<T> {
  return withTempJsonSchema(schema, (schemaPath) => new Promise<T>((resolve, reject) => {
    const args = [
      '--ask-for-approval',
      'never',
      'exec',
      '--model',
      model,
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--output-schema',
      schemaPath,
      '-',
    ];
    const child = spawnImpl(codexPath, args);
    let stdout = '';
    let stderr = '';
    let settled = false;

    // #1534: same deadline as the claude port — kill and surface a per-cluster error.
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.('SIGKILL');
      reject(new DistillTimeoutError(label, timeoutMs));
    }, timeoutMs);
    deadline.unref?.();

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(err);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (code !== 0) {
        reject(new Error(
          `${label}: codex exited with code ${code}: stderr=${stderr.slice(0, 500)} stdout=${stdout.slice(0, 500)}`,
        ));
        return;
      }
      try {
        resolve(parse(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    child.stdin?.write(input);
    child.stdin?.end();
  }));
}

/**
 * Build the distill LLM port. Returns the `DistillDeps.distill` function: given
 * a cluster, spawn `claude -p --model <model>`, pipe the built input on stdin,
 * collect stdout, and parse the strict JSON output.
 *
 * @param opts.claudePath  Path to the `claude` executable (default `claude`).
 * @param opts.model       Model id (default `claude-opus-4-8` — opus-class, §5).
 * @param opts.spawnImpl   Injected spawn (default `child_process.spawn`); tests
 *                         pass a fake so no real `claude` is invoked.
 */
export function createClaudeDistiller(
  opts: { claudePath?: string; model?: string; spawnImpl?: SpawnLike; timeoutMs?: number } = {},
): (cluster: DistillCluster) => Promise<DistillLLMOutput> {
  const claudePath = opts.claudePath ?? DEFAULT_CLAUDE_PATH;
  const model = opts.model ?? DEFAULT_MODEL;
  const spawnImpl: SpawnLike = opts.spawnImpl ?? ((command, args) => spawn(command, [...args]));

  return async function distill(cluster: DistillCluster): Promise<DistillLLMOutput> {
    // Lazy import keeps this module free of a top-level dependency on the
    // prompt's SHA sidecar; the prompt text itself is what we send.
    const { JINN_SKILL_DISTILL_PROMPT_V1 } = await import('./distill-prompt.js');
    const input = buildDistillInput(JINN_SKILL_DISTILL_PROMPT_V1, cluster);
    return runClaudeJson(claudePath, model, spawnImpl, input, (stdout) => assertDistillOutput(extractJsonObject(stdout)), 'distill LLM', opts.timeoutMs);
  };
}

/**
 * Build the Codex distill LLM port. This mirrors {@link createClaudeDistiller}
 * but invokes `codex exec` with read-only sandboxing, no approvals, ephemeral
 * session state, and a JSON schema file for structured final output.
 */
export function createCodexDistiller(
  opts: { codexPath?: string; model?: string; spawnImpl?: SpawnLike; timeoutMs?: number } = {},
): (cluster: DistillCluster) => Promise<DistillLLMOutput> {
  const codexPath = opts.codexPath ?? DEFAULT_CODEX_PATH;
  const model = opts.model ?? DEFAULT_CODEX_MODEL;
  const spawnImpl: SpawnLike = opts.spawnImpl ?? ((command, args) => spawn(command, [...args]));

  return async function distill(cluster: DistillCluster): Promise<DistillLLMOutput> {
    const { JINN_SKILL_DISTILL_PROMPT_V1 } = await import('./distill-prompt.js');
    const input = buildDistillInput(JINN_SKILL_DISTILL_PROMPT_V1, cluster);
    return runCodexJson(
      codexPath,
      model,
      spawnImpl,
      input,
      DISTILL_OUTPUT_SCHEMA,
      (stdout) => assertDistillOutput(extractJsonObject(stdout)),
      'distill LLM',
      opts.timeoutMs,
    );
  };
}

/**
 * Serialize a meta-cluster into the model input appended after the meta prompt:
 * the POLARITY (so the model keeps the right voice — diagnosis-only for
 * failure-lesson) and each source labelled with its opaque id. Only id + the
 * distilled skill's name/description/body are sent — evidence refs and instance
 * ids are audit metadata the model must not echo.
 */
function serializeMetaCluster(cluster: MetaCluster): string {
  const sources = cluster.sources
    .map((s) => `--- ${s.id} ---\nname: ${s.name}\ndescription: ${s.description}\nbody:\n${s.body}`)
    .join('\n\n');
  return `POLARITY = ${cluster.polarity}\n\nSOURCES (already-distilled skills, one per instance):\n${sources}`;
}

/** Build the full meta model input: the versioned meta prompt + the sources + the JSON contract. */
export function buildMetaDistillInput(prompt: string, cluster: MetaCluster): string {
  return [
    prompt,
    '',
    serializeMetaCluster(cluster),
    '',
    'Return ONLY a single JSON object with exactly these fields, and nothing else:',
    '{ "name": "...", "description": "...", "body": "...", "supports": ["s1", "s2"] }',
    '- name: lowercase-hyphen skill name.',
    '- description: the retrieval surface ("Use when … Not for: …").',
    '- body: the markdown SKILL.md body (the five fixed sections).',
    '- supports: the source ids (s1, s2, …) that corroborate the rule; at least two DISTINCT sources.',
  ].join('\n');
}

/** Validate the parsed object is a { name, description, body, supports } meta output. */
function assertMetaDistillOutput(parsed: unknown): MetaDistillLLMOutput {
  const obj = assertSkillOutputFields(parsed, 'meta-distill LLM');
  if (!Array.isArray(obj.supports) || !obj.supports.every((s) => typeof s === 'string' && s.length > 0)) {
    throw new Error('meta-distill LLM: model output missing/invalid field "supports" (expected a string[])');
  }
  return {
    name: obj.name as string,
    description: obj.description as string,
    body: obj.body as string,
    supports: obj.supports as string[],
  };
}

/**
 * Build the stage-2 meta-distill LLM port (issue #1463). Same spawn/parse
 * scaffolding as {@link createClaudeDistiller}: spawns `claude -p --model`,
 * pipes {@link buildMetaDistillInput} on stdin, and parses the strict JSON
 * (tolerating a prose wrapper via the shared {@link extractJsonObject}).
 */
export function createClaudeMetaDistiller(
  opts: { claudePath?: string; model?: string; spawnImpl?: SpawnLike; timeoutMs?: number } = {},
): (cluster: MetaCluster) => Promise<MetaDistillLLMOutput> {
  const claudePath = opts.claudePath ?? DEFAULT_CLAUDE_PATH;
  const model = opts.model ?? DEFAULT_MODEL;
  const spawnImpl: SpawnLike = opts.spawnImpl ?? ((command, args) => spawn(command, [...args]));

  return async function metaDistillPort(cluster: MetaCluster): Promise<MetaDistillLLMOutput> {
    const { JINN_SKILL_META_DISTILL_PROMPT_V1 } = await import('./distill-prompt.js');
    const input = buildMetaDistillInput(JINN_SKILL_META_DISTILL_PROMPT_V1, cluster);
    return runClaudeJson(claudePath, model, spawnImpl, input, (stdout) => assertMetaDistillOutput(extractJsonObject(stdout)), 'meta-distill LLM', opts.timeoutMs);
  };
}

/**
 * Build the Codex stage-2 meta-distill port. Same prompt and validation as the
 * Claude meta port, with Codex structured output enforced by JSON schema.
 */
export function createCodexMetaDistiller(
  opts: { codexPath?: string; model?: string; spawnImpl?: SpawnLike; timeoutMs?: number } = {},
): (cluster: MetaCluster) => Promise<MetaDistillLLMOutput> {
  const codexPath = opts.codexPath ?? DEFAULT_CODEX_PATH;
  const model = opts.model ?? DEFAULT_CODEX_MODEL;
  const spawnImpl: SpawnLike = opts.spawnImpl ?? ((command, args) => spawn(command, [...args]));

  return async function metaDistillPort(cluster: MetaCluster): Promise<MetaDistillLLMOutput> {
    const { JINN_SKILL_META_DISTILL_PROMPT_V1 } = await import('./distill-prompt.js');
    const input = buildMetaDistillInput(JINN_SKILL_META_DISTILL_PROMPT_V1, cluster);
    return runCodexJson(
      codexPath,
      model,
      spawnImpl,
      input,
      META_DISTILL_OUTPUT_SCHEMA,
      (stdout) => assertMetaDistillOutput(extractJsonObject(stdout)),
      'meta-distill LLM',
      opts.timeoutMs,
    );
  };
}
