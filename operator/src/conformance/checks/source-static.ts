/**
 * Layer 2 — static analysis on the source bundle.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.2 traced-I/O boundary + §4.10 checks (a)–(f).
 *
 * All checks in this file apply at the `attested` tier only.
 * ConformanceContext.sourceBundle is a { files: Map<path, content> }
 * loaded by the harness from executor.source.bundleCid.
 *
 * When ctx.sourceBundle is absent the check returns skipped: true — the
 * harness omits the source bundle at non-attested tiers, so skipping is
 * the correct behaviour rather than failing.
 *
 * No AST parser — regex grep is adequate and simpler for the enumerated
 * patterns (see Plan F non-goals).
 */

import type { CheckResult, ConformanceContext } from '../types.js';

// ─── Shared helpers ──────────────────────────────────────────────────────────

type Hit = { path: string; line: number; text: string };

function scanFiles(
  files: Map<string, string>,
  patterns: RegExp[],
  allowlist: string[],
): Hit[] {
  const hits: Hit[] = [];
  for (const [path, content] of files) {
    if (allowlist.some((a) => path.endsWith(a))) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of patterns) {
        if (pat.test(line)) {
          hits.push({ path, line: i + 1, text: line.trim() });
          break; // one hit per line is enough
        }
      }
    }
  }
  return hits;
}

function hitsToDetail(hits: Hit[], limit = 3): string {
  return hits
    .slice(0, limit)
    .map((h) => `${h.path}:${h.line}: ${h.text.slice(0, 80)}`)
    .join('; ');
}

function skip(id: string): CheckResult {
  return { id, layer: 2, passed: true, skipped: true };
}

// ─── Task 10: traced HTTP boundary ──────────────────────────────────────────
//
// Scope §4.10(a): all LLM calls must route through the measured traced-HTTP
// client wrapper. Flag any file (outside the whitelist) that contains a
// string literal whose text includes a known LLM provider hostname.
//
// Known LLM provider API hosts:
const LLM_PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.cohere.com',
  'api.mistral.ai',
];

const HTTP_WRAPPER_ALLOWLIST = [
  'src/trajectory/wrappers/http.ts',
  'src/trajectory/wrappers/llm.ts',
];

// Matches any quoted-string literal (', ", `) containing an LLM provider hostname.
const LLM_HOST_PATTERN = new RegExp(
  `['"\`][^'"\`]*(?:${LLM_PROVIDER_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})[^'"\`]*['"\`]`,
);

/**
 * Check id: `source.traced-http`
 * Layer: 2
 *
 * Skipped when ctx.sourceBundle is absent.
 */
export function checkTracedHttpBoundary(ctx: ConformanceContext): CheckResult {
  const id = 'source.traced-http';
  if (!ctx.sourceBundle) return skip(id);

  const hits = scanFiles(
    ctx.sourceBundle.files,
    [LLM_HOST_PATTERN],
    HTTP_WRAPPER_ALLOWLIST,
  );

  if (hits.length === 0) return { id, layer: 2, passed: true };
  return {
    id,
    layer: 2,
    passed: false,
    detail: hitsToDetail(hits),
  };
}

// ─── Task 11: MCP shim boundary ──────────────────────────────────────────────
//
// Scope §4.10(b): all MCP calls must go through the measured MCP shim.
// Flag any file (outside the whitelist) that directly imports
// @modelcontextprotocol/sdk or instantiates an MCPClient / Client.
//
const MCP_WRAPPER_ALLOWLIST = [
  'src/trajectory/wrappers/mcp.ts',
];

