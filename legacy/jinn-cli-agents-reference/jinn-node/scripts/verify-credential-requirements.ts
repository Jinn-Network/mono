#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDENTIAL_META_TOOLS,
  CREDENTIAL_PROVIDER_ALLOWLIST,
  OPERATOR_CAPABILITY_ALLOWLIST,
  TOOL_CREDENTIAL_MAP,
  TOOL_OPERATOR_CAPABILITY_MAP,
} from '../src/shared/tool-credential-requirements.js';
import { VALID_JOB_TOOLS } from '../src/agent/toolPolicy.js';

type RegisteredTool = {
  name: string;
  handler: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const JINN_NODE_ROOT = resolve(__dirname, '..');
const SRC_ROOT = resolve(JINN_NODE_ROOT, 'src');
const SERVER_FILE = resolve(SRC_ROOT, 'agent/mcp/server.ts');
const TOOLS_INDEX_FILE = resolve(SRC_ROOT, 'agent/mcp/tools/index.ts');
const REQUIRED_GITHUB_OPERATOR_TOOLS = [
  'get_file_contents',
  'search_code',
  'list_commits',
  'process_branch',
] as const;

function parseRegisteredTools(serverSource: string): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pattern = /\{\s*name:\s*'([^']+)'\s*,\s*schema:\s*tools\.[^,]+\s*,\s*handler:\s*tools\.([A-Za-z0-9_]+)\s*\}/g;
  for (const match of serverSource.matchAll(pattern)) {
    tools.push({ name: match[1], handler: match[2] });
  }
  return tools;
}

function parseIndexHandlerSourceMap(indexSource: string): Map<string, string> {
  const mapping = new Map<string, string>();
  const exportPattern = /export\s*\{([\s\S]*?)\}\s*from\s*'([^']+)';/g;

  for (const match of indexSource.matchAll(exportPattern)) {
    const namesBlock = match[1];
    const fromPath = match[2];
    const sourcePath = resolveTsImport(dirname(TOOLS_INDEX_FILE), fromPath);
    if (!sourcePath) continue;

    for (const raw of namesBlock.split(',')) {
      const token = raw.trim();
      if (!token) continue;
      if (token.startsWith('type ')) continue;

      const asParts = token.split(/\s+as\s+/);
      const exportedName = (asParts[1] || asParts[0]).trim();
      if (!exportedName) continue;
      mapping.set(exportedName, sourcePath);
    }
  }

  return mapping;
}

function parseRelativeImports(source: string): string[] {
  const imports: string[] = [];
  const fromPattern = /import\s+[\s\S]*?\s+from\s+['"](\.[^'"]+)['"]/g;
  const sideEffectPattern = /import\s+['"](\.[^'"]+)['"]/g;

  for (const match of source.matchAll(fromPattern)) {
    imports.push(match[1]);
  }
  for (const match of source.matchAll(sideEffectPattern)) {
    imports.push(match[1]);
  }

  return imports;
}

