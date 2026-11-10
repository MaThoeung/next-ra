import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
function keys() {
  const p = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'); const s = Deno.env.get('SUPABASE_SECRET_KEYS');
  const publishable = p ? JSON.parse(p).default : (Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY'));
  const secret = s ? JSON.parse(s).default : (Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  if (!publishable || !secret) throw new Error('Supabase API keys are unavailable.');
  return { publishable, secret };
}
function getSessionId(token: string): string | null {
  try { const part=token.split('.')[1]; if(!part) return null; const b=part.replace(/-/g,'+').replace(/_/g,'/'); const p=JSON.parse(atob(b.padEnd(Math.ceil(b.length/4)*4,'='))); return typeof p.session_id==='string'?p.session_id:null; } catch { return null; }
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
    if(!token) return json({error:'Authentication required.'},401);
    const url=Deno.env.get('SUPABASE_URL'); if(!url) throw new Error('Supabase URL is unavailable.');
    const {publishable,secret}=keys();
    const caller=createClient(url,publishable,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
    const {data:auth,error:authError}=await caller.auth.getUser(token);
    if(authError||!auth.user) return json({error:'Invalid or expired session.'},401);
    const {data:aal,error:aalError}=await caller.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if(aalError||aal?.currentLevel!=='aal2') return json({error:'A verified MFA session (AAL2) is required.'},403);
    const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
    const sessionId=getSessionId(token);
    if(!sessionId) return json({error:'Active session could not be verified.'},401);
    const {data:activeSession,error:sessionError}=await admin.rpc('is_auth_session_active',{p_user_id:auth.user.id,p_session_id:sessionId});
    if(sessionError) throw sessionError;
    if(activeSession!==true) return json({error:'Session is no longer active. Please sign in again.'},401);
    const {data:callerProfile,error:callerProfileError}=await admin.from('profiles').select('account_status').eq('id',auth.user.id).maybeSingle();
    if(callerProfileError) throw callerProfileError;
    if(callerProfile?.account_status!=='active') return json({error:'An active administrator account is required.'},403);
    const {data:callerRoles,error:callerRolesError}=await admin.from('user_roles').select('role').eq('user_id',auth.user.id);
    if(callerRolesError) throw callerRolesError;
    if(!(callerRoles||[]).some((r:any)=>r.role==='super_admin')) return json({error:'Only Super Admin can manage member account access.'},403);
    const body=await req.json(); const action=String(body?.action||''); const memberId=String(body?.member_user_id||'');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memberId)||memberId===auth.user.id) return json({error:'Invalid member account.'},400);
    const {data:targetProfile,error:targetProfileError}=await admin.from('profiles').select('id,email,account_status').eq('id',memberId).maybeSingle();
    if(targetProfileError) throw targetProfileError; if(!targetProfile) return json({error:'Member not found.'},404);
    const {data:targetRoles,error:targetRolesError}=await admin.from('user_roles').select('role').eq('user_id',memberId);
    if(targetRolesError) throw targetRolesError; if((targetRoles||[]).length) return json({error:'This account has administrative privileges and cannot be managed as a regular member.'},403);
    const requestId=crypto.randomUUID(); let auditAction=''; let afterData:Record<string,unknown>={};
    if(action==='lock') {
      const {error}=await admin.auth.admin.updateUserById(memberId,{ban_duration:'876000h'}); if(error) throw error;
      const {error:profileError}=await admin.from('profiles').update({account_status:'suspended',updated_at:new Date().toISOString()}).eq('id',memberId);
      if(profileError) { await admin.auth.admin.updateUserById(memberId,{ban_duration:'none'}); throw profileError; }
      const {error:signOutError}=await admin.auth.admin.signOut(memberId,'global'); if(signOutError) console.error('Target session revocation warning:',signOutError);
      auditAction='member_account_locked'; afterData={account_status:'suspended',auth_banned:true,sessions_revoked:true};
    } else if(action==='unlock') {
      const {error}=await admin.auth.admin.updateUserById(memberId,{ban_duration:'none'}); if(error) throw error;
      const {error:profileError}=await admin.from('profiles').update({account_status:'active',updated_at:new Date().toISOString()}).eq('id',memberId);
      if(profileError) { await admin.auth.admin.updateUserById(memberId,{ban_duration:'876000h'}); throw profileError; }
      auditAction='member_account_unlocked'; afterData={account_status:'active',auth_banned:false};
    } else if(action==='reset_password') {
      const redirect=String(body?.redirect_to||''); let redirectTo:string;
      try { const parsed=new URL(redirect); if(parsed.protocol!=='https:' && parsed.hostname!=='localhost') throw new Error(); redirectTo=parsed.toString(); }
      catch { return json({error:'A valid secure password recovery redirect is required.'},400); }
      const publicClient=createClient(url,publishable,{auth:{persistSession:false,autoRefreshToken:false}});
      const {error}=await publicClient.auth.resetPasswordForEmail(targetProfile.email,{redirectTo}); if(error) throw error;
      auditAction='member_password_reset_email_requested'; afterData={delivery_requested:true,method:'supabase_auth_recovery_email'};
    } else return json({error:'Unsupported member account action.'},400);
    const {error:auditError}=await admin.from('admin_audit_logs').insert({actor_user_id:auth.user.id,action:auditAction,entity_type:'member_account',entity_id:memberId,before_data:{account_status:targetProfile.account_status},after_data:afterData,request_id:requestId});
    if(auditError) throw auditError;
    return json({success:true,action,member_user_id:memberId,request_id:requestId});
  } catch(error) { console.error('admin-member-account:',error); return json({error:error instanceof Error?error.message:'Unexpected error.'},500); }
});