const MCP_PATTERNS = [
  /from\s+['"]@modelcontextprotocol\/sdk/,
  /require\s*\(\s*['"]@modelcontextprotocol\/sdk/,
  /new\s+(?:MCPClient|Client)\s*\(/,
];

/**
 * Check id: `source.mcp-shim`
 * Layer: 2
 *
 * Skipped when ctx.sourceBundle is absent.
 */
export function checkMcpShimBoundary(ctx: ConformanceContext): CheckResult {
  const id = 'source.mcp-shim';
  if (!ctx.sourceBundle) return skip(id);

  const hits = scanFiles(ctx.sourceBundle.files, MCP_PATTERNS, MCP_WRAPPER_ALLOWLIST);

  if (hits.length === 0) return { id, layer: 2, passed: true };
  return {
    id,
    layer: 2,
    passed: false,
    detail: hitsToDetail(hits),
  };
}

// ─── Task 11: subprocess boundary ────────────────────────────────────────────
//
// Scope §4.10(c): no subprocess spawns except through the traced wrapper.
// Flag child_process / execa / Bun.spawn / Deno.Command usage outside the
// subprocess wrapper file.
//
const SUBPROCESS_WRAPPER_ALLOWLIST = [
  'src/trajectory/wrappers/subprocess.ts',
];

const SUBPROCESS_PATTERNS = [
  /from\s+['"](?:node:)?child_process['"]/,
  /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/,
  /from\s+['"]execa['"]/,
  /require\s*\(\s*['"]execa['"]\s*\)/,
  /\bBun\.spawn\s*\(/,
  /\bDeno\.Command\s*\(/,
];

/**
 * Check id: `source.subprocess`
 * Layer: 2
 *
 * Skipped when ctx.sourceBundle is absent.
 */
export function checkSubprocessBoundary(ctx: ConformanceContext): CheckResult {
  const id = 'source.subprocess';
  if (!ctx.sourceBundle) return skip(id);

  const hits = scanFiles(ctx.sourceBundle.files, SUBPROCESS_PATTERNS, SUBPROCESS_WRAPPER_ALLOWLIST);

  if (hits.length === 0) return { id, layer: 2, passed: true };
  return {
    id,
    layer: 2,
    passed: false,
    detail: hitsToDetail(hits),
  };
}

// ─── Task 12: raw sockets ─────────────────────────────────────────────────────
//
// Scope §4.10(d): no raw TCP/TLS sockets outside measured wrappers.
// Flag net.createConnection, tls.connect, and their imports outside
// the socket/HTTP wrapper files.
//
const SOCKET_WRAPPER_ALLOWLIST = [
  'src/trajectory/wrappers/socket.ts',
  'src/trajectory/wrappers/http.ts',
];

const SOCKET_PATTERNS = [
  /\bnet\.createConnection\s*\(/,
  /\btls\.connect\s*\(/,
  /\bdgram\.createSocket\s*\(/,
  /from\s+['"](?:node:)?net['"]/,
  /from\s+['"](?:node:)?tls['"]/,
  /from\s+['"](?:node:)?dgram['"]/,
  /require\s*\(\s*['"](?:node:)?(?:net|tls|dgram)['"]\s*\)/,
];

/**
 * Check id: `source.raw-sockets`
 * Layer: 2
 *
 * Skipped when ctx.sourceBundle is absent.
 */
export function checkRawSockets(ctx: ConformanceContext): CheckResult {
  const id = 'source.raw-sockets';
  if (!ctx.sourceBundle) return skip(id);

  const hits = scanFiles(ctx.sourceBundle.files, SOCKET_PATTERNS, SOCKET_WRAPPER_ALLOWLIST);

  if (hits.length === 0) return { id, layer: 2, passed: true };
  return {
    id,
    layer: 2,
    passed: false,
    detail: hitsToDetail(hits),
  };
}

// ─── Task 12: dynamic code loading ───────────────────────────────────────────
//
// Scope §4.10(e): no dynamic code loading (eval, new Function, vm.runIn*,
// dynamic import() with non-literal/non-relative argument).
//
// Note on dynamic import: import('./foo.js') (relative literal) and
// import('node:fs') (node: literal) are statically analyzable — allowed.
// import(dynamicVar) is not — flagged.
//
// No allowlist: any match is a violation, regardless of file.
//

type DynHit = { path: string; line: number; text: string; reason: string };

function scanDynamicCode(files: Map<string, string>): DynHit[] {
  const hits: DynHit[] = [];
  for (const [path, content] of files) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/\beval\s*\(/.test(line)) {
        hits.push({ path, line: i + 1, text: line.trim(), reason: 'eval' });
        continue;
      }
      if (/\bnew\s+Function\s*\(/.test(line)) {
        hits.push({ path, line: i + 1, text: line.trim(), reason: 'new Function' });
        continue;
      }
      if (/\bvm\.runIn[A-Za-z]+\s*\(/.test(line)) {
        hits.push({ path, line: i + 1, text: line.trim(), reason: 'vm.runIn*' });
        continue;
      }

      // Dynamic import() — check argument.
      const importMatch = line.match(/\bimport\s*\(\s*([^)]+)\)/);
      if (importMatch) {
        const arg = importMatch[1].trim();
        // Allow: string literals that start with ./ or ../ (relative) or node: (built-in).
        const isStaticAllowed = /^['"](?:\.\.?\/[^'"]+|node:[^'"]+)['"]$/.test(arg);
        if (!isStaticAllowed) {
          hits.push({
            path,
            line: i + 1,
            text: line.trim(),
            reason: 'dynamic import with non-literal or non-relative/node: argument',
          });
        }
      }
    }
  }
  return hits;
}

/**
 * Check id: `source.dynamic-code`
 * Layer: 2
 *
 * Skipped when ctx.sourceBundle is absent.
 * No allowlist — any match is a violation.
 */
export function checkDynamicCode(ctx: ConformanceContext): CheckResult {
  const id = 'source.dynamic-code';
  if (!ctx.sourceBundle) return skip(id);

  const hits = scanDynamicCode(ctx.sourceBundle.files);

  if (hits.length === 0) return { id, layer: 2, passed: true };
  return {
    id,
    layer: 2,
    passed: false,
    detail: hits
      .slice(0, 3)
      .map((h) => `${h.path}:${h.line} [${h.reason}]: ${h.text.slice(0, 80)}`)
      .join('; '),
  };
}

// ─── Task 13: artifact emit helper ───────────────────────────────────────────
//
// Scope §4.10(f): artifact emission must go through the canonical helper
// (emitArtifact or the packaging module). Flag files that import fs AND
// look artifact-related (ipfs / uploadToIpfs / .cid) AND call fs.writeFile
// directly, unless the file is in the allowlist.
//
const ARTIFACT_HELPER_ALLOWLIST = [
  'src/trajectory/artifacts.ts',
  'src/harnesses/engine/packaging.ts',
];

/**
 * Check id: `source.artifact-emit`
 * Layer: 2
 *
 * Skipped when ctx.sourceBundle is absent.
 */
export function checkArtifactEmitPath(ctx: ConformanceContext): CheckResult {
  const id = 'source.artifact-emit';
  if (!ctx.sourceBundle) return skip(id);

  const hits: Hit[] = [];

  for (const [path, content] of ctx.sourceBundle.files) {
    if (ARTIFACT_HELPER_ALLOWLIST.some((a) => path.endsWith(a))) continue;

    // Gate 1: file must import fs (otherwise it can't do raw writes).
    const importsFs = /from\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(content) ||
      /require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/.test(content);
    if (!importsFs) continue;

    // Gate 2: file must look like it produces artifacts (IPFS / CID semantics).
    const looksArtifacty =
      /\bipfs\b/i.test(content) ||
      /uploadToIpfs/.test(content) ||
      /\.cid\b/.test(content) ||
      /emitArtifact/.test(content);
    if (!looksArtifacty) continue;

    // Flag: raw fs write calls inside this artifact-related fs-importing file.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (
        /\bfs\.(?:writeFile|writeFileSync|createWriteStream)\s*\(/.test(lines[i]) ||
        /\bwriteFile\s*\(/.test(lines[i])
      ) {
        hits.push({ path, line: i + 1, text: lines[i].trim() });
      }
    }
  }

  if (hits.length === 0) return { id, layer: 2, passed: true };
  return {
    id,
    layer: 2,
    passed: false,
    detail: hitsToDetail(hits),
  };
}