function resolveTsImport(fromDir: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const rawTarget = resolve(fromDir, specifier);
  const candidates = [
    rawTarget,
    rawTarget.endsWith('.js') ? rawTarget.slice(0, -3) + '.ts' : '',
    rawTarget.endsWith('.ts') ? rawTarget : rawTarget + '.ts',
    resolve(rawTarget, 'index.ts'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function fileUsesCredentialClient(
  filePath: string,
  cache: Map<string, boolean>,
  stack: Set<string> = new Set(),
): boolean {
  if (cache.has(filePath)) {
    return cache.get(filePath)!;
  }
  if (stack.has(filePath)) {
    return false;
  }
  if (!existsSync(filePath)) {
    cache.set(filePath, false);
    return false;
  }

  stack.add(filePath);
  const source = readFileSync(filePath, 'utf-8');
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  // Direct usage.
  if (/\bgetCredential(?:Bundle)?\s*\(/.test(codeOnly)) {
    cache.set(filePath, true);
    stack.delete(filePath);
    return true;
  }

  // Recursive usage through local imports (e.g. shared helpers).
  const imports = parseRelativeImports(codeOnly);
  for (const specifier of imports) {
    const resolved = resolveTsImport(dirname(filePath), specifier);
    if (!resolved) continue;
    if (!resolved.startsWith(SRC_ROOT)) continue;
    if (fileUsesCredentialClient(resolved, cache, stack)) {
      cache.set(filePath, true);
      stack.delete(filePath);
      return true;
    }
  }

  cache.set(filePath, false);
  stack.delete(filePath);
  return false;
}

function verify(): string[] {
  const errors: string[] = [];

  if (!existsSync(SERVER_FILE)) {
    return [`Missing MCP server source file: ${SERVER_FILE}`];
  }
  if (!existsSync(TOOLS_INDEX_FILE)) {
    return [`Missing MCP tools index file: ${TOOLS_INDEX_FILE}`];
  }

  const serverSource = readFileSync(SERVER_FILE, 'utf-8');
  const indexSource = readFileSync(TOOLS_INDEX_FILE, 'utf-8');

  const registeredTools = parseRegisteredTools(serverSource);
  if (registeredTools.length === 0) {
    errors.push('No registered MCP tools parsed from server.ts; parser likely drifted.');
    return errors;
  }

  const handlerSourceMap = parseIndexHandlerSourceMap(indexSource);
  const fileCredentialCache = new Map<string, boolean>();

  const registeredToolNames = new Set<string>();
  const credentialedRegisteredTools = new Set<string>();

  for (const tool of registeredTools) {
    registeredToolNames.add(tool.name);

    const sourcePath = handlerSourceMap.get(tool.handler);
    if (!sourcePath) {
      errors.push(`Could not resolve handler source for "${tool.name}" (handler: ${tool.handler})`);
      continue;
    }

    if (fileUsesCredentialClient(sourcePath, fileCredentialCache)) {
      credentialedRegisteredTools.add(tool.name);
    }
  }

  const mappedToolNames = new Set(Object.keys(TOOL_CREDENTIAL_MAP));
  const metaToolNames = new Set<string>(CREDENTIAL_META_TOOLS);

  // Every credentialed registered tool must be mapped.
  for (const toolName of credentialedRegisteredTools) {
    if (!mappedToolNames.has(toolName)) {
      errors.push(`Credentialed MCP tool is missing mapping: ${toolName}`);
    }
  }

  // Every mapped tool must be one of:
  // 1) registered MCP tool name, or
  // 2) declared credential meta-tool, or
  // 3) valid enabledTools token (to support tools present in policy but not registered here).
  for (const mappedName of mappedToolNames) {
    if (!registeredToolNames.has(mappedName) && !metaToolNames.has(mappedName) && !VALID_JOB_TOOLS.has(mappedName)) {
      errors.push(`Mapped tool is neither registered MCP tool nor credential meta-tool: ${mappedName}`);
    }
  }

  // Every credential meta-tool must be mapped and valid in tool policy.
  for (const metaTool of CREDENTIAL_META_TOOLS) {
    if (!mappedToolNames.has(metaTool)) {
      errors.push(`Credential meta-tool missing mapping: ${metaTool}`);
    }
    if (!VALID_JOB_TOOLS.has(metaTool)) {
      errors.push(`Credential meta-tool is not present in VALID_JOB_TOOLS: ${metaTool}`);
    }
  }

  // Provider names must stay within explicit allowlist.
  const providerSet = new Set<string>(CREDENTIAL_PROVIDER_ALLOWLIST);
  for (const [tool, providers] of Object.entries(TOOL_CREDENTIAL_MAP)) {
    for (const provider of providers) {
      if (!providerSet.has(provider)) {
        errors.push(`Tool "${tool}" references unknown credential provider "${provider}"`);
      }
    }
  }

  // Operator capabilities must stay within explicit allowlist.
  const operatorCapabilitySet = new Set<string>(OPERATOR_CAPABILITY_ALLOWLIST);
  for (const [tool, capabilities] of Object.entries(TOOL_OPERATOR_CAPABILITY_MAP)) {
    if (!VALID_JOB_TOOLS.has(tool)) {
      errors.push(`Operator capability mapped tool is not present in VALID_JOB_TOOLS: ${tool}`);
    }
    for (const capability of capabilities) {
      if (!operatorCapabilitySet.has(capability)) {
        errors.push(`Tool "${tool}" references unknown operator capability "${capability}"`);
      }
    }
  }

  // Locked github-capability contract for coding/GitHub tools.
  for (const tool of REQUIRED_GITHUB_OPERATOR_TOOLS) {
    const capabilities = TOOL_OPERATOR_CAPABILITY_MAP[tool];
    if (!capabilities || !capabilities.includes('github')) {
      errors.push(`Required github operator capability mapping missing for tool: ${tool}`);
    }
  }

  return errors;
}

const errors = verify();
if (errors.length > 0) {
  console.error('[verify-credential-requirements] FAILED');
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log('[verify-credential-requirements] OK');
