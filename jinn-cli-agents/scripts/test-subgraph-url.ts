
import { request, gql } from 'graphql-request';

const URLS = [
    "https://api.thegraph.com/subgraphs/name/autonolas/governance",
    "https://api.thegraph.com/subgraphs/name/valory/autonolas-governance",
    "https://api.thegraph.com/subgraphs/name/valory/autonolas-tokenomics",
    "https://api.thegraph.com/subgraphs/name/autonolas/veolas"
];

const QUERY = gql`
{
  votingEscrows(first: 1) {
    id
    value
  }
}
`;

async function main() {
    for (const url of URLS) {
        try {
            console.log(`Testing ${url}...`);
            const data = await request(url, QUERY);
            console.log(`SUCCESS: ${url}`);
            console.log(JSON.stringify(data, null, 2));
            return;
        } catch (e) {
            console.log(`Failed ${url}: ${e.message.split('\n')[0]}`);
        }
    }
    console.log("All URLs failed.");
}

main();
