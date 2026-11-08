import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
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
    const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:profile,error:profileError}=await admin.from("profiles").select("account_status").eq("id",authData.user.id).maybeSingle();
    if(profileError)throw profileError;
    if(!profile||profile.account_status!=="active")return json({error:"This account is not active."},403);

    const body=await req.json();
    const action=String(body.action||"");
    if(action==="get_deposit_instructions"){
      const {data:setting,error:settingError}=await admin.from("platform_settings")
        .select("setting_value").eq("setting_key","manual_deposit_instructions").maybeSingle();
      if(settingError)throw settingError;
      const instructions=String(setting?.setting_value?.text||"");
      return json({success:true,configured:instructions.trim().length>0,instructions});
    }
    const asset=String(body.asset_code||"").toUpperCase();
    const amountText=String(body.amount??"").trim();
    if(!/^[A-Z0-9]{2,15}$/.test(asset)||!/^\d{1,15}(?:\.\d{1,18})?$/.test(amountText))return json({error:"Enter a valid asset and amount."},400);
    const amount=Number(amountText);
    if(!Number.isFinite(amount)||amount<=0||amount>1e15)return json({error:"Amount is outside the allowed range."},400);
    const {data:assetRow,error:assetError}=await admin.from("assets").select("code,decimals,is_active").eq("code",asset).maybeSingle();
    if(assetError)throw assetError;
    if(!assetRow||!assetRow.is_active)return json({error:"This asset is not enabled."},400);
    if((amountText.split(".")[1]||"").length>Number(assetRow.decimals))return json({error:`${asset} supports up to ${assetRow.decimals} decimal places.`},400);

    if(action==="submit_deposit"){
      const {data:instructionSetting,error:instructionError}=await admin.from("platform_settings")
        .select("setting_value").eq("setting_key","manual_deposit_instructions").maybeSingle();
      if(instructionError)throw instructionError;
      if(!String(instructionSetting?.setting_value?.text||"").trim()){
        return json({error:"External deposit instructions have not been configured by the platform administrator yet."},409);
      }
      const reference=String(body.external_reference||"").trim();
      const memo=String(body.memo||"").trim().slice(0,500);
      if(reference.length<4||reference.length>160)return json({error:"Enter the external bank/payment reference (4–160 characters)."},400);
      const {data:route,error:routeError}=await admin.from("asset_networks")
        .select("asset_code,network_code,is_active,deposits_enabled")
        .eq("asset_code",asset).eq("network_code","MANUAL").maybeSingle();
      if(routeError)throw routeError;
      if(!route||!route.is_active||!route.deposits_enabled)return json({error:"Manual deposits are not enabled for this asset."},400);
      const {data:existing,error:existingError}=await admin.from("deposits").select("id")
        .eq("network_code","MANUAL").ilike("transaction_hash",reference).limit(1);
      if(existingError)throw existingError;
      if(existing?.length)return json({error:"This external payment reference has already been submitted."},409);
      const {data:deposit,error:depositError}=await admin.from("deposits").insert({
        user_id:authData.user.id,asset_code:asset,network_code:"MANUAL",
        amount:amountText,transaction_hash:reference,memo:memo||null,status:"submitted"
      }).select("id,asset_code,amount,status,created_at,transaction_hash").single();
      if(depositError)throw depositError;
      return json({
        success:true,deposit,
        message:"Deposit request submitted. Your balance is not credited until an administrator verifies the external payment."
      });
    }

    if(action==="request_withdrawal"){
      const destination=String(body.destination||"").trim();
      const memo=String(body.memo||"").trim().slice(0,500);
      if(destination.length<4||destination.length>500)return json({error:"Enter the external payout destination (4–500 characters)."},400);
      const {data:route,error:routeError}=await admin.from("asset_networks")
        .select("asset_code,network_code,is_active,withdrawals_enabled")
        .eq("asset_code",asset).eq("network_code","MANUAL").maybeSingle();
      if(routeError)throw routeError;
      if(!route||!route.is_active||!route.withdrawals_enabled)return json({error:"Manual withdrawals are not enabled for this asset."},400);
      const {data:result,error:requestError}=await admin.rpc("request_manual_withdrawal",{
        p_user_id:authData.user.id,p_asset_code:asset,p_amount:amountText,
        p_destination_address:destination,p_memo:memo||null
      });
      if(requestError)throw requestError;
      return json({
        success:true,result,
        message:"Withdrawal request recorded. Your amount is reserved internally; an administrator must make and verify the external payout."
      });
    }

    return json({error:"Unsupported action."},400);
  }catch(error){
    console.error("manual-settlement:",error);
    const message=error instanceof Error?error.message:"Unexpected settlement error.";
    const status=/Insufficient available balance/i.test(message)?409:/already been submitted/i.test(message)?409:400;
    return json({error:message},status);
  }
});
