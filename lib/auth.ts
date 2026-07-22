// Hardcoded admin session handling.
// A login sets a signed (HMAC-SHA256) cookie so it cannot be forged.
// Works in the Edge runtime (middleware) via Web Crypto.

export const SESSION_COOKIE = "lgc_admin_session";
const SESSION_VALUE = "authenticated";

function getSecret(): string {
  return process.env.ADMIN_SESSION_SECRET || "insecure-dev-secret";
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

/** Build the signed cookie value to store after a successful login. */
export async function createSessionToken(): Promise<string> {
  const signature = await sign(SESSION_VALUE);
  return `${SESSION_VALUE}.${signature}`;
}

/** Validate a cookie value using a constant-time comparison. */
export async function verifySessionToken(
  token: string | undefined | null
): Promise<boolean> {
  if (!token) return false;
  const [value, signature] = token.split(".");
  if (value !== SESSION_VALUE || !signature) return false;
  const expected = await sign(SESSION_VALUE);
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Check submitted credentials against the hardcoded env values. */
export function checkCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.ADMIN_USERNAME || "admin";
  const expectedPass = process.env.ADMIN_PASSWORD || "";
  return username === expectedUser && password === expectedPass;
}
