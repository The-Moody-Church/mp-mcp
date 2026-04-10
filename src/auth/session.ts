import { createHmac, randomBytes } from "node:crypto";
import type { TokenSet, UserInfo } from "./oidc.js";
import type { AppConfig } from "../config.js";
import { refreshAccessToken } from "./oidc.js";

export interface Session {
  user: UserInfo;
  tokens: TokenSet;
}

/** In-memory session store keyed by session ID. */
const sessions = new Map<string, Session>();

/** Pending OIDC state → expected redirect tracking. */
const pendingStates = new Map<string, { createdAt: number }>();

/** Refresh buffer — refresh 5 minutes before expiry. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Generate a cryptographically random state parameter for OIDC.
 */
export function createOidcState(): string {
  const state = randomBytes(32).toString("hex");
  pendingStates.set(state, { createdAt: Date.now() });
  // Clean up old states (> 10 minutes)
  for (const [key, val] of pendingStates) {
    if (Date.now() - val.createdAt > 10 * 60 * 1000) {
      pendingStates.delete(key);
    }
  }
  return state;
}

/**
 * Validate and consume an OIDC state parameter.
 */
export function consumeOidcState(state: string): boolean {
  if (pendingStates.has(state)) {
    pendingStates.delete(state);
    return true;
  }
  return false;
}

/**
 * Create a new session and return its ID.
 */
export function createSession(user: UserInfo, tokens: TokenSet): string {
  const sessionId = randomBytes(32).toString("hex");
  sessions.set(sessionId, { user, tokens });
  return sessionId;
}

/**
 * Get a session by ID, refreshing the token if needed.
 */
export async function getSession(
  sessionId: string,
  appConfig: AppConfig
): Promise<Session | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // Check if token needs refresh
  if (
    session.tokens.expiresAt &&
    session.tokens.refreshToken &&
    Date.now() > session.tokens.expiresAt - REFRESH_BUFFER_MS
  ) {
    try {
      const newTokens = await refreshAccessToken(
        appConfig,
        session.tokens.refreshToken
      );
      session.tokens = newTokens;
    } catch {
      // Refresh failed — session is dead
      sessions.delete(sessionId);
      return null;
    }
  }

  return session;
}

/**
 * Delete a session.
 */
export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Sign a session ID into a cookie value using HMAC.
 */
export function signSessionCookie(sessionId: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(sessionId).digest("hex");
  return `${sessionId}.${sig}`;
}

/**
 * Verify and extract a session ID from a signed cookie value.
 */
export function verifySessionCookie(
  cookie: string,
  secret: string
): string | null {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return null;
  const sessionId = cookie.substring(0, dot);
  const sig = cookie.substring(dot + 1);
  const expected = createHmac("sha256", secret).update(sessionId).digest("hex");
  if (sig !== expected) return null;
  return sessionId;
}

/**
 * Parse cookies from a Cookie header string.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.substring(0, eq).trim();
    const value = pair.substring(eq + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}
