import { supabase } from 'jinn-node/agent/mcp/tools/shared/supabase.js';

async function main() {
  const projectRunId = process.argv[2];
  if (!projectRunId) {
    console.error('Usage: tsx scripts/get-latest-job-id.ts <project_run_id>');
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('jobs')
    .select('id, created_at')
    .eq('project_run_id', projectRunId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  }
  const id = data && data[0]?.id;
  if (!id) {
    console.error(JSON.stringify({ ok: false, error: 'No jobs found for project_run_id' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, jobId: id }));
}

main();


