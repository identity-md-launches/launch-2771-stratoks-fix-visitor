export type AuthState = "disconnected" | "connected" | "signing" | "checking" | "verified" | "expired" | "unavailable";
export interface Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}
export interface WalletChoice { provider: Provider; name: string; id: string }
export interface AuthConfig {
  version: 1; enabled: true; uri: string; domain: string; world: string; chains: number[];
  nonceTtlMs: number; sessionTtlMs: number; transport: "memory-bearer"; sessionsSurviveRestart: false;
}
export interface VisitorSession {
  version: 1; token: string; address: string; chainId: number; origin: string; world: string;
  uri: string; role: "visitor"; expiresAt: number;
  profile: { address: string; firstVerifiedAt: number; lastVerifiedAt: number; visitCount: number };
}
export interface AuthSnapshot {
  state: AuthState; error: string; address: string | null; chainId: number | null;
  session: VisitorSession | null; busy: boolean; retryAt: number; retryAfterUntil: number;
}
export function discoverWallets(target?: Window, legacy?: Provider): {
  readonly wallets: WalletChoice[]; subscribe(fn: (wallets: WalletChoice[]) => void): () => void; destroy(): void;
};
export function validateChallenge(c: unknown, cfg: AuthConfig, expected: { address: string; chainId: number; origin: string; uri: string; now?: number }): void;
export class VisitorAuthClient implements AuthSnapshot {
  constructor(options: { baseUrl: string | null; uri: string | null; origin: string; fetchImpl?: typeof fetch; timeoutMs?: number; signatureTimeoutMs?: number; onChange?: (snapshot: AuthSnapshot) => void });
  state: AuthState; error: string; address: string | null; chainId: number | null;
  session: VisitorSession | null; config: AuthConfig | null; busy: boolean;
  revocations: Set<unknown>;
  pendingRequests: number; activeAttempts: number;
  retryAt: number; retryAfterUntil: number;
  challenge: { message: string; cancellationSecret: string } | null;
  connect(provider: Provider): Promise<void>;
  loadConfig(): Promise<AuthConfig>;
  signIn(): Promise<void>;
  refreshSession(options?: { retryNow?: boolean }): Promise<void>;
  logout(): Promise<void>;
  retryRevocations(): Promise<void>;
  invalidate(reason?: string, state?: AuthState): void;
  disconnect(): void;
  destroy(): void;
}
