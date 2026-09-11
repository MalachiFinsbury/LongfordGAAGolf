import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  checkCredentials,
  createSessionToken,
  verifySessionToken,
} from "@/lib/auth";

afterEach(() => {
  vi.useRealTimers();
});

/** Matches the secret the suite's setup file configures. */
const SECRET = "test-secret-at-least-16-chars-long";

/**
 * The same HMAC the module signs with, reimplemented here so a test can mint a
 * token the verifier will accept and vary one field of the payload at a time.
 */
async function hmacHex(secret: string, value: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("createSessionToken", () => {
  it("produces a four-part token carrying the revocation epoch", async () => {
    const token = await createSessionToken();
    const parts = token.split(".");

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("authenticated");
    expect(parts[1]).toBe("1");
  });

  it("produces a different token on a later login", async () => {
    // The bug this guards: signing a constant meant every login for the life of
    // the deployment produced the identical string, so a token seen once — in a
    // screenshot, on a shared clubhouse machine — stayed valid forever.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    const first = await createSessionToken();
    vi.setSystemTime(new Date("2026-09-01T09:00:05Z"));
    const second = await createSessionToken();
    expect(first).not.toBe(second);
  });

  it("refuses to sign when the secret is missing", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", "");
    await expect(createSessionToken()).rejects.toThrow(/ADMIN_SESSION_SECRET/);
  });

  it("refuses to sign with a guessably short secret", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", "short");
    await expect(createSessionToken()).rejects.toThrow(/16\+ characters/);
  });
});

