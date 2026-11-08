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
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false&price_change_percentage=24h';
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
    else if (page === 'deposit') root.innerHTML = renderDeposit();
    else if (page === 'withdraw') root.innerHTML = renderWithdraw();
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
    supabase.from('swap_orders').select('id,from_asset_code,to_asset_code,from_amount,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(4),
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
        ${markets.length?`<div class="mini-market-list">${markets.map(c=>`<div class="security-row"><div class="asset-cell">${coinIcon(c)}<div class="asset-name"><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.symbol.toUpperCase())}</span></div></div><div style="text-align:right"><strong style="font-size:10px">${fmtPrice(c.current_price)}</strong><span class="price-change ${Number(c.price_change_percentage_24h)>=0?'positive':'negative'}" style="display:block;margin-top:4px">${Number(c.price_change_percentage_24h)>=0?'+':''}${money(c.price_change_percentage_24h,2)}%</span></div></div>`).join('')}</div>`:emptyState('Market feed unavailable','Live asset prices could not be reached. Please try again later.')}
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
  const marketAssets = state.markets.slice(0,10).filter(c => c.symbol && Number(c.current_price) > 0);
  const codes = ['USD', ...marketAssets.map(c => String(c.symbol).toUpperCase())];
  const uniqueCodes = [...new Set(codes)];
  const opts = (selected) => uniqueCodes.map(code => {
    const coin = marketAssets.find(c => String(c.symbol).toUpperCase() === code);
    const label = code === 'USD' ? 'USD — US Dollar' : `${coin?.name || code} (${code})`;
    return `<option value="${escapeHtml(code)}" ${code===selected?'selected':''}>${escapeHtml(label)}</option>`;
  }).join('');
  const firstCoin = marketAssets.find(c => String(c.symbol).toUpperCase() === 'BTC') || marketAssets[0];
  const firstCode = firstCoin ? String(firstCoin.symbol).toUpperCase() : 'USD';
  const secondCode = firstCode === 'USD' ? (uniqueCodes[1] || 'USD') : 'USD';
  return `${heading('Swap','Convert between USD and supported cryptocurrencies using live public market reference prices.')}
    <div class="alert-banner"><span class="notice-icon">i</span><div><strong>Internal exchange — indicative quote only</strong>Prices are referenced from public market data and displayed in USD. This preview does not contact an external exchange, blockchain or payment provider. No funds move until the internal ledger settlement workflow is released and tested.</div></div>
    <div class="two-col"><section class="card section-card"><h3>Conversion preview</h3><p>USD is the platform's base currency. Choose USD or a supported cryptocurrency to estimate a conversion at the latest available reference price.</p>
      <div class="swap-box"><div class="swap-box-top"><span>You send</span><span id="swap-send-usd">≈ —</span></div><div class="swap-input-row"><input id="swap-amount" type="number" min="0" step="any" value="100" aria-label="Amount to swap"/><select id="swap-from" class="asset-select">${opts('USD')}</select></div></div>
      <button class="swap-direction" id="swap-reverse" aria-label="Reverse assets">↕</button>
      <div class="swap-box"><div class="swap-box-top"><span>Estimated receive</span><span id="swap-receive-usd">≈ —</span></div><div class="swap-input-row"><input id="swap-estimate" readonly value="—" aria-label="Estimated receive amount"/><select id="swap-to" class="asset-select">${opts(firstCode)}</select></div></div>
      <div class="detail-list" style="margin:17px 0"><div class="detail-row"><span>Indicative rate</span><strong id="swap-rate">—</strong></div><div class="detail-row"><span>Available balance</span><strong id="swap-available-balance">—</strong></div><div class="detail-row"><span>Estimated fee</span><strong>Not applied in preview</strong></div><div class="detail-row"><span>Settlement</span><strong class="negative">Internal ledger · not released</strong></div></div>
      <button class="primary-button" id="get-swap-quote" style="width:100%">Calculate USD reference quote</button>
      <div class="security-note" style="margin-top:12px">A quote is an estimate only. This version cannot execute a trade or change your wallet balance.</div>
    </section><aside class="card section-card swap-market-panel"><div class="panel-head"><div><h3>Top 10 cryptocurrencies</h3><p class="panel-subtitle">Ranked by market capitalization · USD</p></div><button class="small-button" id="refresh-swap-markets" type="button">↻ Refresh</button></div>
      <div class="swap-market-meta"><span class="status-pill ${state.markets.length?'approved':'pending'}">${state.markets.length?'Live feed':'Feed unavailable'}</span><span id="swap-market-updated">${state.marketsUpdatedAt?new Date(state.marketsUpdatedAt).toLocaleTimeString():'Waiting for data'}</span></div>
      <div id="swap-market-leaderboard">${renderSwapMarketLeaderboard()}</div>
      <div class="security-row"><div><strong>Base currency</strong><span>USD — United States Dollar</span></div>${statusPill('approved')}</div>
      <div class="security-row"><div><strong>Market reference</strong><span>CoinGecko public market data</span></div>${statusPill(state.markets.length?'approved':'pending')}</div>
      <div class="security-row"><div><strong>Trade settlement</strong><span>Internal ledger workflow under development</span></div>${statusPill('pending')}</div>
      <div class="security-note">Market prices are real public reference data, not executable exchange prices. The platform does not connect to a live exchange or blockchain.</div>
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
function renderDeposit() { return `${heading('Deposit','Add funds to your exchange account.')}
  <div class="alert-banner"><span class="notice-icon">!</span><div><strong>Deposits are not enabled yet</strong>Blockchain deposit addresses, network monitoring and confirmation handling have not been connected. Do not send funds to this platform at this stage.</div></div>
  <div class="two-col"><section class="card section-card"><h3>Deposit availability</h3><p>Supported networks will be activated only after end-to-end testing and operational approval.</p><div class="security-row"><div><strong>Settlement mode</strong><span>Internal ledger only</span></div>${statusPill('pending')}</div><div class="security-row"><div><strong>On-chain deposits</strong><span>Network listener and custody integration</span></div>${statusPill('rejected')}</div><div class="security-row"><div><strong>Bank transfer deposits</strong><span>Payment provider integration</span></div>${statusPill('rejected')}</div></section><section class="card section-card"><h3>Safety reminder</h3><p>Never transfer cryptocurrency to an address sent through an unofficial message. When deposits are ready, an address will be generated from the platform's verified deposit workflow.</p></section></div>`; }
