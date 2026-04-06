import fetch from 'cross-fetch';

const PONDER_URL = 'http://localhost:42069';
const WORKSTREAM_ID = '0xd72290dd1f6c022a2bca56e61b1f73a6b1400f79d109e6bd701dff6707ab6f8a';

async function check() {
  const query = `
    query GetWorkstreamRequests($workstreamId: String!) {
      requests(where: { workstreamId: $workstreamId }) {
        items {
          id
          status
          delivered
          jobName
        }
      }
    }
  `;

  try {
    const res = await fetch(PONDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { workstreamId: WORKSTREAM_ID }
      })
    });

    if (!res.ok) {
      console.log('Error fetching Ponder:', res.statusText);
      return;
    }

    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.error('Fetch failed:', e.message);
  }
}

check();