describe("verifySessionToken", () => {
  it("accepts a token it just issued", async () => {
    expect(await verifySessionToken(await createSessionToken())).toBe(true);
  });

  it("rejects an absent token", async () => {
    expect(await verifySessionToken(undefined)).toBe(false);
    expect(await verifySessionToken(null)).toBe(false);
    expect(await verifySessionToken("")).toBe(false);
  });

  it("rejects a token with the wrong number of parts", async () => {
    expect(await verifySessionToken("authenticated")).toBe(false);
    expect(await verifySessionToken("authenticated.abc")).toBe(false);
    expect(await verifySessionToken("authenticated.1.abc")).toBe(false);
    expect(await verifySessionToken("a.b.c.d.e")).toBe(false);
  });

  it("rejects a token whose payload segments are empty", async () => {
    expect(await verifySessionToken("authenticated..abc.def")).toBe(false);
    expect(await verifySessionToken("authenticated.1..def")).toBe(false);
    expect(await verifySessionToken("authenticated.1.abc.")).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = await createSessionToken();
    const [value, epoch, issued, signature] = token.split(".");
    const flipped = signature[0] === "a" ? `b${signature.slice(1)}` : `a${signature.slice(1)}`;
    expect(await verifySessionToken(`${value}.${epoch}.${issued}.${flipped}`)).toBe(false);
  });

  it("rejects a signature of the wrong length", async () => {
    const [value, epoch, issued] = (await createSessionToken()).split(".");
    expect(await verifySessionToken(`${value}.${epoch}.${issued}.deadbeef`)).toBe(false);
  });

  it("rejects a token claiming a different payload", async () => {
    const token = await createSessionToken();
    const [, epoch, issued, signature] = token.split(".");
    expect(await verifySessionToken(`superuser.${epoch}.${issued}.${signature}`)).toBe(false);
  });

  it("rejects a back-dated issue time, because the timestamp is signed too", async () => {
    // Moving the clock forward in the payload is the obvious way to extend a
    // session; the signature covers it, so the forgery fails to verify.
    const token = await createSessionToken();
    const [value, epoch, , signature] = token.split(".");
    const future = (Date.now() + 60_000).toString(36);
    expect(await verifySessionToken(`${value}.${epoch}.${future}.${signature}`)).toBe(false);
  });

  it("still accepts a token just inside its lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    const token = await createSessionToken();
    vi.setSystemTime(Date.now() + (SESSION_TTL_SECONDS - 60) * 1000);
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("rejects a token past its lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    const token = await createSessionToken();
    vi.setSystemTime(Date.now() + (SESSION_TTL_SECONDS + 60) * 1000);
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("tolerates a server clock slightly behind the issuing one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    const token = await createSessionToken();
    vi.setSystemTime(Date.now() - 30_000);
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("rejects a token stamped well into the future", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    const token = await createSessionToken();
    vi.setSystemTime(Date.now() - 10 * 60_000);
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("rejects a correctly signed token whose issue time is not a number", async () => {
    // Signed with the real secret, so the signature check passes and only the
    // timestamp parsing can turn it away. Anyone able to sign could otherwise
    // mint a session with an unparseable age.
    const payload = "authenticated.1.!!!";
    const token = `${payload}.${await hmacHex(SECRET, payload)}`;
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("accepts a correctly signed token stamped now, proving the forgery helper is sound", async () => {
    // Guards the test above: without this, a broken helper would make that
    // assertion pass for the wrong reason.
    const payload = `authenticated.1.${Date.now().toString(36)}`;
    const token = `${payload}.${await hmacHex(SECRET, payload)}`;
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken();
    vi.stubEnv("ADMIN_SESSION_SECRET", "a-completely-different-secret-value");
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("propagates a missing secret rather than waving the session through", async () => {
    const token = await createSessionToken();
    vi.stubEnv("ADMIN_SESSION_SECRET", "");
    await expect(verifySessionToken(token)).rejects.toThrow(/ADMIN_SESSION_SECRET/);
  });

  it("names the cookie the proxy and the server action both read", () => {
    expect(SESSION_COOKIE).toBe("lgc_admin_session");
  });
});

describe("session epoch", () => {
  it("invalidates every issued token the moment the epoch is bumped", async () => {
    // The only revocation lever there is: the token *is* the session, so
    // signing out can only clear the cookie in the browser that asked. A token
    // already copied elsewhere stays good until this is bumped.
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);

    vi.stubEnv("ADMIN_SESSION_EPOCH", "2");
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("issues tokens that verify under the new epoch", async () => {
    vi.stubEnv("ADMIN_SESSION_EPOCH", "2026-09-11");
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("cannot be defeated by editing the epoch in the token", async () => {
    const token = await createSessionToken();
    const [value, , issued, signature] = token.split(".");

    vi.stubEnv("ADMIN_SESSION_EPOCH", "2");
    // Claiming the new epoch breaks the signature, which covers it.
    expect(await verifySessionToken(`${value}.2.${issued}.${signature}`)).toBe(false);
  });

  it("defaults to a stable epoch when the variable is not set at all", async () => {
    // The common case: nobody has ever needed to revoke, so the variable is
    // absent from the environment and every session still has to work.
    vi.stubEnv("ADMIN_SESSION_EPOCH", undefined);
    const token = await createSessionToken();

    expect(token.split(".")[1]).toBe("1");
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("keeps the token parseable when the epoch itself contains dots", async () => {
    // Otherwise a date like "2026.09.11" would split into extra segments and
    // every session minted under it would be rejected as malformed.
    vi.stubEnv("ADMIN_SESSION_EPOCH", "2026.09.11");
    const token = await createSessionToken();

    expect(token.split(".")).toHaveLength(4);
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("does not confuse two epochs that differ only by a dot", async () => {
    vi.stubEnv("ADMIN_SESSION_EPOCH", "1.2");
    const token = await createSessionToken();

    vi.stubEnv("ADMIN_SESSION_EPOCH", "1_2");
    // Both normalise to "1_2", so this one genuinely is the same epoch; the
    // point is that neither is treated as a malformed token.
    expect(await verifySessionToken(token)).toBe(true);

    vi.stubEnv("ADMIN_SESSION_EPOCH", "3");
    expect(await verifySessionToken(token)).toBe(false);
  });
});

describe("checkCredentials", () => {
  it("accepts the configured pair", () => {
    expect(checkCredentials("organiser", "correct-horse-battery")).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(checkCredentials("organiser", "wrong")).toBe(false);
  });

  it("rejects a wrong username", () => {
    expect(checkCredentials("someone-else", "correct-horse-battery")).toBe(false);
  });

  it("rejects a password that is merely a prefix of the right one", () => {
    expect(checkCredentials("organiser", "correct-horse")).toBe(false);
  });

  it("rejects a password with trailing padding", () => {
    expect(checkCredentials("organiser", "correct-horse-battery ")).toBe(false);
  });

  it("denies everything when the password is not configured", () => {
    // Fails closed: an unset password used to default to the empty string,
    // which meant "admin" plus a blank password unlocked every registrant's
    // name, email, phone and address.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ADMIN_PASSWORD", "");
    expect(checkCredentials("organiser", "")).toBe(false);
    expect(checkCredentials("organiser", "correct-horse-battery")).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  it("denies everything when the username is not configured", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ADMIN_USERNAME", "");
    expect(checkCredentials("", "correct-horse-battery")).toBe(false);
  });

  it("rejects empty credentials against a configured pair", () => {
    expect(checkCredentials("", "")).toBe(false);
  });

  it("compares in a way that is not short-circuited by length", () => {
    // Not a timing measurement — that is too flaky to assert — but a check that
    // wildly mismatched lengths are handled rather than throwing.
    expect(checkCredentials("x".repeat(500), "y".repeat(500))).toBe(false);
  });
});
