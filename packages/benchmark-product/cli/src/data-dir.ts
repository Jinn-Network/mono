import { isAbsolute, join } from "node:path";

/** Resolves Colophon's product-owned machine data without reading a harness home. */
export function colophonDataDir(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const explicit = environment.COLOPHON_DATA_HOME?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (!isAbsolute(explicit)) throw new Error("COLOPHON_DATA_HOME must be an absolute path");
    return explicit;
  }
  const xdg = environment.XDG_DATA_HOME?.trim();
  if (xdg !== undefined && xdg !== "") {
    if (!isAbsolute(xdg)) throw new Error("XDG_DATA_HOME must be an absolute path");
    return join(xdg, "Colophon");
  }
  if (platform === "win32") {
    const local = environment.LOCALAPPDATA?.trim();
    return local !== undefined && local !== "" && isAbsolute(local) ? join(local, "Colophon") : undefined;
  }
  const home = environment.HOME?.trim();
  if (home === undefined || home === "" || !isAbsolute(home)) return undefined;
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "Colophon")
    : join(home, ".local", "share", "Colophon");
}
