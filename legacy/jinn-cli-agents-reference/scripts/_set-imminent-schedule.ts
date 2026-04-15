import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Get current schedule
  const { data: venture } = await sb.from('ventures')
    .select('dispatch_schedule')
    .eq('id', '61684d04-bf17-49c6-a190-0b8af9cca532')
    .single();

  const schedule = venture?.dispatch_schedule || [];

  // Add a "fire every minute" entry for testing
  const testEntry = {
    id: 'entry-test-imminent',
    templateId: '86f509ec-433e-49bb-a535-bfe62c57ed90', // venture-measurement
    cron: '* * * * *', // every minute
    input: {},
    label: 'Test imminent dispatch',
    enabled: true,
  };

  // Remove any previous test entry, then add new one
  const filtered = schedule.filter((e: any) => e.id !== 'entry-test-imminent');
  filtered.push(testEntry);

  const { error } = await sb.from('ventures')
    .update({ dispatch_schedule: filtered })
    .eq('id', '61684d04-bf17-49c6-a190-0b8af9cca532');

  if (error) {
    console.error('Failed to update schedule:', error);
    process.exit(1);
  }

  console.log('Schedule updated. New schedule:');
  console.log(JSON.stringify(filtered.map((e: any) => ({ id: e.id, label: e.label, cron: e.cron })), null, 2));
}

main();
