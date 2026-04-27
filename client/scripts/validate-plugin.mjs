#!/usr/bin/env node
/**
 * Validates a Claude Code plugin directory against the same structural rules as
 * `claude plugin validate` (manifest presence + JSON) and the plugin-dev
 * checklist (hooks/hooks.json when hook scripts exist; agents use `tools:` not
 * `allowed-tools:` in frontmatter).
 *
 * Usage:
 *   node scripts/validate-plugin.mjs                 # auto-discover plugins under cwd
 *   node scripts/validate-plugin.mjs <plugin-root>   # validate a specific plugin root
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_SCRIPT_EXT = /\.(sh|bash|zsh|mjs|cjs|js|ts)$/i;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.yarn',
  '.pnp',
  '.cache',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'out',
  '.tasks',
]);

function hasHookScripts(hooksDir) {
  for (const ent of readdirSync(hooksDir, { withFileTypes: true })) {
    if (ent.name === 'hooks.json' || ent.name === '.DS_Store') continue;
    const p = join(hooksDir, ent.name);
    if (ent.isDirectory()) {
      if (hasHookScripts(p)) return true;
      continue;
    }
    if (ent.isFile() && HOOK_SCRIPT_EXT.test(ent.name)) return true;
  }
  return false;
}

function collectMarkdownFiles(dir, acc) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) collectMarkdownFiles(p, acc);
    else if (ent.isFile() && ent.name.endsWith('.md')) acc.push(p);
  }
}

/** @returns {string | null} */
function extractYamlFrontmatter(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const open = raw.match(/^---\r?\n/);
  if (!open) return null;
  const rest = raw.slice(open[0].length);
  const end = rest.search(/\r?\n---(\r?\n|$)/);
  if (end === -1) return null;
  return rest.slice(0, end);
}

/**
 * Extracts the names of top-level mapping keys from a YAML frontmatter block.
 * Indented lines (nested under a parent key or inside a block scalar),
 * comments, and doc markers are skipped. This is intentionally regex-based
 * rather than a full YAML parser — frontmatter blocks are tiny and we only
 * need to identify the column-0 keys.
 * @param {string} yaml
 * @returns {Set<string>}
 */
function topLevelYamlKeys(yaml) {
  const keys = new Set();
  const KEY_RE = /^([A-Za-z_][\w-]*)\s*:(\s|$)/;
  for (const line of yaml.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const firstChar = line[0];
    if (firstChar === ' ' || firstChar === '\t') continue;
    if (firstChar === '#') continue;
    if (line === '---' || line === '...') continue;
    const m = line.match(KEY_RE);
    if (m) keys.add(m[1]);
  }
  return keys;
}

export function validatePluginRoot(root) {
  const errors = [];
  const warnings = [];
  const pluginJson = join(root, '.claude-plugin', 'plugin.json');
  const marketplaceJson = join(root, '.claude-plugin', 'marketplace.json');

  if (!existsSync(pluginJson) && !existsSync(marketplaceJson)) {
    errors.push(
      `✘ ${root}: No manifest found in directory. Expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json`,
    );
    return { errors, warnings };
  }

  if (existsSync(pluginJson)) {
    try {
      JSON.parse(readFileSync(pluginJson, 'utf8'));
    } catch {
      errors.push(`✘ ${relative(root, pluginJson)}: Invalid JSON`);
    }
  }
  if (existsSync(marketplaceJson)) {
    try {
      JSON.parse(readFileSync(marketplaceJson, 'utf8'));
    } catch {
      errors.push(`✘ ${relative(root, marketplaceJson)}: Invalid JSON`);
    }
  }

  const hooksDir = join(root, 'hooks');
  if (existsSync(hooksDir) && statSync(hooksDir).isDirectory()) {
    if (hasHookScripts(hooksDir)) {
      const hooksJson = join(hooksDir, 'hooks.json');
      if (!existsSync(hooksJson)) {
        errors.push(
          '✘ hooks: hooks/ contains hook scripts but hooks/hooks.json is missing (required for Claude Code hook registration)',
        );
      } else {
        try {
          JSON.parse(readFileSync(hooksJson, 'utf8'));
        } catch {
          errors.push(`✘ ${relative(root, hooksJson)}: Invalid JSON`);
        }
      }
    }
  }

  const agentsDir = join(root, 'agents');
  const agentMds = [];
  collectMarkdownFiles(agentsDir, agentMds);
  for (const md of agentMds) {
    const fm = extractYamlFrontmatter(md);
    if (fm == null) {
      warnings.push(`⚠ ${relative(root, md)}: no YAML frontmatter (skipped agent tool-key check)`);
      continue;
    }
    if (topLevelYamlKeys(fm).has('allowed-tools')) {
      errors.push(
        `✘ ${relative(root, md)}: agent frontmatter uses "allowed-tools:" — use "tools:" (Claude Code plugin agents; see official plugin agents)`,
      );
    }
  }

  return { errors, warnings };
}

function discoverPluginRoots(startDir) {
  const found = [];
  const stack = [startDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const claudePluginEnt = entries.find((e) => e.isDirectory() && e.name === '.claude-plugin');
    if (claudePluginEnt) {
      const cp = join(dir, '.claude-plugin');
      if (existsSync(join(cp, 'plugin.json')) || existsSync(join(cp, 'marketplace.json'))) {
        found.push(dir);
        // do not descend further: a plugin is a leaf for discovery
        continue;
      }
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.')) continue;
      stack.push(join(dir, ent.name));
    }
  }
  return found;
}

// CLI entry point — only runs when invoked directly, not when imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const explicitArg = process.argv[2];
  const cwd = resolve('.');

  let roots;
  if (explicitArg) {
    const root = resolve(explicitArg);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      console.error(`validate-plugin: not a directory: ${root}`);
      process.exit(1);
    }
    roots = [root];
  } else {
    roots = discoverPluginRoots(cwd);
    if (roots.length === 0) {
      console.error(
        `validate-plugin: no Claude Code plugins found under ${cwd} (looked for */.claude-plugin/{plugin,marketplace}.json). Pass an explicit path: node scripts/validate-plugin.mjs <plugin-root>`,
      );
      process.exit(1);
    }
    console.error(`validate-plugin: discovered ${roots.length} plugin root(s) under ${cwd}`);
  }

  let totalErrors = 0;
  for (const root of roots) {
    const { errors, warnings } = validatePluginRoot(root);
    for (const w of warnings) console.error(w);
    for (const e of errors) console.error(e);
    if (errors.length === 0) {
      console.log(`✔ validate-plugin: ${root} OK`);
    }
    totalErrors += errors.length;
  }

  if (totalErrors > 0) process.exit(1);
}
