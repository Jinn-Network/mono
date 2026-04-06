#!/usr/bin/env tsx
import { graphQLRequest } from '../http/client.js';

const workstreamId = process.argv[2] || '0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac';

const query = `
  query GetWorkstream($id: String!) {
    workstream(id: $id) {
      id
      rootRequestId
      rootRequest {
        id
        jobDefinitionId
        jobDefinition {
          id
          name
          blueprint
        }
      }
    }
  }
`;

const result = await graphQLRequest(query, { id: workstreamId }, 'https://indexer.jinn.network/graphql');
console.log(JSON.stringify(result, null, 2));
