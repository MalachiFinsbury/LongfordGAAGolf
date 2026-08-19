// Hardcoded admin session handling.
// A login sets a signed (HMAC-SHA256) cookie so it cannot be forged.
// Works in the Edge runtime (middleware) via Web Crypto.

export const SESSION_COOKIE = "lgc_admin_session";
const SESSION_VALUE = "authenticated";

/**
 * How long a login stays good for. Baked into the token itself, not just the
 * cookie: `maxAge` is a hint the browser is free to ignore, and a cookie value
 * copied out of one browser and pasted into another carries no expiry with it.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

/** Tolerance for a server clock that is slightly behind the issuing one. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Fails closed on purpose. The previous fallback to a constant string meant
 * that any environment missing this variable signed cookies with a value
 * published in this repository — forgeable by anyone who read it.
 */
function getSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "ADMIN_SESSION_SECRET is missing or too short (needs 16+ characters). " +
        "Refusing to sign admin sessions with a guessable key."
    );
  }
  return secret;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sign(value: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return toHex(sig);
}

/**
 * Build the signed cookie value to store after a successful login.
 *
 * The issue time is part of the signed payload, which is what makes sessions
 * expire and makes two logins produce two different tokens. The previous
 * version signed a constant, so every login in the lifetime of the deployment
 * produced the identical string: a token seen once — on a shared clubhouse
 * machine, in a screenshot, in a proxy log — stayed valid forever, and the
 * only way to revoke it was to rotate ADMIN_SESSION_SECRET.
 */
export async function createSessionToken(): Promise<string> {
  const payload = `${SESSION_VALUE}.${Date.now().toString(36)}`;
  return `${payload}.${await sign(payload)}`;
}

/** Validate a cookie value using a constant-time comparison. */
export async function verifySessionToken(
  token: string | undefined | null
): Promise<boolean> {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [value, issuedAt, signature] = parts;
  if (value !== SESSION_VALUE || !issuedAt || !signature) return false;

  const expected = await sign(`${value}.${issuedAt}`);
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (mismatch !== 0) return false;

  // Only trustworthy once the signature has checked out — before that the
  // timestamp is just attacker-supplied text.
  const issued = parseInt(issuedAt, 36);
  if (!Number.isFinite(issued)) return false;

  const ageSeconds = (Date.now() - issued) / 1000;
  if (ageSeconds > SESSION_TTL_SECONDS) return false;
  // A token stamped in the future means a clock problem or a forged payload
  // that somehow verified; either way it is not something to honour.
  if (ageSeconds < -CLOCK_SKEW_SECONDS) return false;

  return true;
}

/** Length-independent comparison, so a wrong guess leaks nothing via timing. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let mismatch = ab.length ^ bb.length;
  const max = Math.max(ab.length, bb.length);
  for (let i = 0; i < max; i++) {
    mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return mismatch === 0;
}

/**
 * Check submitted credentials against the configured values.
 *
 * Fails closed: an unset ADMIN_PASSWORD used to default to the empty string,
 * which meant username "admin" plus a blank password unlocked every
 * registrant's name, email, phone and address.
 */
export function checkCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedUser || !expectedPass) {
    console.error("[auth] ADMIN_USERNAME or ADMIN_PASSWORD is not set — denying all logins.");
    return false;
  }

  // Both compared unconditionally so the response time doesn't reveal which
  // half was wrong.
  const userOk = safeEqual(username, expectedUser);
  const passOk = safeEqual(password, expectedPass);
  return userOk && passOk;
}
