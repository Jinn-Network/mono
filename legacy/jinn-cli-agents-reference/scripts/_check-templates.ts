import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: templates } = await sb.from('templates').select('id, name').limit(10);
  console.log('=== Templates ===');
  console.log(JSON.stringify(templates, null, 2));

  // Also check The Long Run venture's current schedule
  const { data: venture } = await sb.from('ventures').select('id, name, dispatch_schedule').eq('id', '61684d04-bf17-49c6-a190-0b8af9cca532').single();
  console.log('\n=== The Long Run schedule ===');
  console.log(JSON.stringify(venture?.dispatch_schedule, null, 2));
}

main();
