#!/usr/bin/env tsx
import '../env/index.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function checkJobs() {
  console.log('Connecting to Supabase...');
  console.log(`URL: ${SUPABASE_URL}`);
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
  
  // Test connection
  const { data: testData, error: testError } = await supabase
    .from('onchain_job_reports')
    .select('count')
    .limit(1);
  
  if (testError) {
    console.error('❌ Connection failed:', testError.message);
    return;
  }
  
  console.log('✅ Connected successfully!\n');
  
  // Get recent job reports
  console.log('='.repeat(80));
  console.log('RECENT JOB REPORTS');
  console.log('='.repeat(80));
  
  const { data: reports, error } = await supabase
    .from('onchain_job_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
  
  if (error) {
    console.error('Error fetching reports:', error.message);
    return;
  }
  
  if (!reports || reports.length === 0) {
    console.log('No job reports found.');
    return;
  }
  
  reports.forEach((report, idx) => {
    console.log(`\n${idx + 1}. Request: ${report.request_id.slice(0, 20)}...`);
    console.log(`   Status: ${report.status}`);
    console.log(`   Worker: ${report.worker_address.slice(0, 20)}...`);
    console.log(`   Duration: ${report.duration_ms}ms`);
    console.log(`   Tokens: ${report.total_tokens || 'N/A'}`);
    if (report.error_message) {
      console.log(`   Error: ${report.error_message.slice(0, 100)}...`);
    }
    console.log(`   Created: ${new Date(report.created_at).toISOString()}`);
  });
  
  // Check the two specific requests we just tested
  console.log('\n' + '='.repeat(80));
  console.log('CHECKING RECENT TEST REQUESTS');
  console.log('='.repeat(80));
  
  const testRequests = [
    '0x57e889cb20d6077a486ccdc2142ffabb321e5cd3b474515fca91d62e32110bc7',
    '0x9f5943370fa5205a751b21d75f418cc51963950129bbe585fc6948afd5b4c789'
  ];
  
  for (const reqId of testRequests) {
    const { data: reqReports } = await supabase
      .from('onchain_job_reports')
      .select('*')
      .eq('request_id', reqId)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (reqReports && reqReports.length > 0) {
      const r = reqReports[0];
      console.log(`\n✓ ${reqId.slice(0, 20)}...`);
      console.log(`  Status: ${r.status}`);
      console.log(`  Error: ${r.error_message || 'None'}`);
    } else {
      console.log(`\n✗ ${reqId.slice(0, 20)}... - No report found`);
    }
  }
  
  console.log('\n' + '='.repeat(80));
}

checkJobs().catch(console.error);
