import { z } from "zod";
import { RECORD_DISCOVERY_VERSION } from "./identifiers.js";
import { isSourceName, splitOrigin } from "./grammar.js";

// Source Head (§5.2) -- the one mutable, DSSE-signed document per source.
// Field set frozen at design §16 item 3: {origin, sequence, entry, issuedAt,
// refreshBy}, pinned origin grammar (agent IRI + last "/" + source name).

export interface SourceHead {
  protocol: string;
  origin: string;
  sequence: string;
  entry: `sha256:${string}`;
  issuedAt: string;
  refreshBy: string;
}

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const SequenceSchema = z.string().regex(/^[0-9]{16}$/);

const SourceHeadSchema = z.looseObject({
  protocol: z.literal(RECORD_DISCOVERY_VERSION),
  origin: z.string().min(1),
  sequence: SequenceSchema,
  entry: Sha256DigestSchema,
  issuedAt: z.string().min(1),
  refreshBy: z.string().min(1),
});

/**
 * Parses and validates a Source Head per §5.2/§16 item 3: the `origin` must
 * split (on its last "/", §5.2) into a non-empty agent IRI and a
 * source-name-shaped segment (SOURCE_NAME_GRAMMAR, §5.1).
 */
export function parseSourceHead(json: unknown): SourceHead {
  const parsed = SourceHeadSchema.parse(json);

  const { agent, name } = splitOrigin(parsed.origin);
  if (agent.length === 0) {
    throw new Error(`Origin must carry a non-empty agent IRI before the last "/": ${parsed.origin}`);
  }
  if (!isSourceName(name)) {
    throw new Error(`Origin's source-name segment is not source-name-shaped: ${name}`);
  }

  return parsed as SourceHead;
}
