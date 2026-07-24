import { REPO } from '../dispatcher/constants.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';

const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 100;

/** Read every issue comment through individually observable REST requests. */
export async function readIssueCommentBodies(
  run: CommandRunner,
  issueNumber: number,
): Promise<readonly string[]> {
  const bodies: string[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const endpoint = `repos/${REPO}/issues/${issueNumber}/comments`
      + `?per_page=${COMMENT_PAGE_SIZE}&page=${page}`;
    const parsed = JSON.parse(await run('gh', ['api', endpoint])) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Issue comment REST page is malformed');
    for (const row of parsed) {
      if (
        typeof row !== 'object'
        || row === null
        || typeof (row as { body?: unknown }).body !== 'string'
      ) {
        throw new Error('Issue comment REST row is malformed');
      }
      bodies.push((row as { body: string }).body);
    }
    if (parsed.length < COMMENT_PAGE_SIZE) return bodies;
  }
  throw new Error('Issue comment REST pagination exceeded safety limit');
}
