import { getLLMText, source } from '@/lib/source';

/** Every docs page, concatenated, from the same tree as `/llms.txt`. */
export const dynamic = 'force-static';

export async function GET() {
  const bodies = await Promise.all(source.getPages().map(getLLMText));

  return new Response(bodies.join('\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
