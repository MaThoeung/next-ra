import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

function getKeys() {
  const p = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const s = Deno.env.get("SUPABASE_SECRET_KEYS");
  const publishable = p ? JSON.parse(p).default : (Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY"));
  const secret = s ? JSON.parse(s).default : (Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!publishable || !secret) throw new Error("Supabase API keys are unavailable.");
  return { publishable, secret };
}

const coinIds: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", USDT: "tether", BNB: "binancecoin",
  SOL: "solana", USDC: "usd-coin", XRP: "ripple", ADA: "cardano",
  DOGE: "dogecoin", TRX: "tron"
};

let priceCache: { expiresAt: number; prices: Record<string, number>; updatedAt: string } | null = null;

async function getMarketPrices(codes: string[]) {
  const cryptoCodes = [...new Set(codes.filter(code => code !== "USD"))];
  const missing = cryptoCodes.filter(code => !coinIds[code]);
  if (missing.length) throw new Error(`No public market data mapping is configured for: ${missing.join(", ")}.`);
  if (priceCache && priceCache.expiresAt > Date.now() && cryptoCodes.every(code => priceCache!.prices[code] > 0)) {
    const cachedPrices: Record<string, number> = { USD: 1, ...priceCache.prices };
    return { prices: cachedPrices, updatedAt: priceCache.updatedAt };
  }
  const ids = [...new Set(cryptoCodes.map(code => coinIds[code]))];
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}&price_change_percentage=24h`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Public market data returned HTTP ${response.status}. Please retry shortly.`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("The market provider returned an invalid response.");
  const prices: Record<string, number> = {};
  const timestamps: number[] = [];
  for (const code of cryptoCodes) {
    const row = rows.find((item: any) => item.id === coinIds[code]);
    const price = Number(row?.current_price);
    const timestamp = row?.last_updated ? Date.parse(row.last_updated) : NaN;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) {
      throw new Error(`The market price for ${code} is not currently available.`);
    }
    prices[code] = price;
    timestamps.push(timestamp);
  }
  const oldest = timestamps.length ? Math.min(...timestamps) : Date.now();
  if (Date.now() - oldest > 5 * 60 * 1000 || oldest > Date.now() + 15_000) {
    throw new Error("The market provider's price timestamp is stale. Please retry shortly.");
  }
  const updatedAt = new Date(oldest).toISOString();
  priceCache = { expiresAt: Date.now() + 30_000, prices, updatedAt };
  const allPrices: Record<string, number> = { USD: 1, ...prices };
  return { prices: allPrices, updatedAt };
}

