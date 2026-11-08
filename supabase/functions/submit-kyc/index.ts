import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
function getKeys() {
  const p = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'); const s = Deno.env.get('SUPABASE_SECRET_KEYS');
  const publishable = p ? JSON.parse(p).default : (Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY'));
  const secret = s ? JSON.parse(s).default : (Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  if (!publishable || !secret) throw new Error('Supabase API keys are unavailable.'); return { publishable, secret };
}
const documentTypes = new Set(['identity_front','identity_back','passport','selfie','proof_of_address','other']);
const mimeTypes = new Set(['application/pdf','image/jpeg','image/png']);
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
    const userId = authData.user.id;
    const body = await req.json();
    const submissionId = String(body.submission_id || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) return json({ error: 'Invalid submission reference.' }, 400);
    const docs = body.documents;
    if (!Array.isArray(docs) || docs.length < 1 || docs.length > 5) return json({ error: 'Upload between one and five documents.' }, 400);
    for (const doc of docs) {
      const path = String(doc.storage_path || '');
      if (!path.startsWith(`${userId}/${submissionId}/`) || path.includes('..')) return json({ error: 'A document path is outside your secure upload folder.' }, 400);
      if (!documentTypes.has(String(doc.document_type)) || !mimeTypes.has(String(doc.mime_type))) return json({ error: 'Unsupported document type or file format.' }, 400);
      if (!Number.isInteger(Number(doc.file_size_bytes)) || Number(doc.file_size_bytes) <= 0 || Number(doc.file_size_bytes) > 10 * 1024 * 1024) return json({ error: 'A document exceeds the 10 MB file size limit.' }, 400);
    }
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: existing } = await admin.from('kyc_submissions').select('id,user_id,status').eq('id', submissionId).maybeSingle();
    if (existing?.user_id === userId) return json({ submission_id: submissionId, status: existing.status, already_submitted: true });
    const { data: open, error: openError } = await admin.from('kyc_submissions').select('id').eq('user_id', userId).eq('status', 'pending').limit(1).maybeSingle();
    if (openError) throw openError;
    if (open) return json({ error: 'A verification submission is already awaiting review.' }, 409);

    const folder = `${userId}/${submissionId}`;
    const { data: storedFiles, error: listError } = await admin.storage.from('kyc-private').list(folder);
    if (listError) throw listError;
    const storedNames = new Set((storedFiles || []).map((file) => file.name));
    for (const doc of docs) {
      const leaf = String(doc.storage_path).split('/').pop();
      if (!storedNames.has(leaf)) return json({ error: `Uploaded file was not found in private storage: ${leaf}` }, 400);
    }
    const { error: submissionError } = await admin.from('kyc_submissions').insert({ id: submissionId, user_id: userId, status: 'pending', submitted_at: new Date().toISOString() });
    if (submissionError) throw submissionError;
    const rows = docs.map((doc) => ({ submission_id: submissionId, user_id: userId, document_type: doc.document_type, storage_bucket: 'kyc-private', storage_path: doc.storage_path, original_file_name: String(doc.original_file_name || '').slice(0, 255), mime_type: doc.mime_type, file_size_bytes: Number(doc.file_size_bytes) }));
    const { error: documentError } = await admin.from('kyc_documents').insert(rows);
    if (documentError) {
      await admin.from('kyc_submissions').delete().eq('id', submissionId);
      await admin.storage.from('kyc-private').remove(docs.map((doc) => doc.storage_path));
      throw documentError;
    }
    await admin.from('notifications').insert({ user_id: userId, title: 'Identity verification submitted', body: 'Your documents were uploaded securely and are awaiting review.', notification_type: 'kyc' });
    return json({ submission_id: submissionId, status: 'pending', documents_saved: rows.length });
  } catch (error) {
    console.error('submit-kyc:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected error.' }, 500);
  }
});
