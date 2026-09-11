/**
 * Stand-ins for the request-scoped APIs the server action and the pages read.
 *
 * `cookies()` and `headers()` throw outside a request in real Next, so every
 * server-side test supplies these instead.
 */

type CookieOptions = Record<string, unknown>;

export type StoredCookie = { name: string; value: string; options: CookieOptions };

export class FakeCookieStore {
  private store = new Map<string, StoredCookie>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      this.store.set(name, { name, value, options: {} });
    }
  }

  get(name: string): { name: string; value: string } | undefined {
    const entry = this.store.get(name);
    return entry ? { name: entry.name, value: entry.value } : undefined;
  }

  set(
    nameOrCookie: string | { name: string; value: string } & CookieOptions,
    value?: string,
    options: CookieOptions = {}
  ) {
    if (typeof nameOrCookie === "string") {
      this.store.set(nameOrCookie, { name: nameOrCookie, value: value ?? "", options });
      return;
    }
    const { name, value: v, ...rest } = nameOrCookie;
    this.store.set(name, { name, value: v, options: rest });
  }

  delete(name: string) {
    this.store.delete(name);
  }

  has(name: string) {
    return this.store.has(name);
  }

  /** The options a cookie was written with — httpOnly, sameSite, maxAge… */
  optionsFor(name: string): CookieOptions | undefined {
    return this.store.get(name)?.options;
  }

  getAll(): StoredCookie[] {
    return [...this.store.values()];
  }
}

export function fakeHeaders(values: Record<string, string> = {}) {
  const lower = new Map(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v] as const)
  );
  return {
    get: (name: string) => lower.get(name.toLowerCase()) ?? null,
    has: (name: string) => lower.has(name.toLowerCase()),
  };
}

/**
 * What `redirect()` throws. Next signals a redirect by throwing a special
 * error, and code under test deliberately lets it escape — so the double has
 * to behave the same way or `submitRegistration` would look like it returned.
 */
export class RedirectError extends Error {
  readonly digest: string;

  constructor(public url: string) {
    super(`NEXT_REDIRECT: ${url}`);
    this.name = "RedirectError";
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

export function redirectDouble(url: string): never {
  throw new RedirectError(url);
}

/** Runs `fn`, returning the URL it redirected to, or null if it did not. */
export async function captureRedirect(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof RedirectError) return e.url;
    throw e;
  }
}
