import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const cors={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});
function keys(){
  const p=Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),s=Deno.env.get("SUPABASE_SECRET_KEYS");
  const publishable=p?JSON.parse(p).default:(Deno.env.get("SUPABASE_PUBLISHABLE_KEY")||Deno.env.get("SUPABASE_ANON_KEY"));
  const secret=s?JSON.parse(s).default:(Deno.env.get("SUPABASE_SECRET_KEY")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if(!publishable||!secret)throw new Error("Supabase API keys are unavailable.");
  return {publishable,secret};
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"Method not allowed."},405);
  try{
    const token=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"").trim();
    if(!token)return json({error:"Authentication required."},401);
    const url=Deno.env.get("SUPABASE_URL");if(!url)throw new Error("SUPABASE_URL is unavailable.");
    const {publishable,secret}=keys();
    const userClient=createClient(url,publishable,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
    const {data:authData,error:authError}=await userClient.auth.getUser(token);
    if(authError||!authData.user)return json({error:"Invalid or expired session."},401);
    const {data:assurance,error:assuranceError}=await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if(assuranceError||assurance?.currentLevel!=="aal2")return json({error:"Verified administrator MFA (AAL2) is required."},403);
    const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:roles,error:roleError}=await admin.from("user_roles").select("role").eq("user_id",authData.user.id);
    if(roleError)throw roleError;
    const allowed=(roles||[]).some((row:any)=>["super_admin","finance_admin"].includes(row.role));
    if(!allowed)return json({error:"Only Super Admin or Finance Admin can review manual settlements."},403);
    const body=await req.json();
    const action=String(body.action||"");
    if(action==="set_deposit_instructions"){
      const instructions=String(body.instructions||"").trim();
      if(instructions.length>3000)return json({error:"Deposit instructions must be 3,000 characters or fewer."},400);
      const {data:previous,error:previousError}=await admin.from("platform_settings")
        .select("setting_value").eq("setting_key","manual_deposit_instructions").maybeSingle();
      if(previousError)throw previousError;
      const {error:saveError}=await admin.from("platform_settings").upsert({
        setting_key:"manual_deposit_instructions",
        setting_value:{text:instructions},
        description:"Platform instructions for external deposits that Finance must manually verify before internal wallet credit.",
        updated_by:authData.user.id,
        updated_at:new Date().toISOString()
      },{onConflict:"setting_key"});
      if(saveError)throw saveError;
      const {error:auditError}=await admin.from("admin_audit_logs").insert({
        actor_user_id:authData.user.id,
        action:"manual_deposit_instructions_updated",
        entity_type:"platform_setting",
        entity_id:"manual_deposit_instructions",
        before_data:{configured:String(previous?.setting_value?.text||"").trim().length>0},
        after_data:{configured:instructions.length>0,characters:instructions.length}
      });
      if(auditError)console.error("Deposit instructions audit log:",auditError.message);
      return json({success:true,configured:instructions.length>0});
    }
    if(action==="review_deposit"){
      const id=String(body.deposit_id||""),decision=String(body.decision||"");
      if(!/^[0-9a-f-]{36}$/i.test(id)||!["approve","reject"].includes(decision))return json({error:"A valid deposit and review decision are required."},400);
      const {data,error}=await admin.rpc("review_manual_deposit",{
        p_actor_user_id:authData.user.id,p_deposit_id:id,p_action:decision,
        p_reason:decision==="reject"?String(body.reason||"").trim()||"Not verified externally":null
      });
      if(error)throw error;
      return json({success:true,result:data});
    }
    if(action==="review_withdrawal"){
      const id=String(body.withdrawal_id||""),decision=String(body.decision||"");
      if(!/^[0-9a-f-]{36}$/i.test(id)||!["complete","reject"].includes(decision))return json({error:"A valid withdrawal and review decision are required."},400);
      const reference=String(body.external_reference||"").trim();
      const reason=String(body.reason||"").trim();
      if(decision==="complete"&&(reference.length<4||reference.length>160))return json({error:"Enter the verified external payout reference."},400);
      if(decision==="reject"&&reason.length<4)return json({error:"Enter a reason for rejecting the payout request."},400);
      const {data,error}=await admin.rpc("review_manual_withdrawal",{
        p_actor_user_id:authData.user.id,p_withdrawal_id:id,p_action:decision,
        p_external_reference:decision==="complete"?reference:null,
        p_reason:decision==="reject"?reason:null
      });
      if(error)throw error;
      return json({success:true,result:data});
    }
    return json({error:"Unsupported administrator action."},400);
  }catch(error){
    console.error("admin-manual-settlement:",error);
    return json({error:error instanceof Error?error.message:"Unexpected admin settlement error."},400);
  }
});
