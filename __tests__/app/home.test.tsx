// @vitest-environment jsdom
/**
 * The public entry point. Everything a payer ever sees starts here, so what is
 * covered is what would strand them: the form failing to appear, the way back
 * from a cancelled payment, and the rendering mode the nonce-based CSP depends
 * on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/RegistrationForm", () => ({
  default: () => <form data-testid="registration-form" />,
}));

/**
 * Two things Next does at compile time that Vitest does not.
 *
 * A statically imported image normally arrives as an object carrying its
 * intrinsic size and a blur placeholder; without the loader it is a bare path,
 * and next/image rightly refuses it. next/font/google is likewise rewritten
 * during the build and is not callable on its own.
 */
vi.mock("@/public/banner.jpg", () => ({
  default: {
    src: "/_next/static/media/banner.jpg",
    width: 1600,
    height: 900,
    blurDataURL: "data:image/jpeg;base64,/9j/placeholder",
    blurWidth: 8,
    blurHeight: 5,
  },
}));

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans", className: "font-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono", className: "font-mono" }),
}));

const Home = (await import("@/app/page")).default;

afterEach(cleanup);

const noParams = { searchParams: Promise.resolve({}) };

describe("the registration page", () => {
  it("puts the registration form on it", async () => {
    render(await Home(noParams));
    expect(screen.getByTestId("registration-form")).toBeDefined();
  });

  it("says what the event is and where the money goes", async () => {
    render(await Home(noParams));
    expect(screen.getByText(/Gaelic games in County Longford/)).toBeDefined();
  });

  it("describes the banner for anyone who cannot see it", async () => {
    render(await Home(noParams));
    const banner = screen.getByRole("img");

    expect(banner.getAttribute("alt")).toMatch(/Longford GAA Golf Classic/);
    expect(banner.getAttribute("alt")).toMatch(/18 September 2026/);
  });

  it("offers the organiser login", async () => {
    render(await Home(noParams));
    expect(
      screen.getByRole("link", { name: /Organiser login/ }).getAttribute("href")
    ).toBe("/admin");
  });

  it("says nothing about a cancelled payment on an ordinary visit", async () => {
    render(await Home(noParams));
    expect(screen.queryByText(/Payment cancelled/)).toBeNull();
  });

  it("explains what to do after a payer backs out of Stripe", async () => {
    // Where cancel_url sends them. Without this they land on a bare form with
    // no idea whether anything was taken.
    render(await Home({ searchParams: Promise.resolve({ payment: "cancelled" }) }));

    expect(screen.getByText(/Payment cancelled/)).toBeDefined();
    expect(screen.getByText(/choose bank transfer instead/)).toBeDefined();
    expect(screen.getByTestId("registration-form")).toBeDefined();
  });

  it("ignores an unrecognised payment parameter", async () => {
    render(await Home({ searchParams: Promise.resolve({ payment: "sausages" }) }));
    expect(screen.queryByText(/Payment cancelled/)).toBeNull();
  });

  it("renders per request, which the nonce-based CSP depends on", async () => {
    // A prerendered page's scripts carry no nonce, and the policy in proxy.ts
    // would block every one of them.
    const { dynamic } = await import("@/app/page");
    expect(dynamic).toBe("force-dynamic");
  });

  it("carries a title and description a search result can use", async () => {
    const { metadata } = await import("@/app/layout");

    expect(metadata.title).toMatch(/Longford GAA Golf Classic 2026/);
    expect(String(metadata.description)).toMatch(/Killeen Castle/);
  });
});