function decimalPlaces(value: string) {
  return (value.split(".")[1] || "").length;
}
function rounded(value: number, places: number) {
  return Number(value.toFixed(Math.min(Math.max(places, 0), 18)));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Authentication required." }, 401);
    const url = Deno.env.get("SUPABASE_URL");
    if (!url) throw new Error("SUPABASE_URL is unavailable.");
    const { publishable, secret } = getKeys();
    const userClient = createClient(url, publishable, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Invalid or expired session." }, 401);

    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: profile, error: profileError } = await admin.from("profiles")
      .select("account_status").eq("id", authData.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile || profile.account_status !== "active") return json({ error: "This account is not active for trading." }, 403);

    const body = await req.json();
    const action = String(body.action || "");

    if (action === "quote") {
      const from = String(body.from_asset_code || "").toUpperCase();
      const to = String(body.to_asset_code || "").toUpperCase();
      const amountText = String(body.amount ?? "").trim();
      if (!/^[A-Z0-9]{2,15}$/.test(from) || !/^[A-Z0-9]{2,15}$/.test(to) || from === to) {
        return json({ error: "Choose two different supported assets." }, 400);
      }
      if (!/^\d{1,15}(?:\.\d{1,18})?$/.test(amountText)) {
        return json({ error: "Enter a valid positive amount." }, 400);
      }
      const amount = Number(amountText);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e15) return json({ error: "Amount is outside the allowed range." }, 400);

      const { data: assets, error: assetError } = await admin.from("assets")
        .select("code,name,kind,decimals,is_active").in("code", [from, to]).eq("is_active", true);
      if (assetError) throw assetError;
      if ((assets || []).length !== 2) return json({ error: "One or both assets are not enabled by NEXT-RA." }, 400);

      const { data: pairs, error: pairError } = await admin.from("trading_pairs")
        .select("base_asset_code").eq("quote_asset_code", "USD").eq("is_active", true);
      if (pairError) throw pairError;
      const enabled = new Set(["USD", ...(pairs || []).map((p: any) => p.base_asset_code)]);
      if (!enabled.has(from) || !enabled.has(to)) return json({ error: "One or both assets are not enabled for USD-referenced trading." }, 400);

      const { prices, updatedAt } = await getMarketPrices([from, to]);
      const fromPrice = prices[from], toPrice = prices[to];
      if (!fromPrice || !toPrice) return json({ error: "A market price is unavailable for one of the selected assets." }, 503);

      const { data: feeRows, error: feeError } = await admin.from("fee_settings")
        .select("fee_value,effective_from,effective_until,created_at")
        .eq("scope", "operation").eq("operation", "swap")
        .eq("fee_type", "percentage").eq("is_active", true)
        .order("created_at", { ascending: false }).limit(20);
      if (feeError) throw feeError;
      const now = Date.now();
      const activeFee = (feeRows || []).find((item: any) =>
        (!item.effective_from || Date.parse(item.effective_from) <= now) &&
        (!item.effective_until || Date.parse(item.effective_until) > now)
      );
      const feePercent = Number(activeFee?.fee_value ?? 0);
      if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 10) throw new Error("The configured swap fee is invalid.");

      const fromAsset = (assets || []).find((a: any) => a.code === from);
      const toAsset = (assets || []).find((a: any) => a.code === to);
      if (!fromAsset || !toAsset) return json({ error: "One or both assets are not enabled." }, 400);
      const fromDecimals = Number(fromAsset.decimals);
      const toDecimals = Number(toAsset.decimals);
      if (decimalPlaces(amountText) > fromDecimals) return json({ error: `${from} supports up to ${fromDecimals} decimal places.` }, 400);

      const gross = rounded(amount * fromPrice / toPrice, toDecimals);
      const fee = rounded(gross * feePercent / 100, toDecimals);
      const net = rounded(gross - fee, toDecimals);
      const rate = fromPrice / toPrice;
      if (!Number.isFinite(net) || net <= 0) return json({ error: "The estimated receive amount is too small after rounding and fees." }, 400);

      const quoteExpiresAt = new Date(Date.now() + 60_000).toISOString();
      const { data: quote, error: quoteError } = await admin.from("swap_orders").insert({
        user_id: authData.user.id,
        from_asset_code: from,
        to_asset_code: to,
        from_amount: amountText,
        quoted_rate: String(rate),
        estimated_to_amount: String(net),
        fee_asset_code: to,
        fee_amount: String(fee),
        fee_rate_percent: String(feePercent),
        quoted_from_price: String(fromPrice),
        quoted_to_price: String(toPrice),
        market_data_source: "CoinGecko",
        market_data_updated_at: updatedAt,
        quote_expires_at: quoteExpiresAt,
        status: "quoted"
      }).select("id,from_asset_code,to_asset_code,from_amount,quoted_rate,estimated_to_amount,fee_amount,fee_asset_code,fee_rate_percent,quote_expires_at,market_data_updated_at").single();
      if (quoteError) throw quoteError;

      const { data: balanceRows, error: balanceError } = await admin.from("wallet_balances")
        .select("balance").eq("user_id", authData.user.id).eq("domain", "exchange")
        .eq("asset_code", from).eq("account_kind", "available");
      if (balanceError) throw balanceError;
      const available = Number(balanceRows?.[0]?.balance || 0);
      return json({
        success: true,
        quote,
        pricing: {
          from_price_usd: fromPrice,
          to_price_usd: toPrice,
          usd_value: amount * fromPrice,
          gross_to_amount: gross,
          fee_amount: fee,
          fee_rate_percent: feePercent,
          net_to_amount: net,
          rate
        },
        available_balance: available,
        sufficient_balance: available >= amount,
        mode: "internal_simulated",
        external_exchange_connected: false,
        blockchain_connected: false
      });
    }

    if (action === "execute") {
      const swapId = String(body.swap_order_id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(swapId)) {
        return json({ error: "A valid quote ID is required." }, 400);
      }
      const { data: order, error: orderError } = await admin.from("swap_orders")
        .select("id,user_id,status,from_asset_code,to_asset_code,from_amount,quote_expires_at")
        .eq("id", swapId).eq("user_id", authData.user.id).maybeSingle();
      if (orderError) throw orderError;
      if (!order) return json({ error: "Swap quote not found." }, 404);
      if (order.status === "completed") {
        const { data: prior, error: priorError } = await admin.from("swap_orders")
          .select("id,from_asset_code,to_asset_code,from_amount,received_amount,fee_amount,fee_asset_code,ledger_transaction_id,status,completed_at")
          .eq("id", swapId).single();
        if (priorError) throw priorError;
        return json({ success: true, already_completed: true, order: prior });
      }
      if (order.status !== "quoted" || !order.quote_expires_at || Date.parse(order.quote_expires_at) <= Date.now()) {
        return json({ error: "This quote has expired or is no longer available. Request a new quote." }, 409);
      }

      const { prices, updatedAt } = await getMarketPrices([order.from_asset_code, order.to_asset_code]);
      const { data: result, error: executeError } = await admin.rpc("execute_internal_swap", {
        p_user_id: authData.user.id,
        p_swap_order_id: swapId,
        p_from_price: String(prices[order.from_asset_code]),
        p_to_price: String(prices[order.to_asset_code]),
        p_market_data_updated_at: updatedAt
      });
      if (executeError) {
        const message = executeError.message || "Swap could not be completed.";
        const status = /Insufficient available balance/i.test(message) ? 409
          : /price moved|fee changed|expired|not executable|disabled|stale/i.test(message) ? 409 : 400;
        return json({ error: message }, status);
      }

      const { data: completed, error: completedError } = await admin.from("swap_orders")
        .select("id,from_asset_code,to_asset_code,from_amount,quoted_rate,estimated_to_amount,received_amount,fee_amount,fee_asset_code,status,ledger_transaction_id,completed_at")
        .eq("id", swapId).single();
      if (completedError) throw completedError;
      const { data: balances, error: updatedBalanceError } = await admin.from("wallet_balances")
        .select("asset_code,account_kind,balance").eq("user_id", authData.user.id)
        .eq("domain", "exchange").in("asset_code", [order.from_asset_code, order.to_asset_code]);
      if (updatedBalanceError) throw updatedBalanceError;
      return json({ success: true, result, order: completed, balances, mode: "internal_simulated" });
    }

    return json({ error: "Unsupported action. Use quote or execute." }, 400);
  } catch (error) {
    console.error("internal-swap:", error);
    const message = error instanceof Error ? error.message : "Unexpected swap service error.";
    return json({ error: message }, 400);
  }
});
