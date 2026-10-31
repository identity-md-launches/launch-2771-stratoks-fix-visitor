import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { discoverWallets, VisitorAuthClient, type AuthSnapshot, type WalletChoice } from "../../../shared/visitor-auth-client.js";
import { Icon } from "../icons";
import { Modal } from "../Modal";

const initial: AuthSnapshot = { state: "disconnected", error: "", address: null, chainId: null, session: null, busy: false, retryAt: 0, retryAfterUntil: 0 };
const labels = {
  disconnected: "Disconnected", connected: "Connected · not signed in", signing: "Signing in…",
  checking: "Checking session…", verified: "Verified visitor", expired: "Session expired", unavailable: "Sign-in unavailable",
};
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
function readable(error: string) {
  if (/Failed to fetch|NetworkError|Load failed/i.test(error)) return "The sign-in server cannot be reached. Keep browsing or check availability to retry.";
  if (/does not offer compatible visitor sign-in/.test(error)) return "This world has not enabled compatible visitor sign-in. Keep browsing or check availability to retry.";
  if (/session_store_full/.test(error)) return "This account or origin has reached its active-session limit. Sign out in another signed-in tab, or wait for existing sessions to expire.";
  if (/rate_limited|store_full/.test(error)) return "The sign-in server is at its request or account limit. Wait a minute and retry; if it continues, ask the world operator.";
  if (/unsupported_chain/.test(error)) return "Choose a supported network in your wallet, then retry.";
  if (/nonce_expired|unknown_or_used_nonce/.test(error)) return "The sign-in message expired or was already used. Retry for a fresh message.";
  if (/origin_not_allowed|origin_mismatch/.test(error)) return "The world operator must allow this exact preview origin before sign-in is available.";
  if (/wrong_signer|invalid_signature/.test(error)) return "The server could not verify this account signature. Retry with a compatible EVM account wallet. Smart contract wallets are not supported.";
  return error;
}

