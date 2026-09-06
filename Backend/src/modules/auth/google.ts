// Google OAuth 2.0 Authorization Code flow, implemented directly on fetch.
// Deliberately plugin-free: the flow is ~100 lines, fully testable offline,
// and avoids adding a dependency that must stay Bun-compatible.

import { createHash, timingSafeEqual } from "node:crypto";

import { env } from "../../config/env";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// openid is what makes Google return a stable `sub` identifier.
export const GOOGLE_SCOPES = ["openid", "email", "profile"];

export type GoogleAuthUrlInput = {
  clientId: string;
  redirectUri: string;
  state: string;
};

/**
 * Consent-screen URL. `prompt=select_account` forces the Gmail-style account
 * chooser so a user can sign in with a different Google identity instead of
 * silently reusing whatever the browser already authorized.
 */
export function buildGoogleAuthUrl({ clientId, redirectUri, state }: GoogleAuthUrlInput): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** CSRF guard for the callback: the state must match the one we set on the user's browser. */
export function isStateValid(cookieState: string | undefined, queryState: string | undefined): boolean {
  if (!cookieState || !queryState) return false;
  const a = createHash("sha256").update(cookieState).digest();
  const b = createHash("sha256").update(queryState).digest();
  return timingSafeEqual(a, b);
}

export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
  return exchangeCodeForTokenWith(code, redirectUri, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
}

/** Testable core: credentials are injected so offline tests never read env. */
export async function exchangeCodeForTokenWith(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google token exchange failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const parsed = (await response.json()) as { access_token?: string };
  if (!parsed.access_token) {
    throw new Error("Google token exchange returned no access_token");
  }
  return parsed.access_token;
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google userinfo request failed (${response.status}): ${body.slice(0, 200)}`);
  }
  return mapGoogleProfile(await response.json());
}

export type GoogleProfile = {
  googleId: string;
  email: string;
  name: string | null;
  picture: string | null;
};

/** Pure mapping + validation of the userinfo payload — safe to unit test. */
export function mapGoogleProfile(raw: unknown): GoogleProfile {
  const payload = raw as {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
    picture?: unknown;
  };

  const googleId = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!googleId) throw new Error("Google profile is missing the `sub` identifier");
  if (!email) throw new Error("Google profile is missing an email");

  return {
    googleId,
    email,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null,
    picture: typeof payload.picture === "string" && payload.picture.startsWith("https://") ? payload.picture : null,
  };
}
