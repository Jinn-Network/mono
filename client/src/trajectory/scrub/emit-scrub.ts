import { computeGenesisHash, computePrevSpanHash } from '../hash-chain.js';
import type { RedactionManifest, Span } from '../schema.js';
import type { ScrubPipeline } from './pipeline.js';

/**
 * Seller-side scrub applied at emit time, before a trajectory is signed and
 * published. Runs every span's attributes (and each event's attributes) through
 * the pipeline, rebuilds the prev-span hash chain over the scrubbed spans, and
 * produces the redaction manifest (one entry per span listing the keys touched;
 * `event.<key>` for event-attribute redactions).
 */
export async function scrubSpansForEmit(
  spans: Span[],
  pipeline: ScrubPipeline,
  taskCid: string,
): Promise<{ spans: Span[]; redactionManifest: RedactionManifest }> {
  const out: Span[] = [];
  const manifestSpans: RedactionManifest['spans'] = [];
  let total = 0;
  let prev = computeGenesisHash(taskCid);

  for (const span of spans) {
    const redactedKeys = new Set<string>();

    const attrResult = await pipeline.run(span.attributes ?? {});
    for (const r of attrResult.redactions) redactedKeys.add(r.key);

    const events: Span['events'] = [];
    for (const event of span.events) {
      if (event.attributes && Object.keys(event.attributes).length > 0) {
        const evResult = await pipeline.run(event.attributes);
        events.push({ ...event, attributes: evResult.attributes });
        for (const r of evResult.redactions) redactedKeys.add(`event.${r.key}`);
      } else {
        events.push(event);
      }
    }

    const scrubbed: Span = {
      ...span,
      attributes: { ...attrResult.attributes, 'jinn.prevSpanHash': prev },
      events,
    };
    out.push(scrubbed);
    prev = computePrevSpanHash(scrubbed);

    if (redactedKeys.size > 0) {
      const keys = [...redactedKeys];
      manifestSpans.push({ spanId: span.spanId, redactedKeys: keys });
      total += keys.length;
    }
  }

  return { spans: out, redactionManifest: { spans: manifestSpans, totalRedactions: total } };
}

/**
 * Unions two redaction manifests by spanId (dedup redactedKeys per span). Used
 * when an ingestion-time manifest (e.g. a capture's stored redactedKeys) is
 * combined with the emit-time pipeline manifest. Keeps the
 * `totalRedactions === sum(redactedKeys)` invariant the schema enforces.
 */
export function mergeRedactionManifests(a: RedactionManifest, b: RedactionManifest): RedactionManifest {
  const bySpan = new Map<string, Set<string>>();
  for (const m of [a, b]) {
    for (const s of m.spans) {
      const set = bySpan.get(s.spanId) ?? new Set<string>();
      for (const k of s.redactedKeys) set.add(k);
      bySpan.set(s.spanId, set);
    }
  }
  const spans = [...bySpan]
    .map(([spanId, keys]) => ({ spanId, redactedKeys: [...keys] }))
    .filter((s) => s.redactedKeys.length > 0);
  return { spans, totalRedactions: spans.reduce((n, s) => n + s.redactedKeys.length, 0) };
}
