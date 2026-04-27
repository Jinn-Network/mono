import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePluginRoot } from '../../scripts/validate-plugin.mjs';

const tempDirs: string[] = [];

function makePluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jinn-validate-plugin-'));
  tempDirs.push(root);
  return root;
}

function writePluginManifest(root: string, body: string = '{"name":"test"}'): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), body);
}

function writeMarketplaceManifest(root: string, body: string = '{"name":"test"}'): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), body);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('validatePluginRoot — manifest', () => {
  it('passes when .claude-plugin/plugin.json is present', () => {
    const root = makePluginRoot();
    writePluginManifest(root);

    const { errors } = validatePluginRoot(root);

    expect(errors).toEqual([]);
  });

  it('passes when .claude-plugin/marketplace.json is present', () => {
    const root = makePluginRoot();
    writeMarketplaceManifest(root);

    const { errors } = validatePluginRoot(root);

    expect(errors).toEqual([]);
  });

  it('fails when no manifest is present', () => {
    const root = makePluginRoot();

    const { errors } = validatePluginRoot(root);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/No manifest found/);
  });

  it('fails when plugin.json is malformed JSON', () => {
    const root = makePluginRoot();
    writePluginManifest(root, '{ not json');

    const { errors } = validatePluginRoot(root);

    expect(errors.some((e) => /plugin\.json.*Invalid JSON/.test(e))).toBe(true);
  });
});

describe('validatePluginRoot — hooks', () => {
  it('passes when hooks/ is empty', () => {
    const root = makePluginRoot();
    writePluginManifest(root);
    mkdirSync(join(root, 'hooks'));

    const { errors } = validatePluginRoot(root);

    expect(errors).toEqual([]);
  });

  it('passes when hooks/ contains scripts and hooks.json is present', () => {
    const root = makePluginRoot();
    writePluginManifest(root);
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'on-start.sh'), '#!/bin/sh\n');
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{"hooks":{}}');

    const { errors } = validatePluginRoot(root);

    expect(errors).toEqual([]);
  });

  it('fails when hooks/ contains scripts but hooks.json is missing', () => {
    const root = makePluginRoot();
    writePluginManifest(root);
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'on-start.sh'), '#!/bin/sh\n');

    const { errors } = validatePluginRoot(root);

    expect(errors.some((e) => /hooks\.json is missing/.test(e))).toBe(true);
  });

  it('fails when hooks.json is malformed JSON', () => {
    const root = makePluginRoot();
    writePluginManifest(root);
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'on-start.sh'), '#!/bin/sh\n');
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{ broken');

    const { errors } = validatePluginRoot(root);

    expect(errors.some((e) => /hooks\.json.*Invalid JSON/.test(e))).toBe(true);
  });

  it('detects hook scripts in nested subdirectories', () => {
    const root = makePluginRoot();
    writePluginManifest(root);
    mkdirSync(join(root, 'hooks', 'nested'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'nested', 'task.mjs'), 'export {};\n');

    const { errors } = validatePluginRoot(root);

    expect(errors.some((e) => /hooks\.json is missing/.test(e))).toBe(true);
  });
});

describe('validatePluginRoot — agent frontmatter', () => {
  function writeAgent(root: string, frontmatter: string): string {
    const dir = join(root, 'agents');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'sample.md');
    writeFileSync(file, `---\n${frontmatter}\n---\nbody\n`);
    return file;
  }

  it('passes when agent uses tools: only', () => {
    const root = makePluginRoot();
    writePluginManifest(root);
    writeAgent(root, 'name: sample\ntools:\n  - Read');

    const { errors } = validatePluginRoot(root);

    expect(errors).toEqual([]);
  });

  it('fails when agent has top-level allowed-tools:', () => {
    const root = makePluginRoot();
    writePluginManifest(root);
    writeAgent(root, 'name: sample\nallowed-tools:\n  - Read');

    const { errors } = validatePluginRoot(root);

    expect(errors.some((e) => /allowed-tools/.test(e))).toBe(true);
  });

  it('passes when allowed-tools is nested (indented) under another key', () => {
    // The regex anchors `allowed-tools:` to the start of a line via the /m
    // flag, so an indented (nested) occurrence does not trigger the agent
    // tools-key check. This test pins that behavior — if the regex is later
    // tightened to a structural YAML check, this case must still pass.
    const root = makePluginRoot();
    writePluginManifest(root);
    writeAgent(root, 'name: sample\nmetadata:\n  allowed-tools:\n    - Read');

    const { errors } = validatePluginRoot(root);

    expect(errors).toEqual([]);
  });

  it('fails when allowed-tools sits at column 0 inside a nested context (false-positive)', () => {
    // A YAML document where `allowed-tools:` is technically a sibling of
    // `metadata:` (column 0) is still flagged. This pins the current
    // regex-only behavior; a structural YAML parser would treat it as a
    // top-level key (correctly flagged) so the assertion would not change.
    const root = makePluginRoot();
    writePluginManifest(root);
    writeAgent(root, 'name: sample\nmetadata: {}\nallowed-tools:\n  - Read');

    const { errors } = validatePluginRoot(root);

    expect(errors.some((e) => /allowed-tools/.test(e))).toBe(true);
  });

  it('warns (does not fail) when agent has no frontmatter', () => {
    const root = makePluginRoot();
    writePluginManifest(root);
    mkdirSync(join(root, 'agents'));
    writeFileSync(join(root, 'agents', 'plain.md'), '# no frontmatter\n');

    const { errors, warnings } = validatePluginRoot(root);

    expect(errors).toEqual([]);
    expect(warnings.some((w) => /no YAML frontmatter/.test(w))).toBe(true);
  });
});
