// SPDX-License-Identifier: Apache-2.0

/**
 * Observe the base repository state a session starts from — the first of the two capture gaps
 * the `autopilot-issue-1697` fixture records.
 *
 * The commit and tree object names are the content binding a verifier resolves. The remote is
 * normalized to a credential-free network IRI before it is ever written, because the record it
 * lands in is durable, never deleted, and publicly projectable: a token sealed into an
 * append-only archive cannot be withdrawn from it.
 *
 * Nothing here throws. An unreadable repository costs the base state and nothing else.
 */

import { execFileSync } from "node:child_process";

/**
 * A session start must not feel like a hang, so the whole observation shares one deadline
 * rather than giving each read its own: an unreachable repository costs the base state, not
 * the first turn.
 */
export const GIT_BUDGET_MS = 2_000;

/** scp-style `git@host:path`, where `:` separates the path — a port cannot appear. */
const SCP_REMOTE = /^(?<user>[^@/]+)@(?<host>[^:/]+):(?<path>.+?)(?:\.git)?$/u;
/** An explicit URL, where `:NNNN` after the host is unambiguously a port. */
const URL_REMOTE = new RegExp(
  "^(?<scheme>[A-Za-z][A-Za-z0-9+.\\-]*)://" +
    // `[^/]*` is greedy so the group backtracks to the LAST `@` before the host, which is
    // where RFC 3986 puts the boundary. Stopping at the first would leave a password behind.
    "(?:(?<userinfo>[^/]*)@)?" +
    "(?<host>[^/:]+)(?::(?<port>\\d+))?" +
    "(?<path>/.*?)(?:\\.git)?$",
  "u",
);
const NETWORK_SCHEMES = new Set(["https", "http", "git", "ssh"]);
/**
 * `URL_REMOTE`'s userinfo group backtracks to the last `@`, which is quadratic on a remote
 * with many of them. No real remote approaches this, so the shape is refused by length before
 * the matcher ever sees it.
 */
const MAX_REMOTE_LENGTH = 2048;

const ABSOLUTE_IRI_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u;

function isNetworkIri(candidate) {
  if (!ABSOLUTE_IRI_SHAPE.test(candidate)) return false;
  try {
    return new URL(candidate).protocol.length > 1;
  } catch {
    return false;
  }
}

/**
 * The lowercased host when it can name a repository for anyone, `""` when it names one for us.
 *
 * Two rules, one reason. A host without a dot is a local alias — an `ssh_config` `Host` entry,
 * or `localhost` — and resolves for nobody else. A host is also case-insensitive, so
 * `GitHub.com` and `github.com` must not seal as two identities for one repository.
 */
function repositoryHost(host) {
  const lowered = (host ?? "").toLowerCase();
  return lowered.includes(".") && !lowered.includes("@") ? lowered : "";
}

/**
 * Normalize a Git remote to a credential-free network IRI, which is what the record needs.
 * Userinfo and local-only remotes are dropped rather than carried: an absent field is what the
 * record accepts gracefully, a confident wrong one is not.
 */
export function repositoryIri(remote) {
  const value = (remote ?? "").trim();
  // Whitespace anywhere makes it not an IRI, and the runtime refuses the whole feed for one.
  if (value === "" || value.length > MAX_REMOTE_LENGTH || /\s/u.test(value)) return "";

  const url = URL_REMOTE.exec(value);
  if (url !== null) {
    const observed = url.groups.scheme.toLowerCase();
    if (!NETWORK_SCHEMES.has(observed)) return "";
    // ssh:// is a transport, not a way to fetch; https names the same repository publicly.
    // The port does not survive that rewrite: 22 (or Gerrit's 29418) names the SSH daemon,
    // not the web endpoint. Keep a port only where the scheme it belongs to is kept.
    const scheme = observed === "ssh" ? "https" : observed;
    const host = repositoryHost(url.groups.host);
    if (host === "") return "";
    const port = url.groups.port && scheme === observed ? `:${url.groups.port}` : "";
    const candidate = `${scheme}://${host}${port}${url.groups.path}`;
    return isNetworkIri(candidate) ? candidate : "";
  }

  const scp = SCP_REMOTE.exec(value);
  if (scp !== null) {
    const host = repositoryHost(scp.groups.host);
    // `host` binds after the first `@` and `path` admits one, so a hand-written
    // `git@x-access-token:ghs_…@github.com/o/r` would otherwise carry its token through this
    // branch. The URL branch drops userinfo at the last `@`; this one has none to drop, so a
    // surviving `@` means the remote is not the shape this branch claims to read.
    if (host === "" || scp.groups.path.includes("@")) return "";
    const candidate = `https://${host}/${scp.groups.path}`;
    return isNetworkIri(candidate) ? candidate : "";
  }

  return "";
}

/**
 * One short read from *cwd*'s repository, or `""` if anything goes wrong.
 *
 * `-C cwd` is load-bearing, not tidiness: the process directory is not the session's. An
 * orchestrator dispatches a session into a worktree while sitting elsewhere, and reading the
 * wrong repository would seal a confident, wrong answer to the one question this record
 * exists to answer.
 */
function git(cwd, deadline, ...args) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "";
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      timeout: remaining,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * The base commit and tree the session in *cwd* starts from, or `undefined`.
 *
 * The commit, tree, and repository identity are the binding and are required together; branch
 * and target base are context this may legitimately fail to find (a detached head, a
 * repository with no upstream).
 */
export function observeRepositoryState(cwd, { now = Date.now } = {}) {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  const deadline = now() + GIT_BUDGET_MS;
  const baseCommit = git(cwd, deadline, "rev-parse", "HEAD");
  const baseTree = git(cwd, deadline, "rev-parse", "HEAD^{tree}");
  const repository = repositoryIri(git(cwd, deadline, "config", "--get", "remote.origin.url"));
  if (baseCommit === "" || baseTree === "" || repository === "") return undefined;
  const upstream = git(
    cwd,
    deadline,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  );
  const separator = upstream.indexOf("/");
  return {
    repository,
    baseCommit,
    baseTree,
    branch: git(cwd, deadline, "rev-parse", "--abbrev-ref", "HEAD"),
    // "origin/next" names the same base as "next"; the remote prefix is local bookkeeping.
    targetBase: separator === -1 ? upstream : upstream.slice(separator + 1),
  };
}
