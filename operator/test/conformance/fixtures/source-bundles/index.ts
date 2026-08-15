/**
 * Fake source bundles for Layer 2 static-analysis conformance tests.
 *
 * Each bundle is a Map<filePath, fileContent> — no real filesystem I/O.
 * Bundles are intentionally minimal; only the patterns under test matter.
 */

// ─── Task 10: traced HTTP boundary ───────────────────────────────────────────

/** Good: only the traced wrapper touches LLM provider hosts. */
export const GOOD_LLM_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/trajectory/wrappers/http.ts',
      `// Intentional: this IS the measured wrapper.
import { fetch } from 'undici';
export async function tracedFetch(url: string, opts?: RequestInit) {
  // traced call to https://api.anthropic.com/v1/messages
  return fetch(url, opts);
}
`,
    ],
    [
      'src/lib/claude.ts',
      `// Good: uses the wrapper, no raw provider URL.
import { tracedFetch } from '../trajectory/wrappers/http.js';
export async function callClaude(body: unknown) {
  return tracedFetch('/proxy/messages', { method: 'POST', body: JSON.stringify(body) });
}
`,
    ],
  ]),
};

/** Bad: raw fetch to api.anthropic.com outside the wrapper. */
export const BAD_RAW_FETCH_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/lib/claude.ts',
      `import { fetch } from 'node-fetch';
export async function callClaude(body: unknown) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
`,
    ],
  ]),
};

/** Bad: axios call to api.openai.com outside the wrapper. */
export const BAD_AXIOS_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/lib/openai.ts',
      `import axios from 'axios';
export async function callOpenAI(body: unknown) {
  return axios.post('https://api.openai.com/v1/chat/completions', body);
}
`,
    ],
  ]),
};

// ─── Task 11: MCP shim boundary ──────────────────────────────────────────────

/** Good: only the measured MCP wrapper instantiates the client. */
export const GOOD_MCP_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/trajectory/wrappers/mcp.ts',
      `import { Client } from '@modelcontextprotocol/sdk/client/index.js';
export function createTracedMcpClient() { return new Client({ name: 'jinn', version: '1' }); }
`,
    ],
    [
      'src/runner/claude.ts',
      `// Good: uses the traced wrapper, does NOT import @modelcontextprotocol/sdk directly.
import { createTracedMcpClient } from '../trajectory/wrappers/mcp.js';
const client = createTracedMcpClient();
`,
    ],
  ]),
};

/** Bad: non-wrapper file directly constructs the MCP client. */
export const BAD_RAW_MCP_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/runner/claude.ts',
      `import { Client } from '@modelcontextprotocol/sdk/client/index.js';
const client = new Client({ name: 'test', version: '1' });
`,
    ],
  ]),
};

// ─── Task 11: subprocess boundary ────────────────────────────────────────────

/** Good: only the subprocess wrapper imports child_process. */
export const GOOD_SUBPROCESS_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/trajectory/wrappers/subprocess.ts',
      `import { spawn } from 'node:child_process';
export function tracedSpawn(cmd: string, args: string[]) { return spawn(cmd, args); }
`,
    ],
    [
      'src/runner/claude.ts',
      `// Good: uses the wrapper.
import { tracedSpawn } from '../trajectory/wrappers/subprocess.js';
export function runClaude() { return tracedSpawn('claude', []); }
`,
    ],
  ]),
};

/** Bad: raw child_process.spawn outside the wrapper. */
export const BAD_RAW_SPAWN_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/runner/claude.ts',
      `import { spawn } from 'node:child_process';
export function runClaude() { return spawn('claude', []); }
`,
    ],
  ]),
};

/** Bad: execa import outside the wrapper. */
export const BAD_EXECA_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/lib/tools.ts',
      `import { execa } from 'execa';
export async function runTool() { return execa('ls', []); }
`,
    ],
  ]),
};

// ─── Task 12: raw sockets ─────────────────────────────────────────────────────

/** Bad: raw net.createConnection outside any wrapper. */
export const BAD_RAW_SOCKET_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/lib/transport.ts',
      `import { createConnection } from 'node:net';
export function rawConnect(port: number) { return createConnection({ port }); }
`,
    ],
  ]),
};

/** Bad: raw tls.connect outside any wrapper. */
export const BAD_TLS_CONNECT_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/lib/tls-transport.ts',
      `import { connect } from 'node:tls';
export function tlsConnect(port: number, host: string) { return connect(port, host); }
`,
    ],
  ]),
};

// ─── Task 12: dynamic code ────────────────────────────────────────────────────

/** Bad: eval usage. */
export const BAD_EVAL_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/lib/unsafe.ts',
      `export function run(code: string) { return eval(code); }
`,
    ],
  ]),
};

/** Bad: new Function usage. */
export const BAD_NEW_FUNCTION_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/lib/unsafe.ts',
      `export function run(code: string) { return new Function('return ' + code)(); }
`,
    ],
  ]),
};

/** Bad: dynamic import with a non-literal expression. */
export const BAD_DYNAMIC_IMPORT_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/plugins/loader.ts',
      `export async function loadPlugin(name: string) {
  return import(name);
}
`,
    ],
  ]),
};

/** Bad: vm.runInNewContext usage. */
export const BAD_VM_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/sandbox/runner.ts',
      `import vm from 'vm';
export function runSandboxed(code: string) { return vm.runInNewContext(code, {}); }
`,
    ],
  ]),
};

/** Good: only statically analyzable relative-path dynamic imports. */
export const GOOD_DYNAMIC_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/plugins/loader.ts',
      `export async function loadPlugin() {
  const mod = await import('./plugin.js');
  return mod;
}
`,
    ],
  ]),
};

// ─── Task 13: artifact emit helper ───────────────────────────────────────────

/** Good: all fs writes are inside the artifact-emit helper. */
export const GOOD_ARTIFACT_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/harnesses/engine/packaging.ts',
      `import fs from 'node:fs/promises';
import { uploadToIpfs } from '../../adapters/mech/ipfs.js';
export async function emitArtifact(path: string, content: Buffer) {
  await fs.writeFile(path, content);
  const cid = await uploadToIpfs(content);
  return { cid };
}
`,
    ],
    [
      'src/lib/consumer.ts',
      `// Good: imports the artifact helper, does NOT touch fs + IPFS directly.
import { emitArtifact } from '../harnesses/engine/packaging.js';
export async function saveResult(data: Buffer) {
  return emitArtifact('/tmp/output.bin', data);
}
`,
    ],
  ]),
};

/** Bad: non-helper file writes + uploads. */
export const BAD_RAW_WRITE_FILE_BUNDLE: { files: Map<string, string> } = {
  files: new Map([
    [
      'src/lib/consumer.ts',
      `import fs from 'node:fs/promises';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';
export async function saveResult(data: Buffer) {
  await fs.writeFile('/tmp/output.bin', data);
  const cid = await uploadToIpfs(data);
  return { cid };
}
`,
    ],
  ]),
};
