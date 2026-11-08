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
    if (authError || !authData.user) return json({ error: 'Invalid or expired session.' }, 401);
    const { data: aal, error: aalError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if (aalError || aal?.currentLevel !== 'aal2') return json({ error: 'A verified MFA session (AAL2) is required.' }, 403);
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: roles, error: roleError } = await admin.from('user_roles').select('role').eq('user_id', authData.user.id);
    if (roleError) throw roleError;
    if (!(roles || []).some((r) => ['super_admin','compliance_admin'].includes(r.role))) return json({ error: 'Only Super Admin or Compliance Admin may review KYC.' }, 403);
    const body = await req.json();
    const submissionId = String(body.submission_id || ''); const status = String(body.status || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) return json({ error: 'Invalid KYC submission reference.' }, 400);
    if (!['approved','rejected','resubmission_required'].includes(status)) return json({ error: 'Unsupported KYC review status.' }, 400);
    const reason = String(body.rejection_reason || '').trim();
    if (status !== 'approved' && !reason) return json({ error: 'A review note is required when the submission is not approved.' }, 400);
    const { data: submission, error: getError } = await admin.from('kyc_submissions').select('id,user_id,status').eq('id', submissionId).maybeSingle();
    if (getError) throw getError; if (!submission) return json({ error: 'KYC submission not found.' }, 404);
    if (submission.status !== 'pending') return json({ error: 'This KYC submission has already been reviewed.' }, 409);
    const now = new Date().toISOString();
    const { error: updateError } = await admin.from('kyc_submissions').update({ status, reviewed_by: authData.user.id, reviewed_at: now, rejection_reason: status === 'approved' ? null : reason.slice(0, 1000) }).eq('id', submissionId).eq('status', 'pending');
    if (updateError) throw updateError;
    const { error: docsError } = await admin.from('kyc_documents').update({ reviewed_by: authData.user.id, reviewed_at: now }).eq('submission_id', submissionId);
    if (docsError) throw docsError;
    await admin.from('notifications').insert({ user_id: submission.user_id, title: `Identity verification ${status.replaceAll('_',' ')}`, body: status === 'approved' ? 'Your identity verification has been approved.' : reason.slice(0, 1000), notification_type: 'kyc' });
    await admin.from('admin_audit_logs').insert({ actor_user_id: authData.user.id, action: `kyc_${status}`, entity_type: 'kyc_submission', entity_id: submissionId, before_data: { status: submission.status }, after_data: { status, reason: reason || null } });
    return json({ success: true, submission_id: submissionId, status });
  } catch (error) {
    console.error('admin-review-kyc:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected error.' }, 500);
  }
});
