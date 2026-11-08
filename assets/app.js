// Load Supabase from more than one CDN so a single blocked CDN does not
// silently prevent the entire application from starting.
async function loadSupabaseClient() {
  const sources = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm',
    'https://esm.sh/@supabase/supabase-js@2.119.0'
  ];
  const failures = [];
  for (const source of sources) {
    try {
      const module = await import(source);
      if (typeof module.createClient === 'function') return module.createClient;
      throw new Error('The Supabase library loaded without createClient.');
    } catch (error) {
      failures.push(`${source}: ${error?.message || error}`);
      console.warn('NEXT-RA could not load Supabase from', source, error);
    }
  }
  const detail = failures.join(' | ');
  const message = document.getElementById('auth-message');
  if (message) {
    message.className = 'auth-message error';
    message.textContent = 'NEXT-RA could not load its secure account library. Please check your internet connection or network restrictions, then refresh. Details: ' + detail;
    message.classList.remove('hidden');
  }
  throw new Error('Supabase library unavailable. ' + detail);
}
const createClient = await loadSupabaseClient();

const SUPABASE_URL = 'https://lasrylhmiaxiucvlmpuk.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_vPbPAUIYO2Npgc_jXiEQmQ_oIzu0QVf';
const KYC_BUCKET = 'kyc-private';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h';
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
});

const state = {
  user: null, session: null, profile: null, roles: [], aal: 'aal1',
  page: 'dashboard', markets: [], marketsUpdatedAt: 0, marketError: false,
  balances: [], adminOverview: null, notifications: [], tradingPairs: []
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shortId = (value = '') => value ? `${value.slice(0, 7)}…${value.slice(-5)}` : '—';
const money = (value, digits = 2) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtDate = (value) => value ? new Date(value).toLocaleString('en-US', {month:'short',day:'2-digit',year:'numeric'}) : '—';
const fmtPrice = (value) => Number(value || 0) >= 1 ? `$${money(value, 2)}` : `$${Number(value || 0).toLocaleString('en-US',{maximumFractionDigits:8})}`;
const toast = (message, type = 'info') => {
  const node = document.createElement('div'); node.className = `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`; node.textContent = message;
  $('#toast-region').append(node); setTimeout(() => node.remove(), 4200);
};
const pageTitle = {dashboard:'Dashboard',markets:'Markets',swap:'Swap',wallet:'Wallets',deposit:'Deposit',withdraw:'Withdraw',investments:'Investments',referrals:'Referrals',kyc:'Identity verification',security:'Security',activity:'Activity',admin:'Admin console'};
const priceOf = (code) => {
  if (code === 'USDT' || code === 'USDC' || code === 'USD') return 1;
  const bySymbol = state.markets.find((m) => m.symbol?.toUpperCase() === String(code).toUpperCase());
  return bySymbol ? Number(bySymbol.current_price) : null;
};
const coinIcon = (coin) => coin?.image ? `<span class="coin-icon"><img src="${escapeHtml(coin.image)}" alt="" loading="lazy"></span>` : `<span class="coin-icon">${escapeHtml((coin?.symbol || '?').slice(0,1).toUpperCase())}</span>`;
const statusPill = (status) => `<span class="status-pill ${escapeHtml(String(status || '').toLowerCase())}">${escapeHtml(String(status || 'unknown').replaceAll('_',' '))}</span>`;

function showAuth(message = '', type = 'success') {
  $('#auth-screen').classList.remove('hidden'); $('#app-shell').classList.add('hidden');
  const resend = $('#resend-confirmation');
  if (resend) resend.remove();
  if (message) { $('#auth-message').className = `auth-message ${type === 'error' ? 'error' : ''}`; $('#auth-message').textContent = message; $('#auth-message').classList.remove('hidden'); }
}
function showSignupPending(email) {
  showAuth('Your registration request was received. Check your inbox and spam folder for the verification email. Open the verification link using this same website, then sign in.');
  const button = document.createElement('button');
  button.type = 'button'; button.id = 'resend-confirmation'; button.className = 'ghost-button';
  button.style.cssText = 'margin-top:12px;width:100%;'; button.textContent = 'Resend verification email';
  button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = 'Sending…';
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup', email,
        options: { emailRedirectTo: `${window.location.origin}/` }
      });
      if (error) throw error;
      showAuth('If this address has a pending registration, a new verification email has been sent. Check your inbox and spam folder.');
    } catch (error) {
      showAuth(`Could not resend the verification email: ${error.message || 'Please try again later.'}`, 'error');
    }
  });
  $('#auth-message').after(button);
}
function hideAuth() { $('#auth-screen').classList.add('hidden'); $('#app-shell').classList.remove('hidden'); }
function setAuthMode(mode) {
  const signup = mode === 'signup';
  $('#login-tab').classList.toggle('active', !signup); $('#signup-tab').classList.toggle('active', signup);
  $('#auth-title').textContent = signup ? 'Create your account' : 'Welcome back';
  $('#auth-subtitle').textContent = signup ? 'Set up your secure digital asset account.' : 'Sign in to continue to your workspace.';
  $('#auth-submit').innerHTML = signup ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  $('#signup-name-wrap').classList.toggle('hidden', !signup);
  $('#auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#auth-message').classList.add('hidden'); $('#auth-form').dataset.mode = mode;
}

async function checkMfa() {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  state.aal = data?.currentLevel || 'aal1';
  return data || {currentLevel:'aal1', nextLevel:'aal1'};
}
async function getSessionAccess() {
  state.roles = [];
  try {
    const { data, error } = await supabase.functions.invoke('session-access', { body: {} });
    if (!error && data?.roles) state.roles = data.roles;
    else if (error) console.warn('Session access check:', error.message);
  } catch (error) { console.warn('Session access check failed:', error); }
}
async function afterAuthentication() {
  const { data: sessionData } = await supabase.auth.getSession();
  state.session = sessionData.session; state.user = sessionData.session?.user || null;
  if (!state.user) { showAuth(); return; }
  let assurance;
  try { assurance = await checkMfa(); }
  catch (error) { toast(`Could not verify account security: ${error.message}`, 'error'); showAuth(); return; }
  if (assurance.currentLevel !== 'aal2' && assurance.nextLevel === 'aal2') {
    await showMfaChallenge(); return;
  }
  // If this verified email has a pending administrator invitation, accept it through the trusted server endpoint.
  try {
    const { data: accepted } = await supabase.functions.invoke('accept-admin-invitation', { body: {} });
    if (accepted?.accepted) toast(`Administrator invitation accepted: ${accepted.role.replaceAll('_',' ')}. Set up 2FA to unlock admin tools.`, 'success');
  } catch (error) { console.warn('Invitation acceptance check:', error); }
  await getSessionAccess();
  if (state.roles.length && state.aal !== 'aal2') {
    // Admin accounts remain signed in, but the admin area is locked until MFA is verified.
    toast('Two-factor verification is required before opening administrative tools.');
  }
  await loadProfile();
  hideAuth(); updateShellIdentity();
  await loadMarkets();

  // The first Super Admin session is routed through the security setup.
  // MFA enrollment still requires the account owner to scan and verify the QR code.
  if (state.roles.includes('super_admin') && state.aal !== 'aal2') {
    await renderPage('security');
    const { data: factors, error: factorError } = await supabase.auth.mfa.listFactors();
    if (factorError) {
      toast(`Could not check authenticator status: ${factorError.message}`, 'error');
      return;
    }
    const verifiedTotp = (factors?.totp || []).some((factor) => factor.status === 'verified');
    const pendingTotp = (factors?.totp || []).some((factor) => factor.status === 'unverified');
    if (!verifiedTotp && !pendingTotp) await startMfaSetup();
    else if (!verifiedTotp) toast('An unfinished authenticator setup exists. Remove the unfinished factor in Security settings, then start setup again.', 'error');
    return;
  }
  await renderPage('dashboard');
}

async function showMfaChallenge() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) { toast(error.message, 'error'); return; }
  const factor = (data?.totp || []).find((f) => f.status === 'verified');
  if (!factor) { toast('A second factor is required, but no verified authenticator is available. Contact support.','error'); return; }
  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({factorId:factor.id});
  if (challengeError) { toast(challengeError.message,'error'); return; }
  openModal('Verify your identity', 'Enter the six-digit code from your authenticator app to finish signing in.', `
    <label class="field-label" for="mfa-login-code">Authenticator code</label>
    <input class="form-control mfa-pin" id="mfa-login-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
    <div class="field-help">Codes refresh every 30 seconds. Never share this code with anyone.</div>
  `, `<button class="ghost-button" id="mfa-cancel">Cancel</button><button class="primary-button" id="mfa-verify-login">Verify and continue →</button>`);
  $('#mfa-cancel').onclick = async () => { closeModal(); await supabase.auth.signOut(); showAuth('Sign-in was cancelled.','error'); };
  $('#mfa-verify-login').onclick = async () => {
    const code = $('#mfa-login-code').value.trim(); if (!/^\d{6}$/.test(code)) return toast('Enter a valid six-digit code.','error');
    const btn = $('#mfa-verify-login'); btn.disabled = true; btn.textContent = 'Verifying…';
    const { error: verifyError } = await supabase.auth.mfa.verify({factorId:factor.id,challengeId:challenge.id,code});
    if (verifyError) { btn.disabled = false; btn.textContent = 'Verify and continue →'; toast(verifyError.message,'error'); return; }
    closeModal(); await afterAuthentication();
  };
  setTimeout(() => $('#mfa-login-code')?.focus(), 40);
}

async function loadProfile() {
  if (!state.user) return;
  const { data, error } = await supabase.from('profiles').select('id,email,display_name,phone,country_code,preferred_language,account_status,created_at').eq('id',state.user.id).maybeSingle();
  if (!error) state.profile = data;
  else console.warn('Profile read:', error.message);
}
function updateShellIdentity() {
  const email = state.profile?.display_name || state.user?.email || 'Your account';
  const initial = (state.profile?.display_name || state.user?.email || 'U').slice(0,1).toUpperCase();
  $('#sidebar-email').textContent = email; $('#sidebar-role').textContent = state.roles.length ? state.roles.map((r)=>r.replaceAll('_',' ')).join(' · ') : 'Member';
  $('#sidebar-avatar').textContent = initial; $('#top-avatar').textContent = initial;
  $('#admin-nav-wrap').classList.toggle('hidden', state.roles.length === 0);
  $('#year').textContent = new Date().getFullYear();
}
async function loadMarkets(force = false) {
  if (!force && state.markets.length && Date.now() - state.marketsUpdatedAt < 60000) return state.markets;
  try {
    const response = await fetch(COINGECKO_URL, {headers:{accept:'application/json'}});
    if (!response.ok) throw new Error(`Market provider returned ${response.status}`);
    const data = await response.json();
    state.markets = Array.isArray(data) ? data : []; state.marketsUpdatedAt = Date.now(); state.marketError = false;
    $('#market-status-text').textContent = 'Live';
    return state.markets;
  } catch (error) {
    state.marketError = true; $('#market-status-text').textContent = 'Unavailable';
    console.warn('Market feed unavailable:', error.message); return state.markets;
  }
}
async function loadBalances() {
  if (!state.user) return [];
  const { data, error } = await supabase.from('wallet_balances').select('account_id,user_id,domain,asset_code,account_kind,balance').eq('user_id',state.user.id);
  if (error) { console.warn('Wallet balances:',error.message); state.balances=[]; return []; }
  state.balances = data || []; return state.balances;
}
function balanceTotals(balances = state.balances) {
  let exchange=0, investment=0, priced=true;
  for (const row of balances) {
    if (!['available','locked'].includes(row.account_kind)) continue;
    const price = priceOf(row.asset_code);
    if (price == null) { priced=false; continue; }
    const value = Number(row.balance || 0) * price;
    if (row.domain === 'exchange') exchange += value;
    if (row.domain === 'investment') investment += value;
  }
  return {exchange,investment,total:exchange+investment,priced};
}

function heading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(title.toUpperCase())}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>`:''}</div>`;
}
function emptyState(title, text, icon = '◇') { return `<div class="empty-state"><div class="empty-icon">${icon}</div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p></div>`; }
function marketRow(coin) {
  const change = Number(coin.price_change_percentage_24h || 0); const up = change >= 0;
  return `<tr><td><div class="asset-cell">${coinIcon(coin)}<div class="asset-name"><strong>${escapeHtml(coin.name)}</strong><span>${escapeHtml(String(coin.symbol||'').toUpperCase())}</span></div></div></td><td><strong>${fmtPrice(coin.current_price)}</strong></td><td><span class="price-change ${up?'positive':'negative'}">${up?'+':''}${money(change,2)}%</span></td><td class="table-muted">${fmtPrice(coin.market_cap)}</td><td class="table-muted">${fmtPrice(coin.total_volume)}</td></tr>`;
}
function activityRow(row) {
  const label = row.type === 'swap' ? `${row.from_asset_code} → ${row.to_asset_code}` : row.type === 'investment' ? `Investment · ${row.asset_code}` : `${row.type} · ${row.asset_code}`;
  const amount = row.type === 'swap' ? `${money(row.from_amount,6)} ${row.from_asset_code}` : `${money(row.amount ?? row.principal_amount,6)} ${row.asset_code}`;
  return `<tr><td>${escapeHtml(label)}</td><td class="table-muted">${fmtDate(row.created_at)}</td><td>${escapeHtml(amount)}</td><td>${statusPill(row.status)}</td></tr>`;
}

