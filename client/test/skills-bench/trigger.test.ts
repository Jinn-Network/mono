import { describe, expect, it } from 'vitest';
import { sessionJsonlPath, detectSkillTrigger } from '../../src/skills-bench/trigger.js';

describe('sessionJsonlPath', () => {
  it('slugs the cwd by replacing every non-alphanumeric character with a dash', () => {
    // Mirrors the exact shape observed in a real smoke-run session dir:
    // an apostrophe immediately followed by a slash produces a real double
    // dash (`-s--`), and a `.claude` dot-dir loses its leading dot the same
    // way every other separator does.
    const cwd = "/Users/op/life's-work/proj/.claude/worktrees/w/bench/runs/r/work/solve-tdd-0-abc123";
    const expectedSlug =
      '-Users-op-life-s-work-proj--claude-worktrees-w-bench-runs-r-work-solve-tdd-0-abc123';
    const result = sessionJsonlPath('/config-dir', cwd, 'session-xyz');
    expect(result).toBe(`/config-dir/projects/${expectedSlug}/session-xyz.jsonl`);
  });

  it('is a pure function of its three arguments', () => {
    const a = sessionJsonlPath('/cfg', '/a/b/c', 'sid');
    const b = sessionJsonlPath('/cfg', '/a/b/c', 'sid');
    expect(a).toBe(b);
  });
});

// --- synthetic fixture builders --------------------------------------------
// Minimal event shapes matching the real signature derived from inspecting
// bench/.claude-bench-config/projects/ (see trigger.ts module doc). Synthetic
// ids/content only — no real smoke session content is reproduced here.

function assistantSkillToolUse(id: string, skill: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] },
  });
}

function assistantSkillListing(skills: string[]): string {
  // Mirrors the real `skill_listing` attachment shape — present in every
  // session regardless of arm, and must NEVER be treated as trigger evidence.
  return JSON.stringify({
    type: 'attachment',
    attachment: { type: 'skill_listing', content: skills.map((s) => `- ${s}: some description`).join('\n') },
  });
}

function assistantOtherToolUse(name: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_other', name, input: {} }] },
  });
}

function userToolResult(toolUseId: string, isError = false): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: isError }] },
  });
}

describe('detectSkillTrigger', () => {
  it('detects a genuine Skill tool_use naming the mounted skill', () => {
    const jsonl = [
      assistantSkillListing(['tdd', 'dataviz']),
      assistantSkillToolUse('toolu_1', 'tdd'),
      userToolResult('toolu_1', false),
    ].join('\n');
    const result = detectSkillTrigger(jsonl, 'tdd');
    expect(result.triggered).toBe(true);
    expect(result.evidence.length).toBeGreaterThan(0);
    // Evidence must be short descriptors, never full event bodies.
    for (const e of result.evidence) {
      expect(e).toMatch(/^(assistant|user)#\d+$/);
    }
  });

  it('is case-insensitive and trims whitespace on the skill name', () => {
    const jsonl = assistantSkillToolUse('toolu_1', '  TDD  ');
    expect(detectSkillTrigger(jsonl, 'tdd').triggered).toBe(true);
  });

  it('does NOT trigger on the skill_listing catalog attachment alone (the false-positive this rig must avoid)', () => {
    // This is the exact real-data finding: a treatment arm's skill_listing
    // includes the mounted skill's name because it is available, not
    // because it was used. Substring-matching the whole event would
    // wrongly report every treatment attempt as triggered.
    const jsonl = [
      assistantSkillListing(['tdd', 'dataviz']),
      assistantOtherToolUse('Bash'),
      assistantOtherToolUse('Read'),
    ].join('\n');
    expect(detectSkillTrigger(jsonl, 'tdd').triggered).toBe(false);
  });

  it('does not trigger when no Skill tool_use is present at all (the real smoke-run null)', () => {
    // Mirrors the real captured smoke sessions: Bash/Read/Edit tool_use only,
    // no Skill tool_use anywhere, even though the skill was mounted and
    // listed. This is a genuine "not exercised" case, not a detector bug.
    const jsonl = [
      assistantSkillListing(['tdd']),
      assistantOtherToolUse('Read'),
      assistantOtherToolUse('Bash'),
      assistantOtherToolUse('Edit'),
    ].join('\n');
    expect(detectSkillTrigger(jsonl, 'tdd').triggered).toBe(false);
  });

  it('does not trigger for a Skill tool_use naming a different skill', () => {
    const jsonl = assistantSkillToolUse('toolu_1', 'dataviz');
    expect(detectSkillTrigger(jsonl, 'tdd').triggered).toBe(false);
  });

  it('downgrades to not-triggered when the paired tool_result is an explicit error', () => {
    const jsonl = [
      assistantSkillToolUse('toolu_1', 'tdd'),
      userToolResult('toolu_1', true), // is_error: true — the call failed
    ].join('\n');
    expect(detectSkillTrigger(jsonl, 'tdd').triggered).toBe(false);
  });

  it('still triggers when the tool_result is missing entirely (session truncated)', () => {
    const jsonl = assistantSkillToolUse('toolu_1', 'tdd');
    expect(detectSkillTrigger(jsonl, 'tdd').triggered).toBe(true);
  });

  it('triggers if at least one of several matched invocations succeeds', () => {
    const jsonl = [
      assistantSkillToolUse('toolu_1', 'tdd'),
      userToolResult('toolu_1', true),
      assistantSkillToolUse('toolu_2', 'tdd'),
      userToolResult('toolu_2', false),
    ].join('\n');
    expect(detectSkillTrigger(jsonl, 'tdd').triggered).toBe(true);
  });

  it('ignores malformed/non-JSON lines without throwing', () => {
    const jsonl = ['not json at all', assistantSkillToolUse('toolu_1', 'tdd'), '{broken'].join('\n');
    expect(detectSkillTrigger(jsonl, 'tdd').triggered).toBe(true);
  });

  it('handles empty input', () => {
    expect(detectSkillTrigger('', 'tdd')).toEqual({ triggered: false, evidence: [] });
  });
});
