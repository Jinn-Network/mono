import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: venture } = await sb.from('ventures')
    .select('dispatch_schedule')
    .eq('id', '61684d04-bf17-49c6-a190-0b8af9cca532')
    .single();

  const schedule = venture?.dispatch_schedule || [];
  const filtered = schedule.filter((e: any) => e.id !== 'entry-test-imminent');

  const { error } = await sb.from('ventures')
    .update({ dispatch_schedule: filtered })
    .eq('id', '61684d04-bf17-49c6-a190-0b8af9cca532');

  if (error) {
    console.error('Failed:', error);
    process.exit(1);
  }

  console.log('Test entry removed. Remaining schedule:');
  console.log(JSON.stringify(filtered.map((e: any) => ({ id: e.id, label: e.label })), null, 2));
}

main();
