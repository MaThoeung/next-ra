import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const out = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

function getKeys() {
  const p = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const s = Deno.env.get("SUPABASE_SECRET_KEYS");
  const publishable = p ? JSON.parse(p).default : (Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY"));
  const secret = s ? JSON.parse(s).default : (Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!publishable || !secret) throw new Error("Supabase API keys are unavailable.");
  return { publishable, secret };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "Method not allowed." }, 405);

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return out({ error: "Authentication required." }, 401);

    const url = Deno.env.get("SUPABASE_URL");
    if (!url) throw new Error("SUPABASE_URL is unavailable.");
    const { publishable, secret } = getKeys();
    const userClient = createClient(url, publishable, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return out({ error: "Invalid or expired session." }, 401);

    const { data: assurance, error: assuranceError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if (assuranceError || assurance?.currentLevel !== "aal2") {
      return out({ error: "A verified MFA session (AAL2) is required." }, 403);
    }

    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: roleRows, error: roleError } = await admin.from("user_roles").select("role").eq("user_id", authData.user.id);
    if (roleError) throw roleError;
    if (!(roleRows || []).some((row: any) => row.role === "super_admin")) {
      return out({ error: "Only the Super Admin can change trading configuration." }, 403);
    }

    const body = await req.json();
    const action = String(body.action || "");
    const now = new Date().toISOString();

    if (action === "set_pair_enabled") {
      const pairId = String(body.pair_id || "");
      const enabled = body.enabled;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pairId) || typeof enabled !== "boolean") {
        return out({ error: "A valid pair ID and enabled status are required." }, 400);
      }
      const { data: pair, error: pairError } = await admin.from("trading_pairs")
        .select("id,base_asset_code,quote_asset_code,is_active").eq("id", pairId).maybeSingle();
      if (pairError) throw pairError;
      if (!pair) return out({ error: "Trading pair not found." }, 404);
      if (enabled) {
        const { data: assets, error: assetError } = await admin.from("assets")
          .select("code,is_active").in("code", [pair.base_asset_code, pair.quote_asset_code]);
        if (assetError) throw assetError;
        if ((assets || []).length !== 2 || (assets || []).some((asset: any) => !asset.is_active)) {
          return out({ error: "Both assets must be active before enabling this pair." }, 409);
        }
      }
      const { data: updated, error: updateError } = await admin.from("trading_pairs")
        .update({ is_active: enabled }).eq("id", pairId)
        .select("id,base_asset_code,quote_asset_code,is_active").single();
      if (updateError) throw updateError;
      const { error: auditError } = await admin.from("admin_audit_logs").insert({
        actor_user_id: authData.user.id,
        action: enabled ? "trading_pair_preview_enabled" : "trading_pair_preview_disabled",
        entity_type: "trading_pair",
        entity_id: pairId,
        before_data: { is_active: pair.is_active },
        after_data: { is_active: enabled, execution_enabled: false }
      });
      if (auditError) console.error("Trading pair audit log:", auditError.message);
      return out({ success: true, trading_pair: updated, execution_enabled: false });
    }

    if (action === "set_swap_fee") {
      const feePercent = Number(body.fee_percent);
      if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 10) {
        return out({ error: "Swap fee must be a number between 0 and 10 percent." }, 400);
      }
      const { data: created, error: insertError } = await admin.from("fee_settings").insert({
        scope: "operation", operation: "swap", fee_type: "percentage",
        fee_value: feePercent, is_active: true, effective_from: now
      }).select("id,fee_value,is_active,effective_from").single();
      if (insertError) throw insertError;

      const { error: disableError } = await admin.from("fee_settings")
        .update({ is_active: false, effective_until: now })
        .eq("scope", "operation").eq("operation", "swap")
        .eq("is_active", true).neq("id", created.id);
      if (disableError) {
        await admin.from("fee_settings").delete().eq("id", created.id);
        throw disableError;
      }
      const { error: auditError } = await admin.from("admin_audit_logs").insert({
        actor_user_id: authData.user.id, action: "swap_fee_updated",
        entity_type: "fee_setting", entity_id: created.id,
        after_data: { fee_type: "percentage", fee_value_percent: feePercent }
      });
      if (auditError) console.error("Swap fee audit log:", auditError.message);
      return out({ success: true, swap_fee: created, note: "Fee is configured but not collected while swap execution remains disabled." });
    }

    return out({ error: "Unsupported configuration action." }, 400);
  } catch (error) {
    console.error("admin-trading-settings:", error);
    return out({ error: error instanceof Error ? error.message : "Unexpected error." }, 500);
  }
});
