import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{...cors,"Content-Type":"application/json"}});
function keys(){const p=Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'),s=Deno.env.get('SUPABASE_SECRET_KEYS');const pub=p?JSON.parse(p).default:(Deno.env.get('SUPABASE_PUBLISHABLE_KEY')||Deno.env.get('SUPABASE_ANON_KEY'));const sec=s?JSON.parse(s).default:(Deno.env.get('SUPABASE_SECRET_KEY')||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));if(!pub||!sec)throw new Error('Supabase keys unavailable');return{pub,sec};}
function sessionId(token:string){try{const x=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');const p=JSON.parse(atob(x.padEnd(Math.ceil(x.length/4)*4,'=')));return typeof p.session_id==='string'?p.session_id:null;}catch{return null;}}
Deno.serve(async req=>{if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return json({error:'Method not allowed'},405);try{
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim();if(!token)return json({error:'Authentication required'},401);
 const url=Deno.env.get('SUPABASE_URL');if(!url)throw new Error('Supabase URL unavailable');const{pub,sec}=keys();
 const user=createClient(url,pub,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
 const{data:auth,error:authErr}=await user.auth.getUser(token);if(authErr||!auth.user)return json({error:'Invalid session'},401);
 const{data:aal,error:aalErr}=await user.auth.mfa.getAuthenticatorAssuranceLevel(token);if(aalErr||aal?.currentLevel!=='aal2')return json({error:'AAL2 required'},403);
 const db=createClient(url,sec,{auth:{persistSession:false,autoRefreshToken:false}});const sid=sessionId(token);if(!sid)return json({error:'Session verification failed'},401);
 const{data:active,error:activeErr}=await db.rpc('is_auth_session_active',{p_user_id:auth.user.id,p_session_id:sid});if(activeErr)throw activeErr;if(active!==true)return json({error:'Session is no longer active'},401);
 const{data:profile,error:profileErr}=await db.from('profiles').select('account_status').eq('id',auth.user.id).maybeSingle();if(profileErr)throw profileErr;if(profile?.account_status!=='active')return json({error:'Active account required'},403);
 const{data:roles,error:rolesErr}=await db.from('user_roles').select('role').eq('user_id',auth.user.id);if(rolesErr)throw rolesErr;if(!(roles||[]).some((r:any)=>r.role==='super_admin'))return json({error:'Only Super Admin can appoint or revoke Admin access'},403);
 const body=await req.json();const member=String(body.member_user_id||'');const action=String(body.action||'');if(!/^[0-9a-f-]{36}$/i.test(member)||member===auth.user.id||!['appoint','revoke'].includes(action))return json({error:'Invalid member or action'},400);
 const{data:target,error:targetErr}=await db.from('profiles').select('id,email,account_status').eq('id',member).maybeSingle();if(targetErr)throw targetErr;if(!target)return json({error:'Member not found'},404);
 const{data:targetRoles,error:trErr}=await db.from('user_roles').select('role').eq('user_id',member);if(trErr)throw trErr;if((targetRoles||[]).some((r:any)=>r.role==='super_admin'))return json({error:'Super Admin role cannot be changed here'},403);
 const bundle=['finance_admin','operations_admin','support_admin','compliance_admin'];const before=(targetRoles||[]).map((r:any)=>r.role);
 if(action==='appoint'){if(target.account_status!=='active')return json({error:'Only an active member can be appointed as Admin'},409);const rows=bundle.filter(role=>!before.includes(role)).map(role=>({user_id:member,role,assigned_by:auth.user.id}));if(rows.length){const{error}=await db.from('user_roles').insert(rows);if(error)throw error;}}
 else{const{error}=await db.from('user_roles').delete().eq('user_id',member).in('role',bundle);if(error)throw error;}
 const after=action==='appoint'?[...new Set([...before,...bundle])]:before.filter((r:string)=>!bundle.includes(r));
 const{error:auditErr}=await db.from('admin_audit_logs').insert({actor_user_id:auth.user.id,action:action==='appoint'?'member_admin_appointed':'member_admin_revoked',entity_type:'member_admin_role',entity_id:member,before_data:{roles:before},after_data:{roles:after,admin_access:action==='appoint'}});if(auditErr)throw auditErr;
 return json({success:true,action,member_user_id:member,admin_access:action==='appoint',roles:after});
 }catch(e){console.error('admin-member-role',e);return json({error:e instanceof Error?e.message:'Unexpected error'},500);}});