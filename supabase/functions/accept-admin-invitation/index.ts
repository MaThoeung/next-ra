import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
function getKeys() {
  const p = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'); const s = Deno.env.get('SUPABASE_SECRET_KEYS');
  const publishable = p ? JSON.parse(p).default : (Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY'));
  const secret = s ? JSON.parse(s).default : (Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  if (!publishable || !secret) throw new Error('Supabase API keys are unavailable.'); return { publishable, secret };
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Authentication required.' }, 401);
    const url = Deno.env.get('SUPABASE_URL'); if (!url) throw new Error('Supabase URL is unavailable.');
    const { publishable, secret } = getKeys();
    const userClient = createClient(url, publishable, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    const user = authData?.user;
    if (authError || !user?.email) return json({ error: 'A valid signed-in account is required.' }, 401);
    if (!user.email_confirmed_at && !user.confirmed_at) return json({ error: 'Confirm your email address before accepting an administrator invitation.' }, 403);
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = user.email.toLowerCase();
    const { data: invitation, error: findError } = await admin.from('admin_invitations').select('id,email,role,invited_by,expires_at,status').eq('email', email).eq('status', 'pending').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (findError) throw findError;
    if (!invitation) return json({ error: 'No active administrator invitation was found for this verified email address.' }, 404);
    const { error: roleError } = await admin.from('user_roles').upsert({ user_id: user.id, role: invitation.role, assigned_by: invitation.invited_by }, { onConflict: 'user_id,role', ignoreDuplicates: true });
    if (roleError) throw roleError;
    const { error: updateError } = await admin.from('admin_invitations').update({ status: 'accepted', accepted_user_id: user.id, accepted_at: new Date().toISOString() }).eq('id', invitation.id).eq('status', 'pending');
    if (updateError) throw updateError;
    await admin.from('admin_audit_logs').insert({ actor_user_id: user.id, action: 'admin_invitation_accepted', entity_type: 'admin_invitation', entity_id: invitation.id, after_data: { role: invitation.role, email } });
    return json({ accepted: true, role: invitation.role, message: 'Invitation accepted. Set up an authenticator app before opening administrative tools.' });
  } catch (error) {
    console.error('accept-admin-invitation:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected error.' }, 500);
  }
});
