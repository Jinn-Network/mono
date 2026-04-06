import { createClient } from "@ponder/client";
import * as schema from "./schema";

const PONDER_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL?.replace('/graphql', '/sql')
  || 'http://localhost:42069/sql';

export const ponderClient = createClient(PONDER_URL, { schema });
