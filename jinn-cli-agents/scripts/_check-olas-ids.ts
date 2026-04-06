#!/usr/bin/env tsx
import 'dotenv/config';
import { supabase } from 'jinn-node/agent/mcp/tools/shared/supabase.js';

const slugs = ['governance-digest', 'competitive-landscape', 'crypto-token-research', 'code-repository-audit', 'content-campaign'];

async function main() {
  const mode = process.argv[2]; // 'check', 'clear', or 'set'
  // set mode: tsx _check-olas-ids.ts set slug=agentId slug=agentId ...
  const setMap: Record<string, number> = {};
  if (mode === 'set') {
    for (const arg of process.argv.slice(3)) {
      const [slug, id] = arg.split('=');
      if (slug && id) setMap[slug] = parseInt(id, 10);
    }
  }

  for (const slug of slugs) {
    const { data, error } = await supabase
      .from('templates')
      .select('id, slug, olas_agent_id')
      .eq('slug', slug)
      .single();

    if (!data) {
      console.log(`  ${slug}: NOT FOUND (${error?.message || 'unknown'})`);
      continue;
    }

    console.log(`  ${slug}: olas_agent_id=${data.olas_agent_id}`);

    if (mode === 'clear' && data.olas_agent_id) {
      const { error: updateError } = await supabase
        .from('templates')
        .update({ olas_agent_id: null })
        .eq('id', data.id);

      if (updateError) {
        console.log(`    FAIL clearing: ${updateError.message}`);
      } else {
        console.log(`    CLEARED olas_agent_id`);
      }
    }

    if (mode === 'set' && setMap[slug]) {
      const { error: updateError } = await supabase
        .from('templates')
        .update({ olas_agent_id: setMap[slug] })
        .eq('id', data.id);

      if (updateError) {
        console.log(`    FAIL setting: ${updateError.message}`);
      } else {
        console.log(`    SET olas_agent_id=${setMap[slug]}`);
      }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
