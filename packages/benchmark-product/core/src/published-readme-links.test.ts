/**
 * The README is the only document someone who installed a package from npm holds (issue #4954).
 * A relative link works in a checkout and nowhere else: on the npm page and in `node_modules` it
 * points at a file the tarball never carried. So every link in a published README is absolute, and
 * a path the tarball does not ship is named only as the text of a link that says where to get it.
 *
 * Repository links are written against the `next` branch. The publish `--apply` step rewrites that
 * ref to the publishing commit (`.github/scripts/colophon-publish-manifest.mjs`), so the tarball
 * carries permalinks. A link in any other form would ship as written, which is why the form is
 * held here.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productRoot = resolve(coreRoot, "..");
const repoRoot = resolve(productRoot, "../..");

/** The packages whose README the publish `--apply` step rewrites and npm then serves. */
const PUBLISHED_PACKAGES = ["cli", "core", "check"] as const;

interface PublishedReadme {
  readonly name: string;
  readonly packageDir: string;
  /** The `files` allowlist: what the tarball carries beside `package.json`. */
  readonly files: readonly string[];
  /** `https://github.com/<owner>/<repo>`, from the manifest's own `repository.url`. */
  readonly repositoryUrl: string;
  readonly markdown: string;
}

function publishedReadme(name: string): PublishedReadme {
  const packageDir = resolve(productRoot, name);
  const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
    readonly files: readonly string[];
    readonly repository: { readonly url: string };
  };
  return {
    name,
    packageDir,
    files: manifest.files,
    repositoryUrl: manifest.repository.url.replace(/\.git$/u, ""),
    markdown: readFileSync(resolve(packageDir, "README.md"), "utf8"),
  };
}

const READMES = PUBLISHED_PACKAGES.map(publishedReadme);

/** Markdown with its fenced blocks removed: a command in a fence is not a link or a named path. */
const withoutFences = (markdown: string): string => markdown.replace(/^```[^\n]*\n.*?^```/gmsu, "");

/** Every link destination: inline `[text](target)` and reference definitions `[label]: target`. */
function linkTargets(markdown: string): readonly string[] {
  // Code spans go first so that code such as `a[0](b)` is not read as a link. A span inside a link
  // label leaves `[](target)` behind, which is still a link.
  const prose = withoutFences(markdown).replace(/`[^`\n]+`/gu, "");
  const inline = [...prose.matchAll(/\]\(\s*<?([^)\s>]+)/gu)].map((match) => match[1]!);
  const definitions = [...prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)/gmu)].map((match) => match[1]!);
  return [...inline, ...definitions];
}

/** A destination with no URL scheme that is not an anchor in the README itself. */
const isRelative = (target: string): boolean => !/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(target);

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens. */
const headingAnchor = (heading: string): string =>
  heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /gu, "-");

function headingAnchors(markdown: string): readonly string[] {
  return [...withoutFences(markdown).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gmu)].map((match) => headingAnchor(match[1]!));
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Every mention of a URL under the package's own repository, in whatever Markdown form. */
function repositoryLinks(readme: PublishedReadme): readonly string[] {
  const pattern = new RegExp(`${escapeRegExp(readme.repositoryUrl)}/[^\\s)>\\]]*`, "gu");
  return [...readme.markdown.matchAll(pattern)].map((match) => match[0]);
}

/** Whether the tarball carries `path`, given relative to the package directory. */
function shipped(readme: PublishedReadme, path: string): boolean {
  const normalized = path.replace(/\/$/u, "");
  return readme.files.some((entry) => {
    const allowed = entry.replace(/\/$/u, "");
    return normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

/**
 * Code spans outside any link that name a path this checkout has and the tarball does not: a file
 * elsewhere in the repository, or one in the package directory that `files` leaves out. The reader
 * of an installed README has no such path and no word on where it is.
 */
function unshippedPathsNamedWithoutALink(readme: PublishedReadme): readonly string[] {
  const outsideLinks = withoutFences(readme.markdown).replace(/\[[^\]]*\]\([^)]*\)/gu, "");
  const spans = [...outsideLinks.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]!);
  const looksLikeAPath = (span: string): boolean =>
    /^[\w.-][\w./-]*$/u.test(span) && (span.includes("/") || /\.[a-z]+$/u.test(span));
  return [...new Set(spans)].filter(looksLikeAPath).filter((span) =>
    [readme.packageDir, productRoot, repoRoot].some((base) => {
      const absolute = resolve(base, span);
      if (!existsSync(absolute)) return false;
      const fromPackage = relative(readme.packageDir, absolute);
      return fromPackage.startsWith("..") || !shipped(readme, fromPackage);
    }),
  );
}

describe("published package READMEs resolve for someone who has only the npm package", () => {
  it("holds no relative link and no path that leaves the package", () => {
    const relativeLinks = READMES.flatMap((readme) =>
      linkTargets(readme.markdown).filter(isRelative).map((target) => `${readme.name}/README.md -> ${target}`));
    expect(relativeLinks).toEqual([]);

    // Not every such path is a link: a code span naming `../SOMETHING.md` is as unreachable.
    const leavingThePackage = READMES.flatMap((readme) =>
      readme.markdown.split("\n").filter((line) => line.includes("../")).map((line) => `${readme.name}/README.md: ${line.trim()}`));
    expect(leavingThePackage).toEqual([]);
  });

  it("names a file or directory the tarball does not ship only as a link that says where to get it", () => {
    const unlinked = READMES.flatMap((readme) =>
      unshippedPathsNamedWithoutALink(readme).map((path) => `${readme.name}/README.md names ${path}`));
    expect(unlinked).toEqual([]);
  });

  it("links the repository only at a path that exists, on the ref the publish step pins", () => {
    let checked = 0;
    for (const readme of READMES) {
      expect(readme.repositoryUrl, readme.name).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/u);
      const form = new RegExp(`^${escapeRegExp(readme.repositoryUrl)}/(blob|tree)/next/([^#?]+)(?:#(.+))?$`, "u");
      for (const link of repositoryLinks(readme)) {
        const label = `${readme.name}/README.md -> ${link}`;
        const match = form.exec(link);
        expect(match, `${label} must be a /blob/next/ or /tree/next/ link`).not.toBeNull();
        const [, kind, path, anchor] = match!;
        const target = resolve(repoRoot, decodeURIComponent(path!));
        expect(existsSync(target), `${label} names a path that does not exist`).toBe(true);
        expect(statSync(target).isDirectory(), `${label} must use /tree/ for a directory and /blob/ for a file`)
          .toBe(kind === "tree");
        if (anchor !== undefined) {
          expect(headingAnchors(readFileSync(target, "utf8")), `${label} names a heading that does not exist`)
            .toContain(anchor);
        }
        checked += 1;
      }
    }
    expect(checked, "the scan must find the repository links it is checking").toBeGreaterThan(0);
  });
});
