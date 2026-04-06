import { GraphQLClient, gql } from 'graphql-request';

const txHash = process.argv[2] || '0x47096b9b45662034591749e9070387a38c433f708d04854a0c1176736e2929d6';

const client = new GraphQLClient('https://indexer.jinn.network/graphql');

const query = gql`
  query GetRequest($txHash: String!) {
    requests(where: { transactionHash: $txHash }) {
      items {
        id
        ipfsHash
        delivered
        jobName
      }
    }
  }
`;

async function main() {
  console.log(`Checking transaction: ${txHash}`);
  const result = await client.request(query, { txHash });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
