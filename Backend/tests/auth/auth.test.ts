import { describe, expect, test } from "vitest";
import {
  buildGoogleAuthUrl,
  isStateValid,
  mapGoogleProfile,
  GOOGLE_SCOPES,
} from "../../src/modules/auth/google";

// ─── buildGoogleAuthUrl ─────────────────────────────────────────────────────

describe("buildGoogleAuthUrl", () => {
  const base = { clientId: "my-client-id", redirectUri: "https://app.example.com/auth/google/callback", state: "state-123" };

  test("points at Google's authorization endpoint", () => {
    expect(buildGoogleAuthUrl(base).startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
  });

  test("carries client id, redirect uri, and response type", () => {
    const url = new URL(buildGoogleAuthUrl(base));
    expect(url.searchParams.get("client_id")).toBe("my-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/auth/google/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  test("requests openid, email, and profile scopes", () => {
    const url = new URL(buildGoogleAuthUrl(base));
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    expect(GOOGLE_SCOPES).toContain("openid");
  });

  test("includes the CSRF state parameter verbatim", () => {
    const url = new URL(buildGoogleAuthUrl(base));
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  test("forces the account chooser so users can switch Google identities", () => {
    const url = new URL(buildGoogleAuthUrl(base));
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });
});

// ─── isStateValid (CSRF guard) ──────────────────────────────────────────────

describe("isStateValid", () => {
  test("accepts matching cookie and query states", () => {
    expect(isStateValid("abc-123", "abc-123")).toBe(true);
  });

  test("rejects mismatched states", () => {
    expect(isStateValid("abc-123", "different")).toBe(false);
  });

  test("rejects missing cookie state (flow was never started)", () => {
    expect(isStateValid(undefined, "abc-123")).toBe(false);
  });

  test("rejects missing query state (Google did not return it)", () => {
    expect(isStateValid("abc-123", undefined)).toBe(false);
  });

  test("rejects empty strings", () => {
    expect(isStateValid("", "")).toBe(false);
  });
});

// ─── mapGoogleProfile ───────────────────────────────────────────────────────

describe("mapGoogleProfile", () => {
  const validPayload = {
    sub: "google-user-id-42",
    email: "User@Example.com",
    email_verified: true,
    name: "  Shubham Bhattacharya  ",
    picture: "https://lh3.googleusercontent.com/a/photo.jpg",
  };

  test("maps a complete payload", () => {
    const profile = mapGoogleProfile(validPayload);
    expect(profile).toEqual({
      googleId: "google-user-id-42",
      email: "user@example.com",
      name: "Shubham Bhattacharya",
      picture: "https://lh3.googleusercontent.com/a/photo.jpg",
    });
  });

  test("lowercases and trims the email for stable uniqueness", () => {
    expect(mapGoogleProfile(validPayload).email).toBe("user@example.com");
  });

  test("trims the display name", () => {
    expect(mapGoogleProfile(validPayload).name).toBe("Shubham Bhattacharya");
  });

  test("rejects payloads without the `sub` identifier", () => {
    const { sub, ...noSub } = validPayload;
    expect(() => mapGoogleProfile(noSub)).toThrow("sub");
  });

  test("rejects payloads without an email", () => {
    const { email, ...noEmail } = validPayload;
    expect(() => mapGoogleProfile(noEmail)).toThrow("email");
  });

  test("treats blank name as null instead of empty string", () => {
    const profile = mapGoogleProfile({ ...validPayload, name: "   " });
    expect(profile.name).toBeNull();
  });

  test("treats missing name as null", () => {
    const { name, ...noName } = validPayload;
    expect(mapGoogleProfile(noName).name).toBeNull();
  });

  test("rejects non-https picture URLs", () => {
    const profile = mapGoogleProfile({ ...validPayload, picture: "javascript:alert(1)" });
    expect(profile.picture).toBeNull();
  });
});
