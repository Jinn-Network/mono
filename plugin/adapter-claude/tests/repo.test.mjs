// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { observeRepositoryState, repositoryIri } from "../src/repo.mjs";
import { temp } from "./helpers.mjs";

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function makeRepo(remote) {
  const path = temp("jinn-claude-repo-");
  git(path, "init", "-q");
  git(path, "config", "user.email", "t@example.test");
  git(path, "config", "user.name", "T");
  git(path, "config", "commit.gpgsign", "false");
  writeFileSync(join(path, "f.txt"), path);
  git(path, "add", "f.txt");
  git(path, "commit", "-qm", "one");
  git(path, "remote", "add", "origin", remote);
  return path;
}

test("a git remote becomes a credential-free network IRI", () => {
  for (const [remote, expected] of [
    ["git@github.com:Jinn-Network/mono.git", "https://github.com/Jinn-Network/mono"],
    ["https://github.com/Jinn-Network/mono.git", "https://github.com/Jinn-Network/mono"],
    // The remote every GitHub Actions checkout writes. A token sealed into an append-only
    // archive cannot be withdrawn from it, so it is stripped here, at the source.
    ["https://x-access-token:ghs_secret@github.com/o/r.git", "https://github.com/o/r"],
    // ssh:// is a transport; https names the same repository publicly, and :22 names the SSH
    // daemon rather than the web endpoint, so it does not survive the rewrite.
    ["ssh://git@github.com:22/o/r.git", "https://github.com/o/r"],
    ["https://GitHub.com/O/R", "https://github.com/O/R"],
    ["https://gerrit.example.com:8443/o/r", "https://gerrit.example.com:8443/o/r"],
  ]) {
    assert.equal(repositoryIri(remote), expected, remote);
  }
});

test("a remote that names a repository only on this machine names none at all", () => {
  for (const remote of [
    "file:///Users/someone/repo",
    "/Users/someone/repo",
    "git@myhost:owner/repo.git", // an ssh_config alias: a plausible host that resolves for us
    "https://localhost/o/r",
    "git@x-access-token:ghs_secret@github.com/o/r",
    "",
    "   ",
    "https://github.com/o/r with a space",
    `https://github.com/${"o".repeat(3000)}`,
  ]) {
    assert.equal(repositoryIri(remote), "", remote);
  }
});

test("observing reads the commit and tree the session started from", () => {
  const repo = makeRepo("https://github.com/example/repo.git");
  const observed = observeRepositoryState(repo);
  assert.equal(observed.repository, "https://github.com/example/repo");
  assert.match(observed.baseCommit, /^[0-9a-f]{40}$/u);
  assert.match(observed.baseTree, /^[0-9a-f]{40}$/u);
  assert.notEqual(observed.baseCommit, observed.baseTree);
  assert.equal(observed.targetBase, ""); // no upstream configured
});

test("a repository whose remote names no public identity reports nothing", () => {
  assert.equal(observeRepositoryState(makeRepo("/somewhere/local")), undefined);
});

test("a directory that is not a repository, or no directory at all, reports nothing", () => {
  assert.equal(observeRepositoryState(temp()), undefined);
  assert.equal(observeRepositoryState(""), undefined);
  assert.equal(observeRepositoryState(undefined), undefined);
});

test("the base state comes from the session directory, not the process directory", () => {
  // An orchestrator dispatches a session into a worktree while sitting elsewhere. Reading the
  // process directory would seal a confident, wrong answer to exactly the question this
  // record exists to answer.
  const elsewhere = makeRepo("https://github.com/example/repoA.git");
  const session = makeRepo("https://github.com/example/repoB.git");
  const previous = process.cwd();
  try {
    process.chdir(elsewhere);
    assert.equal(observeRepositoryState(session).repository, "https://github.com/example/repoB");
  } finally {
    process.chdir(previous);
  }
});

test("a spent budget costs the observation rather than the session start", () => {
  const repo = makeRepo("https://github.com/example/repo.git");
  assert.equal(observeRepositoryState(repo, { now: () => Date.now() - 60_000 }), undefined);
});
