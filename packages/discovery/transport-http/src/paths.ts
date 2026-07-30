import { SEQUENCE_WIDTH, SOURCE_NAME_GRAMMAR, WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

// The archive path grammar, and the whole of this package's answer to
// cross-plan contract 7 (archive exposure scoping): the handler routes
// ONLY what `parseArchivePath` admits, and `parseArchivePath` admits
// exactly five shapes -- the well-known document, a digest path, a
// source head, an archive page, and the SSE tail. Everything else is
// `undefined`, which the handler answers 404. A host that mounts the
// handler therefore cannot leak a sibling route through it, whatever it
// mounts alongside: the grammar is closed, not a denylist.
//
// The shapes mirror `record-discovery-protocol`'s own path helpers
// (`recordPath`, `headPath`, `archivePagePath`, `WELL_KNOWN_PATH`) --
// design §7's "derivable from the digest alone, one digest one path, no
// query parameters required".

const RECORD_PREFIX = "/records/";
const SOURCES_PREFIX = "/sources/";
const HEAD_SUFFIX = "/head";
const ENTRIES_SEGMENT = "/entries/";
const TAIL_SUFFIX = "/tail";

const DIGEST_NAME = /^[0-9a-f]{64}$/;
const PAGE_NAME = new RegExp(`^[0-9]{${SEQUENCE_WIDTH}}$`);

export type ArchiveRoute =
  | { kind: "well-known"; path: string }
  | { kind: "record"; path: string }
  | { kind: "head"; sourceName: string; path: string }
  | { kind: "page"; sourceName: string; page: string; path: string }
  | { kind: "tail"; sourceName: string };

/** The SSE tail endpoint for one source. Not a static-layout object -- see Finding F5. */
export function archiveTailPath(sourceName: string): string {
  return `${SOURCES_PREFIX}${sourceName}${TAIL_SUFFIX}`;
}

/**
 * Removes `basePath` from `pathname`, returning the archive-relative
 * remainder, or `undefined` when `pathname` does not lie under the
 * mount. `basePath` is `""` when the handler is mounted at the origin
 * root.
 */
export function stripBasePath(pathname: string, basePath: string): string | undefined {
  if (basePath === "") return pathname;
  if (pathname === basePath) return "/";
  if (!pathname.startsWith(`${basePath}/`)) return undefined;
  return pathname.slice(basePath.length);
}

/** Classifies an archive-relative path, or `undefined` when it is not one of the five admitted shapes. */
export function parseArchivePath(pathname: string): ArchiveRoute | undefined {
  if (!pathname.startsWith("/")) return undefined;
  if (pathname.includes("//") || pathname.includes("\\")) return undefined;
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return undefined;

  if (pathname === WELL_KNOWN_PATH) return { kind: "well-known", path: pathname };

  if (pathname.startsWith(RECORD_PREFIX)) {
    const name = pathname.slice(RECORD_PREFIX.length);
    return DIGEST_NAME.test(name) ? { kind: "record", path: pathname } : undefined;
  }

  if (!pathname.startsWith(SOURCES_PREFIX)) return undefined;
  const remainder = pathname.slice(SOURCES_PREFIX.length);

  const headIndex = remainder.indexOf(HEAD_SUFFIX);
  if (headIndex > 0 && headIndex + HEAD_SUFFIX.length === remainder.length) {
    const sourceName = remainder.slice(0, headIndex);
    return SOURCE_NAME_GRAMMAR.test(sourceName)
      ? { kind: "head", sourceName, path: pathname }
      : undefined;
  }

  const tailIndex = remainder.indexOf(TAIL_SUFFIX);
  if (tailIndex > 0 && tailIndex + TAIL_SUFFIX.length === remainder.length) {
    const sourceName = remainder.slice(0, tailIndex);
    return SOURCE_NAME_GRAMMAR.test(sourceName) ? { kind: "tail", sourceName } : undefined;
  }

  const entriesIndex = remainder.indexOf(ENTRIES_SEGMENT);
  if (entriesIndex > 0) {
    const sourceName = remainder.slice(0, entriesIndex);
    const page = remainder.slice(entriesIndex + ENTRIES_SEGMENT.length);
    return SOURCE_NAME_GRAMMAR.test(sourceName) && PAGE_NAME.test(page)
      ? { kind: "page", sourceName, page, path: pathname }
      : undefined;
  }

  return undefined;
}