function renderWithdraw() { return `${heading('Withdraw','Request a transfer from your exchange account.')}
  <div class="alert-banner"><span class="notice-icon">!</span><div><strong>Withdrawals are not enabled yet</strong>Destination screening, transaction approval, hot/cold wallet controls and blockchain signing are not connected. No withdrawal request can be submitted.</div></div>
  <div class="card section-card"><h3>Withdrawal controls</h3><p>Withdrawal functionality will remain unavailable until all server-side security and operational controls are implemented and tested.</p><div class="security-row"><div><strong>Two-factor authentication</strong><span>Required for sensitive account operations</span></div>${statusPill(state.aal==='aal2'?'approved':'pending')}</div><div class="security-row"><div><strong>Transaction screening</strong><span>Address screening and risk rules</span></div>${statusPill('pending')}</div><div class="security-row"><div><strong>Approval workflow</strong><span>Role separation and dual control</span></div>${statusPill('pending')}</div></div>`; }

async function renderInvestments() {
  const [plans, investments] = await Promise.all([
    supabase.from('investment_plans').select('id,plan_code,name,description,asset_code,minimum_amount,maximum_amount,minimum_duration_days,maximum_duration_days,rate_value,rate_period').eq('is_active',true).order('name'),
    supabase.from('investments').select('id,asset_code,principal_amount,duration_days,applied_rate,applied_rate_period,status,starts_at,matures_at,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(20)
  ]);
  const planRows = plans.data||[], invRows = investments.data||[];
  return `${heading('Investments','Review available plans and your investment history.')}
    <div class="alert-banner"><span class="notice-icon">i</span><div><strong>Investment activation is not available</strong>Plans are displayed only when configured by an authorised administrator. New investments will not be accepted until terms, funding rules and payout calculations are approved.</div></div>
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Available plans</div><div class="panel-subtitle">Administrator-configured investment terms</div></div></div>${planRows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Plan</th><th>Asset</th><th>Minimum</th><th>Duration</th><th>Rate</th></tr></thead><tbody>${planRows.map(p=>`<tr><td><strong>${escapeHtml(p.name)}</strong><div class="table-muted">${escapeHtml(p.description||p.plan_code)}</div></td><td>${escapeHtml(p.asset_code)}</td><td>${money(p.minimum_amount,2)}</td><td>${p.minimum_duration_days}–${p.maximum_duration_days} days</td><td>${money(p.rate_value,2)}% / ${escapeHtml(p.rate_period)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No active plans','There are no investment plans configured for this account yet.')}</section>
    <div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">My investment history</div><div class="panel-subtitle">Your investment records are private to your account.</div></div></div>${invRows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Asset</th><th>Principal</th><th>Duration</th><th>Status</th><th>Start date</th></tr></thead><tbody>${invRows.map(i=>`<tr><td>${escapeHtml(i.asset_code)}</td><td>${money(i.principal_amount,6)}</td><td>${i.duration_days} days</td><td>${statusPill(i.status)}</td><td>${fmtDate(i.starts_at)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No investments yet','Your investment history will appear here.')}</section>`;
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
    supabase.from('swap_orders').select('id,from_asset_code,to_asset_code,from_amount,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(30),
    supabase.from('investments').select('id,asset_code,principal_amount,status,created_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(30)
  ]);
  const rows=[...(d.data||[]).map(x=>({...x,type:'deposit'})),...(w.data||[]).map(x=>({...x,type:'withdraw'})),...(s.data||[]).map(x=>({...x,type:'swap'})),...(i.data||[]).map(x=>({...x,type:'investment'}))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  return `${heading('Activity','A private timeline of your account records.')}
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Account history</div><div class="panel-subtitle">Latest 120 records across your account modules</div></div></div>${rows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.type)}</td><td class="table-muted">${shortId(r.id)}</td><td>${fmtDate(r.created_at)}</td><td>${r.type==='swap'?`${money(r.from_amount,6)} ${escapeHtml(r.from_asset_code)}`:`${money(r.amount??r.principal_amount,6)} ${escapeHtml(r.asset_code)}`}</td><td>${statusPill(r.status)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No activity yet','Your account records will appear here once an approved operation has been processed.')}</section>`;
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
  const invites=data.pending_invitations||[];
  const pairs=data.trading_pairs||[];
  const fee=data.active_swap_fee||null;
  const treasury=data.treasury_balances||[];
  const hasTreasuryLiquidity=treasury.some(item=>Number(item.balance)>0);
  const settings=data.system_settings||{};
  const systemValue=(key)=>settings[key]===undefined?'Not configured':String(settings[key]);
  return `${heading('Admin console','Governance, system health, market configuration and compliance.',isSuper?`<button class="primary-button" id="open-invite-admin">+ Invite administrator</button>`:'')}
    <div class="grid admin-metric-grid"><div class="card admin-metric"><span>Total registered users</span><strong>${m.users??'—'}</strong></div><div class="card admin-metric"><span>Pending KYC reviews</span><strong>${m.pending_kyc??'—'}</strong></div><div class="card admin-metric"><span>Pending deposits</span><strong>${m.pending_deposits??'—'}</strong></div><div class="card admin-metric"><span>Pending withdrawals</span><strong>${m.pending_withdrawals??'—'}</strong></div><div class="card admin-metric"><span>Swap orders</span><strong>${m.swap_orders??'—'}</strong></div><div class="card admin-metric"><span>Posted ledger transactions</span><strong>${m.posted_ledger_transactions??'—'}</strong></div></div>
    <div class="two-col">
      <section class="card section-card"><div class="panel-head"><div><h3 style="margin:0">System safety status</h3><div class="panel-subtitle">Live configuration read from the database</div></div></div>
        <div class="security-row"><div><strong>Settlement mode</strong><span>${escapeHtml(systemValue('settlement_mode'))}</span></div>${statusPill(settings.settlement_mode==='internal_ledger_only'?'approved':'pending')}</div>
        <div class="security-row"><div><strong>On-chain deposits</strong><span>Blockchain deposit integration</span></div>${statusPill(settings.onchain_deposits_enabled===true?'pending':'approved')}</div>
        <div class="security-row"><div><strong>On-chain withdrawals</strong><span>Blockchain signing and payout integration</span></div>${statusPill(settings.onchain_withdrawals_enabled===true?'pending':'approved')}</div>
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
    <section class="card section-card"><div class="panel-head"><div><h3 style="margin:0">Platform treasury &amp; liquidity</h3><div class="panel-subtitle">Balances are derived from posted internal-ledger entries.</div></div><span class="status-pill ${hasTreasuryLiquidity?'approved':'pending'}">${hasTreasuryLiquidity?'Funded':'No liquidity'}</span></div>
      ${treasury.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Asset</th><th>Treasury balance</th><th>Settlement readiness</th></tr></thead><tbody>${treasury.map(item=>`<tr><td><strong>${escapeHtml(item.asset_code)}</strong></td><td>${money(item.balance,8)} ${escapeHtml(item.asset_code)}</td><td>${Number(item.balance)>0?statusPill('approved'):statusPill('pending')}</td></tr>`).join('')}</tbody></table></div>`:emptyState('Treasury accounts not available','The platform treasury accounts could not be loaded.')}
      <div class="security-note">A live swap cannot settle unless the platform holds the asset being delivered. Price feeds do not create inventory.</div>
    </section>
    <div class="page-spacer"></div>
    <section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Trading pair controls</div><div class="panel-subtitle">Enabling a pair makes it available for preview quotes only; it does not enable execution.</div></div></div>
      ${pairs.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Pair</th><th>Configuration</th><th>Action</th></tr></thead><tbody>${pairs.map(p=>`<tr><td><strong>${escapeHtml(p.base_asset_code)} / ${escapeHtml(p.quote_asset_code)}</strong></td><td>${statusPill(p.is_active?'approved':'pending')}</td><td>${isSuper?`<button class="small-button ${p.is_active?'reject':'approve'}" data-admin-pair-toggle="${escapeHtml(p.id)}" data-enabled="${p.is_active?'true':'false'}">${p.is_active?'Disable pair':'Enable preview pair'}</button>`:'Read only'}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No pairs configured','Add trading pairs in the database before enabling market quotes.')}
    </section>
    ${isSuper?`<div class="page-spacer"></div><section class="card section-card"><h3>Swap fee configuration</h3><p>Fee changes are recorded in the admin audit log. This fee is configuration only; no fee is collected while swap execution is disabled.</p>
      <div class="security-row"><div><strong>Current swap fee</strong><span>${fee?`${money(fee.fee_value,2)}% · effective ${fmtDate(fee.effective_from)}`:'Not configured'}</span></div>${statusPill(fee?'approved':'pending')}</div>
      <div class="form-field"><label class="field-label" for="swap-fee-percent">New swap fee (%)</label><input id="swap-fee-percent" class="form-control" type="number" min="0" max="10" step="0.01" value="${fee?escapeHtml(String(fee.fee_value)):''}" placeholder="Enter 0–10" /></div>
      <button class="primary-button" id="save-swap-fee" style="margin-top:12px">Save swap fee configuration →</button>
    </section>`:`<section class="card section-card"><h3>Swap fee configuration</h3><p>${fee?`Current configured fee: ${money(fee.fee_value,2)}%.`:'No swap fee has been configured.'} Contact the Super Admin to make changes.</p></section>`}
    <div class="page-spacer"></div>
    <div class="two-col"><section class="card section-card"><div class="panel-head"><div><h3 style="margin:0">KYC review queue</h3><div class="panel-subtitle">Identity documents requiring review</div></div><span class="status-pill pending">${kycRows.length} pending</span></div>
      ${kycRows.length?kycRows.map(k=>`<div class="admin-kyc-row"><div><strong>${escapeHtml(k.email||shortId(k.user_id))}</strong><span>Submitted ${fmtDate(k.submitted_at)} · ${k.documents?.length||0} document(s)</span><div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:8px">${(k.documents||[]).map(doc=>doc.signed_url?`<a class="small-button" href="${escapeHtml(doc.signed_url)}" target="_blank" rel="noopener">View ${escapeHtml(doc.document_type)}</a>`:'').join('')}</div></div><div class="row-actions"><button class="small-button approve" data-kyc-review="approved" data-kyc-id="${escapeHtml(k.id)}">Approve</button><button class="small-button reject" data-kyc-review="rejected" data-kyc-id="${escapeHtml(k.id)}">Reject</button></div></div>`).join('') : emptyState('No pending KYC reviews','New submissions will appear here once members submit documents.')}
    </section><section class="card section-card"><h3>Platform limitations</h3><p>These protections are intentional until custody and settlement controls are independently tested.</p>
      <div class="security-row"><div><strong>Deposit processing</strong><span>Disabled pending blockchain monitoring</span></div>${statusPill('pending')}</div>
      <div class="security-row"><div><strong>Withdrawal processing</strong><span>Disabled pending custody and signing</span></div>${statusPill('pending')}</div>
      <div class="security-row"><div><strong>Swap execution</strong><span>Preview only; no balance movement</span></div>${statusPill('pending')}</div>
    </section></div>
    ${isSuper?`<div class="page-spacer"></div><section class="card panel table-card"><div class="panel-head"><div><div class="panel-title">Pending administrator invitations</div><div class="panel-subtitle">Invitations issued by the Super Admin</div></div></div>${invites.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Email</th><th>Role</th><th>Created</th><th>Expires</th><th>Status</th></tr></thead><tbody>${invites.map(x=>`<tr><td>${escapeHtml(x.email)}</td><td>${escapeHtml(x.role.replaceAll('_',' '))}</td><td>${fmtDate(x.created_at)}</td><td>${fmtDate(x.expires_at)}</td><td>${statusPill(x.status)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No pending invitations','New subordinate administrator invitations will appear here.')}</section>`:''}
    <div class="security-note" style="margin-top:13px">Financial and administrative changes are handled server-side and audited. On-chain deposits, withdrawals and live swap execution remain disabled.</div>`;
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
  }catch(error){console.error(error);toast(error.message||'Could not submit KYC documents.','error');btn.disabled=false;btn.textContent='Upload and submit documents →';}
}

async function loadNotifications() {
  const {data,error}=await supabase.from('notifications').select('id,title,body,notification_type,created_at,read_at').eq('user_id',state.user.id).order('created_at',{ascending:false}).limit(20);
  if(error){toast(error.message,'error');return;}
  state.notifications=data||[];
  const unread=state.notifications.filter(n=>!n.read_at).length;$('#notification-dot').classList.toggle('hidden',!unread);
  openModal('Notifications',unread?`${unread} unread message(s)`:'You are all caught up.',state.notifications.length?state.notifications.map(n=>`<div class="security-row"><div><strong>${escapeHtml(n.title)}</strong><span>${escapeHtml(n.body||'') } · ${fmtDate(n.created_at)}</span></div>${n.read_at?'':`<button class="small-button" data-notification-read="${escapeHtml(n.id)}">Mark read</button>`}</div>`).join(''):emptyState('No notifications','System messages and account updates will appear here.'));
  $$('[data-notification-read]').forEach(btn=>btn.onclick=async()=>{const {error}=await supabase.from('notifications').update({read_at:new Date().toISOString()}).eq('id',btn.dataset.notificationRead).eq('user_id',state.user.id);if(error)toast(error.message,'error');else{closeModal();await loadNotifications();}});
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
  $$('[data-go]').forEach(button=>button.addEventListener('click',()=>renderPage(button.dataset.go)));
  if(page==='markets'){
    $('#refresh-markets')?.addEventListener('click',async()=>{await loadMarkets(true);await renderPage('markets');});
    $('#market-search')?.addEventListener('input',()=>{const term=$('#market-search').value.toLowerCase();const items=state.markets.filter(m=>m.name.toLowerCase().includes(term)||m.symbol.toLowerCase().includes(term));$('#market-table-body').innerHTML=items.length?items.map(marketRow).join(''):`<tr><td colspan="5">${emptyState('No matching assets','Try another search term.')}</td></tr>`;});
  }
  if(page==='swap'){
    const refreshSwapMarkets=async()=>{
      const button=$('#refresh-swap-markets'); if(button){button.disabled=true;button.textContent='Loading…';}
      await loadMarkets(true);
      const list=$('#swap-market-leaderboard'); if(list)list.innerHTML=renderSwapMarketLeaderboard();
      const updated=$('#swap-market-updated'); if(updated)updated.textContent=state.marketsUpdatedAt?new Date(state.marketsUpdatedAt).toLocaleTimeString():'Unavailable';
      if(button){button.disabled=false;button.textContent='↻ Refresh';}
    };
    $('#refresh-swap-markets')?.addEventListener('click',refreshSwapMarkets);
    state.swapMarketRefreshTimer=setInterval(refreshSwapMarkets,60000);
    // The empty-state view intentionally has no quote controls until an admin enables a pair.
    const amountInput=$('#swap-amount'),fromSelect=$('#swap-from'),toSelect=$('#swap-to');
    const estimateInput=$('#swap-estimate'),rateOutput=$('#swap-rate');
    const availableOutput=$('#swap-available-balance');
    const sendUsd=$('#swap-send-usd'),receiveUsd=$('#swap-receive-usd');
    const calculate=()=>{
      if(!amountInput||!fromSelect||!toSelect||!estimateInput||!rateOutput||!availableOutput||!sendUsd||!receiveUsd)return;
      const amount=Number(amountInput.value||0),from=fromSelect.value,to=toSelect.value;
      const fromPrice=priceOf(from),toPrice=priceOf(to);
      const available=state.balances.filter(row=>row.domain==='exchange'&&row.account_kind==='available'&&row.asset_code===from).reduce((sum,row)=>sum+Number(row.balance||0),0);
      availableOutput.textContent=`${money(available,8)} ${from}`;
      const supportedCodes=['USD',...state.markets.slice(0,10).map(m=>String(m.symbol||'').toUpperCase())];
      const pairSupported=supportedCodes.includes(from)&&supportedCodes.includes(to);
      if(!Number.isFinite(amount)||amount<=0||from===to||!pairSupported||fromPrice==null||toPrice==null||!Number.isFinite(fromPrice)||!Number.isFinite(toPrice)||toPrice<=0){
        estimateInput.value='—';rateOutput.textContent=pairSupported?'Waiting for valid amount or market price':'Asset is not supported';
        sendUsd.textContent='≈ —';receiveUsd.textContent='≈ —';return;
      }
      const usd=amount*fromPrice,output=usd/toPrice;
      if(!Number.isFinite(output))return;
      estimateInput.value=output.toFixed(8).replace(/0+$/,'').replace(/\.$/,'');
      rateOutput.textContent=`1 ${from} ≈ ${money(fromPrice/toPrice,8)} ${to}`;
      sendUsd.textContent=`≈ ${fmtPrice(usd)}`;
      receiveUsd.textContent=`≈ ${fmtPrice(usd)}`;
    };
    $('#get-swap-quote')?.addEventListener('click',calculate);
    amountInput?.addEventListener('input',calculate);
    fromSelect?.addEventListener('change',calculate);
    toSelect?.addEventListener('change',calculate);
    $('#swap-reverse')?.addEventListener('click',()=>{if(!fromSelect||!toSelect)return;const a=fromSelect.value;fromSelect.value=toSelect.value;toSelect.value=a;calculate();});
    calculate();
  }
  if(page==='kyc')$('#kyc-form')?.addEventListener('submit',submitKyc);
  if(page==='security')$('#setup-mfa')?.addEventListener('click',startMfaSetup);
  if(page==='referrals')$('#copy-referral')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#referral-code').value);toast('Referral code copied.','success');}catch{toast('Copy is not available in this browser.','error');}});
  if(page==='admin'){
    $('#open-invite-admin')?.addEventListener('click',openAdminInviteModal);
    $$('[data-kyc-review]').forEach(btn=>btn.addEventListener('click',()=>reviewKyc(btn.dataset.kycId,btn.dataset.kycReview)));
    $$('[data-admin-pair-toggle]').forEach(btn=>btn.addEventListener('click',async()=>{
      const enabled=btn.dataset.enabled!=='true';
      if(!confirm(`${enabled?'Enable':'Disable'} this pair for preview quotes? This does not turn on real swap execution.`))return;
      btn.disabled=true;
      const {data,error}=await supabase.functions.invoke('admin-trading-settings',{body:{action:'set_pair_enabled',pair_id:btn.dataset.adminPairToggle,enabled}});
      if(error){btn.disabled=false;return toast(error.message||'Could not update trading pair.','error');}
      toast(enabled?'Preview pair enabled.':'Preview pair disabled.','success');
      await renderPage('admin');
    }));
    $('#save-swap-fee')?.addEventListener('click',async()=>{
      const fee=Number($('#swap-fee-percent').value);
      if(!Number.isFinite(fee)||fee<0||fee>10)return toast('Enter a swap fee between 0 and 10 percent.','error');
      if(!confirm(`Save the swap fee as ${fee}%? This will not collect fees until swap execution is enabled.`))return;
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