async function renderPage(page) {
  if (state.swapMarketRefreshTimer) { clearInterval(state.swapMarketRefreshTimer); state.swapMarketRefreshTimer=null; }
  if (state.swapQuoteExpiryTimer) { clearInterval(state.swapQuoteExpiryTimer); state.swapQuoteExpiryTimer=null; }
  if (!state.user) return;
  state.page = page;
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $('#breadcrumb-current').textContent = pageTitle[page] || 'Dashboard';
  $('#sidebar').classList.remove('open');
  const root = $('#page-content'); root.innerHTML = `<div class="loading-panel">Loading ${escapeHtml(pageTitle[page] || 'page')}…</div>`;
  try {
    if (page === 'dashboard') root.innerHTML = await renderDashboard();
    else if (page === 'markets') root.innerHTML = await renderMarkets();
    else if (page === 'swap') root.innerHTML = await renderSwap();
    else if (page === 'wallet') root.innerHTML = await renderWallets();
    else if (page === 'deposit') root.innerHTML = await renderDeposit();
    else if (page === 'withdraw') root.innerHTML = await renderWithdraw();
    else if (page === 'investments') root.innerHTML = await renderInvestments();
    else if (page === 'referrals') root.innerHTML = await renderReferrals();
    else if (page === 'kyc') root.innerHTML = await renderKyc();
    else if (page === 'security') root.innerHTML = await renderSecurity();
    else if (page === 'activity') root.innerHTML = await renderActivity();
    else if (page === 'admin') root.innerHTML = await renderAdmin();
    bindPageEvents(page);
  } catch (error) {
    console.error(error); root.innerHTML = `${heading(pageTitle[page] || 'Workspace','An unexpected issue occurred.')}<div class="card panel">${emptyState('Could not load this section',error.message || 'Please refresh and try again.','!')}</div>`;
  }
}

