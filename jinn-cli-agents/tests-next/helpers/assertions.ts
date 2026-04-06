import fetch from 'cross-fetch';

export interface PollOptions {
  maxAttempts?: number;
  delayMs?: number;
}

interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
}

async function pollGraphQL<T>(
  url: string,
  request: GraphQLRequest,
  extractor: (payload: any) => T | null,
  options?: PollOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 30;
  const delayMs = options?.delayMs ?? 2000;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!resp.ok) {
        lastErr = new Error(`GraphQL HTTP ${resp.status}`);
      } else {
        const body = await resp.json();
        const extracted = extractor(body);
        if (extracted) {
          return extracted;
        }
      }
    } catch (err) {
      lastErr = err as Error;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastErr ?? new Error('GraphQL polling timed out');
}

export async function waitForDelivery(
  gqlUrl: string,
  requestId: string,
  options?: PollOptions
): Promise<any> {
  return pollGraphQL(
    gqlUrl,
    {
      query: 'query($id:String!){ delivery(id:$id){ id requestId ipfsHash transactionHash blockTimestamp } }',
      variables: { id: requestId },
    },
    (payload) => payload?.data?.delivery?.id ? payload.data.delivery : null,
    options
  );
}

export async function waitForArtifact(
  gqlUrl: string,
  artifactId: string,
  options?: PollOptions
): Promise<any> {
  return pollGraphQL(
    gqlUrl,
    {
      query: 'query($id:String!){ artifact(id:$id){ id requestId name topic cid contentPreview } }',
      variables: { id: artifactId },
    },
    (payload) => payload?.data?.artifact?.id ? payload.data.artifact : null,
    options
  );
}

export async function waitForJobDefinition(
  gqlUrl: string,
  jobDefinitionId: string,
  options?: PollOptions
): Promise<any> {
  return pollGraphQL(
    gqlUrl,
    {
      query: 'query($id:String!){ jobDefinition(id:$id){ id name enabledTools sourceRequestId sourceJobDefinitionId } }',
      variables: { id: jobDefinitionId },
    },
    (payload) => payload?.data?.jobDefinition?.id ? payload.data.jobDefinition : null,
    options
  );
}

export async function waitForRequest(
  gqlUrl: string,
  requestId: string,
  options?: PollOptions
): Promise<any> {
  return pollGraphQL(
    gqlUrl,
    {
      query: 'query($id:String!){ request(id:$id){ id jobDefinitionId ipfsHash sourceRequestId sourceJobDefinitionId } }',
      variables: { id: requestId },
    },
    (payload) => payload?.data?.request?.id ? payload.data.request : null,
    options
  );
}
