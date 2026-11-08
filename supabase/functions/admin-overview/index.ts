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

    const [users, pendingKycCount, pendingDepositCount, pendingWithdrawalCount, pendingKyc, pendingInvitations, assets, pairs, fees, settings, swaps, ledger, treasuryAccounts] = await Promise.all([
      admin.from('profiles').select('id', { count: 'exact', head: true }),
      admin.from('kyc_submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('deposits').select('id', { count: 'exact', head: true }).in('status', ['submitted', 'under_review']),
      admin.from('withdrawals').select('id', { count: 'exact', head: true }).in('status', ['requested', 'under_review']),
      admin.from('kyc_submissions').select('id,user_id,status,submitted_at').eq('status', 'pending').order('submitted_at', { ascending: true }).limit(20),
      roles.includes('super_admin') ? admin.from('admin_invitations').select('id,email,role,status,created_at,expires_at').eq('status', 'pending').order('created_at', { ascending: false }).limit(20) : Promise.resolve({ data: [], error: null }),
      admin.from('assets').select('code,name,is_active,display_order').order('display_order', { ascending: true }),
      admin.from('trading_pairs').select('id,base_asset_code,quote_asset_code,is_active,display_order').order('display_order', { ascending: true }),
      admin.from('fee_settings').select('id,scope,operation,fee_type,fee_value,is_active,effective_from,effective_until,created_at').eq('scope', 'operation').eq('operation', 'swap').order('created_at', { ascending: false }).limit(20),
      admin.from('platform_settings').select('setting_key,setting_value'),
      admin.from('swap_orders').select('id', { count: 'exact', head: true }),
      admin.from('ledger_transactions').select('id', { count: 'exact', head: true }).eq('status', 'posted'),
      admin.from('ledger_accounts').select('id,asset_code').eq('domain', 'platform').eq('account_kind', 'treasury').eq('is_active', true),
    ]);
    for (const result of [users, pendingKycCount, pendingDepositCount, pendingWithdrawalCount, pendingKyc, pendingInvitations, assets, pairs, fees, settings, swaps, ledger, treasuryAccounts]) if (result.error) throw result.error;

    const treasuryIds = (treasuryAccounts.data || []).map((x) => x.id);
    const treasuryEntries = treasuryIds.length
      ? await admin.from('ledger_entries').select('account_id,side,amount,ledger_transactions!inner(status)')
          .in('account_id', treasuryIds).eq('ledger_transactions.status', 'posted')
      : { data: [], error: null };
    if (treasuryEntries.error) throw treasuryEntries.error;
    const treasuryBalances = (treasuryAccounts.data || []).map((account) => {
      const balance = (treasuryEntries.data || [])
        .filter((entry) => entry.account_id === account.id)
        .reduce((sum, entry) => sum + (entry.side === 'credit' ? 1 : -1) * Number(entry.amount || 0), 0);
      return { asset_code: account.asset_code, balance: String(balance) };
    });

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
    const systemSettings = Object.fromEntries((settings.data || []).map((x) => [x.setting_key, x.setting_value]));
    const currentTime = Date.now();
    const activeSwapFee = (fees.data || []).find((x) => x.is_active &&
      (!x.effective_from || new Date(x.effective_from).getTime() <= currentTime) &&
      (!x.effective_until || new Date(x.effective_until).getTime() > currentTime)) || null;
    return json({
      roles,
      metrics: {
        users: users.count ?? 0,
        pending_kyc: pendingKycCount.count ?? 0,
        pending_deposits: pendingDepositCount.count ?? 0,
        pending_withdrawals: pendingWithdrawalCount.count ?? 0,
        swap_orders: swaps.count ?? 0,
        posted_ledger_transactions: ledger.count ?? 0,
      },
      assets: assets.data || [],
      trading_pairs: pairs.data || [],
      active_swap_fee: activeSwapFee,
      treasury_balances: treasuryBalances,
      system_settings: systemSettings,
      pending_kyc: kycItems,
      pending_invitations: roles.includes('super_admin') ? (pendingInvitations.data || []) : [],
    });
  } catch (error) {
    console.error('admin-overview:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected error.' }, 500);
  }
});