async function renderDashboard() {
  await loadMarkets(); await loadBalances();
  const totals = balanceTotals();
  const [recentDeposits,recentWithdrawals,recentSwaps,latestKyc] = await Promise.all([
    supabase.from('deposits').select('id,asset_code,amount,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(4),
    supabase.from('withdrawals').select('id,asset_code,amount,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(4),
    supabase.from('swap_orders').select('id,from_asset_code,to_asset_code,from_amount,received_amount,fee_amount,fee_asset_code,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(4),
    supabase.from('kyc_submissions').select('status').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(1).maybeSingle()
  ]);
  const recent = [
    ...(recentDeposits.data||[]).map(r=>({...r,type:'deposit'})),
    ...(recentWithdrawals.data||[]).map(r=>({...r,type:'withdraw'})),
    ...(recentSwaps.data||[]).map(r=>({...r,type:'swap'}))
  ].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,5);
  const greeting = state.profile?.display_name ? `Welcome back, ${state.profile.display_name.split(' ')[0]}` : 'Welcome back';
  const markets = state.markets.slice(0,5);
  const kycStatus = latestKyc.data?.status || 'not_submitted';
  const kycLabel = ({approved:'Verified',pending:'Under review',rejected:'Action required',not_submitted:'Not submitted'})[kycStatus] || kycStatus.replaceAll('_',' ');
  const accountStatusLabel = state.profile?.account_status === 'active' ? 'Active' : (state.profile?.account_status || 'Unknown').replaceAll('_',' ');
  return `${heading(greeting,'Here is your digital asset account overview.',`<button class="secondary-button" data-go="wallet">View wallets →</button>`)}
    <div class="grid stats-grid">
      <div class="card stat-card"><div class="stat-top"><span>Total portfolio value</span><span class="stat-icon">◈</span></div><div class="stat-value">${totals.priced?`$${money(totals.total)}`:'—'}</div><div class="stat-foot">Calculated from available and locked balances</div></div>
      <div class="card stat-card"><div class="stat-top"><span>Exchange wallet</span><span class="stat-icon">▣</span></div><div class="stat-value">$${money(totals.exchange)}</div><div class="stat-foot">Trading and spot balances</div></div>
      <div class="card stat-card"><div class="stat-top"><span>Investment wallet</span><span class="stat-icon">◷</span></div><div class="stat-value">$${money(totals.investment)}</div><div class="stat-foot">Separate investment balance domain</div></div>
      <div class="card stat-card"><div class="stat-top"><span>Identity verification</span><span class="stat-icon">⌑</span></div><div class="stat-value" style="font-size:18px;text-transform:capitalize">${escapeHtml(kycLabel)}</div><div class="stat-foot">Account status: ${escapeHtml(accountStatusLabel)} · <button class="text-link" data-go="kyc">View KYC →</button></div></div>
    </div>
    <div class="grid overview-grid">
      <section class="card panel"><div class="panel-head"><div><div class="panel-title">Wallet overview</div><div class="panel-subtitle">Your balances are separated by account domain.</div></div><button class="text-link" data-go="wallet">View all wallets →</button></div>
        <div class="wallet-stack"><div class="wallet-tile"><div class="wallet-tile-top"><span>Exchange wallet</span><span class="wallet-chip">EXCHANGE</span></div><strong>$${money(totals.exchange)}</strong><small>Available and locked assets</small></div><div class="wallet-tile"><div class="wallet-tile-top"><span>Investment wallet</span><span class="wallet-chip">INVESTMENT</span></div><strong>$${money(totals.investment)}</strong><small>Separate from exchange funds</small></div></div>
        <div class="page-spacer"></div><div class="quick-actions"><button class="quick-action" data-go="deposit"><span class="qa-icon">↓</span><strong>Deposit</strong><span>Not enabled</span></button><button class="quick-action" data-go="withdraw"><span class="qa-icon">↑</span><strong>Withdraw</strong><span>Not enabled</span></button><button class="quick-action" data-go="swap"><span class="qa-icon">⇄</span><strong>Swap</strong><span>Preview only</span></button></div>
      </section>
      <section class="card panel"><div class="panel-head"><div><div class="panel-title">Market snapshot</div><div class="panel-subtitle">Top assets by market capitalisation</div></div><button class="text-link" data-go="markets">All markets →</button></div>
        ${markets.length?`<div class="mini-market-list">${markets.map(c=>`<div class="security-row"><div class="asset-cell"><span class="investment-asset-icon">${escapeHtml(code.slice(0,3))}</span><div class="asset-name"><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.symbol.toUpperCase())}</span></div></div><div style="text-align:right"><strong style="font-size:10px">${fmtPrice(c.current_price)}</strong><span class="price-change ${Number(c.price_change_percentage_24h)>=0?'positive':'negative'}" style="display:block;margin-top:4px">${Number(c.price_change_percentage_24h)>=0?'+':''}${money(c.price_change_percentage_24h,2)}%</span></div></div>`).join('')}</div>`:emptyState('Market feed unavailable','Live asset prices could not be reached. Please try again later.')}
      </section>
    </div>
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Recent activity</div><div class="panel-subtitle">Recent deposits, withdrawals and swaps</div></div><button class="text-link" data-go="activity">View activity →</button></div>
      ${recent.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Activity</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>${recent.map(activityRow).join('')}</tbody></table></div>`:emptyState('No account activity yet','When account activity becomes available, it will appear here.','◴')}
    </section>`;
}

async function renderMarkets() {
  await loadMarkets();
  return `${heading('Markets','Live market reference data from CoinGecko.',`<button class="secondary-button" id="refresh-markets">↻ Refresh prices</button>`)}
    ${state.marketError?`<div class="alert-banner"><span class="notice-icon">!</span><div><strong>Market data is temporarily unavailable</strong>The connected public market provider did not return data. No sample prices are shown.</div></div>`:''}
    <div class="market-toolbar"><div class="search-field"><input class="form-control" id="market-search" placeholder="Search assets…" /></div><div class="pill-tabs"><button class="pill-tab active">All assets</button><button class="pill-tab">USD market</button></div></div>
    <section class="card table-card"><div class="table-wrap"><table class="data-table" id="market-table"><thead><tr><th>Asset</th><th>Last price</th><th>24h change</th><th>Market cap</th><th>24h volume</th></tr></thead><tbody id="market-table-body">${state.markets.length?state.markets.map(marketRow).join(''):`<tr><td colspan="5">${emptyState('No market data','Try refreshing the public market feed.')}</td></tr>`}</tbody></table></div></section>
    <div class="security-note table-scroll-bottom">Market prices are informational only and do not represent executable quotes or guaranteed trading prices. Source: CoinGecko public market data.</div>`;
}

function renderSwapMarketLeaderboard() {
  if (!state.markets.length) return emptyState('Market data unavailable','Please refresh in a moment.','!');
  return `<div class="swap-market-list">${state.markets.slice(0,10).map((coin,index)=>{
    const change=Number(coin.price_change_percentage_24h||0),up=change>=0;
    return `<div class="swap-market-row"><span class="swap-market-rank">${index+1}</span>${coinIcon(coin)}<div class="swap-market-name"><strong>${escapeHtml(coin.name)}</strong><span>${escapeHtml(String(coin.symbol||'').toUpperCase())}</span></div><div class="swap-market-quote"><strong>${fmtPrice(coin.current_price)}</strong><span class="price-change ${up?'positive':'negative'}">${up?'+':''}${money(change,2)}%</span></div></div>`;
  }).join('')}</div>`;
}

async function renderSwap() {
  await loadMarkets();
  await loadBalances();
  const {data:assets,error:assetError}=await supabase.from('assets')
    .select('code,name,kind,decimals,is_active')
    .eq('is_active',true);
  if(assetError) console.warn('Swap asset list:',assetError.message);
  const activeAssets=(assets||[]).filter(a=>a.code==='USD'||a.kind==='crypto');
  const marketRank=new Map(state.markets.map((m,i)=>[String(m.symbol||'').toUpperCase(),i]));
  activeAssets.sort((a,b)=>a.code==='USD'?-1:b.code==='USD'?1:(marketRank.get(a.code)??99)-(marketRank.get(b.code)??99));
  const codes=activeAssets.map(a=>a.code);
  const opts=(selected)=>activeAssets.map(a=>{
    const label=a.code==='USD'?'USD — US Dollar':`${a.name} (${a.code})`;
    return `<option value="${escapeHtml(a.code)}" ${a.code===selected?'selected':''}>${escapeHtml(label)}</option>`;
  }).join('');
  const firstCode=codes.includes('BTC')?'BTC':(codes.find(c=>c!=='USD')||'USD');
  return `${heading('Swap','Buy, sell and convert supported cryptocurrencies using real market reference prices in USD.')}
    <div class="alert-banner"><span class="notice-icon">i</span><div><strong>Internal simulated exchange — USD base currency</strong>Market prices are referenced from CoinGecko. Confirmed swaps update NEXT-RA internal balances and ledger records only. No exchange, blockchain, bank or payment network is connected. Internal balances are platform accounting units and are not on-chain assets or guaranteed redeemable funds.</div></div>
    <div class="two-col"><section class="card section-card"><h3>Convert assets</h3><p>Use USD to buy crypto, sell crypto into USD, or convert one supported coin into another through USD market reference prices.</p>
      <div class="swap-box"><div class="swap-box-top"><span>You send</span><span id="swap-send-usd">≈ —</span></div><div class="swap-input-row"><input id="swap-amount" type="number" min="0" step="any" value="100" aria-label="Amount to swap"/><select id="swap-from" class="asset-select">${opts('USD')}</select></div></div>
      <button class="swap-direction" id="swap-reverse" aria-label="Reverse assets">↕</button>
      <div class="swap-box"><div class="swap-box-top"><span>Estimated receive</span><span id="swap-receive-usd">≈ —</span></div><div class="swap-input-row"><input id="swap-estimate" readonly value="—" aria-label="Estimated receive amount"/><select id="swap-to" class="asset-select">${opts(firstCode)}</select></div></div>
      <div class="detail-list" style="margin:17px 0">
        <div class="detail-row"><span>Indicative rate</span><strong id="swap-rate">—</strong></div>
        <div class="detail-row"><span>Available balance</span><strong id="swap-available-balance">—</strong></div>
        <div class="detail-row"><span>Market reference</span><strong>CoinGecko · USD</strong></div>
      </div>
      <button class="primary-button" id="get-swap-quote" style="width:100%">Get live swap quote →</button>
      <div id="swap-quote-result" class="swap-quote-result hidden" aria-live="polite"></div>
      <div class="security-note" style="margin-top:12px">A quote expires after 60 seconds. Final settlement rechecks current market prices, available balance and the configured fee before posting a balanced ledger transaction.</div>
    </section><aside class="card section-card swap-market-panel"><div class="panel-head"><div><h3>Top 10 cryptocurrencies</h3><p class="panel-subtitle">Ranked by market capitalization · USD</p></div><button class="small-button" id="refresh-swap-markets" type="button">↻ Refresh</button></div>
      <div class="swap-market-meta"><span class="status-pill ${state.markets.length?'approved':'pending'}">${state.markets.length?'Live feed':'Feed unavailable'}</span><span id="swap-market-updated">${state.marketsUpdatedAt?new Date(state.marketsUpdatedAt).toLocaleTimeString():'Waiting for data'}</span></div>
      <div id="swap-market-leaderboard">${renderSwapMarketLeaderboard()}</div>
      <div class="security-row"><div><strong>Base currency</strong><span>USD — United States Dollar</span></div>${statusPill('approved')}</div>
      <div class="security-row"><div><strong>Internal settlement</strong><span>Double-entry ledger · atomic posting</span></div>${statusPill('approved')}</div>
      <div class="security-row"><div><strong>External exchange / blockchain</strong><span>Not connected by design</span></div>${statusPill('pending')}</div>
      <div class="security-note">Market prices are public reference data. Swap values are internal simulated accounting units; they are not matched or hedged on an external exchange.</div>
    </aside></div>`;
}
async function renderWallets() {
  await loadBalances();
  const grouped = ['exchange','investment'].map(domain=>({domain,rows:state.balances.filter(b=>b.domain===domain)}));
  return `${heading('Wallets','Exchange and investment balances are maintained separately.')}
    <div class="grid overview-grid"><section class="card section-card"><h3>Exchange wallet</h3><p>Assets reserved for future trading and exchange activity.</p>${renderBalanceTable(grouped[0].rows,'No exchange balances yet')}</section><section class="card section-card"><h3>Investment wallet</h3><p>Separate accounting domain for investment principal and proceeds.</p>${renderBalanceTable(grouped[1].rows,'No investment balances yet')}</section></div>
    <div class="security-note">Balances are calculated from posted internal ledger entries. No funds are moved by viewing this page.</div>`;
}
function renderBalanceTable(rows, emptyTitle) {
  const visible = rows.filter(r=>['available','locked'].includes(r.account_kind));
  if (!visible.length) return emptyState(emptyTitle,'Your balances will appear here after a supported transaction has been recorded.');
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Asset</th><th>Account type</th><th>Balance</th><th>USD reference</th></tr></thead><tbody>${visible.map(r=>{const p=priceOf(r.asset_code);return `<tr><td><strong>${escapeHtml(r.asset_code)}</strong></td><td class="table-muted">${escapeHtml(r.account_kind)}</td><td>${money(r.balance,8)}</td><td>${p==null?'—':fmtPrice(Number(r.balance)*p)}</td></tr>`;}).join('')}</tbody></table></div>`;
}
async function renderDeposit() {
  const [{data:assets,error:assetError},{data:history,error:historyError},{data:instructionsData,error:instructionsError}]=await Promise.all([
    supabase.from('assets').select('code,name,kind,decimals').eq('is_active',true).order('display_order'),
    supabase.from('deposits').select('id,asset_code,amount,transaction_hash,status,created_at,rejection_reason,memo')
      .eq('user_id',state.user.id).eq('network_code','MANUAL').order('created_at',{ascending:false}).limit(15),
    supabase.functions.invoke('manual-settlement',{body:{action:'get_deposit_instructions'}})
  ]);
  const instructions=String(instructionsData?.instructions||'').trim();
  const configured=Boolean(instructionsData?.configured&&instructions);
  const rows=history||[];
  const bankAssets=(assets||[]).filter(a=>a.code==='USD');
  const cryptoAssets=(assets||[]).filter(a=>a.kind==='crypto'&&a.code!=='USD');
  const opts=(list)=>list.map(a=>`<option value="${escapeHtml(a.code)}">${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`).join('');
  return `${heading('Deposit','Fund your NEXT-RA account using a USD bank transfer or a cryptocurrency transfer.')}
    <div class="alert-banner"><span class="notice-icon">!</span><div><strong>External payment with manual verification</strong>Choose a payment channel, complete the transfer outside NEXT-RA, then submit the reference. Finance must verify receipt before any internal wallet balance is credited. Bank rails and blockchain monitoring are not connected to this platform.</div></div>
    <div class="deposit-method-grid">
      <label class="deposit-method-card"><input type="radio" name="deposit-method" value="bank" checked><span class="method-icon">▤</span><strong>Bank transfer</strong><small>USD · Bank account</small></label>
      <label class="deposit-method-card"><input type="radio" name="deposit-method" value="crypto"><span class="method-icon">◇</span><strong>Cryptocurrency</strong><small>Digital asset · Network</small></label>
    </div>
    <section class="card section-card deposit-instructions-card">
      <div class="panel-head"><div><h3 style="margin:0">Official payment instructions</h3><div class="panel-subtitle">Verify the beneficiary details before sending any funds.</div></div>${statusPill(configured?'approved':'pending')}</div>
      ${configured?`<div class="manual-instructions-text">${escapeHtml(instructions)}</div>`:`<div class="alert-banner" style="margin:0"><span class="notice-icon">!</span><div><strong>Payment details are not configured</strong>Super Admin / Finance must publish the official bank and crypto receiving instructions before accepting requests. Do not transfer funds yet.</div></div>`}
      ${instructionsError?`<div class="security-note">${escapeHtml(instructionsError.message||'Could not load instructions.')}</div>`:''}
    </section>
    <div class="two-col"><section class="card section-card"><h3>New deposit request</h3><p>Submit one request for each completed external transfer.</p>
      <form id="manual-deposit-form" class="form-grid">
        <div class="form-field full"><label class="field-label" for="deposit-asset">Asset to credit</label>
          <select class="form-control select-control" id="deposit-asset" required>
            <optgroup label="USD bank transfer" id="deposit-usd-group">${opts(bankAssets)}</optgroup>
            <optgroup label="Cryptocurrency" id="deposit-crypto-group">${opts(cryptoAssets)}</optgroup>
          </select>
        </div>
        <div class="form-field" id="deposit-network-wrap"><label class="field-label" for="deposit-network">Blockchain network</label><select class="form-control select-control" id="deposit-network"><option value="TRON">TRON (TRC20)</option><option value="BSC">BNB Smart Chain (BEP20)</option><option value="ETHEREUM">Ethereum (ERC20)</option><option value="BITCOIN">Bitcoin</option><option value="SOLANA">Solana</option><option value="XRPL">XRP Ledger</option></select></div>
        <div class="form-field"><label class="field-label" for="manual-deposit-amount">Amount</label><input class="form-control" id="manual-deposit-amount" type="number" min="0.00000001" step="any" required placeholder="Enter amount"/></div>
        <div class="form-field full"><label class="field-label" for="manual-deposit-reference" id="deposit-reference-label">Bank transfer reference</label><input class="form-control" id="manual-deposit-reference" type="text" minlength="4" maxlength="160" required placeholder="Enter your bank transfer reference"/></div>
        <div class="form-field full"><label class="field-label" for="manual-deposit-memo">Additional note (optional)</label><textarea class="form-control" id="manual-deposit-memo" rows="2" maxlength="500" placeholder="Additional payment details"></textarea></div>
        <div class="form-field full"><button class="primary-button" id="manual-deposit-submit" type="submit" ${configured?'':'disabled'}>Submit deposit for verification →</button></div>
      </form>
      ${assetError?`<div class="security-note">Could not load supported assets: ${escapeHtml(assetError.message||'')}</div>`:''}
    </section><aside class="card section-card"><h3>Deposit process</h3>
      <div class="security-row"><div><strong>01 · Choose channel</strong><span>USD bank transfer or supported crypto asset.</span></div>${statusPill('approved')}</div>
      <div class="security-row"><div><strong>02 · Make external payment</strong><span>Use only the official details published above.</span></div>${statusPill('pending')}</div>
      <div class="security-row"><div><strong>03 · Submit proof reference</strong><span>Bank reference or blockchain transaction hash.</span></div>${statusPill('pending')}</div>
      <div class="security-row"><div><strong>04 · Finance verification</strong><span>Internal USD / crypto ledger is credited only after approval.</span></div>${statusPill('pending')}</div>
      <div class="security-note">A submitted request is not proof of payment. Crypto transfers are not monitored on-chain by NEXT-RA.</div>
    </aside></div>
    <div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Deposit history</div><div class="panel-subtitle">Review status and verification results for your requests.</div></div></div>
      ${rows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Asset</th><th>Amount</th><th>Payment reference</th><th>Date</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.asset_code)}</td><td>${money(r.amount,8)}</td><td class="table-muted">${escapeHtml(r.transaction_hash||'—')}</td><td>${fmtDate(r.created_at)}</td><td>${statusPill(r.status)}${r.rejection_reason?`<div class="field-help">${escapeHtml(r.rejection_reason)}</div>`:''}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No deposit requests','Your deposit requests will appear here.') }
    </section>`;
}
async function renderWithdraw() {
  const [{data:assets,error:assetError},{data:history,error:historyError}]=await Promise.all([
    supabase.from('assets').select('code,name,kind,decimals').eq('is_active',true).order('display_order'),
    supabase.from('withdrawals').select('id,asset_code,amount,fee_amount,net_amount,destination_address,status,created_at,rejection_reason,memo')
      .eq('user_id',state.user.id).eq('network_code','MANUAL').order('created_at',{ascending:false}).limit(15)
  ]);
  const bankAssets=(assets||[]).filter(a=>a.code==='USD');
  const cryptoAssets=(assets||[]).filter(a=>a.kind==='crypto'&&a.code!=='USD');
  const opts=(list)=>list.map(a=>`<option value="${escapeHtml(a.code)}">${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`).join('');
  const rows=history||[];
  return `${heading('Withdraw','Request a USD bank payout or cryptocurrency withdrawal from your internal balance.')}
    <div class="alert-banner"><span class="notice-icon">!</span><div><strong>External payout requires manual processing</strong>Your internal balance is reserved after a request is accepted. Finance must send the bank payment or crypto transfer outside NEXT-RA and record its reference. No bank API, payment gateway, blockchain node or signing service is connected.</div></div>
    <div class="deposit-method-grid">
      <label class="deposit-method-card"><input type="radio" name="withdraw-method" value="bank" checked><span class="method-icon">▤</span><strong>Bank payout</strong><small>USD · Bank account</small></label>
      <label class="deposit-method-card"><input type="radio" name="withdraw-method" value="crypto"><span class="method-icon">◇</span><strong>Crypto withdrawal</strong><small>Digital asset · Network</small></label>
    </div>
    <div class="two-col"><section class="card section-card"><h3>New withdrawal request</h3><p>Enter the amount and verify the destination details carefully.</p>
      <form id="manual-withdrawal-form" class="form-grid">
        <div class="form-field full"><label class="field-label" for="manual-withdrawal-asset">Asset</label><select class="form-control select-control" id="manual-withdrawal-asset" required><optgroup label="USD bank payout" id="withdraw-usd-group">${opts(bankAssets)}</optgroup><optgroup label="Cryptocurrency" id="withdraw-crypto-group">${opts(cryptoAssets)}</optgroup></select></div>
        <div class="form-field" id="withdraw-network-wrap"><label class="field-label" for="withdraw-network">Blockchain network</label><select class="form-control select-control" id="withdraw-network"><option value="TRON">TRON (TRC20)</option><option value="BSC">BNB Smart Chain (BEP20)</option><option value="ETHEREUM">Ethereum (ERC20)</option><option value="BITCOIN">Bitcoin</option><option value="SOLANA">Solana</option><option value="XRPL">XRP Ledger</option></select></div>
        <div class="form-field"><label class="field-label" for="manual-withdrawal-amount">Amount</label><input class="form-control" id="manual-withdrawal-amount" type="number" min="0.00000001" step="any" required placeholder="Enter amount"/></div>
        <div class="form-field full"><label class="field-label" for="manual-withdrawal-destination" id="withdraw-destination-label">Bank account details</label><textarea class="form-control" id="manual-withdrawal-destination" rows="3" minlength="4" maxlength="500" required placeholder="Bank name, account holder and account number"></textarea></div>
        <div class="form-field full"><label class="field-label" for="manual-withdrawal-memo">Additional note (optional)</label><textarea class="form-control" id="manual-withdrawal-memo" rows="2" maxlength="500" placeholder="Beneficiary or payout note"></textarea></div>
        <div class="form-field full"><button class="primary-button" id="manual-withdrawal-submit" type="submit">Submit withdrawal request →</button></div>
      </form>
      ${assetError?`<div class="security-note">Could not load supported assets: ${escapeHtml(assetError.message||'')}</div>`:''}
    </section><aside class="card section-card"><h3>Withdrawal controls</h3>
      <div class="security-row"><div><strong>Available balance check</strong><span>Server-side validation before reservation.</span></div>${statusPill('approved')}</div>
      <div class="security-row"><div><strong>Internal reservation</strong><span>Funds move to withdrawal clearing pending review.</span></div>${statusPill('approved')}</div>
      <div class="security-row"><div><strong>External payout</strong><span>Finance sends the payment outside NEXT-RA.</span></div>${statusPill('pending')}</div>
      <div class="security-row"><div><strong>Completion evidence</strong><span>Admin records the verified payout reference.</span></div>${statusPill('pending')}</div>
      <div class="security-note">A rejected request releases the reserved amount back to your internal available balance. No on-chain transaction is broadcast.</div>
    </aside></div>
    <div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Withdrawal history</div><div class="panel-subtitle">Track payout review and completion status.</div></div></div>
      ${rows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Asset</th><th>Amount</th><th>Destination</th><th>Date</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.asset_code)}</td><td>${money(r.amount,8)}</td><td class="table-muted">${escapeHtml(r.destination_address)}</td><td>${fmtDate(r.created_at)}</td><td>${statusPill(r.status)}${r.rejection_reason?`<div class="field-help">${escapeHtml(r.rejection_reason)}</div>`:''}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No withdrawal requests','Your withdrawal requests will appear here.') }
    </section>`;
}
async function renderInvestments() {
  await loadMarkets();
  const [plans, investments] = await Promise.all([
    supabase.from('investment_plans').select('id,plan_code,name,description,asset_code,minimum_amount,maximum_amount,minimum_duration_days,maximum_duration_days,rate_value,rate_period,is_active').eq('is_active',true).order('name'),
    supabase.from('investments').select('id,asset_code,principal_amount,duration_days,applied_rate,applied_rate_period,status,starts_at,matures_at,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(20)
  ]);
  if (plans.error) console.warn('Investment plans could not be loaded:',plans.error.message);
  if (investments.error) console.warn('Investment history could not be loaded:',investments.error.message);
  const planRows = plans.data||[], invRows = investments.data||[];
  const supported = ['BTC','ETH','USDT','BNB','SOL','USDC','XRP','ADA','DOGE','TRX'];
  const coins = supported.map(code=>state.markets.find(m=>String(m.symbol||'').toUpperCase()===code)).filter(Boolean);
  const selectedCode = state.investmentDisplayAsset || coins[0]?.symbol?.toUpperCase() || 'BTC';
  const selectedCoin = coins.find(c=>String(c.symbol).toUpperCase()===selectedCode) || coins[0];
  const selectedPrice = selectedCoin ? Number(selectedCoin.current_price) : null;
  const selectedPlans = planRows.filter(p=>!p.asset_code || p.asset_code===selectedCode);
  const activeTotal = invRows.filter(i=>['active','pending'].includes(i.status)).reduce((sum,i)=>sum+Number(i.principal_amount||0),0);
  const maturedTotal = invRows.filter(i=>i.status==='matured').reduce((sum,i)=>sum+Number(i.principal_amount||0),0);
  const assetCards = coins.map(c=>{
    const code=String(c.symbol).toUpperCase(), change=Number(c.price_change_percentage_24h||0), up=change>=0;
    return `<button type="button" class="investment-asset-card ${code===selectedCode?'selected':''}" data-invest-asset="${escapeHtml(code)}" aria-pressed="${code===selectedCode?'true':'false'}">
      <span class="investment-asset-top">${coinIcon(c)}<span class="investment-change ${up?'up':'down'}">${up?'+':''}${money(change,2)}%</span></span>
      <strong>${escapeHtml(c.name)}</strong><span class="investment-asset-symbol">${escapeHtml(code)}</span>
      <b>${fmtPrice(c.current_price)}</b><small>24h market reference</small></button>`;
  }).join('');
  return `${heading('Investments','USD-denominated investment plans with live crypto market visuals.')}
    <div class="investment-disclosure"><strong>How NEXT-RA Investment works</strong><p>Your investment principal and returns are recorded in USD. Crypto prices, charts and network activity are visual market references only. Price movements do not change your principal or configured USD return. No crypto is purchased or held on your behalf.</p></div>
    <div class="grid investment-summary-grid">
      <div class="card investment-summary"><span>Active investment principal</span><strong>${fmtPrice(activeTotal)}</strong><small>USD · account records</small></div>
      <div class="card investment-summary"><span>Matured principal awaiting choice</span><strong>${fmtPrice(maturedTotal)}</strong><small>USD · withdraw or reinvest</small></div>
      <div class="card investment-summary"><span>Payment currency</span><strong>USD</strong><small>Principal and ROI denomination</small></div>
    </div>
    <section class="card panel investment-market-panel">
      <div class="panel-head"><div><div class="panel-title">Choose a market visual</div><div class="panel-subtitle">Select an asset to view its live public market reference. This does not change your investment currency.</div></div><span class="status-pill ${state.marketError?'pending':'approved'}">${state.marketError?'Market feed unavailable':'Live market reference'}</span></div>
      <div class="investment-assets-grid">${assetCards||emptyState('Market data unavailable','The market reference feed did not return the supported assets.')}</div>
      ${selectedCoin? `<div class="investment-selected-market"><div><span class="table-muted">Selected market reference</span><h3>${escapeHtml(selectedCoin.name)} (${escapeHtml(selectedCode)})</h3><strong>${fmtPrice(selectedPrice)}</strong><span class="investment-change ${Number(selectedCoin.price_change_percentage_24h||0)>=0?'up':'down'}">${Number(selectedCoin.price_change_percentage_24h||0)>=0?'+':''}${money(selectedCoin.price_change_percentage_24h||0,2)}% · 24h</span></div><div class="investment-market-note">Illustrative market data only<br><small>Not used to calculate USD ROI</small></div></div>`:''}
    </section>
    <div class="page-spacer"></div>
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Available investment plans</div><div class="panel-subtitle">Configured by an authorised administrator · USD principal · 24-hour payout cycle</div></div></div>
      ${selectedPlans.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Plan</th><th>Principal range (USD)</th><th>Duration</th><th>Configured ROI</th><th>Currency</th></tr></thead><tbody>${selectedPlans.map(p=>`<tr><td><strong>${escapeHtml(p.name)}</strong><div class="table-muted">${escapeHtml(p.description||p.plan_code)}</div></td><td>${money(p.minimum_amount,2)} – ${p.maximum_amount==null?'No maximum':money(p.maximum_amount,2)}</td><td>${p.minimum_duration_days??'—'}–${p.maximum_duration_days??'—'} days</td><td>${p.rate_value==null?'Admin configuration pending':money(p.rate_value,2)+'% / '+escapeHtml(p.rate_period||'period')}</td><td><strong>USD</strong></td></tr>`).join('')}</tbody></table></div>`:emptyState('No active plans for this selection','Investment plans will appear here after an authorised administrator configures and opens them. No investment can be started from this display yet.')}
    </section>
    <div class="page-spacer"></div>
    <section class="card panel investment-activity-panel"><div class="panel-head"><div><div class="panel-title">Public network activity</div><div class="panel-subtitle">${escapeHtml(selectedCode)} · public blockchain reference</div></div><span class="status-pill pending">Connection pending</span></div><div class="investment-activity-placeholder"><span class="notice-icon">i</span><div><strong>Public transaction feed is not connected yet</strong><p>When an approved public data provider is integrated, this area will show third-party network transactions. These records will remain separate from NEXT-RA member activity and will never affect investment balances.</p></div></div></section>
    <div class="page-spacer"></div>
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">My investment history</div><div class="panel-subtitle">Your private investment records · all amounts in USD</div></div></div>
      ${invRows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Market reference</th><th>Principal (USD)</th><th>Duration</th><th>ROI terms</th><th>Status</th><th>Start date</th></tr></thead><tbody>${invRows.map(i=>`<tr><td>${escapeHtml(i.asset_code||'—')}</td><td><strong>${money(i.principal_amount,2)} USD</strong></td><td>${i.duration_days} days</td><td>${i.applied_rate==null?'—':money(i.applied_rate,2)+'% / '+escapeHtml(i.applied_rate_period||'')}</td><td>${statusPill(i.status)}${i.status==='matured'?'<div class="field-help">Choose withdrawal or reinvestment</div>':''}</td><td>${fmtDate(i.starts_at)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No investments yet','Your private investment records will appear here after the investment service is enabled.')}</section>
    <div class="security-note investment-simulation-note">NEXT-RA investment is presented as a USD-denominated platform product. Market visuals and public network data are informational only and do not represent asset custody, trading exposure, guaranteed returns or proof of reserves.</div>`;
}
async function renderReferrals() {
  const [profile,rewards] = await Promise.all([
    supabase.from('referral_profiles').select('referral_code,created_at').eq('user_id',state.user.id).maybeSingle(),
    supabase.from('referral_rewards').select('id,asset_code,amount,reward_level,status,created_at').eq('referrer_user_id',state.user.id).order('created_at',{ascending:false}).limit(20)
  ]);
  const code = profile.data?.referral_code;
  return `${heading('Referrals','Your referral profile and reward history.')}
    <div class="two-col"><section class="card section-card"><h3>Your referral code</h3><p>Share your personal referral code after the referral programme has been configured.</p><div class="swap-box"><div class="swap-box-top"><span>Referral code</span><span>PERSONAL</span></div><div class="swap-input-row"><input id="referral-code" readonly value="${escapeHtml(code||'Not generated yet')}" style="font-size:16px"/><button class="secondary-button" id="copy-referral" ${code?'':'disabled'}>Copy</button></div></div></section><section class="card section-card"><h3>Programme status</h3><p>Referral reward rates and payout rules will be published by an administrator before referrals become active.</p><div class="security-row"><div><strong>Referral code</strong><span>Profile status</span></div>${statusPill(code?'approved':'pending')}</div><div class="security-row"><div><strong>Reward calculation</strong><span>Rules not yet configured</span></div>${statusPill('pending')}</div></section></div>
    <div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Reward history</div><div class="panel-subtitle">Recorded rewards associated with your referral account</div></div></div>${(rewards.data||[]).length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Asset</th><th>Amount</th><th>Level</th><th>Status</th><th>Date</th></tr></thead><tbody>${rewards.data.map(r=>`<tr><td>${escapeHtml(r.asset_code)}</td><td>${money(r.amount,6)}</td><td>${r.reward_level||'—'}</td><td>${statusPill(r.status)}</td><td>${fmtDate(r.created_at)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No referral rewards','Reward records will appear here once the programme is configured.')}</section>`;
}

async function renderKyc() {
  const {data,error} = await supabase.from('kyc_submissions').select('id,status,submitted_at,reviewed_at,rejection_reason').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(5);
  const latest = data?.[0];
  return `${heading('Identity verification','Submit identity documents through a private, access-controlled upload area.')}
    <div class="kyc-status-card"><div class="kyc-status-meta"><div class="kyc-status-icon">▤</div><div><strong>Verification status</strong><span>${latest?`Last submitted ${fmtDate(latest.submitted_at)}`:'No verification submitted yet'}</span></div></div>${statusPill(latest?.status||'not_submitted')}</div>
    ${latest?.rejection_reason?`<div class="alert-banner"><span class="notice-icon">!</span><div><strong>Additional information required</strong>${escapeHtml(latest.rejection_reason)}</div></div>`:''}
    <div class="two-col"><section class="card section-card"><h3>Submit identity documents</h3><p>Upload a government identity document and, where requested, supporting information. Accepted formats: PDF, JPG and PNG. Maximum 10 MB per file.</p>
      <form id="kyc-form" class="form-grid"><div class="form-field"><label class="field-label" for="kyc-document-type">Document type</label><select class="form-control select-control" id="kyc-document-type"><option value="passport">Passport</option><option value="identity_front">Identity card — front</option><option value="identity_back">Identity card — back</option><option value="selfie">Selfie</option><option value="proof_of_address">Proof of address</option><option value="other">Other supporting document</option></select></div>
      <div class="form-field"><label class="field-label" for="kyc-files">Choose documents</label><input class="form-control" id="kyc-files" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple required /></div>
      <div class="form-field full"><div class="field-help">Files are stored in the private <strong>kyc-private</strong> bucket. Only your account and authorised administrators with verified MFA can access them.</div></div>
      <div class="form-field full"><label style="display:flex;gap:8px;align-items:flex-start;font-size:9px;color:#718197;line-height:1.5"><input type="checkbox" id="kyc-consent" style="margin:1px 0 0" required /> I confirm these documents belong to me and consent to their use for identity verification.</label></div>
      <div class="form-field full"><button type="submit" class="primary-button" id="kyc-submit-btn">Upload and submit documents →</button></div></form>
    </section><aside class="card section-card"><h3>Verification guidelines</h3><p>For a smooth review, upload clear, complete and unedited documents. Make sure names and details are readable.</p><div class="security-row"><div><strong>Accepted files</strong><span>PDF, JPEG, PNG</span></div><strong style="font-size:9px">10 MB max</strong></div><div class="security-row"><div><strong>Storage</strong><span>Private, non-public document bucket</span></div>${statusPill('approved')}</div><div class="security-row"><div><strong>Review access</strong><span>Authorised admin with MFA (AAL2)</span></div>${statusPill('approved')}</div></aside></div>
    ${error?`<div class="security-note">KYC status could not be loaded: ${escapeHtml(error.message)}</div>`:''}
    <div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Submission history</div><div class="panel-subtitle">Previous verification attempts</div></div></div>${data?.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Submission</th><th>Submitted</th><th>Status</th><th>Review note</th></tr></thead><tbody>${data.map(s=>`<tr><td>${shortId(s.id)}</td><td>${fmtDate(s.submitted_at)}</td><td>${statusPill(s.status)}</td><td class="table-muted">${escapeHtml(s.rejection_reason||'—')}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No KYC submissions','Your submitted verification documents will be listed here.')}</section>`;
}

async function renderSecurity() {
  const {data,error} = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  const verified = (data?.totp||[]).filter(f=>f.status==='verified');
  const unverified = (data?.totp||[]).filter(f=>f.status!=='verified');
  const isAdmin = state.roles.length > 0;
  return `${heading('Security','Protect your account with a second authentication factor.')}
    <div class="two-col"><section class="card section-card"><h3>Two-factor authentication</h3><p>Use an authenticator app to add a second layer of protection to your account.</p>
      <div class="security-row"><div><strong>Authenticator app (TOTP)</strong><span>${verified.length?'A verified authenticator is connected.':'No verified authenticator is connected.'}</span></div>${statusPill(verified.length?'approved':'pending')}</div>
      <div class="security-row"><div><strong>Current session security</strong><span>Authenticator assurance level</span></div>${statusPill(state.aal==='aal2'?'approved':'pending')}</div>
      ${verified.length?`<div class="field-help" style="margin-top:15px">Your authenticator is enrolled. Administrative pages require a session verified at AAL2.</div>`:`<button class="primary-button" id="setup-mfa" style="margin-top:14px">Set up authenticator app →</button>`}
      ${unverified.length?`<div class="field-help" style="margin-top:10px">An unfinished authenticator setup exists. Start a new setup only after removing the unfinished setup from your authenticator app.</div>`:''}
    </section><aside class="card section-card"><h3>Account access</h3><p>Administrative permissions are separated from standard member access.</p><div class="security-row"><div><strong>Account email</strong><span>${escapeHtml(state.user.email||'—')}</span></div><span class="status-pill approved">Verified</span></div><div class="security-row"><div><strong>Account role</strong><span>${escapeHtml(isAdmin?state.roles.join(', ').replaceAll('_',' '):'Member')}</span></div>${statusPill(isAdmin?'approved':'pending')}</div><div class="security-row"><div><strong>Admin area</strong><span>${isAdmin?'Requires AAL2 for every sensitive operation.':'No administrative role assigned.'}</span></div>${statusPill(isAdmin?(state.aal==='aal2'?'approved':'pending'):'rejected')}</div></aside></div>
    <div class="security-note" style="margin-top:16px">Keep your authenticator app and recovery method secure. Support staff will never ask you to disclose a one-time password.</div>`;
}

async function renderActivity() {
  const [d,w,s,i] = await Promise.all([
    supabase.from('deposits').select('id,asset_code,amount,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(30),
    supabase.from('withdrawals').select('id,asset_code,amount,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(30),
    supabase.from('swap_orders').select('id,from_asset_code,to_asset_code,from_amount,received_amount,fee_amount,fee_asset_code,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(30),
    supabase.from('investments').select('id,asset_code,principal_amount,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(30)
  ]);
  const rows=[...(d.data||[]).map(x=>({...x,type:'deposit'})),...(w.data||[]).map(x=>({...x,type:'withdraw'})),...(s.data||[]).map(x=>({...x,type:'swap'})),...(i.data||[]).map(x=>({...x,type:'investment'}))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  return `${heading('Activity','A private timeline of your account records.')}
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Account history</div><div class="panel-subtitle">Latest 120 records across your account modules</div></div></div>${rows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Sent / received</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.type)}</td><td class="table-muted">${shortId(r.id)}</td><td>${fmtDate(r.created_at)}</td><td>${r.type==='swap'?`${money(r.from_amount,8)} ${escapeHtml(r.from_asset_code)} → ${r.received_amount==null?'—':money(r.received_amount,8)+' '+escapeHtml(r.to_asset_code)}`:`${money(r.amount??r.principal_amount,6)} ${escapeHtml(r.asset_code)}`}</td><td>${statusPill(r.status)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No activity yet','Your account records will appear here once an approved operation has been processed.')}</section>`;
}

async function renderAdmin() {
  if (!state.roles.length) return `${heading('Admin console','Restricted administrative workspace.')}<div class="card panel">${emptyState('No administrator role','This account does not have an administrator role assigned.','⌑')}</div>`;
  if (state.aal !== 'aal2') return `${heading('Admin console','Restricted administrative workspace.')}<div class="mfa-required"><strong>Two-factor authentication required</strong>Administrative tools are locked until you enrol an authenticator app and verify this session at AAL2.<div style="margin-top:10px"><button class="primary-button" data-go="security">Open security settings →</button></div></div>`;
  const {data,error} = await supabase.functions.invoke('admin-overview',{body:{}});
  if (error) return `${heading('Admin console','Administrative overview and governance tools.')}<div class="card panel">${emptyState('Admin overview unavailable',error.message||'The secure admin service did not respond.')}</div>`;
  state.adminOverview=data;
  const m=data.metrics||{};
  const isSuper=state.roles.includes('super_admin');
  const kycRows=data.pending_kyc||[];
  const depositRows=data.pending_deposits||[];
  const withdrawalRows=data.pending_withdrawals||[];
  const canReviewMoney=state.roles.some(role=>['super_admin','finance_admin'].includes(role));
  const invites=data.pending_invitations||[];
  const pairs=data.trading_pairs||[];
  const fee=data.active_swap_fee||null;
  const treasury=data.treasury_balances||[];
  const hasTreasuryLiquidity=false;
  let investmentPlanRows=[];
  let investmentPlanError='';
  if(isSuper){
    const {data:investmentData,error:investmentError}=await supabase.functions.invoke('admin-investment-settings',{body:{action:'list'}});
    if(investmentError) investmentPlanError=investmentError.message||'Investment configuration service unavailable.';
    else if(!investmentData?.success) investmentPlanError=investmentData?.error||'Could not load investment plans.';
    else investmentPlanRows=investmentData.plans||[];
  }
  const settings=data.system_settings||{};
  const systemValue=(key)=>settings[key]===undefined?'Not configured':String(settings[key]);
  return `${heading('Admin console','Governance, system health, market configuration and compliance.',isSuper?`<button class="primary-button" id="open-invite-admin">+ Invite administrator</button>`:'')}
    <div class="grid admin-metric-grid"><div class="card admin-metric"><span>Total registered users</span><strong>${m.users??'—'}</strong></div><div class="card admin-metric"><span>Pending KYC reviews</span><strong>${m.pending_kyc??'—'}</strong></div><div class="card admin-metric"><span>Pending deposits</span><strong>${m.pending_deposits??'—'}</strong></div><div class="card admin-metric"><span>Pending withdrawals</span><strong>${m.pending_withdrawals??'—'}</strong></div><div class="card admin-metric"><span>Swap orders</span><strong>${m.swap_orders??'—'}</strong></div><div class="card admin-metric"><span>Posted ledger transactions</span><strong>${m.posted_ledger_transactions??'—'}</strong></div></div>
    <div class="two-col">
      <section class="card section-card"><div class="panel-head"><div><h3 style="margin:0">System safety status</h3><div class="panel-subtitle">Live configuration read from the database</div></div></div>
        <div class="security-row"><div><strong>Settlement mode</strong><span>${escapeHtml(systemValue('settlement_mode'))}</span></div>${statusPill(settings.settlement_mode==='internal_ledger_only'?'approved':'pending')}</div>
        <div class="security-row"><div><strong>On-chain deposits</strong><span>Blockchain deposit integration</span></div>${statusPill(settings.onchain_deposits_enabled===true?'pending':'approved')}</div>
        <div class="security-row"><div><strong>On-chain withdrawals</strong><span>Blockchain signing and payout integration</span></div>${statusPill(settings.onchain_withdrawals_enabled===true?'pending':'approved')}</div>
        <div class="security-row"><div><strong>Internal swap execution</strong><span>${settings.swap_execution_enabled===true?'Enabled after fee configuration':'Disabled until Super Admin saves a fee of at least 0.05%'}</span></div>${statusPill(settings.swap_execution_enabled===true?'approved':'pending')}</div>
        <div class="security-row"><div><strong>Market data</strong><span>Public price reference feed</span></div>${statusPill(state.marketError?'pending':'approved')}</div>
      </section>
      <section class="card section-card"><h3>Administrator access</h3><p>Privileged controls require a Super Admin role and an AAL2 verified session.</p>
        <div class="security-row"><div><strong>Your role</strong><span>${escapeHtml(state.roles.join(', ').replaceAll('_',' '))}</span></div>${statusPill('approved')}</div>
        <div class="security-row"><div><strong>Session assurance</strong><span>${escapeHtml(state.aal)}</span></div>${statusPill(state.aal==='aal2'?'approved':'pending')}</div>
        <div class="security-row"><div><strong>Supported assets</strong><span>${(data.assets||[]).length} configured assets</span></div>${statusPill('approved')}</div>
        <div class="security-row"><div><strong>Active trading pairs</strong><span>${pairs.filter(p=>p.is_active).length} of ${pairs.length}</span></div>${statusPill(pairs.some(p=>p.is_active)?'approved':'pending')}</div>
      </section>
    </div>
    <div class="page-spacer"></div>
    <section class="card section-card"><div class="panel-head"><div><h3 style="margin:0">External custody &amp; reserve status</h3><div class="panel-subtitle">No external exchange, bank custody or blockchain reserve is connected.</div></div><span class="status-pill pending">External custody off</span></div>
      ${treasury.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Asset</th><th>Treasury balance</th><th>Settlement readiness</th></tr></thead><tbody>${treasury.map(item=>`<tr><td><strong>${escapeHtml(item.asset_code)}</strong></td><td>${money(item.balance,8)} ${escapeHtml(item.asset_code)}</td><td>${Number(item.balance)>0?statusPill('approved'):statusPill('pending')}</td></tr>`).join('')}</tbody></table></div>`:emptyState('Treasury accounts not available','The platform treasury accounts could not be loaded.')}
      <div class="security-note">NEXT-RA internal simulated balances are ledger units only. This panel is not proof of external reserves, custody or redeemability.</div>
    </section>
    <div class="page-spacer"></div>
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Trading pair controls</div><div class="panel-subtitle">Enabling a pair allows internal simulated swaps using USD market-reference prices. It never enables external exchange or blockchain execution.</div></div></div>
      ${pairs.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Pair</th><th>Configuration</th><th>Action</th></tr></thead><tbody>${pairs.map(p=>`<tr><td><strong>${escapeHtml(p.base_asset_code)} / ${escapeHtml(p.quote_asset_code)}</strong></td><td>${statusPill(p.is_active?'approved':'pending')}</td><td>${isSuper?`<button class="small-button ${p.is_active?'reject':'approve'}" data-admin-pair-toggle="${escapeHtml(p.id)}" data-enabled="${p.is_active?'true':'false'}">${p.is_active?'Disable pair':'Enable internal pair'}</button>`:'Read only'}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No pairs configured','Add trading pairs in the database before enabling market quotes.')}
    </section>
    ${isSuper?`<div class="page-spacer"></div><section class="card section-card"><h3>Swap fee configuration</h3><p>Fee changes are recorded in the admin audit log. The configured fee is applied to completed internal swaps. No external exchange or blockchain fee is charged.</p>
      <div class="security-row"><div><strong>Current swap fee</strong><span>${fee?`${money(fee.fee_value,2)}% · effective ${fmtDate(fee.effective_from)}`:'Not configured · minimum allowed is 0.05%'}</span></div>${statusPill(fee?'approved':'pending')}</div>
      <div class="form-field"><label class="field-label" for="swap-fee-percent">New swap fee (%)</label><input id="swap-fee-percent" class="form-control" type="number" min="0.05" max="10" step="0.01" value="${fee?escapeHtml(String(fee.fee_value)):''}" placeholder="Enter 0.05–10" /></div>
      <button class="primary-button" id="save-swap-fee" style="margin-top:12px">Save swap fee configuration →</button>
    </section>`:`<section class="card section-card"><h3>Swap fee configuration</h3><p>${fee?`Current configured fee: ${money(fee.fee_value,2)}%.`:'No swap fee has been configured.'} Contact the Super Admin to make changes.</p></section>`}
    <div class="page-spacer"></div>
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Manual deposit verification</div><div class="panel-subtitle">Approve only after checking the external payment receipt or bank statement.</div></div><span class="status-pill pending">${depositRows.length} pending</span></div>
      ${depositRows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Member</th><th>Asset / amount</th><th>External reference</th><th>Submitted</th><th>Action</th></tr></thead><tbody>${depositRows.map(row=>`<tr><td>${escapeHtml(row.email||shortId(row.user_id))}</td><td><strong>${money(row.amount,8)} ${escapeHtml(row.asset_code)}</strong></td><td class="table-muted">${escapeHtml(row.transaction_hash||'—')}<div class="field-help">${escapeHtml(row.memo||'')}</div></td><td>${fmtDate(row.created_at)}</td><td>${canReviewMoney?`<div class="row-actions"><button class="small-button approve" data-manual-deposit="approve" data-id="${escapeHtml(row.id)}">Verify &amp; credit</button><button class="small-button reject" data-manual-deposit="reject" data-id="${escapeHtml(row.id)}">Reject</button></div>`:'Read only'}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No pending deposit requests','New external payment requests will appear here for manual review.')}
    </section>
    <div class="page-spacer"></div>
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Manual withdrawal requests</div><div class="panel-subtitle">Make the external payout first, then mark it completed with the payment reference.</div></div><span class="status-pill pending">${withdrawalRows.length} pending</span></div>
      ${withdrawalRows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Member</th><th>Asset / amount</th><th>Destination</th><th>Submitted</th><th>Action</th></tr></thead><tbody>${withdrawalRows.map(row=>`<tr><td>${escapeHtml(row.email||shortId(row.user_id))}</td><td><strong>${money(row.amount,8)} ${escapeHtml(row.asset_code)}</strong><div class="table-muted">Net: ${money(row.net_amount,8)} · Fee: ${money(row.fee_amount,8)}</div></td><td class="table-muted" style="white-space:normal;max-width:240px">${escapeHtml(row.destination_address)}<div class="field-help">${escapeHtml(row.memo||'')}</div></td><td>${fmtDate(row.created_at)}</td><td>${canReviewMoney?`<div class="row-actions"><button class="small-button approve" data-manual-withdrawal="complete" data-id="${escapeHtml(row.id)}">Mark paid</button><button class="small-button reject" data-manual-withdrawal="reject" data-id="${escapeHtml(row.id)}">Reject &amp; refund</button></div>`:'Read only'}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No pending withdrawal requests','New external payout requests will appear here for manual review.')}
    </section>
    ${canReviewMoney?`<div class="page-spacer"></div><section class="card section-card"><h3>External deposit instructions</h3><p>Publish separate USD bank-transfer details and crypto deposit details (asset, network and receiving address) for authenticated members. Keep this information current. No bank/payment provider or blockchain monitor is connected to NEXT-RA.</p>
      <div class="form-field"><label class="field-label" for="manual-deposit-instructions">Payment instructions</label><textarea class="form-control" id="manual-deposit-instructions" rows="5" maxlength="3000" placeholder="USD BANK TRANSFER\nBank name:\nBeneficiary name:\nAccount number / IBAN:\nSWIFT / routing code:\nCurrency: USD\n\nCRYPTO DEPOSITS\nUSDT · TRON (TRC20): receiving address\nUSDT · BNB Smart Chain (BEP20): receiving address\nBTC · Bitcoin: receiving address\nETH · Ethereum (ERC20): receiving address\nMinimum confirmations / notes:…">${escapeHtml(String(settings.manual_deposit_instructions?.text||''))}</textarea></div>
      <button class="primary-button" id="save-manual-deposit-instructions" style="margin-top:12px">Save deposit instructions →</button>
      <div class="security-note" style="margin-top:9px">Changes are audited. Use clear labels for each asset and network. Members can see these instructions only after signing in. Deposit requests remain pending until Finance verifies actual receipt.</div>
    </section>`:''}
    <div class="page-spacer"></div>
    <div class="two-col"><section class="card section-card"><div class="panel-head"><div><h3 style="margin:0">KYC review queue</h3><div class="panel-subtitle">Identity documents requiring review</div></div><span class="status-pill pending">${kycRows.length} pending</span></div>
      ${kycRows.length?kycRows.map(k=>`<div class="admin-kyc-row"><div><strong>${escapeHtml(k.email||shortId(k.user_id))}</strong><span>Submitted ${fmtDate(k.submitted_at)} · ${k.documents?.length||0} document(s)</span><div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:8px">${(k.documents||[]).map(doc=>doc.signed_url?`<a class="small-button" href="${escapeHtml(doc.signed_url)}" target="_blank" rel="noopener">View ${escapeHtml(doc.document_type)}</a>`:'').join('')}</div></div><div class="row-actions"><button class="small-button approve" data-kyc-review="approved" data-kyc-id="${escapeHtml(k.id)}">Approve</button><button class="small-button reject" data-kyc-review="rejected" data-kyc-id="${escapeHtml(k.id)}">Reject</button></div></div>`).join('') : emptyState('No pending KYC reviews','New submissions will appear here once members submit documents.')}
    </section><section class="card section-card"><h3>Platform limitations</h3><p>External payments are handled manually outside NEXT-RA; no blockchain or bank payment integration is present.</p>
      <div class="security-row"><div><strong>Manual deposits</strong><span>Externally verified by Finance Admin</span></div>${statusPill('approved')}</div>
      <div class="security-row"><div><strong>Manual withdrawals</strong><span>Externally paid by platform operator</span></div>${statusPill('approved')}</div>
      <div class="security-row"><div><strong>Internal simulated swaps</strong><span>Posted to internal double-entry ledger</span></div>${statusPill('approved')}</div>
    </section></div>
    ${isSuper?`<div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Pending administrator invitations</div><div class="panel-subtitle">Invitations issued by the Super Admin</div></div></div>${invites.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Email</th><th>Role</th><th>Created</th><th>Expires</th><th>Status</th></tr></thead><tbody>${invites.map(x=>`<tr><td>${escapeHtml(x.email)}</td><td>${escapeHtml(x.role.replaceAll('_',' '))}</td><td>${fmtDate(x.created_at)}</td><td>${fmtDate(x.expires_at)}</td><td>${statusPill(x.status)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No pending invitations','New subordinate administrator invitations will appear here.')}</section>`:''}
    ${isSuper?`<div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Administrative audit log</div><div class="panel-subtitle">Latest 50 privileged actions · read-only · sensitive before/after payloads are not exposed here.</div></div><span class="status-pill approved">${(data.audit_logs||[]).length} records</span></div>${(data.audit_logs||[]).length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>Reference</th><th>Actor</th></tr></thead><tbody>${data.audit_logs.map(log=>`<tr><td>${fmtDate(log.created_at)}</td><td><strong>${escapeHtml(log.action||'—')}</strong></td><td>${escapeHtml(log.entity_type||'—')}</td><td class="table-muted">${escapeHtml(log.entity_id||log.request_id||'—')}</td><td class="table-muted">${escapeHtml(shortId(log.actor_user_id||''))}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No audit events yet','Privileged administrative actions will be listed here once recorded.')}</section>`:''}

    ${isSuper?`<div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Investment plan management</div><div class="panel-subtitle">USD principal and ROI · 24-hour payout cycle · crypto asset is a visual market reference only</div></div></div>
      <div class="investment-disclosure"><strong>Investment configuration only</strong><p>Saving or enabling a plan does not create investments, credit balances or execute payouts. All investor accounting remains USD-denominated. Market reference asset is presentation data only.</p></div>
      ${investmentPlanError?`<div class="security-note">${escapeHtml(investmentPlanError)}</div>`:''}
      <div class="investment-admin-form">
        <div class="form-field"><label class="field-label" for="inv-plan-code">Plan code</label><input id="inv-plan-code" class="form-control" maxlength="40" placeholder="BTC-30D" /></div>
        <div class="form-field"><label class="field-label" for="inv-plan-name">Plan name</label><input id="inv-plan-name" class="form-control" maxlength="80" placeholder="30 Day Plan" /></div>
        <div class="form-field"><label class="field-label" for="inv-plan-asset">Market reference asset</label><select id="inv-plan-asset" class="form-control">${['BTC','ETH','USDT','BNB','SOL','USDC','XRP','ADA','DOGE','TRX'].map(x=>`<option value="${x}">${x}</option>`).join('')}</select></div>
        <div class="form-field"><label class="field-label" for="inv-plan-min">Minimum principal (USD)</label><input id="inv-plan-min" class="form-control" type="number" min="0.01" step="0.01" value="100" /></div>
        <div class="form-field"><label class="field-label" for="inv-plan-max">Maximum principal (USD)</label><input id="inv-plan-max" class="form-control" type="number" min="0.01" step="0.01" placeholder="Optional" /></div>
        <div class="form-field"><label class="field-label" for="inv-plan-days-min">Minimum duration (days)</label><input id="inv-plan-days-min" class="form-control" type="number" min="7" max="365" value="7" /></div>
        <div class="form-field"><label class="field-label" for="inv-plan-days-max">Maximum duration (days)</label><input id="inv-plan-days-max" class="form-control" type="number" min="7" max="365" value="30" /></div>
        <div class="form-field"><label class="field-label" for="inv-plan-rate">ROI rate (%)</label><input id="inv-plan-rate" class="form-control" type="number" min="0" max="100" step="0.01" placeholder="Set by Admin" /></div>
        <div class="form-field"><label class="field-label" for="inv-plan-period">ROI period</label><select id="inv-plan-period" class="form-control"><option value="daily">Daily (24 hours)</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="fixed">Fixed term</option></select></div>
        <div class="form-field"><label class="field-label" for="inv-plan-description">Description</label><input id="inv-plan-description" class="form-control" maxlength="500" placeholder="Optional plan description" /></div>
      </div>
      <button class="primary-button" id="save-investment-plan" style="margin-top:14px" ${investmentPlanError?'disabled':''}>Save investment plan →</button>
      <div class="page-spacer"></div>
      ${investmentPlanRows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Plan</th><th>Reference asset</th><th>USD range</th><th>Duration</th><th>ROI</th><th>Status</th><th>Action</th></tr></thead><tbody>${investmentPlanRows.map(p=>`<tr><td><strong>${escapeHtml(p.name)}</strong><div class="table-muted">${escapeHtml(p.plan_code)}</div></td><td>${escapeHtml(p.asset_code||'—')}</td><td>${money(p.minimum_amount,2)}–${p.maximum_amount==null?'∞':money(p.maximum_amount,2)}</td><td>${p.minimum_duration_days}–${p.maximum_duration_days} days</td><td>${p.rate_value==null?'—':money(p.rate_value,2)+'% / '+escapeHtml(p.rate_period||'')}</td><td>${statusPill(p.is_active?'approved':'pending')}</td><td><button class="small-button ${p.is_active?'reject':'approve'}" data-invest-plan-toggle="${escapeHtml(p.id)}" data-enabled="${p.is_active?'true':'false'}">${p.is_active?'Disable':'Enable'}</button></td></tr>`).join('')}</tbody></table></div>`:emptyState('No investment plans configured','Create a plan above. It will remain disabled until you enable it.') }
    </section>`:''}
    <div class="security-note" style="margin-top:13px">Manual payment requests require external verification. Swaps, wallet credits and payout holds are recorded in the internal double-entry ledger. No blockchain or external exchange is connected.</div>`;
}

function openModal(title, description, body, actions='') {
  $('#modal-root').innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true"><div class="modal-head"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div><button class="modal-close" id="modal-close" aria-label="Close">×</button></div><div class="modal-body">${body}</div>${actions?`<div class="modal-actions">${actions}</div>`:''}</div></div>`;
  $('#modal-close').onclick = closeModal;
  $('#modal-backdrop').addEventListener('click',(event)=>{if(event.target.id==='modal-backdrop')closeModal();});
}
function closeModal(){ $('#modal-root').innerHTML=''; }

async function startMfaSetup() {
  const {data,error}=await supabase.auth.mfa.enroll({factorType:'totp',friendlyName:'Exchange Authenticator'});
  if(error){toast(error.message,'error');return;}
  const factorId=data.id; const qr=data.totp?.qr_code; const secret=data.totp?.secret;
  openModal('Connect your authenticator','Scan the QR code using Google Authenticator, Microsoft Authenticator or another TOTP app.',`
    <div class="qr-box"><img alt="Authenticator enrollment QR code" src="${escapeHtml(qr)}" /></div>
    <div class="field-help">Or enter this setup key manually in your authenticator app.</div><div class="secret-box">${escapeHtml(secret||'Unavailable')}</div>
    <label class="field-label" for="mfa-setup-code">Enter the six-digit code from your app</label><input class="form-control mfa-pin" id="mfa-setup-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
  `,`<button class="ghost-button" id="cancel-mfa-setup">Cancel</button><button class="primary-button" id="verify-mfa-setup">Verify and enable →</button>`);
  $('#cancel-mfa-setup').onclick=async()=>{ await supabase.auth.mfa.unenroll({factorId}); closeModal(); await renderPage('security'); };
  $('#verify-mfa-setup').onclick=async()=>{
    const code=$('#mfa-setup-code').value.trim(); if(!/^\d{6}$/.test(code))return toast('Enter a valid six-digit code.','error');
    const btn=$('#verify-mfa-setup');btn.disabled=true;btn.textContent='Verifying…';
    const {data:challenge,error:challengeError}=await supabase.auth.mfa.challenge({factorId});
    if(challengeError){btn.disabled=false;btn.textContent='Verify and enable →';return toast(challengeError.message,'error');}
    const {error:verifyError}=await supabase.auth.mfa.verify({factorId,challengeId:challenge.id,code});
    if(verifyError){btn.disabled=false;btn.textContent='Verify and enable →';return toast(verifyError.message,'error');}
    closeModal();await checkMfa();await getSessionAccess();updateShellIdentity();toast('Two-factor authentication is now enabled.','success');await renderPage(state.roles.includes('super_admin')?'admin':'security');
  };
}

async function submitKyc(event) {
  event.preventDefault();
  const files=[...$('#kyc-files').files]; const docType=$('#kyc-document-type').value;
  if(!files.length)return toast('Choose at least one document.','error');
  if(files.length>5)return toast('You can upload up to five files per submission.','error');
  if(!$('#kyc-consent').checked)return toast('Please confirm the document declaration.','error');
  const validMime=['application/pdf','image/jpeg','image/png'];
  for(const file of files){if(!validMime.includes(file.type))return toast('Only PDF, JPG and PNG files are accepted.','error');if(file.size<=0||file.size>10*1024*1024)return toast('Each file must be no larger than 10 MB.','error');}
  const btn=$('#kyc-submit-btn');btn.disabled=true;btn.textContent='Uploading securely…';
  const submissionId=crypto.randomUUID();const documents=[];const uploadedPaths=[];
  try{
    for(const file of files){
      const safeName=file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-90)||'document';
      const path=`${state.user.id}/${submissionId}/${Date.now()}-${safeName}`;
      const {error}=await supabase.storage.from(KYC_BUCKET).upload(path,file,{contentType:file.type,upsert:false,cacheControl:'3600'});
      if(error)throw error;uploadedPaths.push(path);
      documents.push({document_type:docType,storage_path:path,original_file_name:file.name,mime_type:file.type,file_size_bytes:file.size});
    }
    const {data,error}=await supabase.functions.invoke('submit-kyc',{body:{submission_id:submissionId,documents}});
    if(error)throw error;
    toast('Documents uploaded and submitted for review.','success');await renderPage('kyc');
  }catch(error){console.error(error);if(uploadedPaths.length){const {error:cleanupError}=await supabase.storage.from(KYC_BUCKET).remove(uploadedPaths);if(cleanupError)console.warn('KYC upload cleanup was incomplete:',cleanupError.message);}toast(error.message||'Could not submit KYC documents.','error');btn.disabled=false;btn.textContent='Upload and submit documents →';}
}

async function loadNotifications() {
  const {data,error}=await supabase.from('notifications').select('id,title,body,notification_type,created_at,read_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(20);
  if(error){toast(error.message,'error');return;}
  state.notifications=data||[];
  const unread=state.notifications.filter(n=>!n.read_at).length;$('#notification-dot').classList.toggle('hidden',!unread);
  openModal('Notifications',unread?`${unread} unread message(s)`:'You are all caught up.',state.notifications.length?state.notifications.map(n=>`<div class="security-row"><div><strong>${escapeHtml(n.title)}</strong><span>${escapeHtml(n.body||'') } · ${fmtDate(n.created_at)}</span></div>${n.read_at?'':`<button class="small-button" data-notification-read="${escapeHtml(n.id)}">Mark read</button>`}</div>`).join(''):emptyState('No notifications','System messages and account updates will appear here.'));
  $$('[data-notification-read]').forEach(btn=>btn.onclick=async()=>{const {error}=await supabase.from('notifications').update({read_at:new Date().toISOString()}).eq('id',btn.dataset.notificationRead).eq('user_id',state.user.id);if(error)toast(error.message,'error');else{closeModal();await loadNotifications();}});
}

async function reviewManualDeposit(depositId,decision) {
  const reason=decision==='reject'?prompt('Enter why this external payment could not be verified:'):'';
  if(decision==='reject'&&!reason?.trim())return;
  const message=decision==='approve'
    ?'Confirm that you personally verified receipt of this payment in the external bank/payment system. This will credit the user internal wallet.'
    :'Reject this deposit request? No wallet balance will be credited.';
  if(!confirm(message))return;
  const {data,error}=await supabase.functions.invoke('admin-manual-settlement',{body:{
    action:'review_deposit',deposit_id:depositId,decision,
    reason:reason||null
  }});
  if(error)return toast(error.message||'Deposit review failed.','error');
  toast(decision==='approve'?'External payment verified and internal balance credited.':'Deposit request rejected.','success');
  await renderPage('admin');
}
async function reviewManualWithdrawal(withdrawalId,decision) {
  const reference=decision==='complete'?prompt('Enter the external bank/payment reference after you have actually made the payout:'):'';
  const reason=decision==='reject'?prompt('Enter why this payout request is rejected:'):'';
  if(decision==='complete'&&!reference?.trim())return;
  if(decision==='reject'&&!reason?.trim())return;
  const message=decision==='complete'
    ?'Confirm that you have already sent the payment outside NEXT-RA. This records the external payout as completed.'
    :'Reject this payout request and return the reserved amount to the user available wallet?';
  if(!confirm(message))return;
  const {data,error}=await supabase.functions.invoke('admin-manual-settlement',{body:{
    action:'review_withdrawal',withdrawal_id:withdrawalId,decision,
    external_reference:reference||null,reason:reason||null
  }});
  if(error)return toast(error.message||'Withdrawal review failed.','error');
  toast(decision==='complete'?'External payout marked completed.':'Withdrawal rejected and balance returned.','success');
  await renderPage('admin');
}

function openAdminInviteModal() {
  openModal('Invite administrator','Only the Super Admin can invite subordinate administrator accounts.',`
    <label class="field-label" for="invite-email">Administrator email</label><input class="form-control" id="invite-email" type="email" placeholder="colleague@example.com" required />
    <label class="field-label" for="invite-role">Administrator role</label><select class="form-control select-control" id="invite-role"><option value="operations_admin">Operations Admin</option><option value="finance_admin">Finance Admin</option><option value="compliance_admin">Compliance Admin</option><option value="support_admin">Support Admin</option></select>
    <div class="field-help">The invited person receives an email invitation. The account is granted its subordinate role only after accepting the invitation. MFA is required before using administrative tools.</div>
  `,`<button class="ghost-button" id="cancel-admin-invite">Cancel</button><button class="primary-button" id="send-admin-invite">Send invitation →</button>`);
  $('#cancel-admin-invite').onclick=closeModal;
  $('#send-admin-invite').onclick=async()=>{
    const email=$('#invite-email').value.trim().toLowerCase(),role=$('#invite-role').value;if(!email.includes('@'))return toast('Enter a valid email address.','error');
    const btn=$('#send-admin-invite');btn.disabled=true;btn.textContent='Sending…';
    const {data,error}=await supabase.functions.invoke('admin-invite',{body:{email,role}});
    if(error){btn.disabled=false;btn.textContent='Send invitation →';return toast(error.message,'error');}
    closeModal();toast('Administrator invitation sent.','success');await renderPage('admin');
  };
}
async function reviewKyc(id,status) {
  const reason=status==='rejected'?prompt('Enter the reason for rejecting this verification:'):'';
  if(status==='rejected'&&!reason?.trim())return;
  if(!confirm(`Confirm ${status} for this KYC submission?`))return;
  const {error}=await supabase.functions.invoke('admin-review-kyc',{body:{submission_id:id,status,rejection_reason:reason||null}});
  if(error)return toast(error.message,'error');
  toast(`KYC submission ${status}.`,'success');await renderPage('admin');
}

function bindPageEvents(page) {
  if(page==='investments'){
    $$('[data-invest-asset]').forEach(button=>button.addEventListener('click',()=>{state.investmentDisplayAsset=button.dataset.investAsset;renderPage('investments');}));
  }

  $$('[data-go]').forEach(button=>button.addEventListener('click',()=>renderPage(button.dataset.go)));
  if(page==='markets'){
    $('#refresh-markets')?.addEventListener('click',async()=>{await loadMarkets(true);await renderPage('markets');});
    $('#market-search')?.addEventListener('input',()=>{const term=$('#market-search').value.toLowerCase();const items=state.markets.filter(m=>m.name.toLowerCase().includes(term)||m.symbol.toLowerCase().includes(term));$('#market-table-body').innerHTML=items.length?items.map(marketRow).join(''):`<tr><td colspan="5">${emptyState('No matching assets','Try another search term.')}</td></tr>`;});
  }
  if(page==='swap'){
    const amountInput=$('#swap-amount'),fromSelect=$('#swap-from'),toSelect=$('#swap-to');
    const estimateInput=$('#swap-estimate'),rateOutput=$('#swap-rate');
    const availableOutput=$('#swap-available-balance');
    const sendUsd=$('#swap-send-usd'),receiveUsd=$('#swap-receive-usd');
    const quoteButton=$('#get-swap-quote'),quotePanel=$('#swap-quote-result');
    let activeQuote=null,expiryTimer=null;
    const clearQuote=()=>{
      activeQuote=null;
      if(expiryTimer){clearInterval(expiryTimer);expiryTimer=null;state.swapQuoteExpiryTimer=null;}
      quotePanel?.classList.add('hidden');
      if(quotePanel)quotePanel.innerHTML='';
    };
    const calculate=()=>{
      if(!amountInput||!fromSelect||!toSelect||!estimateInput||!rateOutput||!availableOutput||!sendUsd||!receiveUsd)return;
      const amount=Number(amountInput.value||0),from=fromSelect.value,to=toSelect.value;
      const fromPrice=priceOf(from),toPrice=priceOf(to);
      const available=state.balances.filter(row=>row.domain==='exchange'&&row.account_kind==='available'&&row.asset_code===from).reduce((sum,row)=>sum+Number(row.balance||0),0);
      availableOutput.textContent=`${money(available,8)} ${from}`;
      if(!Number.isFinite(amount)||amount<=0||from===to||fromPrice==null||toPrice==null||!Number.isFinite(fromPrice)||!Number.isFinite(toPrice)||toPrice<=0){
        estimateInput.value='—';rateOutput.textContent=from===to?'Choose different assets':'Waiting for valid amount or market price';
        sendUsd.textContent='≈ —';receiveUsd.textContent='≈ —';return;
      }
      const usd=amount*fromPrice,output=usd/toPrice;
      if(!Number.isFinite(output))return;
      estimateInput.value=output.toFixed(8).replace(/0+$/,'').replace(/\.$/,'');
      rateOutput.textContent=`1 ${from} ≈ ${money(fromPrice/toPrice,8)} ${to}`;
      sendUsd.textContent=`≈ ${fmtPrice(usd)}`;
      receiveUsd.textContent=`≈ ${fmtPrice(usd)}`;
    };
    const requestQuote=async()=>{
      if(!amountInput||!fromSelect||!toSelect)return;
      const amount=amountInput.value.trim(),from=fromSelect.value,to=toSelect.value;
      if(!amount||Number(amount)<=0||from===to)return toast('Enter an amount and choose two different assets.','error');
      clearQuote();quoteButton.disabled=true;quoteButton.textContent='Getting market quote…';
      try{
        const {data,error}=await supabase.functions.invoke('internal-swap',{body:{action:'quote',from_asset_code:from,to_asset_code:to,amount}});
        if(error)throw error;
        if(!data?.success||!data.quote)throw new Error(data?.error||'The quote service did not return a quote.');
        activeQuote=data.quote;
        const p=data.pricing;
        estimateInput.value=String(p.net_to_amount);
        rateOutput.textContent=`1 ${from} ≈ ${money(p.rate,8)} ${to}`;
        sendUsd.textContent=`≈ ${fmtPrice(p.usd_value)}`;
        receiveUsd.textContent=`≈ ${fmtPrice(p.usd_value)}`;
        availableOutput.textContent=`${money(data.available_balance,8)} ${from}`;
        const expires=Date.parse(data.quote.quote_expires_at);
        quotePanel.innerHTML=`
          <div class="swap-quote-head"><strong>Quote summary</strong><span class="status-pill approved">Market quote received</span></div>
          <div class="detail-list">
            <div class="detail-row"><span>Send amount</span><strong>${money(data.quote.from_amount,10)} ${escapeHtml(from)}</strong></div>
            <div class="detail-row"><span>USD reference value</span><strong>${fmtPrice(p.usd_value)}</strong></div>
            <div class="detail-row"><span>Gross receive</span><strong>${money(p.gross_to_amount,10)} ${escapeHtml(to)}</strong></div>
            <div class="detail-row"><span>Swap fee (${money(p.fee_rate_percent,2)}%)</span><strong>${money(p.fee_amount,10)} ${escapeHtml(to)}</strong></div>
            <div class="detail-row"><span>Net receive</span><strong class="positive">${money(p.net_to_amount,10)} ${escapeHtml(to)}</strong></div>
            <div class="detail-row"><span>Your available balance</span><strong>${money(data.available_balance,10)} ${escapeHtml(from)}</strong></div>
          </div>
          <div class="swap-quote-warning ${data.sufficient_balance?'':'error'}">${data.sufficient_balance?'The quote is ready. Confirm to post this internal ledger swap.':'Insufficient available balance. A quote can be viewed, but this swap cannot be executed.'}</div>
          <div class="swap-quote-expiry" id="swap-quote-expiry">Quote expires in 60 seconds.</div>
          <button class="primary-button" id="execute-swap" style="width:100%;margin-top:10px" ${data.sufficient_balance?'':'disabled'}>Confirm internal swap →</button>
          <div class="security-note" style="margin-top:9px">Confirmation changes only your NEXT-RA internal ledger balances. It does not move funds on a blockchain or submit an order to an external exchange.</div>`;
        quotePanel.classList.remove('hidden');
        expiryTimer=setInterval(()=>{
          const remaining=Math.max(0,Math.ceil((expires-Date.now())/1000));
          const label=$('#swap-quote-expiry');
          if(label)label.textContent=remaining>0?`Quote expires in ${remaining} seconds.`:'Quote expired. Request a new quote.';
          const execute=$('#execute-swap');
          if(execute&&remaining<=0)execute.disabled=true;
          if(remaining<=0&&expiryTimer){clearInterval(expiryTimer);expiryTimer=null;}
        },1000);
        state.swapQuoteExpiryTimer=expiryTimer;
        $('#execute-swap')?.addEventListener('click',async()=>{
          if(!activeQuote||Date.now()>=expires)return toast('Quote expired. Please request a new quote.','error');
          if(!confirm(`Confirm internal swap: ${amount} ${from} → approximately ${p.net_to_amount} ${to}? This updates only NEXT-RA internal balances and is not an on-chain or external exchange trade.`))return;
          const btn=$('#execute-swap');btn.disabled=true;btn.textContent='Posting ledger transaction…';
          try{
            const {data:execution,error:executionError}=await supabase.functions.invoke('internal-swap',{body:{action:'execute',swap_order_id:activeQuote.id}});
            if(executionError)throw executionError;
            if(!execution?.success)throw new Error(execution?.error||'The internal swap could not be completed.');
            clearQuote();
            toast('Internal swap completed and ledger posted.','success');
            await loadBalances();
            await renderPage('swap');
          }catch(executionError){
            const message=executionError.message||'Swap failed.';
            btn.disabled=false;btn.textContent='Retry confirmation →';
            toast(message,'error');
          }
        });
      }catch(error){
        quotePanel.innerHTML=`<div class="swap-quote-warning error">${escapeHtml(error.message||'Unable to create a quote.')}</div>`;
        quotePanel.classList.remove('hidden');
        toast(error.message||'Unable to create a quote.','error');
      }finally{quoteButton.disabled=false;quoteButton.textContent='Get live swap quote →';}
    };
    quoteButton?.addEventListener('click',requestQuote);
    amountInput?.addEventListener('input',()=>{clearQuote();calculate();});
    fromSelect?.addEventListener('change',()=>{clearQuote();calculate();});
    toSelect?.addEventListener('change',()=>{clearQuote();calculate();});
    $('#swap-reverse')?.addEventListener('click',()=>{if(!fromSelect||!toSelect)return;const a=fromSelect.value;fromSelect.value=toSelect.value;toSelect.value=a;clearQuote();calculate();});
    $('#refresh-swap-markets')?.addEventListener('click',async()=>{
      const button=$('#refresh-swap-markets');if(button){button.disabled=true;button.textContent='Loading…';}
      await loadMarkets(true);
      const list=$('#swap-market-leaderboard');if(list)list.innerHTML=renderSwapMarketLeaderboard();
      const updated=$('#swap-market-updated');if(updated)updated.textContent=state.marketsUpdatedAt?new Date(state.marketsUpdatedAt).toLocaleTimeString():'Unavailable';
      if(button){button.disabled=false;button.textContent='↻ Refresh';}
      calculate();
    });
    state.swapMarketRefreshTimer=setInterval(async()=>{
      await loadMarkets(true);
      const list=$('#swap-market-leaderboard');if(list)list.innerHTML=renderSwapMarketLeaderboard();
      const updated=$('#swap-market-updated');if(updated)updated.textContent=state.marketsUpdatedAt?new Date(state.marketsUpdatedAt).toLocaleTimeString():'Unavailable';
      calculate();
    },60000);
    calculate();
  }
  if(page==='deposit'){
    const asset=$('#deposit-asset'),network=$('#deposit-network-wrap'),label=$('#deposit-reference-label');
    const syncDeposit=()=>{
      const crypto=asset.value!=='USD';
      network.classList.toggle('hidden',!crypto);
      const supported={BTC:['BITCOIN'],ETH:['ETHEREUM'],BNB:['BSC'],USDT:['TRON','BSC','ETHEREUM'],USDC:['BSC','ETHEREUM','SOLANA'],TRX:['TRON'],SOL:['SOLANA'],XRP:['XRPL'],ADA:['CARDANO'],DOGE:['DOGECOIN']}[asset.value]||[];
      const networkSelect=$('#deposit-network'),current=networkSelect.value;
      networkSelect.innerHTML=supported.map(n=>`<option value="${n}">${({TRON:'TRON (TRC20)',BSC:'BNB Smart Chain (BEP20)',ETHEREUM:'Ethereum (ERC20)',BITCOIN:'Bitcoin',SOLANA:'Solana',XRPL:'XRP Ledger',CARDANO:'Cardano',DOGECOIN:'Dogecoin'})[n]}</option>`).join('');
      if(supported.includes(current))networkSelect.value=current;
      label.textContent=crypto?'Blockchain transaction hash':'Bank transfer reference';
      $('#manual-deposit-reference').placeholder=crypto?'Enter transaction hash (TXID)':'Enter your bank transfer reference';
    };
    asset?.addEventListener('change',syncDeposit);
    $$('input[name="deposit-method"]').forEach(r=>r.addEventListener('change',()=>{const group=$(`#deposit-${r.value==='bank'?'usd':'crypto'}-group`);if(group?.querySelector('option'))asset.value=group.querySelector('option').value;syncDeposit();}));syncDeposit();
    $('#manual-deposit-form')?.addEventListener('submit',async(event)=>{
      event.preventDefault();
      const button=$('#manual-deposit-submit');button.disabled=true;button.textContent='Submitting request…';
      try{
        const {data,error}=await supabase.functions.invoke('manual-settlement',{body:{
          action:'submit_deposit',
          asset_code:$('#deposit-asset').value,
          channel:$('#deposit-asset').value==='USD'?'BANK_TRANSFER':'CRYPTO',
          network_code:$('#deposit-asset').value==='USD'?'BANK':$('#deposit-network').value,
          amount:$('#manual-deposit-amount').value,
          external_reference:$('#manual-deposit-reference').value.trim(),
          memo:[`CHANNEL:${$('#deposit-asset').value==='USD'?'BANK_TRANSFER':'CRYPTO'}`,`NETWORK:${$('#deposit-asset').value==='USD'?'BANK':$('#deposit-network').value}`,$('#manual-deposit-memo').value.trim()].filter(Boolean).join(' | ')
        }});
        if(error)throw error;
        if(!data?.success)throw new Error(data?.error||'Deposit request could not be submitted.');
        toast('Deposit request submitted for manual verification. No balance has been credited yet.','success');
        await renderPage('deposit');
      }catch(error){toast(error.message||'Deposit request failed.','error');button.disabled=false;button.textContent='Submit deposit for verification →';}
    });
  }
  if(page==='withdraw'){
    const asset=$('#manual-withdrawal-asset'),network=$('#withdraw-network-wrap'),label=$('#withdraw-destination-label');
    const syncWithdraw=()=>{
      const crypto=asset.value!=='USD';
      network.classList.toggle('hidden',!crypto);
      const supported={BTC:['BITCOIN'],ETH:['ETHEREUM'],BNB:['BSC'],USDT:['TRON','BSC','ETHEREUM'],USDC:['BSC','ETHEREUM','SOLANA'],TRX:['TRON'],SOL:['SOLANA'],XRP:['XRPL'],ADA:['CARDANO'],DOGE:['DOGECOIN']}[asset.value]||[];
      const networkSelect=$('#withdraw-network'),current=networkSelect.value;
      networkSelect.innerHTML=supported.map(n=>`<option value="${n}">${({TRON:'TRON (TRC20)',BSC:'BNB Smart Chain (BEP20)',ETHEREUM:'Ethereum (ERC20)',BITCOIN:'Bitcoin',SOLANA:'Solana',XRPL:'XRP Ledger',CARDANO:'Cardano',DOGECOIN:'Dogecoin'})[n]}</option>`).join('');
      if(supported.includes(current))networkSelect.value=current;
      label.textContent=crypto?'Destination wallet address':'Bank account details';
      $('#manual-withdrawal-destination').placeholder=crypto?'Paste the destination wallet address':'Bank name, account holder and account number';
    };
    asset?.addEventListener('change',syncWithdraw);
    $$('input[name="withdraw-method"]').forEach(r=>r.addEventListener('change',()=>{const group=$(`#withdraw-${r.value==='bank'?'usd':'crypto'}-group`);if(group?.querySelector('option'))asset.value=group.querySelector('option').value;syncWithdraw();}));syncWithdraw();
    $('#manual-withdrawal-form')?.addEventListener('submit',async(event)=>{
      event.preventDefault();
      const asset=$('#manual-withdrawal-asset').value,amount=$('#manual-withdrawal-amount').value;
      const destination=$('#manual-withdrawal-destination').value.trim();
      if(!confirm(`Submit an external payout request for ${amount} ${asset}? This reserves your internal balance; it does not send a bank payment or blockchain transaction.`))return;
      const button=$('#manual-withdrawal-submit');button.disabled=true;button.textContent='Submitting request…';
      try{
        const {data,error}=await supabase.functions.invoke('manual-settlement',{body:{
          action:'request_withdrawal',asset_code:asset,channel:asset==='USD'?'BANK_TRANSFER':'CRYPTO',network_code:asset==='USD'?'BANK':$('#withdraw-network').value,amount,destination,
          memo:[`CHANNEL:${asset==='USD'?'BANK_TRANSFER':'CRYPTO'}`,`NETWORK:${asset==='USD'?'BANK':$('#withdraw-network').value}`,$('#manual-withdrawal-memo').value.trim()].filter(Boolean).join(' | ')
        }});
        if(error)throw error;
        if(!data?.success)throw new Error(data?.error||'Withdrawal request could not be submitted.');
        toast('Withdrawal request submitted. The amount is now reserved for external payout.','success');
        await loadBalances();
        await renderPage('withdraw');
      }catch(error){toast(error.message||'Withdrawal request failed.','error');button.disabled=false;button.textContent='Submit payout request →';}
    });
  }
  if(page==='kyc')$('#kyc-form')?.addEventListener('submit',submitKyc);
  if(page==='security')$('#setup-mfa')?.addEventListener('click',startMfaSetup);
  if(page==='referrals')$('#copy-referral')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#referral-code').value);toast('Referral code copied.','success');}catch{toast('Copy is not available in this browser.','error');}});
  if(page==='admin'){

    $('#save-investment-plan')?.addEventListener('click',async()=>{
      const payload={action:'save_plan',plan_code:$('#inv-plan-code').value,name:$('#inv-plan-name').value,asset_code:$('#inv-plan-asset').value,minimum_amount:$('#inv-plan-min').value,maximum_amount:$('#inv-plan-max').value,minimum_duration_days:$('#inv-plan-days-min').value,maximum_duration_days:$('#inv-plan-days-max').value,rate_value:$('#inv-plan-rate').value,rate_period:$('#inv-plan-period').value,description:$('#inv-plan-description').value};
      if(!payload.plan_code.trim()||!payload.name.trim()||!payload.rate_value.trim())return toast('Enter plan code, name and ROI rate before saving.','error');
      if(!confirm('Save this USD-denominated investment plan? It will be saved disabled; no member balances or investments will be changed.'))return;
      const btn=$('#save-investment-plan');btn.disabled=true;btn.textContent='Saving…';
      const {data,error}=await supabase.functions.invoke('admin-investment-settings',{body:payload});
      if(error||!data?.success){btn.disabled=false;btn.textContent='Save investment plan →';return toast(error?.message||data?.error||'Could not save investment plan.','error');}
      toast('Investment plan saved disabled and audit logged.','success');await renderPage('admin');
    });
    $('[data-invest-plan-toggle]').forEach(btn=>btn.addEventListener('click',async()=>{
      const enabled=btn.dataset.enabled!=='true';
      if(!confirm((enabled?'Enable':'Disable')+' this investment plan? This only changes plan availability; it does not create or pay investments.'))return;
      btn.disabled=true;
      const {data,error}=await supabase.functions.invoke('admin-investment-settings',{body:{action:'set_plan_enabled',id:btn.dataset.investPlanToggle,enabled}});
      if(error||!data?.success){btn.disabled=false;return toast(error?.message||data?.error||'Could not update plan.','error');}
      toast(enabled?'Investment plan enabled.':'Investment plan disabled.','success');await renderPage('admin');
    }));
    $('#open-invite-admin')?.addEventListener('click',openAdminInviteModal);
    $$('[data-manual-deposit]').forEach(btn=>btn.addEventListener('click',()=>reviewManualDeposit(btn.dataset.id,btn.dataset.manualDeposit)));
    $$('[data-manual-withdrawal]').forEach(btn=>btn.addEventListener('click',()=>reviewManualWithdrawal(btn.dataset.id,btn.dataset.manualWithdrawal)));
    $('#save-manual-deposit-instructions')?.addEventListener('click',async()=>{
      const instructions=$('#manual-deposit-instructions').value.trim();
      if(!confirm(instructions?'Publish these external payment instructions for signed-in members?':'Clear the external deposit instructions? This will disable new deposit requests.'))return;
      const button=$('#save-manual-deposit-instructions');button.disabled=true;button.textContent='Saving…';
      try{
        const {data,error}=await supabase.functions.invoke('admin-manual-settlement',{body:{action:'set_deposit_instructions',instructions}});
        if(error)throw error;
        if(!data?.success)throw new Error(data?.error||'Could not save instructions.');
        toast('External deposit instructions saved and audited.','success');
        await renderPage('admin');
      }catch(error){toast(error.message||'Could not save instructions.','error');button.disabled=false;button.textContent='Save deposit instructions →';}
    });
    $$('[data-kyc-review]').forEach(btn=>btn.addEventListener('click',()=>reviewKyc(btn.dataset.kycId,btn.dataset.kycReview)));
    $$('[data-admin-pair-toggle]').forEach(btn=>btn.addEventListener('click',async()=>{
      const enabled=btn.dataset.enabled!=='true';
      if(!confirm(`${enabled?'Enable':'Disable'} this pair for preview quotes? This does not turn on real swap execution.`))return;
      btn.disabled=true;
      const {data,error}=await supabase.functions.invoke('admin-trading-settings',{body:{action:'set_pair_enabled',pair_id:btn.dataset.adminPairToggle,enabled}});
      if(error){btn.disabled=false;return toast(error.message||'Could not update trading pair.','error');}
      toast(enabled?'Internal trading pair enabled.':'Internal trading pair disabled.','success');
      await renderPage('admin');
    }));
    $('#save-swap-fee')?.addEventListener('click',async()=>{
      const fee=Number($('#swap-fee-percent').value);
      if(!Number.isFinite(fee)||fee<0.05||fee>10)return toast('Enter a swap fee between 0.05% and 10%. The minimum is 0.05% per transaction.','error');
      if(!confirm(`Save the swap fee as ${fee}%? This fee will apply to completed internal simulated swaps.`))return;
      const btn=$('#save-swap-fee');btn.disabled=true;btn.textContent='Saving…';
      const {data,error}=await supabase.functions.invoke('admin-trading-settings',{body:{action:'set_swap_fee',fee_percent:fee}});
      if(error){btn.disabled=false;btn.textContent='Save swap fee configuration →';return toast(error.message||'Could not save swap fee.','error');}
      toast('Swap fee configuration saved and audited.','success');
      await renderPage('admin');
    });
  }
}

$('#login-tab').addEventListener('click',()=>setAuthMode('login'));
$('#signup-tab').addEventListener('click',()=>setAuthMode('signup'));
$('#reveal-password').addEventListener('click',()=>{const field=$('#auth-password');field.type=field.type==='password'?'text':'password';$('#reveal-password').textContent=field.type==='password'?'Show':'Hide';});
$('#auth-form').addEventListener('submit',async(event)=>{
  event.preventDefault();const email=$('#auth-email').value.trim().toLowerCase(),password=$('#auth-password').value,mode=$('#auth-form').dataset.mode||'login';const submit=$('#auth-submit');submit.disabled=true;submit.textContent=mode==='signup'?'Creating account…':'Signing in…';$('#auth-message').classList.add('hidden');
  try{
    if(mode==='signup'){
      const displayName=$('#auth-name').value.trim();
      if(!displayName) throw new Error('Please enter your display name.');
      if(password.length<8) throw new Error('Password must be at least 8 characters long.');
      const redirectTo = `${window.location.origin}/`;
      const {data,error}=await supabase.auth.signUp({
        email,
        password,
        options:{
          data:{display_name:displayName},
          emailRedirectTo:redirectTo
        }
      });
      if(error) throw error;
      if(data.user && !data.session){
        // Supabase may return an obfuscated user for an address that already exists.
        if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          showAuth('This email may already be registered. Try signing in, or use the verification email option if you have a pending signup.', 'error');
        } else {
          showSignupPending(email);
        }
      }else if(data.session){
        await afterAuthentication();
      }else{
        showAuth('Registration did not return an account session. Please check the email address and try again. If this continues, send support the exact error shown by your browser.','error');
      }
    }else{
      const {error}=await supabase.auth.signInWithPassword({email,password});if(error)throw error;await afterAuthentication();
    }
  }catch(error){
    const raw = error.message || 'Authentication failed.';
    const friendly = /redirect.*(allow|url)|not allowed/i.test(raw)
      ? `${raw} Add this website's exact domain to Supabase Authentication → URL Configuration → Redirect URLs.`
      : /rate limit|too many requests/i.test(raw)
        ? 'Too many attempts were made. Wait a few minutes before trying again.'
        : /password/i.test(raw) && mode === 'signup'
          ? 'Please use a password with at least 8 characters.'
          : raw;
    showAuth(friendly,'error');
  }
  finally{submit.disabled=false;submit.innerHTML=mode==='signup'?'Create account <span>→</span>':'Sign in <span>→</span>';}
});
$('#sign-out-btn').addEventListener('click',async()=>{await supabase.auth.signOut();state.user=null;state.roles=[];showAuth('You have signed out.','success');});
$('#mobile-menu').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
$('#main-nav').addEventListener('click',(event)=>{const button=event.target.closest('[data-page]');if(button)renderPage(button.dataset.page);});
$('#admin-nav-wrap').addEventListener('click',(event)=>{const button=event.target.closest('[data-page]');if(button)renderPage(button.dataset.page);});
$('#notifications-btn').addEventListener('click',loadNotifications);
$('#top-avatar').addEventListener('click',()=>renderPage('security'));
$$('[data-static-info]').forEach(link=>link.addEventListener('click',(event)=>{event.preventDefault();toast(`${link.dataset.staticInfo} will be published before launch.`);}));
// Mark the UI handlers as ready only after all event listeners have been attached.
window.__NEXT_RA_APP_READY = true;
supabase.auth.onAuthStateChange((event,session)=>{
  if(event==='SIGNED_OUT'){state.session=null;state.user=null;state.roles=[];showAuth();}
  if(event==='TOKEN_REFRESHED')state.session=session;
});

(async()=>{
  try {
    setAuthMode('login');
    const {data:{session},error}=await supabase.auth.getSession();
    if(error) throw error;
    if(session) await afterAuthentication(); else showAuth();
  } catch(error) {
    console.error('NEXT-RA initialization failed:',error);
    showAuth(`The application loaded, but could not connect to the account service: ${error.message || 'Unknown error'}. Please refresh and try again.`, 'error');
  }
})();
