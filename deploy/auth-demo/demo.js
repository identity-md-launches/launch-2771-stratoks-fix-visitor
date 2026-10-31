import { VisitorAuthClient, discoverWallets } from './shared/visitor-auth-client.js';
const el = (id) => document.getElementById(id);
const discovery = discoverWallets();
const backendEnabled = document.querySelector('meta[name="stratoks-demo-backend"]').content === 'same-origin-isolated';
const loadConfig = () => backendEnabled ? controller.loadConfig().catch(() => {}) : Promise.resolve();
const controller = new VisitorAuthClient({ baseUrl: location.origin, uri: location.origin + '/', origin: location.origin, onChange: render });
function render({ state, error, address, chainId, session, busy }) {
  el('status').textContent = session && state === 'unavailable' ? 'Session unconfirmed' : { disconnected: 'Disconnected', connected: 'Connected · not authenticated', signing: 'Signing · waiting for wallet or backend', checking: 'Checking session', verified: 'Verified visitor', expired: 'Session expired', unavailable: 'Sign-in unavailable' }[state];
  el('account').textContent = address ? `${address} · chain ${chainId ?? 'unknown'}${session ? ` · ${state === 'verified' ? 'verified visits' : 'last confirmed visits'}: ${session.profile.visitCount}` : ''}` : '';
  el('error').textContent = error;
  el('connect').disabled = busy;
  el('sign').disabled = busy || !address || !!session || !controller.config;
  el('reason').textContent = busy ? 'Wait for this attempt, or disconnect to cancel. Requests time out and can be retried.' : session ? state === 'verified' ? 'Already verified. Sign out before signing in again.' : 'Session confirmation is pending. Your credential is retained; checks retry automatically. You can sign out.' : !address ? 'Connect a wallet to enable sign-in.' : !controller.config ? 'No compatible isolated backend is available. Static hosting does not install the backend; run the demo server, then reconnect.' : !controller.config.chains.includes(chainId) ? `Sign-in requires chain ${controller.config.chains.join(' or ')}. Select it in your wallet.` : 'Sign-in is optional. Read the exact message in your wallet before signing.';
}
function listWallets(wallets) {
  el('wallets').replaceChildren();
  el('requirements').textContent = wallets.length ? 'Choose your wallet. Its name comes from the injected provider; verify the wallet prompt yourself.' : 'No injected EVM wallet found. Install MetaMask/Rabby or open this page in an injected mobile wallet browser. Ordinary mobile browsers cannot connect by themselves.';
  for (const wallet of wallets) {
    const button = document.createElement('button'); button.textContent = wallet.name;
    button.addEventListener('click', async () => { await controller.connect(wallet.provider); await loadConfig(); });
    el('wallets').append(button);
  }
}
discovery.subscribe(listWallets);
el('connect').addEventListener('click', async () => {
  listWallets(discovery.wallets); el('wallet-panel').scrollIntoView({ block: 'nearest' });
  await loadConfig();
  if (discovery.wallets.length === 1) await controller.connect(discovery.wallets[0].provider);
  else if (discovery.wallets.length > 1) el('wallets').querySelector('button')?.focus();
});
el('sign').addEventListener('click', () => controller.signIn());
el('logout').addEventListener('click', () => controller.logout());
el('disconnect').addEventListener('click', () => controller.disconnect());
window.addEventListener('focus', () => controller.refreshSession());
window.addEventListener('online', () => controller.refreshSession());
const monitor = setInterval(() => { if (backendEnabled) controller.refreshSession(); }, 30_000);
let viewing = false;
async function view() {
  if (!backendEnabled) { el('world').textContent = 'Static preview · no backend installed. Run the isolated demo server to view its world and enable verified sign-in.'; return; }
  if (viewing) return; viewing = true;
  try {
    const r = await fetch('/api/expanse/frame?x=0&y=0&w=48&h=32', { credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('World unavailable');
    const frame = await r.json(), v = frame.view;
    el('world').textContent = `Tick ${frame.tick} · ${frame.residents.length} residents · anonymous viewing`;
    const canvas = el('terrain'), ctx = canvas.getContext('2d'); canvas.width = v.w; canvas.height = v.h;
    const colors = ['#4d7a46','#456b3f','#264f71','#a39467','#8a8b83','#636a4b','#9f997b','#cad2d0','#344b59','#7d785d','#375b48'];
    v.tiles.forEach((tile, i) => { ctx.fillStyle = colors[tile] ?? '#4d7a46'; ctx.fillRect(i % v.w, Math.floor(i / v.w), 1, 1); });
    for (const c of v.creatures ?? []) { ctx.fillStyle = '#f4d994'; ctx.fillRect(Math.floor(c[2]) - v.x0, Math.floor(c[3]) - v.y0, 1, 1); }
  } catch { el('world').textContent = 'Backend unavailable. Anonymous viewing resumes when it returns.'; }
  finally { viewing = false; }
}
const viewer = setInterval(view, 1000); view();
loadConfig(); render({ state: 'disconnected' });
window.addEventListener('pagehide', () => { clearInterval(monitor); clearInterval(viewer); controller.destroy(); discovery.destroy(); });
// Test-only observation hook is intentionally absent; tests exercise DOM and the public controller separately.
