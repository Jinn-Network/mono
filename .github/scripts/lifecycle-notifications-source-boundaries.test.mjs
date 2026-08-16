import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const sourceRoot = join(root, 'packages', 'lifecycle-notifications', 'src');
const PRODUCT_IDENTIFIERS = /\b(?:OperatorConsole|jinnOperator|operatorConsole)\b/;
const PRODUCT_PACKAGES = /@jinn-network\/(?:operator|client)(?:["'/]|$)/;

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

function specifiers(source) {
  const trivia = String.raw`(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n|$)))*`;
  return [
    new RegExp(String.raw`\bfrom${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}["']([^"']+)["']`, 'g'),
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function externalSpecifierRoot(specifier) {
  if (specifier.startsWith('.')) return null;
  if (specifier.startsWith('node:')) return specifier.split('/')[0];
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

test('lifecycle-notifications production source has no externals and no product identifiers', () => {
  const production = files(sourceRoot).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  const disallowed = production.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const specifierRoot = externalSpecifierRoot(specifier);
    return specifierRoot === null ? [] : [`${relative(root, file)} -> ${specifier}`];
  }));
  assert.deepEqual(disallowed, [], 'production source must import only relative modules');

  const productHits = production.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const hits = [];
    if (PRODUCT_IDENTIFIERS.test(source)) hits.push(`${relative(root, file)} -> product identifier`);
    if (PRODUCT_PACKAGES.test(source)) hits.push(`${relative(root, file)} -> product package`);
    return hits;
  });
  assert.deepEqual(productHits, []);
});
