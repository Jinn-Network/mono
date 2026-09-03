// VERBATIM PORT of packages/benchmark-product/core/src/runtime/child-temp-env.test.ts (scan half).
// Fixes land next; this commit exists so the regression cases can be observed red.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const JUSTIFICATION = /\btemp-env:/u;
export const CARRIES_TEMP = /inheritedTempEnv\(|scopedTempEnv\(|TMPDIR|\.\.\.process\.env\b/u;
const NOT_A_SPAWN_SITE = /env:\s*(?:z\.|Readonly<|NodeJS\.ProcessEnv|dict\[)/u;

function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, ' ');
}

function delegatedNames(expression, calls) {
  const names = new Set();
  const patterns = [/env:\s*([A-Za-z_$][\w$]*)/gu, /\.\.\.([A-Za-z_$][\w$]*)/gu];
  if (calls) patterns.push(/([A-Za-z_$][\w$]*)\s*\(/gu);
  for (const pattern of patterns) for (const match of expression.matchAll(pattern)) names.add(match[1]);
  return [...names];
}

function definitionWindow(source, name) {
  const definition = new RegExp(`(?:const|let|function)\\s+${name}\\b`, 'u').exec(source);
  if (definition === null) return undefined;
  const body = source.slice(definition.index, definition.index + 2_000);
  const next = /\n(?:export\s+)?(?:async\s+)?(?:const|let|function)\s/u.exec(body.slice(1));
  return next === null ? body : body.slice(0, next.index + 1);
}

function carriesTemp(source, expression, seen) {
  const code = withoutComments(expression);
  if (CARRIES_TEMP.test(code)) return true;
  for (const name of delegatedNames(code, seen.size > 0)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const definition = definitionWindow(source, name);
    if (definition !== undefined && carriesTemp(source, definition, seen)) return true;
  }
  return false;
}

function envSite(source, index) {
  const valueStart = source.indexOf(':', index) + 1;
  let end = source.indexOf('\n', valueStart);
  const brace = source.slice(valueStart, end === -1 ? undefined : end).indexOf('{');
  if (brace !== -1) {
    let depth = 0;
    for (let cursor = valueStart + brace; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}' && (depth -= 1) === 0) {
        end = cursor + 1;
        break;
      }
    }
  }
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const preceding = source.slice(0, lineStart).split('\n').slice(-8).join('\n');
  const comments = preceding.split('\n').filter((line) => /^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n');
  return `${comments}\n${source.slice(index, end === -1 ? undefined : end)}`;
}

export function unhandledSites(source) {
  const unhandled = [];
  for (const match of source.matchAll(/(?<![\w-])env:/gu)) {
    const site = envSite(source, match.index);
    if (NOT_A_SPAWN_SITE.test(site)) continue;
    if (JUSTIFICATION.test(site) || carriesTemp(source, site, new Set())) continue;
    const line = source.slice(0, match.index).split('\n').length;
    unhandled.push(`${line}: ${site.slice(site.indexOf('env:')).split('\n')[0].trim()}`);
  }
  return unhandled;
}

export function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(?:ts|mjs)$/u.test(entry.name) || entry.name.endsWith('.test.ts')) return [];
    return [path];
  });
}

export function scanRoots(roots) {
  return roots.flatMap((directory) =>
    sourceFiles(directory).flatMap((file) =>
      unhandledSites(readFileSync(file, 'utf8'), file).map((site) => `${file}: ${site}`)));
}
