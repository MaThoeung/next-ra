import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
function apiKeys() {
  const pubRaw = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  const secretRaw = Deno.env.get('SUPABASE_SECRET_KEYS');
  const publishable = pubRaw ? JSON.parse(pubRaw).default : (Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY'));
  const secret = secretRaw ? JSON.parse(secretRaw).default : (Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  if (!publishable || !secret) throw new Error('Supabase API keys are unavailable in the Edge Function environment.');
  return { publishable, secret };
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Authentication required.' }, 401);
    const url = Deno.env.get('SUPABASE_URL');
    if (!url) throw new Error('Supabase URL is unavailable.');
    const { publishable, secret } = apiKeys();
    const userClient = createClient(url, publishable, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return json({ error: 'Invalid or expired session.' }, 401);
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: rows, error } = await admin.from('user_roles').select('role').eq('user_id', authData.user.id);
    if (error) throw error;
    return json({
      user_id: authData.user.id,
      email: authData.user.email,
      roles: (rows || []).map((row) => row.role),
    });
  } catch (error) {
    console.error('session-access:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected error.' }, 500);
  }
});
