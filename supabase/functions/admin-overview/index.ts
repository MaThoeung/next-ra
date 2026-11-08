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
    const { data: roleRows, error: roleError } = await admin.from('user_roles').select('role').eq('user_id', authData.user.id);
    if (roleError) throw roleError;
    const roles = (roleRows || []).map((r) => r.role);
    if (!roles.length) return json({ error: 'Administrator access required.' }, 403);

    const [users, pendingKycCount, pendingDepositCount, pendingWithdrawalCount, pendingKyc, pendingInvitations] = await Promise.all([
      admin.from('profiles').select('id', { count: 'exact', head: true }),
      admin.from('kyc_submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('deposits').select('id', { count: 'exact', head: true }).in('status', ['submitted', 'under_review']),
      admin.from('withdrawals').select('id', { count: 'exact', head: true }).in('status', ['requested', 'under_review']),
      admin.from('kyc_submissions').select('id,user_id,status,submitted_at').eq('status', 'pending').order('submitted_at', { ascending: true }).limit(20),
      roles.includes('super_admin') ? admin.from('admin_invitations').select('id,email,role,status,created_at,expires_at').eq('status', 'pending').order('created_at', { ascending: false }).limit(20) : Promise.resolve({ data: [], error: null }),
    ]);
    for (const result of [users, pendingKycCount, pendingDepositCount, pendingWithdrawalCount, pendingKyc, pendingInvitations]) if (result.error) throw result.error;

    const submissions = pendingKyc.data || [];
    const userIds = [...new Set(submissions.map((x) => x.user_id))];
    const submissionIds = submissions.map((x) => x.id);
    const [profiles, docs] = await Promise.all([
      userIds.length ? admin.from('profiles').select('id,email,display_name').in('id', userIds) : Promise.resolve({ data: [], error: null }),
      submissionIds.length ? admin.from('kyc_documents').select('id,submission_id,document_type,storage_path,original_file_name,mime_type,file_size_bytes').in('submission_id', submissionIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (profiles.error) throw profiles.error; if (docs.error) throw docs.error;
    const profileMap = new Map((profiles.data || []).map((p) => [p.id, p]));
    const documentMap = new Map<string, unknown[]>();
    for (const doc of docs.data || []) {
      const { data: signed } = await admin.storage.from('kyc-private').createSignedUrl(doc.storage_path, 180);
      const list = documentMap.get(doc.submission_id) || [];
      list.push({ id: doc.id, document_type: doc.document_type, original_file_name: doc.original_file_name, mime_type: doc.mime_type, file_size_bytes: doc.file_size_bytes, signed_url: signed?.signedUrl || null });
      documentMap.set(doc.submission_id, list);
    }
    const kycItems = submissions.map((item) => ({ ...item, email: profileMap.get(item.user_id)?.email || null, display_name: profileMap.get(item.user_id)?.display_name || null, documents: documentMap.get(item.id) || [] }));
    return json({
      roles,
      metrics: { users: users.count ?? 0, pending_kyc: pendingKycCount.count ?? 0, pending_deposits: pendingDepositCount.count ?? 0, pending_withdrawals: pendingWithdrawalCount.count ?? 0 },
      pending_kyc: kycItems,
      pending_invitations: roles.includes('super_admin') ? (pendingInvitations.data || []) : [],
    });
  } catch (error) {
    console.error('admin-overview:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected error.' }, 500);
  }
});
