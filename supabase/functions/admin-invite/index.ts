import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
function getKeys() {
  const p = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'); const s = Deno.env.get('SUPABASE_SECRET_KEYS');
  const publishable = p ? JSON.parse(p).default : (Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY'));
  const secret = s ? JSON.parse(s).default : (Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  if (!publishable || !secret) throw new Error('Supabase API keys are unavailable.'); return { publishable, secret };
}
const allowedRoles = new Set(['finance_admin', 'operations_admin', 'support_admin', 'compliance_admin']);
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
    if (authError || !authData.user) return json({ error: 'Invalid or expired session.' }, 401);
    const { data: aal, error: aalError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if (aalError || aal?.currentLevel !== 'aal2') return json({ error: 'A verified MFA session (AAL2) is required.' }, 403);
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: roles, error: rolesError } = await admin.from('user_roles').select('role').eq('user_id', authData.user.id);
    if (rolesError) throw rolesError;
    if (!(roles || []).some((x) => x.role === 'super_admin')) return json({ error: 'Only the Super Admin can invite administrators.' }, 403);

    const body = await req.json();
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email address is required.' }, 400);
    if (!allowedRoles.has(role)) return json({ error: 'The requested administrator role is not allowed.' }, 400);
    const { data: existing, error: existingError } = await admin.from('admin_invitations').select('id').eq('email', email).eq('status', 'pending').gt('expires_at', new Date().toISOString()).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return json({ error: 'A pending administrator invitation already exists for this email.' }, 409);
    const { data: invitation, error: insertError } = await admin.from('admin_invitations').insert({ email, role, invited_by: authData.user.id }).select('id,email,role,status,created_at,expires_at').single();
    if (insertError) throw insertError;
    const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email);
    if (inviteError) {
      await admin.from('admin_invitations').delete().eq('id', invitation.id);
      return json({ error: `Invitation email could not be sent: ${inviteError.message}` }, 400);
    }
    await admin.from('admin_audit_logs').insert({ actor_user_id: authData.user.id, action: 'admin_invitation_sent', entity_type: 'admin_invitation', entity_id: invitation.id, after_data: { email, role } });
    return json({ invitation, invited_user_id: inviteData.user?.id || null });
  } catch (error) {
    console.error('admin-invite:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected error.' }, 500);
  }
});
