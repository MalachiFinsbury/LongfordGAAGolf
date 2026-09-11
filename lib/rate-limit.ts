import { headers } from "next/headers";
import { getAdminClient } from "./supabase";

/** Submissions allowed from one IP per window. */
const MAX_PER_WINDOW = 10;
const WINDOW_SECONDS = 60 * 60;

/**
 * Best-effort client IP. On Vercel `x-forwarded-for` is set by the platform
 * and the left-most entry is the real client; a spoofed value gets appended
 * after it, so it cannot be used to escape the bucket.
 */
async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return h.get("x-real-ip") ?? "unknown";
}

export type RateLimitResult = { allowed: boolean; count: number };

export type RateLimitOptions = {
  /**
   * What to do when the counter itself is unavailable.
   *
   * The default is to fail OPEN: for a fundraising form we would rather take a
   * legitimate entry than reject it, the limiter exists to stop bulk abuse
   * rather than to be a security boundary, and the expensive downstream action
   * (emailing an invoice) is still bounded by Stripe's own limits.
   *
   * That reasoning does not survive being pointed at the login page, so the
   * caller there opts out — see `login` in app/actions.ts.
   */
  failClosed?: boolean;
};

/**
 * Counts one attempt against the caller's IP.
 */
export async function checkRateLimit(
  scope: string,
  { failClosed = false }: RateLimitOptions = {}
): Promise<RateLimitResult> {
  const onFailure = (reason: string, detail: unknown): RateLimitResult => {
    console.error(
      `[rate-limit] ${reason} for "${scope}", ${failClosed ? "DENYING" : "allowing"} request`,
      detail
    );
    return { allowed: !failClosed, count: 0 };
  };

  try {
    const ip = await clientIp();
    const { data, error } = await getAdminClient().rpc("bump_rate_limit", {
      p_key: `${scope}:${ip}`,
      p_window_seconds: WINDOW_SECONDS,
    });

    if (error) return onFailure("counter unavailable", error.message);

    const count = Number(data ?? 0);
    if (count > MAX_PER_WINDOW) {
      console.warn(`[rate-limit] ${scope} blocked for ${ip} (${count} in window)`);
    }
    return { allowed: count <= MAX_PER_WINDOW, count };
  } catch (e) {
    return onFailure("check threw", e);
  }
}