export function VisitorWallet({ backendUrl, worldId, open, onOpen, onClose }: {
  backendUrl: string | null; worldId: string | null; open: boolean; onOpen: () => void; onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [wallets, setWallets] = useState<WalletChoice[]>([]);
  const [checking, setChecking] = useState(false);
  const [pendingWallet, setPendingWallet] = useState<string | null>(null);
  const [offlineRevocations, setOfflineRevocations] = useState(0);
  const [retryReady, setRetryReady] = useState(true);
  const connectTicket = useRef(0);
  const client = useRef<VisitorAuthClient | null>(null);
  // Old services stay private while offline revocations are retried. No credential enters React state/storage.
  const retired = useRef(new Set<VisitorAuthClient>());
  const mounted = useRef(true);
  const probe = useRef(false);
  const releaseRetired = (old: VisitorAuthClient) => {
    if (!old.pendingRequests && !old.activeAttempts && !old.revocations.size) retired.current.delete(old);
    if (mounted.current) setOfflineRevocations([...retired.current].reduce((n, c) => n + c.revocations.size, 0));
  };
  useEffect(() => {
    const d = discoverWallets();
    const unsubscribe = d.subscribe(setWallets);
    return () => { unsubscribe(); d.destroy(); };
  }, []);
  useLayoutEffect(() => {
    setSnapshot(initial); setChecking(false); probe.current = false; setPendingWallet(null);
    let active = true;
    const c = new VisitorAuthClient({ baseUrl: backendUrl, uri: backendUrl ? `${backendUrl}/` : null, origin: location.origin, signatureTimeoutMs: 60_000,
      onChange: (s) => { if (active) setSnapshot({ ...s, session: s.session ? { ...s.session, token: "" } : null }); },
    });
    client.current = c;
    return () => {
      active = false;
      c.destroy();
      if (client.current === c) client.current = null;
      retired.current.add(c);
      c.retryRevocations().finally(() => releaseRetired(c)).catch(() => {});
    };
  }, [backendUrl, worldId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const c of retired.current) c.retryRevocations().catch(() => {});
    };
  }, []);

  async function checkAvailability() {
    const c = client.current;
    if (!backendUrl || !c || probe.current || c.busy) return;
    probe.current = true; setChecking(true);
    try { await c.loadConfig(); } catch { /* The controller exposes a recoverable unavailable state. */ }
    finally { if (client.current === c && mounted.current) { probe.current = false; setChecking(false); } }
  }
  useEffect(() => { void checkAvailability(); }, [backendUrl, worldId]);
  useEffect(() => {
    // Retained, unconfirmed sessions must recover too. The controller owns backoff,
    // Retry-After and deduplication across polling, focus, online and the retry action.
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const c = client.current;
        if (c?.session && !c.busy) await c.refreshSession();
        for (const old of retired.current) {
          try { await old.retryRevocations(); } catch { /* Retry remains available. */ }
          releaseRetired(old);
        }
        if (mounted.current) setOfflineRevocations([...retired.current].reduce((n, old) => n + old.revocations.size, 0));
      } finally { reading = false; }
    };
    const timer = setInterval(refresh, 30_000);
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    addEventListener("focus", onFocus); addEventListener("online", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { clearInterval(timer); removeEventListener("focus", onFocus); removeEventListener("online", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, []);
  useEffect(() => { if (open && client.current?.session) void client.current.refreshSession(); }, [open]);
  useEffect(() => {
    const delay = Math.max(0, snapshot.retryAfterUntil - Date.now());
    setRetryReady(delay === 0);
    if (delay) { const timer = setTimeout(() => setRetryReady(true), delay); return () => clearTimeout(timer); }
  }, [snapshot.retryAfterUntil]);

  const c = client.current;
  const available = !!c?.config;
  const state = backendUrl || snapshot.address ? snapshot.state : "unavailable";
  const supported = !!c?.config?.chains.includes(snapshot.chainId ?? -1);
  const reason = snapshot.busy ? "Waiting for the wallet or server. This action will time out; you can also cancel below."
    : snapshot.session && state === "checking" ? "Confirming this session with the server. You can keep browsing or sign out."
    : snapshot.session && state !== "verified" ? "Sign-in is temporarily unconfirmed. Your credential stays in this tab; the session check will retry automatically. You can keep browsing or sign out."
    : snapshot.session ? `Verified on chain ${snapshot.session.chainId}. Reload forgets this tab’s credential. Sign out before reloading to end the server session; otherwise it lasts until expiry or server restart.`
    : !backendUrl
    ? snapshot.error ? readable(snapshot.error) : "This is an isolated preview. Connect a world server in Choose world to use a visitor account."
    : checking ? "Checking whether this world offers visitor sign-in…"
    : available && snapshot.address && !supported ? `Select chain ${c?.config?.chains.join(" or ")} in your wallet. Network is part of the signed message; no transaction is sent.`
    : snapshot.error ? readable(snapshot.error)
    : !available ? "This world has not enabled compatible visitor sign-in, or its backend is unavailable."
    : !snapshot.address ? "Choose and unlock a wallet first. Connecting alone does not sign you in."
    : "Sign a readable, free message. No gas, transaction, asset approval or private key.";
  const status = checking ? "Checking sign-in availability" : snapshot.session && state === "unavailable" ? "Session unconfirmed" : labels[state];
  const buttonText = snapshot.address ? (state === "verified" ? "Verified" : state === "checking" || snapshot.session ? "Check" : state === "signing" ? "Signing…" : state === "expired" ? "Expired" : "Wallet") : "Connect";
  const pendingRevocation = (c?.revocations.size ?? 0) + offlineRevocations > 0;

  return <>
    <button className="exp-wallet-control" aria-haspopup="dialog" aria-label={snapshot.address ? `${buttonText} wallet ${short(snapshot.address)} · ${status}` : "Connect wallet"}
      title={status} onClick={() => { onOpen(); if (!c?.config) void checkAvailability(); }}>
      <Icon name="wallet" size={18} />
      <span className="exp-wallet-compact">{buttonText}</span>
      <span className="exp-wallet-wide">{snapshot.address ? `${short(snapshot.address)} · ${buttonText}` : "Connect wallet"}</span>
    </button>
    {!open && <span className="sr-only" role="status" aria-atomic="true">{snapshot.address ? status : ""}</span>}
    {open && <Modal title="Visitor account" onClose={onClose}>
      <div className="exp-visitor" data-auth-state={state}>
        <div className="exp-visitor-feedback" role="status" aria-atomic="true">
          <div className="exp-visitor-status"><Icon name={state === "verified" ? "check" : "wallet"} size={20} /><strong>{status}</strong></div>
          <p id="visitor-reason" className="exp-visitor-reason">{reason}</p>
        </div>
        <p className="exp-muted">Viewing stays walletless. Sign-in records a private visit and gives no world controls or resident memories.</p>
        {snapshot.address && <p className="exp-visitor-address" aria-label="Connected wallet address">{snapshot.address}</p>}
        {backendUrl && <p className="exp-small exp-muted exp-visitor-service">World service: <span>{backendUrl}</span></p>}
        {!snapshot.address && <div className="exp-visitor-wallets" aria-label="Choose a wallet">
          {wallets.map((w, i) => <button key={`${w.id}-${i}`} className="exp-visitor-wallet" disabled={snapshot.busy} aria-describedby="visitor-reason" onClick={async () => {
            const current = client.current;
            if (!current) return;
            const ticket = ++connectTicket.current;
            setPendingWallet(w.name); await current.connect(w.provider);
            if (client.current === current && ticket === connectTicket.current) setPendingWallet(null);
          }}>
            <Icon name="wallet" size={22} /><span>{w.name}{pendingWallet === w.name && snapshot.busy ? " · opening…" : ""}</span><Icon name="chevron" size={16} />
          </button>)}
          {!wallets.length && <p className="exp-small exp-muted">No wallet found. Use MetaMask, Rabby or a compatible EVM extension. On a phone, open this page inside your wallet’s own browser and unlock it. An ordinary mobile browser cannot connect here.</p>}
        </div>}
        {snapshot.session && <dl className="exp-visitor-profile">
          <div><dt>{state === "verified" ? "Verified visits" : "Last confirmed visits"}</dt><dd>{snapshot.session.profile.visitCount.toLocaleString()}</dd></div>
          <div><dt>Credential expires</dt><dd>{new Date(snapshot.session.expiresAt).toLocaleTimeString()}</dd></div>
          <div><dt>First verified visit</dt><dd>{new Date(snapshot.session.profile.firstVerifiedAt).toLocaleDateString()}</dd></div>
        </dl>}
        {!snapshot.session && backendUrl && <button className="exp-button primary" disabled={!available || checking || !snapshot.address || !supported || snapshot.busy} aria-describedby="visitor-reason" onClick={() => void c?.signIn()}>Sign in with message<Icon name="arrow" size={17} /></button>}
        {snapshot.busy && <button className="exp-button" onClick={() => { ++connectTicket.current; c?.invalidate("Attempt cancelled. Dismiss any wallet prompt before retrying."); setPendingWallet(null); }}>Cancel attempt</button>}
        {snapshot.session && state !== "verified" && <button className="exp-button" disabled={state === "checking" || !retryReady} aria-describedby="visitor-reason" onClick={() => void c?.refreshSession({ retryNow: true })}>{state === "checking" ? "Checking session…" : !retryReady ? "Retry scheduled" : "Retry session check"}</button>}
        {snapshot.session && <button className="exp-button" onClick={() => void c?.logout()}>Sign out</button>}
        {pendingRevocation && <button className="exp-button" disabled={snapshot.busy} onClick={async () => {
          await c?.logout();
          for (const old of retired.current) { try { await old.retryRevocations(); } catch {} releaseRetired(old); }
          setOfflineRevocations([...retired.current].reduce((n, old) => n + old.revocations.size, 0));
        }}>Retry server sign-out</button>}
        {snapshot.address && !snapshot.busy && <button className="exp-visitor-text" onClick={() => void (async () => {
          if (c?.session || c?.revocations.size) await c.logout();
          if (client.current === c) c?.disconnect();
        })()}>Disconnect wallet</button>}
        {!available && backendUrl && <button className="exp-button" disabled={checking || snapshot.busy} onClick={() => void checkAvailability()}>Check sign-in availability</button>}
        {pendingRevocation && <p className="exp-small exp-visitor-error">Server revocation is pending. Retry while this tab is open. Otherwise the old session lasts until expiry or server restart.</p>}
        <details className="exp-visitor-details"><summary>Privacy and wallet support</summary>
          <p>Reload forgets this tab’s credential. Sign out before reloading to end the server session; otherwise it lasts until expiry or server restart. Private visit history stays on the world server, subject to the owner’s retention policy for inactive visitor records. Resident memory is separate. Login never pauses, resets or advances the simulation.</p>
          <p>Only simulated MetaMask/Rabby-style providers were tested. Actual extensions and mobile devices are untested. Compatible injected EVM account wallets may work. Smart contract wallets, Coinbase Smart Wallet and WalletConnect are not supported by this signature verifier.</p>
        </details>
      </div>
    </Modal>}
  </>;
}
