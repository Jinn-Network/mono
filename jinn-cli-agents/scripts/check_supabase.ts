import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 0xd72290dd1f6c022a2bca56e61b1f73a6b1400f79d109e6bd701dff6707ab6f8a
const WORKSTREAM_ID = '0xd72290dd1f6c022a2bca56e61b1f73a6b1400f79d109e6bd701dff6707ab6f8a';

async function check() {
  // We don't have a direct link from JobReport to WorkstreamId in the schema I saw.
  // But maybe we can find it in the raw_telemetry or if there is a 'requests' table.
  
  // Let's list tables first to be sure
  // Supabase-js doesn't list tables easily.
  // Let's try to query 'job_reports' and see if we can filter.
  
  const { data: reports, error } = await supabase
    .from('job_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error fetching reports:', error);
  } else {
    console.log('Recent Reports:');
    if (reports.length > 0) {
        console.log('Most recent report telemetry:', reports[0].raw_telemetry);
        console.log('Most recent report output:', reports[0].final_output?.substring(0, 200));
    }
    reports.forEach(r => {
      console.log(`[${r.status}] ID: ${r.id} ReqID: ${r.request_id}`);
      if (r.final_output && r.final_output.includes(WORKSTREAM_ID)) {
          console.log('  -> Found workstream ID in output!');
      }
    });
  }
}

check();
