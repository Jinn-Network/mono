#!/usr/bin/env npx tsx
/**
 * Render Code Spec Blueprints to Markdown
 *
 * Reads invariant blueprints from codespec/blueprints/*.json and generates
 * a human-readable markdown specification at docs/guides/code-spec.md
 *
 * Usage:
 *   npx tsx codespec/scripts/render-spec.ts
 *   yarn render:codespec
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLUEPRINTS_DIR = join(__dirname, '..', 'blueprints');
const OUTPUT_PATH = join(__dirname, '..', '..', 'docs', 'guides', 'code-spec.md');

interface Invariant {
  id: string;
  type: 'BOOLEAN' | 'FLOOR' | 'CEILING' | 'RANGE';
  condition: string;
  assessment?: string;
  why?: string;
  quote?: string;
  examples?: {
    do: string[];
    dont: string[];
  };
  enforcedBy?: string[];
  exceptions?: string[];
  threshold?: number;
  min?: number;
  max?: number;
  unit?: string;
}

interface BlueprintFile {
  $schema?: string;
  invariants: Invariant[];
}

function loadBlueprint(filename: string): Invariant[] {
  const path = join(BLUEPRINTS_DIR, filename);
  if (!existsSync(path)) {
    console.warn(`Blueprint file not found: ${path}`);
    return [];
  }
  const content = readFileSync(path, 'utf-8');
  const data: BlueprintFile = JSON.parse(content);
  return data.invariants || [];
}

function renderInvariant(inv: Invariant, tier: 'objective' | 'rule' | 'default'): string {
  const lines: string[] = [];

  // Title from ID
  const title = inv.id
    .replace(/^(OBJ-|RULE-|DB-)/, '')
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  lines.push(`### ${title}`);
  lines.push('');

  // Quote if present
  if (inv.quote) {
    lines.push(`> ${inv.quote}`);
    lines.push('');
  }

  // Condition as the principle
  if (tier === 'objective') {
    lines.push(`**The principle:** ${inv.condition}`);
  } else if (tier === 'rule') {
    lines.push(`**The rule:** ${inv.condition}`);
  } else {
    lines.push(`**Behavior:** ${inv.condition}`);
  }
  lines.push('');

  // Why this matters
  if (inv.why) {
    lines.push('**Why this matters:**');
    lines.push(inv.why);
    lines.push('');
  }

  // Assessment (how to check)
  if (inv.assessment) {
    lines.push('**How to assess:**');
    lines.push(inv.assessment);
    lines.push('');
  }

  // Examples
  if (inv.examples) {
    lines.push('**Examples:**');
    lines.push('');
    if (inv.examples.do.length > 0) {
      lines.push('✅ **Do:**');
      for (const example of inv.examples.do) {
        lines.push(`- ${example}`);
      }
      lines.push('');
    }
    if (inv.examples.dont.length > 0) {
      lines.push('❌ **Don\'t:**');
      for (const example of inv.examples.dont) {
        lines.push(`- ${example}`);
      }
      lines.push('');
    }
  }

  // Exceptions
  if (inv.exceptions && inv.exceptions.length > 0) {
    lines.push('**Allowed exceptions:**');
    for (const exception of inv.exceptions) {
      lines.push(`- ${exception}`);
    }
    lines.push('');
  }

  // Enforced by (for objectives)
  if (inv.enforcedBy && inv.enforcedBy.length > 0) {
    lines.push(`**Enforced by:** ${inv.enforcedBy.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

function renderSpec(): string {
  const objectives = loadBlueprint('objectives.json');
  const rules = loadBlueprint('rules.json');
  const defaults = loadBlueprint('defaults.json');

  const lines: string[] = [];

  // Header
  lines.push('# Code Spec');
  lines.push('');
  lines.push('> **Generated from:** `codespec/blueprints/*.json`');
  lines.push('> ');
  lines.push('> This document is auto-generated. Edit the JSON blueprints, not this file.');
  lines.push('');

  // Overview
  lines.push('## Overview');
  lines.push('');
  lines.push('This specification defines desired code patterns for an AI-generated codebase. It ensures consistency across multiple AI sessions and makes the codebase maintainable by both humans and future AI agents.');
  lines.push('');
  lines.push('**Philosophy:** In an AI-generated codebase, different prompts naturally produce different solutions to the same problem. Without explicit guidance, patterns drift and the codebase becomes inconsistent. This spec provides that guidance.');
  lines.push('');
  lines.push('## How to Read This Spec');
  lines.push('');
  lines.push('This specification is organized into three tiers:');
  lines.push('');
  lines.push('1. **Objectives** - High-level goals and guiding philosophies');
  lines.push('2. **Rules** - Hard constraints that must never be violated');
  lines.push('3. **Default Behaviors** - Standard patterns for common operations');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Objectives
  lines.push('## Objectives');
  lines.push('');
  lines.push('Objectives are high-level goals that provide directional guidance for all code. They inform the rules and default behaviors.');
  lines.push('');
  for (const obj of objectives) {
    lines.push(renderInvariant(obj, 'objective'));
  }
  lines.push('---');
  lines.push('');

  // Rules
  lines.push('## Rules');
  lines.push('');
  lines.push('Rules are hard constraints that must never be violated. Unlike objectives (which are directional) and default behaviors (which can have rare exceptions), rules are absolute.');
  lines.push('');
  for (const rule of rules) {
    lines.push(renderInvariant(rule, 'rule'));
  }
  lines.push('---');
  lines.push('');

  // Default Behaviors
  lines.push('## Default Behaviors');
  lines.push('');
  lines.push('Default behaviors define the standard way to handle common operations. They are consistent with objectives and rules. In rare cases, deviations may be justified (e.g., third-party library constraints), but must be explicitly documented.');
  lines.push('');
  for (const db of defaults) {
    lines.push(renderInvariant(db, 'default'));
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('## References');
  lines.push('');
  lines.push('- [OpenAI Model Spec](https://github.com/openai/model_spec)');
  lines.push('- [PEP 20 - The Zen of Python](https://peps.python.org/pep-0020/)');
  lines.push('- Blueprint source: `codespec/blueprints/`');
  lines.push('');

  return lines.join('\n');
}

// Main
const spec = renderSpec();
writeFileSync(OUTPUT_PATH, spec);
console.log(`✅ Code spec rendered to: ${OUTPUT_PATH}`);
console.log(`   Objectives: ${loadBlueprint('objectives.json').length}`);
console.log(`   Rules: ${loadBlueprint('rules.json').length}`);
console.log(`   Default Behaviors: ${loadBlueprint('defaults.json').length}`);
