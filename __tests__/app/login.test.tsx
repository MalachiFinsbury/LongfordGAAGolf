// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LoginState } from "@/app/actions";

/** What the mocked login action returns for the next attempt. */
let loginResult: LoginState = {};
const loginSpy = vi.fn();

vi.mock("@/app/actions", () => ({
  login: async (_prev: LoginState, formData: FormData) => {
    loginSpy(Object.fromEntries(formData.entries()));
    return loginResult;
  },
}));

const LoginForm = (await import("@/app/admin/login/LoginForm")).default;
const LoginPage = (await import("@/app/admin/login/page")).default;

const user = () => userEvent.setup();

beforeEach(() => {
  loginResult = {};
  loginSpy.mockClear();
});

afterEach(cleanup);

describe("the organiser login form", () => {
  it("asks for a username and a password, and requires both", () => {
    render(<LoginForm />);

    const username = screen.getByLabelText(/Username/) as HTMLInputElement;
    const password = screen.getByLabelText(/Password/) as HTMLInputElement;

    expect(username.required).toBe(true);
    expect(password.required).toBe(true);
    expect(password.type).toBe("password");
  });

  it("helps a password manager fill it", () => {
    render(<LoginForm />);

    expect(screen.getByLabelText(/Username/).getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText(/Password/).getAttribute("autocomplete")).toBe(
      "current-password"
    );
  });

  it("does not capitalise or spell-check the username on a phone", () => {
    // An organiser signing in from the course would otherwise get "Organiser".
    render(<LoginForm />);
    const username = screen.getByLabelText(/Username/);

    expect(username.getAttribute("autocapitalize")).toBe("none");
    expect(username.getAttribute("spellcheck")).toBe("false");
  });

  it("posts what was typed", async () => {
    const u = user();
    render(<LoginForm />);

    await u.type(screen.getByLabelText(/Username/), "organiser");
    await u.type(screen.getByLabelText(/Password/), "correct-horse-battery");
    await u.click(screen.getByRole("button", { name: /Sign in/ }));

    await waitFor(() => expect(loginSpy).toHaveBeenCalled());
    expect(loginSpy.mock.calls[0][0]).toEqual({
      username: "organiser",
      password: "correct-horse-battery",
    });
  });

  it("reads the password back on request, for a long one typed on a phone", async () => {
    const u = user();
    render(<LoginForm />);
    const password = screen.getByLabelText(/Password/) as HTMLInputElement;

    await u.click(screen.getByRole("button", { name: "Show" }));
    expect(password.type).toBe("text");

    await u.click(screen.getByRole("button", { name: "Hide" }));
    expect(password.type).toBe("password");
  });

  it("announces the reveal state to a screen reader", async () => {
    const u = user();
    render(<LoginForm />);

    expect(screen.getByRole("button", { name: "Show" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
    await u.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("button", { name: "Hide" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });

  it("warns about Caps Lock before the third failed attempt", async () => {
    // The usual culprit behind a "wrong password" on a shared organiser login.
    const u = user();
    render(<LoginForm />);
    const password = screen.getByLabelText(/Password/);

    expect(screen.queryByText(/Caps Lock is on/)).toBeNull();
    await u.click(password);
    await u.keyboard("{CapsLock}a");

    expect(await screen.findByText(/Caps Lock is on/)).toBeDefined();
  });

  it("stops warning once the field is left", async () => {
    const u = user();
    render(<LoginForm />);

    await u.click(screen.getByLabelText(/Password/));
    await u.keyboard("{CapsLock}a");
    await screen.findByText(/Caps Lock is on/);

    await u.tab();
    await waitFor(() => expect(screen.queryByText(/Caps Lock is on/)).toBeNull());
  });

  it("shows the server's rejection as an alert", async () => {
    loginResult = { error: "Invalid username or password." };
    const u = user();
    render(<LoginForm />);

    await u.type(screen.getByLabelText(/Username/), "organiser");
    await u.type(screen.getByLabelText(/Password/), "guess");
    await u.click(screen.getByRole("button", { name: /Sign in/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Invalid username or password.");
  });

  it("shows the rate-limit message the same way", async () => {
    loginResult = { error: "Too many attempts. Please wait a few minutes and try again." };
    const u = user();
    render(<LoginForm />);

    await u.type(screen.getByLabelText(/Username/), "organiser");
    await u.type(screen.getByLabelText(/Password/), "guess");
    await u.click(screen.getByRole("button", { name: /Sign in/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Too many attempts/);
  });

  it("renders one message, not a hint against the field that was wrong", async () => {
    // Which half failed is never disclosed — the server returns one string for
    // both (see the login tests in actions.test.ts), and the form must not
    // decorate either field in a way that gives it away.
    loginResult = { error: "Invalid username or password." };
    const u = user();
    render(<LoginForm />);

    await u.type(screen.getByLabelText(/Username/), "wrong-user");
    await u.type(screen.getByLabelText(/Password/), "wrong-pass");
    await u.click(screen.getByRole("button", { name: /Sign in/ }));

    await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByLabelText(/Username/).getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByLabelText(/Password/).getAttribute("aria-invalid")).toBeNull();
  });
});

describe("the login page", () => {
  it("presents the form under a heading that says whose login it is", () => {
    render(<LoginPage />);

    expect(screen.getByRole("heading", { name: /Organiser login/ })).toBeDefined();
    expect(screen.getByLabelText(/Username/)).toBeDefined();
  });

  it("offers a way back to the public registration page", () => {
    render(<LoginPage />);
    const link = screen.getByRole("link", { name: /Back to the registration page/ });

    expect(link.getAttribute("href")).toBe("/");
  });

  it("keeps itself and the dashboard out of search results", async () => {
    // Linked from the public homepage, so crawlers find it by following an
    // ordinary link.
    const { metadata } = await import("@/app/admin/login/page");
    const adminPage = await import("@/app/admin/page");

    expect(metadata.title).toMatch(/Organiser login/);
    expect(adminPage.metadata.robots).toEqual({ index: false, follow: false });
  });
});
