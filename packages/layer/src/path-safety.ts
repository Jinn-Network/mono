import { isAbsolute, relative, resolve } from 'node:path';

/** True when `candidate` resolves to `root` or one of its descendants. */
export function isInsidePackageDir(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
