import 'dotenv/config';
import { enqueueTransaction } from 'jinn-node/agent/mcp/tools/enqueue-transaction.js';
import { getTransactionStatus } from 'jinn-node/agent/mcp/tools/get-transaction-status.js';
import { searchJobs } from 'jinn-node/agent/mcp/tools/search-jobs.js';
import { searchArtifacts } from 'jinn-node/agent/mcp/tools/search-artifacts.js';

async function main() {
  process.env.JINN_CTX_REQUEST_ID = process.env.TEST_REQUEST_ID || '0x273609f62f0510689d41f373426fb08c76b4b9242efe44bc1815e6e5eef54c80';
  process.env.MECH_WORKER_ADDRESS = process.env.MECH_WORKER_ADDRESS || '0xaB15F8d064b59447Bd8E9e89DD3FA770aBF5EEb7';

  console.log('1) searchJobs via Ponder:');
  const sj = await searchJobs({ query: '0x' });
  console.log(sj.content?.[0]?.text);

  console.log('\n2) searchArtifacts via Ponder:');
  const sa = await searchArtifacts({ query: '0x' } as any);
  console.log(sa.content?.[0]?.text);

  console.log('\n3) enqueueTransaction via Control API (dry payload)');
  const et = await enqueueTransaction({
    payload: { to: '0x0000000000000000000000000000000000000000', data: '0x', value: '0' },
    chain_id: 8453,
    execution_strategy: 'SAFE',
  } as any);
  console.log(et.content?.[0]?.text);

  // If a request was enqueued, try get status (this will likely error due to guard clauses)
  const parsed = et.content?.[0]?.text ? JSON.parse(et.content[0].text) : null;
  const id = parsed?.transaction_request?.id;
  if (id) {
    console.log('\n4) getTransactionStatus via Control API:');
    const gs = await getTransactionStatus({ request_id: id });
    console.log(gs.content?.[0]?.text);
  }
}

main().catch(console.error);
