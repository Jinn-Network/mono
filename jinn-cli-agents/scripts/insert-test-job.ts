import { supabase } from 'jinn-node/agent/mcp/tools/shared/supabase.js';

async function main() {
  const projectDefinitionId = process.argv[2] || '20465d3e-b598-433d-b556-cffb5c296de8';
  try {
    const job = {
      name: 'Test Image Posting Job',
      description: 'Temporary job for test-worker lineage',
      prompt_content: 'Temporary job context for test-worker run',
      enabled_tools: ['civitai_generate_image', 'civitai_publish_post'],
      project_definition_id: projectDefinitionId,
      schedule_config: { trigger: 'manual' },
      is_active: true
    } as any;

    const { data, error } = await supabase
      .from('jobs')
      .insert(job)
      .select('id')
      .single();

    if (error) {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, id: data?.id }));
  } catch (e: any) {
    console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    process.exit(1);
  }
}

main();


