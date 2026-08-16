#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const changelogPath = process.env.CHANGELOG_PATH ?? 'operator/CHANGELOG.md';
const releaseName = (process.env.RELEASE_NAME ?? '').trim();
const releaseTag = (process.env.RELEASE_TAG ?? '').trim();
const releaseDate = ((process.env.RELEASE_DATE ?? '').split('T')[0] || new Date().toISOString().slice(0, 10));
const releaseBody = (process.env.RELEASE_BODY ?? '').trimEnd();

if (!releaseTag) {
  throw new Error('RELEASE_TAG is required');
}

const heading = releaseName || releaseTag;
const section = `## ${heading}\n\n_Released ${releaseDate}_\n\n${releaseBody}\n`;

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  console.log(`${name}=${value}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findNextHeadingIndex(text, fromIndex) {
  const headingPattern = /^## /gm;
  headingPattern.lastIndex = fromIndex;
  const match = headingPattern.exec(text);
  return match?.index ?? -1;
}

function findSectionRange(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  const start = match.index;
  const nextHeading = findNextHeadingIndex(text, start + match[0].length);
  return { start, end: nextHeading === -1 ? text.length : nextHeading };
}

function joinChangelog(before, replacement, after) {
  const trimmedBefore = before.replace(/\s*$/, '');
  const trimmedReplacement = replacement.trimEnd();
  const trimmedAfter = after.replace(/^\s*/, '');
  return [trimmedBefore, trimmedReplacement, trimmedAfter].filter(Boolean).join('\n\n').replace(/\s*$/, '\n');
}

const changelog = readFileSync(changelogPath, 'utf8');
const releaseHeadingPattern = new RegExp(
  `^## (?:${escapeRegExp(heading)}|${escapeRegExp(releaseTag)}(?:\\s|$).*)$`,
  'm',
);

const existingRelease = findSectionRange(changelog, releaseHeadingPattern);
let updated;

if (existingRelease) {
  updated = joinChangelog(
    changelog.slice(0, existingRelease.start),
    section,
    changelog.slice(existingRelease.end),
  );
} else {
  const unreleased = /^## Unreleased\s*$/m.exec(changelog);
  let insertAt;

  if (unreleased) {
    const nextHeading = findNextHeadingIndex(changelog, unreleased.index + unreleased[0].length);
    insertAt = nextHeading === -1 ? changelog.length : nextHeading;
  } else {
    const title = /^# .+$/m.exec(changelog);
    if (title) {
      const lineEnd = changelog.indexOf('\n', title.index + title[0].length);
      insertAt = lineEnd === -1 ? changelog.length : lineEnd + 1;
    } else {
      insertAt = 0;
    }
  }

  updated = joinChangelog(changelog.slice(0, insertAt), section, changelog.slice(insertAt));
}

if (updated === changelog) {
  setOutput('changed', 'false');
} else {
  writeFileSync(changelogPath, updated);
  setOutput('changed', 'true');
}
