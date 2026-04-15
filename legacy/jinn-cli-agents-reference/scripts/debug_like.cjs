
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: [path.resolve(__dirname, '../frontend/app/.env.local'), '.env'] });

console.log('Keys:', Object.keys(process.env).filter(k => k.includes('SUPABASE')));

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('Missing credentials');
    console.log('URL:', !!supabaseUrl);
    console.log('Service Key:', !!serviceKey);
    console.log('Anon Key:', !!anonKey);
    process.exit(1);
}

const adminClient = createClient(supabaseUrl, serviceKey);
const anonClient = createClient(supabaseUrl, anonKey);

async function testRLS() {
    console.log('Testing RLS Visibility...');

    // 1. Get Venture
    const { data: ventures } = await adminClient
        .from('ventures')
        .select('id, name')
        .limit(1);

    if (!ventures || ventures.length === 0) {
        console.error('No ventures found');
        return;
    }
    const venture = ventures[0];
    console.log(`Using venture: ${venture.name} (${venture.id})`);
    const userAddress = '0xTestRLSUser';

    // 2. Insert Like (Admin)
    console.log('Inserting like (Admin)...');
    const { error: insertError } = await adminClient
        .from('likes')
        .insert({ venture_id: venture.id, user_address: userAddress });

    if (insertError) {
        if (insertError.code === '23505') console.log('Like already exists');
        else {
            console.error('Insert failed:', insertError);
            return;
        }
    } else {
        console.log('Insert success');
    }

    // 3. Read Like (Anon)
    console.log('Reading like (Anon)...');
    const { data: likes, error: readError } = await anonClient
        .from('likes')
        .select('*')
        .eq('venture_id', venture.id)
        .eq('user_address', userAddress);

    if (readError) {
        console.error('Read failed:', readError);
    } else {
        console.log(`Anon client found ${likes.length} records.`);
        if (likes.length === 0) {
            console.error('FAILURE: RLS prevents Anon from seeing the record!');
        } else {
            console.log('SUCCESS: RLS allows Anon to see the record.');
        }
    }

    // 4. Cleanup
    await adminClient.from('likes').delete().eq('venture_id', venture.id).eq('user_address', userAddress);
    console.log('Cleaned up');
}

testRLS();
