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

/**
 * Counts one attempt against the caller's IP.
 *
 * Fails OPEN — if the counter itself is broken we would rather take a
 * legitimate fundraising entry than reject it. That is a deliberate trade:
 * the limiter exists to stop bulk abuse, not to be a security boundary, and
 * the expensive downstream action (emailing an invoice) is still bounded by
 * Stripe's own rate limits.
 */
export async function checkRateLimit(scope: string): Promise<RateLimitResult> {
  try {
    const ip = await clientIp();
    const { data, error } = await getAdminClient().rpc("bump_rate_limit", {
      p_key: `${scope}:${ip}`,
      p_window_seconds: WINDOW_SECONDS,
    });

    if (error) {
      console.error("[rate-limit] counter unavailable, allowing request", error.message);
      return { allowed: true, count: 0 };
    }

    const count = Number(data ?? 0);
    if (count > MAX_PER_WINDOW) {
      console.warn(`[rate-limit] ${scope} blocked for ${ip} (${count} in window)`);
    }
    return { allowed: count <= MAX_PER_WINDOW, count };
  } catch (e) {
    console.error("[rate-limit] check threw, allowing request", e);
    return { allowed: true, count: 0 };
  }
}
