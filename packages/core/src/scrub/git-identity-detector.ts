/**
 * git-identity detector — deterministic B2 findings for personal names in
 * structured git carriers (#1970 / design §3.2 B2, §6.2):
 *
 *  - `Author:` / `Committer:` / `Co-Authored-By:` / `Signed-off-by:` lines
 *  - `git config user.name` / `git config user.email` (and `user.name=` /
 *    `user.email=` config-list forms)
 *
 * Emits name (and email-on-user.email carriers) as B2 VERY_HIGH. Emails on
 * Author-style trailers stay with the B1 plain-patterns detector so spans do
 * not overlap; both still redact on the same line (joint effect). Free-prose
 * names outside these carriers are untouched.
 */

import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Detector, Finding } from './finding.js';
import type { Attributes } from './types.js';

const VERSION = '0.1.0';

/** Trailer labels that carry a display name (optional `<email>`). */
const TRAILER_LABEL =
  /^(Author|Committer|Co-Authored-By|Signed-off-by):\s*/gim;

/**
 * `git config [--global|--local|…] user.name VALUE` — VALUE may be quoted.
 * Captures only the value, not the carrier keywords.
 */
const GIT_CONFIG_NAME =
  /\bgit\s+config\s+(?:--\w+\s+)*user\.name\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))/gi;

/** Same shape for `user.email`. */
const GIT_CONFIG_EMAIL =
  /\bgit\s+config\s+(?:--\w+\s+)*user\.email\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))/gi;

/** `git config --list` / env-dump style: `user.name=…` at line start. */
const USER_NAME_ASSIGN =
  /^user\.name\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\n]+?))\s*$/gim;

const USER_EMAIL_ASSIGN =
  /^user\.email\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\n]+?))\s*$/gim;

function firstCapture(match: RegExpExecArray): { value: string; groupIndex: number } | null {
  for (let i = 1; i < match.length; i += 1) {
    const g = match[i];
    if (g !== undefined && g.length > 0) return { value: g, groupIndex: i };
  }
  return null;
}

function captureOffset(match: RegExpExecArray, groupIndex: number): number {
  // Reconstruct start of the chosen capture group within match[0].
  // Groups are alternatives — only one is set — so search the full match text.
  const full = match[0]!;
  const value = match[groupIndex]!;
  const at = full.lastIndexOf(value);
  return match.index + (at >= 0 ? at : 0);
}

function pushFinding(
  findings: Finding[],
  key: string,
  start: number,
  end: number,
  evidence: string,
  detector: { name: string; version: string },
): void {
  if (start < 0 || end <= start) return;
  findings.push({
    class: 'B2',
    span: { key, start, end },
    confidence: 'VERY_HIGH',
    evidence: [evidence],
    detector,
  });
}

function collectTrailers(
  text: string,
  key: string,
  detector: { name: string; version: string },
): Finding[] {
  const findings: Finding[] = [];
  const re = new RegExp(TRAILER_LABEL.source, TRAILER_LABEL.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const valueStart = match.index + match[0]!.length;
    const lineEnd = text.indexOf('\n', valueStart);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const rest = text.slice(valueStart, end);

    // Prefer `Name <email>` — redact name only (email → B1).
    const angle = /^(.*?)\s*<[^>\n]*>\s*$/.exec(rest);
    if (angle) {
      const rawName = angle[1] ?? '';
      const name = rawName.trim();
      if (name.length > 0) {
        const leading = rawName.length - rawName.trimStart().length;
        const start = valueStart + leading;
        pushFinding(findings, key, start, start + name.length, 'git-identity:trailer-name', detector);
      }
      continue;
    }

    const name = rest.trim();
    if (name.length > 0) {
      const leading = rest.length - rest.trimStart().length;
      const start = valueStart + leading;
      pushFinding(findings, key, start, start + name.length, 'git-identity:trailer-name', detector);
    }
  }
  return findings;
}

function collectConfigCaptures(
  text: string,
  key: string,
  pattern: RegExp,
  evidence: string,
  detector: { name: string; version: string },
): Finding[] {
  const findings: Finding[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const captured = firstCapture(match);
    if (!captured) continue;
    const start = captureOffset(match, captured.groupIndex);
    pushFinding(findings, key, start, start + captured.value.length, evidence, detector);
  }
  return findings;
}

export function gitIdentityDetector(policy: KeyPolicy): Detector {
  const meta = { name: 'git-identity', version: VERSION };
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        findings.push(...collectTrailers(value, key, meta));
        findings.push(
          ...collectConfigCaptures(value, key, GIT_CONFIG_NAME, 'git-identity:user-name', meta),
        );
        findings.push(
          ...collectConfigCaptures(value, key, GIT_CONFIG_EMAIL, 'git-identity:user-email', meta),
        );
        findings.push(
          ...collectConfigCaptures(value, key, USER_NAME_ASSIGN, 'git-identity:user-name', meta),
        );
        findings.push(
          ...collectConfigCaptures(value, key, USER_EMAIL_ASSIGN, 'git-identity:user-email', meta),
        );
      }
      return findings;
    },
  };
}
