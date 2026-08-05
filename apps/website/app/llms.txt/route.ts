import { llms } from 'fumadocs-core/source';
import { source } from '@/lib/source';

/**
 * The index. Compiled from the same content tree the HTML pages are built
 * from — there is no separately maintained agent copy to drift (DevX surface
 * design §6.4).
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(llms(source).index(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
