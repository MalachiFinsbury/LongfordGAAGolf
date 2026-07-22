"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getPublicClient } from "@/lib/supabase";
import {
  SESSION_COOKIE,
  checkCredentials,
  createSessionToken,
} from "@/lib/auth";
import {
  MAX_TEAMS,
  PLAYERS_PER_TEAM,
  calculateTotal,
  type Team,
} from "@/lib/types";

export type SubmitState = { ok: boolean; error?: string };

function toInt(value: FormDataEntryValue | null): number {
  const n = parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toNum(value: FormDataEntryValue | null): number {
  const n = parseFloat(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(value: FormDataEntryValue | null): string {
  return String(value ?? "").trim();
}

export async function submitRegistration(
  _prev: SubmitState,
  formData: FormData
): Promise<SubmitState> {
  const name = str(formData.get("name"));
  const mobile = str(formData.get("mobile"));
  const email = str(formData.get("email"));

  if (!name || !mobile || !email) {
    return { ok: false, error: "Please fill in your name, mobile and email." };
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  const number_of_teams = Math.min(toInt(formData.get("number_of_teams")), MAX_TEAMS);

  // Collect team players for the number of teams selected.
  const teams: Team[] = [];
  for (let t = 1; t <= number_of_teams; t++) {
    const players = [];
    for (let p = 1; p <= PLAYERS_PER_TEAM; p++) {
      players.push({
        name: str(formData.get(`team_${t}_player_${p}_name`)),
        handicap: str(formData.get(`team_${t}_player_${p}_handicap`)),
      });
    }
    teams.push({ players });
  }

  // At least one player name is required if any team was selected.
  if (number_of_teams > 0) {
    const hasCaptain = teams[0].players.some((p) => p.name);
    if (!hasCaptain) {
      return {
        ok: false,
        error: "Please enter at least the first player's name for Team 1.",
      };
    }
  }

  const tee_box_count = toInt(formData.get("tee_box_count"));
  const green_count = toInt(formData.get("green_count"));
  const donation_amount = toNum(formData.get("donation_amount"));
  const sponsor_raffle = formData.get("sponsor_raffle") === "on";
  const raffle_prize = sponsor_raffle ? str(formData.get("raffle_prize")) : "";

  const total_amount = calculateTotal({
    number_of_teams,
    tee_box_count,
    green_count,
    donation_amount,
  });

  try {
    const supabase = getPublicClient();
    const { error } = await supabase.from("registrations").insert({
      name,
      company_or_club: str(formData.get("company_or_club")) || null,
      address: str(formData.get("address")) || null,
      mobile,
      email,
      number_of_teams,
      teams,
      tee_box_count,
      green_count,
      donation_amount,
      sponsor_raffle,
      raffle_prize: raffle_prize || null,
      total_amount,
    });
    if (error) {
      return { ok: false, error: `Could not save your registration: ${error.message}` };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unexpected error saving registration.",
    };
  }

  return { ok: true };
}

export type LoginState = { error?: string };

export async function login(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!checkCredentials(username, password)) {
    return { error: "Invalid username or password." };
  }

  const token = await createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8, // 8 hours
  });

  redirect("/admin");
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/admin/login");
}
