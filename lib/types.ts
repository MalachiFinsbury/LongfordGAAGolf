export const PRICE_PER_TEAM = 2200;
export const PRICE_PER_TEE_BOX = 500;
export const PRICE_PER_GREEN = 500;
export const MAX_TEAMS = 5;
export const PLAYERS_PER_TEAM = 4;

export type Player = {
  name: string;
  handicap: string;
};

export type Team = {
  players: Player[];
};

export type Registration = {
  id: string;
  created_at: string;
  name: string;
  company_or_club: string | null;
  address: string | null;
  mobile: string;
  email: string;
  number_of_teams: number;
  teams: Team[];
  tee_box_count: number;
  green_count: number;
  donation_amount: number;
  sponsor_raffle: boolean;
  raffle_prize: string | null;
  total_amount: number;
};

export function calculateTotal(input: {
  number_of_teams: number;
  tee_box_count: number;
  green_count: number;
  donation_amount: number;
}): number {
  return (
    input.number_of_teams * PRICE_PER_TEAM +
    input.tee_box_count * PRICE_PER_TEE_BOX +
    input.green_count * PRICE_PER_GREEN +
    (input.donation_amount || 0)
  );
}

export function formatEuro(amount: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount || 0);
}
